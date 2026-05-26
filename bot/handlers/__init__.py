from aiogram import Router
from . import auth, server, compile, console

router = Router()
router.include_router(auth.router)
router.include_router(server.router)
router.include_router(compile.router)
router.include_router(console.router)
