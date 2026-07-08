# AGENTS.md

## Cursor Cloud specific instructions

CustomPlatform is a single Python product: a FastAPI web app (PWA, UI in Russian) that
acts as a client/proxy to an external SA-MP "web platform" over WebSocket, plus an
optional Telegram bot. There is no local database, no build step (frontend is static
files in `web/static/`), and no test/lint tooling in the repo.

### Services

- **Web app (required)**: `.venv/bin/uvicorn web.app:app --host 127.0.0.1 --port 8002 --reload`
  - ASGI app is `web.app:app`. Serves the PWA and all `/api/*` routes.
  - App state is persisted as JSON files written next to `web/` (e.g. `web/notes.json`,
    `web/tasks.json`, `web/totp.json`) at runtime; these are gitignored.
- **Telegram bot (optional)**: `.venv/bin/python -m bot.main` — needs a real `BOT_TOKEN`
  in `.env`, otherwise it starts and then crashes.

### Environment / caveats

- Python 3.12 with a `.venv`. `python3.12-venv` is a system package required to create
  the venv (installed via apt; not part of the update script).
- Copy `.env.example` to `.env` before running. The update script does this only if
  `.env` is missing. Placeholder values are enough to boot the web app.
- **Core SA-MP features (login, code browse/edit, compile, server start/stop) require a
  reachable external platform via `PLATFORM_URL`.** Without it, `/api/login` returns 502
  and those features cannot be exercised. The web server itself boots fine standalone.
- **Local, platform-independent features** that CAN be tested without the external
  platform: notes (`/api/notes`), tasks (`/api/tasks`), and public note pages (`/n/{token}`,
  `/api/public/notes/{token}`). These are gated by a JWT bearer token.
- Auth uses a hardcoded `SECRET_KEY` in `web/api/auth.py`, so a valid token for local
  testing can be minted with:
  `.venv/bin/python -c "from web.api.auth import create_token; print(create_token('devuser'))"`
- The DB browser feature (`/api/db/*`) has hardcoded remote credentials and requires a
  SOCKS5 proxy (Xray on `127.0.0.1:10808`); not needed for general dev.
- `deploy/setup.sh` is a production server installer (systemd + nginx + certbot + xray).
  Do not run it for local dev.
