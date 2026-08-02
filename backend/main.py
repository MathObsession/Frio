import hashlib
import json
import os
import secrets
import time
from pathlib import Path
from typing import Any

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
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

OLLAMA_API_KEY = os.getenv("OLLAMA_API_KEY", "")
if os.getenv("OLLAMA_URL"):
    OLLAMA_URL = os.getenv("OLLAMA_URL", "")
else:
    OLLAMA_URL = "https://ollama.com" if OLLAMA_API_KEY else "http://localhost:11434"
AUTH_USERNAME = os.getenv("AUTH_USERNAME", "frio")
AUTH_PASSWORD = os.getenv("AUTH_PASSWORD", "frio")
TOKEN_TTL = 60 * 60 * 24
USERS_FILE = Path(__file__).parent / "users.json"

_tokens: dict[str, dict] = {}


def ollama_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {OLLAMA_API_KEY}"} if OLLAMA_API_KEY else {}


def resolve_model(name: str) -> str:
    if not OLLAMA_API_KEY:
        return name
    if name.endswith(":cloud"):
        return name[: -len(":cloud")]
    if name.endswith("-cloud"):
        return name[: -len("-cloud")]
    return name

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


class LoginRequest(BaseModel):
    username: str
    password: str


class RegisterRequest(BaseModel):
    username: str
    password: str


def _make_record(password: str) -> str:
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac(
        "sha256", password.encode(), bytes.fromhex(salt), 100_000
    )
    return f"{salt}${dk.hex()}"


def _verify(password: str, record: str) -> bool:
    try:
        salt, expected = record.split("$", 1)
        dk = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), bytes.fromhex(salt), 100_000
        )
        return secrets.compare_digest(dk.hex(), expected)
    except Exception:
        return False


def load_users() -> dict[str, str]:
    try:
        if USERS_FILE.exists():
            data = json.loads(USERS_FILE.read_text())
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {}


def save_users(users: dict[str, str]) -> None:
    USERS_FILE.write_text(json.dumps(users, indent=2))


def ensure_admin() -> None:
    users = load_users()
    if AUTH_USERNAME and AUTH_USERNAME not in users:
        users[AUTH_USERNAME] = _make_record(AUTH_PASSWORD)
        save_users(users)


ensure_admin()


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


@app.post("/api/auth/login")
def login(req: LoginRequest) -> dict:
    users = load_users()
    record = users.get(req.username.strip())
    if record is None or not _verify(req.password, record):
        raise HTTPException(status_code=401, detail="Invalid username or password")
    return {"token": _issue_token(req.username)}


@app.post("/api/auth/register")
def register(req: RegisterRequest) -> dict:
    username = req.username.strip()
    password = req.password
    if not (3 <= len(username) <= 32):
        raise HTTPException(status_code=400, detail="Username must be 3-32 characters")
    if len(password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    users = load_users()
    if username in users:
        raise HTTPException(status_code=400, detail="Username already taken")
    users[username] = _make_record(password)
    save_users(users)
    return {"token": _issue_token(username)}


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


def sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


@app.get("/api/health")
async def health() -> dict:
    try:
        async with httpx.AsyncClient(timeout=5, headers=ollama_headers()) as client:
            r = await client.get(f"{OLLAMA_URL}/api/version")
            if r.status_code == 200:
                return {"ok": True, "ollama": True}
            if OLLAMA_API_KEY:
                r2 = await client.get(f"{OLLAMA_URL}/api/tags")
                return {"ok": True, "ollama": r2.status_code == 200}
            return {"ok": True, "ollama": False}
    except Exception:
        return {"ok": True, "ollama": False}


@app.get("/api/models")
async def models(_: str = Depends(require_auth)) -> dict:
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
    req: ChatRequest, _: str = Depends(require_auth)
) -> StreamingResponse:
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
                        yield sse({"done": True})
                        return

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


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
