import asyncio
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
    search: bool = True
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


def _delta_reasoning(delta: dict) -> str:
    parts: list[str] = []
    rc = delta.get("reasoning_content")
    if isinstance(rc, str):
        parts.append(rc)
    r = delta.get("reasoning")
    if isinstance(r, str):
        parts.append(r)
    elif isinstance(r, list):
        for item in r:
            if isinstance(item, dict):
                t = item.get("text") or item.get("content")
                if isinstance(t, str):
                    parts.append(t)
    return "".join(parts)


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


# ---------------------------------------------------------------------------
# Web search (DuckDuckGo) — the model decides whether a query needs it
# ---------------------------------------------------------------------------

SEARCH_CLASSIFIER_MODEL = os.getenv("CF_SEARCH_MODEL", "gemma4:31b-cloud")
SEARCH_CLASSIFIER_PROMPT = (
    "You are a decision engine. Given a user message, decide whether answering it "
    "requires a live web search for up-to-date information (current events, news, live "
    "prices, weather, sports scores, recent releases, facts that change over time). "
    "If general knowledge is enough, do not search.\n"
    'Respond ONLY with a single JSON object, no markdown and no code fences: '
    '{"search": true, "query": "the most effective search query"} or '
    '{"search": false, "query": ""}\n\n'
    "User message: {text}"
)


def _extract_json(text: str) -> Any:
    if not text:
        return None
    text = text.strip()
    if text.startswith("```"):
        first = text.find("\n")
        if first >= 0:
            text = text[first + 1 :]
        text = text.rsplit("```", 1)[0].strip()
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        return json.loads(text[start : end + 1])
    except Exception:
        return None


def _search_decision(content: str, fallback_query: str) -> tuple[bool, str]:
    obj = _extract_json(content)
    if not isinstance(obj, dict):
        return False, ""
    search = obj.get("search") in (True, "true", "True", "yes", "1")
    query = str(obj.get("query") or "").strip()[:300]
    return search, query or fallback_query[:300]


async def _cf_classify_search(access: str, account_id: str, text: str) -> tuple[bool, str]:
    url = f"{CF_API_BASE}/accounts/{account_id}/ai/v1/chat/completions"
    model = CF_MODEL_MAP.get(SEARCH_CLASSIFIER_MODEL) or SEARCH_CLASSIFIER_MODEL
    payload = {
        "model": model,
        "messages": [
            {"role": "user", "content": SEARCH_CLASSIFIER_PROMPT.format(text=text[:2000])}
        ],
        "stream": False,
        "temperature": 0,
        "max_tokens": 512,
    }
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            res = await client.post(
                url, json=payload, headers={"Authorization": f"Bearer {access}"}
            )
            if res.status_code != 200:
                return False, ""
            data = res.json()
        content = ((data.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
        return _search_decision(content, text)
    except Exception:
        return False, ""


async def _ollama_classify_search(model: str, text: str) -> tuple[bool, str]:
    payload = {
        "model": model,
        "messages": [
            {"role": "user", "content": SEARCH_CLASSIFIER_PROMPT.format(text=text[:2000])}
        ],
        "stream": False,
        "options": {"temperature": 0},
    }
    try:
        async with httpx.AsyncClient(timeout=60, headers=ollama_headers()) as client:
            res = await client.post(f"{OLLAMA_URL}/api/chat", json=payload)
            if res.status_code != 200:
                return False, ""
            data = res.json()
        content = (data.get("message") or {}).get("content") or ""
        return _search_decision(content, text)
    except Exception:
        return False, ""


async def _classify_search(username: str, text: str) -> tuple[bool, str]:
    access = await _cf_access_token(username)
    account_id = _cf_grants.get(username, {}).get("account_id") if access else None
    if access and account_id:
        return await _cf_classify_search(access, account_id, text)
    return await _ollama_classify_search(resolve_model(SEARCH_CLASSIFIER_MODEL), text)


def _ddg_search(query: str, max_results: int = 5) -> list[dict]:
    try:
        from ddgs import DDGS

        results = DDGS().text(query, max_results=max_results)
    except Exception:
        return []
    out: list[dict] = []
    for r in results or []:
        title = str(r.get("title") or "").strip()
        url = str(r.get("href") or "").strip()
        snippet = str(r.get("body") or "").strip()
        if title and url:
            out.append({"title": title, "url": url, "snippet": snippet[:300]})
    return out


async def _maybe_web_search(req: ChatRequest, username: str) -> tuple[str | None, list[dict]]:
    if not req.search or any(m.images for m in req.messages):
        return None, []
    last_user = next((m.content for m in reversed(req.messages) if m.role == "user"), "")
    if not last_user:
        return None, []
    try:
        needs, query = await _classify_search(username, last_user)
    except Exception:
        return None, []
    if not needs or not query:
        return None, []
    try:
        results = await asyncio.to_thread(_ddg_search, query)
    except Exception:
        return None, []
    if not results:
        return None, []
    lines = [
        "Web search results for the user's question. Use them to answer accurately, "
        "citing sources inline as markdown links like [1](https://example.com). "
        "If the results do not contain the answer, say so rather than guessing.",
        "",
    ]
    for i, r in enumerate(results, 1):
        lines.append(f"[{i}] {r['title']}")
        lines.append(r["url"])
        if r["snippet"]:
            lines.append(r["snippet"])
        lines.append("")
    return "\n".join(lines), results


def sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def _chat_workers_ai(
    req: ChatRequest,
    username: str,
    search_context: str | None = None,
    sources: list[dict] | None = None,
) -> StreamingResponse:
    grant = _cf_grants.get(username)
    account_id = grant["account_id"]
    access = grant["access_token"]
    model = CF_MODEL_MAP.get(req.model) or CF_MODEL_DEFAULT
    messages = _to_openai_messages(req.messages)
    if search_context:
        messages = [{"role": "system", "content": search_context}] + messages
    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
    }
    url = f"{CF_API_BASE}/accounts/{account_id}/ai/v1/chat/completions"
    headers = {"Authorization": f"Bearer {access}", "Content-Type": "application/json"}

    async def event_stream():
        if sources:
            yield sse({"sources": sources})
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
                    reasoning = _delta_reasoning(delta)
                    if reasoning and req.think:
                        yield sse({"thinking": reasoning})
                    if chunk.get("done") or choice.get("finish_reason") or chunk.get("stop_reason"):
                        yield sse({"done": True, "provider": "cloudflare"})
                        return
        yield sse({"done": True, "provider": "cloudflare"})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _chat_ollama(
    req: ChatRequest,
    search_context: str | None = None,
    sources: list[dict] | None = None,
) -> StreamingResponse:
    messages = [m.model_dump(exclude_none=True) for m in req.messages]
    if search_context:
        messages = [{"role": "system", "content": search_context}] + messages
    payload = {
        "model": resolve_model(req.model),
        "messages": messages,
        "stream": True,
        "think": req.think,
        "keep_alive": "30m",
    }
    if req.options:
        payload["options"] = req.options

    async def event_stream():
        if sources:
            yield sse({"sources": sources})
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
    search_context, sources = await _maybe_web_search(req, username)
    if not has_images and await _cf_access_token(username):
        return await _chat_workers_ai(req, username, search_context, sources)
    return _chat_ollama(req, search_context, sources)


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
