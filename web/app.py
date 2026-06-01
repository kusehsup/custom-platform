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

app = FastAPI(title='CustomPlatform')
app.include_router(router)
app.include_router(db_router)
app.include_router(totp_router)


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


@app.get('/{full_path:path}')
async def serve_spa(full_path: str):
    return FileResponse(static_dir / 'index.html')
