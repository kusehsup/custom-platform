import base64
import io
import time
from collections import defaultdict

import pyotp
import qrcode
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from .auth import get_current_user
from . import totp_store

router = APIRouter(prefix='/api/totp', tags=['totp'])

# ------------------------------------------------------------------ #
#  Rate limiter для /api/login                                        #
# ------------------------------------------------------------------ #

_login_attempts: dict[str, list[float]] = defaultdict(list)
RATE_WINDOW   = 60    # секунд
RATE_MAX      = 10    # попыток за окно


def check_rate_limit(ip: str):
    now = time.time()
    attempts = [t for t in _login_attempts[ip] if now - t < RATE_WINDOW]
    attempts.append(now)
    _login_attempts[ip] = attempts
    if len(attempts) > RATE_MAX:
        raise HTTPException(
            status_code=429,
            detail=f'Слишком много попыток. Подождите {RATE_WINDOW} секунд.'
        )


def reset_rate_limit(ip: str):
    _login_attempts.pop(ip, None)


# ------------------------------------------------------------------ #
#  Схемы                                                              #
# ------------------------------------------------------------------ #

class VerifyRequest(BaseModel):
    code: str


class EnableRequest(BaseModel):
    code: str


# ------------------------------------------------------------------ #
#  Эндпоинты                                                          #
# ------------------------------------------------------------------ #

@router.get('/status')
async def totp_status(login: str = Depends(get_current_user)):
    return {
        'enabled': totp_store.is_enabled(),
        'has_secret': totp_store.get_secret() is not None,
    }


@router.post('/setup')
async def totp_setup(login: str = Depends(get_current_user)):
    """Генерируем новый секрет и возвращаем QR-код."""
    secret = pyotp.random_base32()
    totp_store.setup(secret)

    uri = pyotp.totp.TOTP(secret).provisioning_uri(
        name=login,
        issuer_name='CustomPlatform'
    )
    # Генерируем QR как base64 PNG
    img = qrcode.make(uri)
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    qr_b64 = base64.b64encode(buf.getvalue()).decode()

    return {
        'secret': secret,
        'qr': f'data:image/png;base64,{qr_b64}',
        'uri': uri,
    }


@router.post('/enable')
async def totp_enable(body: EnableRequest, login: str = Depends(get_current_user)):
    """Включаем TOTP после того как пользователь подтвердил код."""
    secret = totp_store.get_secret()
    if not secret:
        raise HTTPException(status_code=400, detail='Сначала выполните настройку')
    totp = pyotp.TOTP(secret)
    if not totp.verify(body.code, valid_window=1):
        raise HTTPException(status_code=400, detail='Неверный код')
    totp_store.enable()
    return {'ok': True}


@router.post('/disable')
async def totp_disable(body: VerifyRequest, login: str = Depends(get_current_user)):
    """Отключаем TOTP — нужен действующий код для подтверждения."""
    secret = totp_store.get_secret()
    if not secret:
        raise HTTPException(status_code=400, detail='TOTP не настроен')
    totp = pyotp.TOTP(secret)
    if not totp.verify(body.code, valid_window=1):
        raise HTTPException(status_code=400, detail='Неверный код')
    totp_store.disable()
    return {'ok': True}


@router.post('/verify')
async def totp_verify(body: VerifyRequest):
    """Проверка кода при логине (до выдачи JWT)."""
    secret = totp_store.get_secret()
    if not secret:
        raise HTTPException(status_code=400, detail='TOTP не настроен')
    totp = pyotp.TOTP(secret)
    if not totp.verify(body.code, valid_window=1):
        raise HTTPException(status_code=401, detail='Неверный код аутентификатора')
    return {'ok': True}
