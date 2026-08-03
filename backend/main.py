import json
import os
import secrets
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, StreamingResponse
from pydantic import BaseModel

def _load_dotenv(path: str) -> None:
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
    except OSError:
        pass


_load_dotenv(str(Path(__file__).parent / ".env"))

# Ollama / ollama.com fallback (used when a user has no Cloudflare session).
OLLAMA_API_KEY = os.getenv("OLLAMA_API_KEY", "")
if os.getenv("OLLAMA_URL"):
    OLLAMA_URL = os.getenv("OLLAMA_URL", "")
else:
    OLLAMA_URL = "https://ollama.com" if OLLAMA_API_KEY else "http://localhost:11434"

# Cloudflare OAuth (private client: users who are members of the owner's
# Cloudflare account). All of these are optional; if unset, /api/chat falls
# back to the Ollama path for every user.
CF_OAUTH_CLIENT_ID = os.getenv("CF_OAUTH_CLIENT_ID", "")
CF_OAUTH_CLIENT_SECRET = os.getenv("CF_OAUTH_CLIENT_SECRET", "")
CF_OAUTH_REDIRECT_URI = os.getenv("CF_OAUTH_REDIRECT_URI", "")
# Must be a subset of the scopes configured on the OAuth client.
CF_OAUTH_SCOPES = os.getenv("CF_OAUTH_SCOPES", "ai.read")
# The account that hosts Workers AI. Required when the client lacks account.read
# (the app can't list accounts to find the id itself).
CF_ACCOUNT_ID = os.getenv("CF_ACCOUNT_ID", "")
CF_OAUTH_AUTH_URL = os.getenv(
    "CF_OAUTH_AUTH_URL", "https://dash.cloudflare.com/oauth2/auth"
)
CF_OAUTH_TOKEN_URL = os.getenv(
    "CF_OAUTH_TOKEN_URL", "https://dash.cloudflare.com/oauth2/token"
)
CF_API_BASE = "https://api.cloudflare.com/client/v4"

# Frontend model ids (Sidebar MODELS) -> Workers AI / AI Gateway model ids.
CF_MODEL_MAP = {
    "gemma4:31b-cloud": os.getenv("CF_MODEL_LITE", "@cf/openai/gpt-oss-20b"),
    "nemotron-3-super:cloud": os.getenv(
        "CF_MODEL_PRO", "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b"
    ),
    "minimax-m3:cloud": os.getenv("CF_MODEL_MAX", "@cf/nvidia/nemotron-3-120b-a12b"),
}
CF_MODEL_DEFAULT = CF_MODEL_MAP.get("nemotron-3-super:cloud")

TOKEN_TTL = 60 * 60 * 24  # app session lifetime

_tokens: dict[str, dict] = {}
_cf_grants: dict[str, dict] = {}
_oauth_states: dict[str, float] = {}
_oauth_codes: dict[str, dict] = {}


def ollama_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {OLLAMA_API_KEY}"} if OLLAMA_API_KEY else {}


def resolve_model(name: str) -> str:
    return name


def _cf_configured() -> bool:
    return bool(CF_OAUTH_CLIENT_ID and CF_OAUTH_CLIENT_SECRET and CF_OAUTH_REDIRECT_URI)


app = FastAPI(title="Frio backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

class ChatMessage(BaseModel):
    role: str
    content: str
    images: list[str] | None = None


class ChatRequest(BaseModel):
    model: str
    messages: list[ChatMessage]
    think: bool = False
    options: dict[str, Any] | None = None


class OAuthExchangeRequest(BaseModel):
    code: str


def _issue_token(username: str) -> str:
    now = time.time()
    for t in [t for t, info in _tokens.items() if info["exp"] < now]:
        _tokens.pop(t, None)
    token = secrets.token_hex(32)
    _tokens[token] = {"exp": now + TOKEN_TTL, "username": username}
    return token


def require_auth(authorization: str | None = Header(default=None)) -> str:
    if not authorization:
        raise HTTPException(status_code=401, detail="Not authenticated")
    token = authorization.removeprefix("Bearer ").strip()
    info = _tokens.get(token)
    if info is None:
        raise HTTPException(status_code=401, detail="Invalid session")
    if info["exp"] < time.time():
        _tokens.pop(token, None)
        raise HTTPException(status_code=401, detail="Session expired")
    return info["username"]


# ---------------------------------------------------------------------------
# Cloudflare OAuth
# ---------------------------------------------------------------------------

@app.get("/api/auth/oauth/cloudflare/authorize")
async def cf_authorize() -> RedirectResponse:
    if not _cf_configured():
        raise HTTPException(
            status_code=400,
            detail="Cloudflare OAuth is not configured",
        )
    state = secrets.token_hex(16)
    _oauth_states[state] = time.time() + 600
    params = urlencode(
        {
            "response_type": "code",
            "client_id": CF_OAUTH_CLIENT_ID,
            "redirect_uri": CF_OAUTH_REDIRECT_URI,
            "scope": CF_OAUTH_SCOPES,
            "state": state,
        }
    )
    return RedirectResponse(f"{CF_OAUTH_AUTH_URL}?{params}")


@app.get("/api/auth/oauth/cloudflare/callback")
async def cf_callback(request: Request) -> RedirectResponse:
    params = request.query_params
    error = params.get("error")
    code = params.get("code")
    state = params.get("state", "")

    if error or not code:
        _oauth_states.pop(state, None)
        print(f"CF OAuth denied: error={error!r} code={bool(code)} state={state}", flush=True)
        return RedirectResponse(f"/?oauth=error&e={error or 'no_code'}")
    if state not in _oauth_states:
        print(f"CF OAuth bad state: {state!r}", flush=True)
        return RedirectResponse("/?oauth=error&e=bad_state")
    _oauth_states.pop(state, None)
    try:
        async with httpx.AsyncClient() as client:
            token_res = await client.post(
                CF_OAUTH_TOKEN_URL,
                data={
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": CF_OAUTH_REDIRECT_URI,
                },
                auth=(CF_OAUTH_CLIENT_ID, CF_OAUTH_CLIENT_SECRET),
            )
            if token_res.status_code != 200:
                return RedirectResponse("/?oauth=error")
            tok = token_res.json()
            access = tok["access_token"]
            refresh = tok.get("refresh_token", "")
            expires_in = int(tok.get("expires_in", 3600))

            ui = await client.get(
                "https://dash.cloudflare.com/oauth2/userinfo",
                headers={"Authorization": f"Bearer {access}"},
            )
            ui_data = ui.json() if ui.status_code == 200 else {}
            email = ui_data.get("email")
            sub = ui_data.get("sub")

            acc = await client.get(
                f"{CF_API_BASE}/accounts",
                headers={"Authorization": f"Bearer {access}"},
            )
            account_id = None
            if acc.status_code == 200:
                result = (acc.json().get("result") or [])
                if result:
                    account_id = result[0].get("id")
            if not account_id:
                account_id = CF_ACCOUNT_ID or None

        if email:
            username = email
        elif sub:
            username = f"cf-{sub}"
        elif account_id:
            username = f"cf-{account_id}"
        else:
            username = f"cf-{secrets.token_hex(4)}"

        _cf_grants[username] = {
            "access_token": access,
            "refresh_token": refresh,
            "account_id": account_id,
            "exp": time.time() + max(expires_in - 60, 60),
        }
        app_token = _issue_token(username)
        one_time = secrets.token_urlsafe(16)
        _oauth_codes[one_time] = {
            "token": app_token,
            "username": username,
            "exp": time.time() + 120,
        }
        return RedirectResponse(f"/?oauth=1&code={one_time}")
    except Exception:
        return RedirectResponse("/?oauth=error")


@app.post("/api/auth/oauth/exchange")
async def oauth_exchange(req: OAuthExchangeRequest) -> dict:
    info = _oauth_codes.pop(req.code, None)
    if info is None or info["exp"] < time.time():
        raise HTTPException(status_code=400, detail="Invalid or expired OAuth code")
    return {"token": info["token"], "username": info["username"]}


@app.post("/api/auth/logout")
def logout(authorization: str | None = Header(default=None)) -> dict:
    if authorization:
        _tokens.pop(authorization.removeprefix("Bearer ").strip(), None)
    return {"ok": True}


@app.get("/api/auth/me")
def me(username: str = Depends(require_auth)) -> dict:
    return {"username": username}


@app.get("/api/auth/check")
def check_auth(_: str = Depends(require_auth)) -> dict:
    return {"ok": True}


# ---------------------------------------------------------------------------
# Workers AI helpers
# ---------------------------------------------------------------------------

async def _cf_access_token(username: str) -> str | None:
    grant = _cf_grants.get(username)
    if not grant or not grant.get("account_id"):
        return None
    if grant["exp"] > time.time():
        return grant["access_token"]
    if not grant.get("refresh_token"):
        return None
    try:
        async with httpx.AsyncClient() as client:
            res = await client.post(
                CF_OAUTH_TOKEN_URL,
                data={
                    "grant_type": "refresh_token",
                    "refresh_token": grant["refresh_token"],
                },
                auth=(CF_OAUTH_CLIENT_ID, CF_OAUTH_CLIENT_SECRET),
            )
            if res.status_code != 200:
                _cf_grants.pop(username, None)
                return None
            tok = res.json()
        grant["access_token"] = tok["access_token"]
        if tok.get("refresh_token"):
            grant["refresh_token"] = tok["refresh_token"]
        grant["exp"] = time.time() + max(int(tok.get("expires_in", 3600)) - 60, 60)
        return grant["access_token"]
    except Exception:
        return None


def _to_openai_messages(messages: list[ChatMessage]) -> list[dict]:
    out: list[dict] = []
    for m in messages:
        if m.images:
            content: list[dict] = [{"type": "text", "text": m.content or ""}]
            for img in m.images:
                data_url = img if img.startswith("data:") else f"data:image/jpeg;base64,{img}"
                content.append({"type": "image_url", "image_url": {"url": data_url}})
            out.append({"role": m.role, "content": content})
        else:
            out.append({"role": m.role, "content": m.content})
    return out


def sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def _chat_workers_ai(req: ChatRequest, username: str) -> StreamingResponse:
    grant = _cf_grants.get(username)
    account_id = grant["account_id"]
    access = grant["access_token"]
    model = CF_MODEL_MAP.get(req.model) or CF_MODEL_DEFAULT
    payload = {
        "model": model,
        "messages": _to_openai_messages(req.messages),
        "stream": True,
    }
    url = f"{CF_API_BASE}/accounts/{account_id}/ai/v1/chat/completions"
    headers = {"Authorization": f"Bearer {access}", "Content-Type": "application/json"}

    async def event_stream():
        async with httpx.AsyncClient(timeout=None, headers=headers) as client:
            async with client.stream("POST", url, json=payload) as upstream:
                if upstream.status_code != 200:
                    body = (await upstream.aread()).decode("utf-8", errors="replace")
                    yield sse(
                        {"error": body[:400] or f"Workers AI error {upstream.status_code}"}
                    )
                    return
                async for line in upstream.aiter_lines():
                    line = line.strip()
                    if not line:
                        continue
                    if line.startswith("data:"):
                        line = line[5:].strip()
                    if line == "[DONE]":
                        yield sse({"done": True, "provider": "cloudflare"})
                        return
                    try:
                        chunk = json.loads(line)
                    except Exception:
                        continue
                    choice = (chunk.get("choices") or [{}])[0]
                    delta = choice.get("delta") or {}
                    text = delta.get("content") or (choice.get("message") or {}).get("content")
                    if text:
                        yield sse({"content": text})
                    if chunk.get("done") or choice.get("finish_reason") or chunk.get("stop_reason"):
                        yield sse({"done": True, "provider": "cloudflare"})
                        return
        yield sse({"done": True, "provider": "cloudflare"})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _chat_ollama(req: ChatRequest) -> StreamingResponse:
    payload = {
        "model": resolve_model(req.model),
        "messages": [m.model_dump(exclude_none=True) for m in req.messages],
        "stream": True,
        "think": req.think,
        "keep_alive": "30m",
    }
    if req.options:
        payload["options"] = req.options

    async def event_stream():
        async with httpx.AsyncClient(timeout=None, headers=ollama_headers()) as client:
            async with client.stream(
                "POST", f"{OLLAMA_URL}/api/chat", json=payload
            ) as upstream:
                if upstream.status_code != 200:
                    body = (await upstream.aread()).decode("utf-8", errors="replace")
                    yield sse({"error": body[:400] or f"Ollama error {upstream.status_code}"})
                    return
                async for line in upstream.aiter_lines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        chunk = json.loads(line)
                    except Exception:
                        continue
                    message = chunk.get("message") or {}
                    content = message.get("content")
                    if content:
                        yield sse({"content": content})
                    thinking = message.get("thinking")
                    if thinking:
                        yield sse({"thinking": thinking})
                    if chunk.get("done"):
                        yield sse({"done": True, "provider": "ollama"})
                        return

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# Public / app endpoints
# ---------------------------------------------------------------------------

@app.get("/api/health")
async def health() -> dict:
    try:
        async with httpx.AsyncClient(timeout=5, headers=ollama_headers()) as client:
            r = await client.get(f"{OLLAMA_URL}/api/version")
            if r.status_code == 200:
                return {"ok": True, "ollama": True, "cf": _cf_configured()}
            if OLLAMA_API_KEY:
                r2 = await client.get(f"{OLLAMA_URL}/api/tags")
                return {"ok": True, "ollama": r2.status_code == 200, "cf": _cf_configured()}
            return {"ok": True, "ollama": False, "cf": _cf_configured()}
    except Exception:
        return {"ok": True, "ollama": False, "cf": _cf_configured()}


@app.get("/api/models")
async def models(username: str = Depends(require_auth)) -> dict:
    if await _cf_access_token(username) and _cf_grants.get(username, {}).get("account_id"):
        return {
            "models": [
                {"name": name, "model": name, "provider": "workers-ai"}
                for name in CF_MODEL_MAP
            ]
        }
    try:
        async with httpx.AsyncClient(timeout=10, headers=ollama_headers()) as client:
            r = await client.get(f"{OLLAMA_URL}/api/tags")
            r.raise_for_status()
            data = r.json()
            return {"models": data.get("models", [])}
    except Exception:
        return {"models": []}


@app.post("/api/chat")
async def chat(
    req: ChatRequest, username: str = Depends(require_auth)
) -> StreamingResponse:
    has_images = any(m.images for m in req.messages)
    if not has_images and await _cf_access_token(username):
        return await _chat_workers_ai(req, username)
    return _chat_ollama(req)


DIST_DIR = Path(__file__).resolve().parent.parent / "dist"
if DIST_DIR.is_dir():
    from fastapi.responses import FileResponse
    from fastapi.staticfiles import StaticFiles

    app.mount(
        "/assets",
        StaticFiles(directory=DIST_DIR / "assets"),
        name="assets",
    )

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str) -> FileResponse:
        target = (DIST_DIR / path).resolve()
        if (
            path
            and target.is_file()
            and target.is_relative_to(DIST_DIR.resolve())
        ):
            return FileResponse(target)
        return FileResponse(DIST_DIR / "index.html")


if __name__ == "__main__":
    import uvicorn

    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "8000"))
    reload = os.getenv("FRIO_RELOAD", "0") == "1"
    uvicorn.run("main:app", host=host, port=port, reload=reload)
