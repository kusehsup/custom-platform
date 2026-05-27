import sys
import asyncio
import logging

logging.basicConfig(
    level=logging.WARNING,
    format='%(asctime)s [%(name)s] %(levelname)s: %(message)s'
)
logging.getLogger('platform.client').setLevel(logging.DEBUG)

if sys.platform == 'win32':
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pathlib import Path

from .api.routes import router

app = FastAPI(title='CustomPlatform')
app.include_router(router)


@app.exception_handler(ConnectionError)
async def connection_error_handler(request: Request, exc: ConnectionError):
    return JSONResponse(status_code=503, content={'detail': str(exc)})

static_dir = Path(__file__).parent / 'static'
app.mount('/static', StaticFiles(directory=static_dir), name='static')


@app.get('/{full_path:path}')
async def serve_spa(full_path: str):
    return FileResponse(static_dir / 'index.html')
