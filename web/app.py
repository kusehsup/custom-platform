import sys
import asyncio
import logging

logging.basicConfig(
    level=logging.WARNING,
    format='%(asctime)s [%(name)s] %(levelname)s: %(message)s'
)

if sys.platform == 'win32':
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from pathlib import Path

from .api.routes import router
from .api.db_routes import router as db_router
from .api.totp_routes import router as totp_router
from .api.github_routes import router as github_router
from .api.claude_cli_routes import router as claude_router
from .api.tasks_routes import router as tasks_router
from .api.external_commands_routes import router as external_cmd_router

app = FastAPI(title='CustomPlatform')
app.include_router(router)
app.include_router(db_router)
app.include_router(totp_router)
app.include_router(github_router)
app.include_router(claude_router)
app.include_router(tasks_router)
app.include_router(external_cmd_router)


class NoCacheAPIMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        if request.url.path.startswith('/api/'):
            response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate'
            response.headers['Pragma'] = 'no-cache'
        return response

app.add_middleware(NoCacheAPIMiddleware)


@app.exception_handler(ConnectionError)
async def connection_error_handler(request: Request, exc: ConnectionError):
    return JSONResponse(status_code=503, content={'detail': str(exc)})

static_dir = Path(__file__).parent / 'static'
app.mount('/static', StaticFiles(directory=static_dir), name='static')


# ── PWA: SW и manifest с корня, чтобы scope покрывал всё приложение ──

@app.get('/service-worker.js')
async def service_worker():
    # MIME важно: application/javascript, иначе браузер не зарегистрирует
    return FileResponse(
        static_dir / 'service-worker.js',
        media_type='application/javascript',
        headers={
            'Service-Worker-Allowed': '/',
            'Cache-Control': 'no-cache',
        },
    )


@app.get('/manifest.webmanifest')
async def manifest():
    return FileResponse(
        static_dir / 'manifest.webmanifest',
        media_type='application/manifest+json',
    )


@app.get('/{full_path:path}')
async def serve_spa(full_path: str):
    return FileResponse(static_dir / 'index.html')
