"""
Аварийная админка xray.

Эта ручка нужна когда основной WS-коннект к SA-MP-платформе лежит
из-за того что xray-туннель не работает — а значит в платформу
невозможно войти (логин валидируется удалённой платформой).

Доступ — по pin-коду, который сгенерирован setup.sh и лежит в
/etc/custom-platform/xray_pin. Без auth. Внутри платформы те же
действия доступны авторизованному юзеру без пина.

Эндпоинты:
  POST /api/xray/setup/status   — статус xray (active/inactive + outbound info)
  POST /api/xray/setup/apply    — записать новый /etc/xray/config.json из vless://
  POST /api/xray/setup/start    — systemctl start xray
  POST /api/xray/setup/stop     — systemctl stop xray

Все четыре требуют поля `pin` в body. Авторизованные аналоги без
пина (для UI внутри платформы) — в конце файла.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse, parse_qs, unquote

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .auth import get_current_user

router = APIRouter()

PIN_PATH = Path('/etc/custom-platform/xray_pin')
PROFILES_PATH = Path('/etc/custom-platform/xray_profiles.json')
XRAY_CONFIG = Path('/etc/xray/config.json')

VALID_SLOTS = ('primary', 'backup', 'custom')


# ── Helpers ──────────────────────────────────────────────────────────

def _load_pin() -> Optional[str]:
    try:
        return PIN_PATH.read_text(encoding='utf-8').strip() or None
    except Exception:
        return None


def _check_pin(pin: str):
    actual = _load_pin()
    if not actual:
        raise HTTPException(
            status_code=503,
            detail='PIN не настроен на сервере (см. /etc/custom-platform/xray_pin)',
        )
    if not pin or pin.strip() != actual:
        raise HTTPException(status_code=401, detail='Неверный PIN')


def _vless_to_config(url: str) -> dict:
    url = (url or '').strip()
    if not url.startswith('vless://'):
        raise HTTPException(status_code=400, detail='Ссылка должна начинаться с vless://')

    parsed = urlparse(url)
    uuid = parsed.username or ''
    host = parsed.hostname or ''
    port = parsed.port or 443
    qs = parse_qs(parsed.query)

    def q(key: str, default: str = '') -> str:
        v = qs.get(key, [default])
        return v[0] if v else default

    if not uuid or not host:
        raise HTTPException(status_code=400, detail='В vless:// не найден uuid или host')

    security = q('security', 'reality')
    sni = q('sni') or q('host') or ''
    pbk = q('pbk', '')
    sid = q('sid', '')
    fp = q('fp', 'chrome')
    flow = q('flow', '')
    spx = unquote(q('spx', '/'))
    net = q('type', 'tcp')

    user = {'id': uuid, 'encryption': 'none'}
    if flow:
        user['flow'] = flow

    outbound: dict = {
        'protocol': 'vless',
        'settings': {
            'vnext': [{
                'address': host,
                'port': int(port),
                'users': [user],
            }],
        },
        'streamSettings': {
            'network': net,
            'security': security,
        },
    }

    if security == 'reality':
        outbound['streamSettings']['realitySettings'] = {
            'serverName': sni or 'google.com',
            'fingerprint': fp,
            'publicKey': pbk,
            'shortId': sid,
            'spiderX': spx,
        }
    elif security == 'tls':
        outbound['streamSettings']['tlsSettings'] = {
            'serverName': sni,
            'fingerprint': fp,
        }

    return {
        'log': {'loglevel': 'warning'},
        'inbounds': [{
            'port': 10808,
            'protocol': 'socks',
            'settings': {'auth': 'noauth', 'udp': True},
        }],
        'outbounds': [outbound],
    }


async def _systemctl(action: str) -> tuple[int, str]:
    """systemctl <action> xray — возвращает (returncode, combined output)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            'systemctl', action, 'xray',
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=15)
        return proc.returncode or 0, out.decode('utf-8', errors='replace')
    except asyncio.TimeoutError:
        return 1, 'systemctl timeout'
    except Exception as e:
        return 1, f'systemctl failed: {e}'


async def _xray_status_dict() -> dict:
    """Что показывать пользователю про xray. Не светит uuid/key — только хост."""
    active = False
    try:
        proc = await asyncio.create_subprocess_exec(
            'systemctl', 'is-active', 'xray',
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        active = out.decode().strip() == 'active'
    except Exception:
        pass

    outbound_host = None
    outbound_port = None
    outbound_security = None
    try:
        cfg = json.loads(XRAY_CONFIG.read_text(encoding='utf-8'))
        ob = (cfg.get('outbounds') or [None])[0] or {}
        vnext = (((ob.get('settings') or {}).get('vnext')) or [None])[0] or {}
        outbound_host = vnext.get('address')
        outbound_port = vnext.get('port')
        outbound_security = ((ob.get('streamSettings') or {}).get('security'))
    except FileNotFoundError:
        pass
    except Exception:
        pass

    return {
        'active': active,
        'config_exists': XRAY_CONFIG.exists(),
        'outbound_host': outbound_host,
        'outbound_port': outbound_port,
        'outbound_security': outbound_security,
        'profiles': _profiles_public(_profiles_read()),
    }


def _write_config(cfg: dict):
    XRAY_CONFIG.parent.mkdir(parents=True, exist_ok=True)
    XRAY_CONFIG.write_text(json.dumps(cfg, indent=2), encoding='utf-8')


# ── Profiles store ──────────────────────────────────────────────────

def _profiles_read() -> dict:
    """Загружает все слоты + active. Если файла нет — пустые слоты."""
    try:
        data = json.loads(PROFILES_PATH.read_text(encoding='utf-8'))
    except Exception:
        data = {}
    if not isinstance(data, dict):
        data = {}
    result = {slot: str(data.get(slot) or '') for slot in VALID_SLOTS}
    result['active'] = data.get('active') if data.get('active') in VALID_SLOTS else None
    return result


def _profiles_write(profiles: dict):
    PROFILES_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {slot: (profiles.get(slot) or '') for slot in VALID_SLOTS}
    payload['active'] = profiles.get('active') if profiles.get('active') in VALID_SLOTS else None
    PROFILES_PATH.write_text(json.dumps(payload, indent=2), encoding='utf-8')
    try:
        PROFILES_PATH.chmod(0o600)
    except Exception:
        pass


def _profiles_public(profiles: dict) -> dict:
    """То что отдаём в UI — без UUID/private-полей. Только host+port+security."""
    out = {'active': profiles.get('active'), 'slots': {}}
    for slot in VALID_SLOTS:
        url = profiles.get(slot) or ''
        info = {'configured': False, 'host': None, 'port': None, 'security': None}
        if url:
            info['configured'] = True
            try:
                parsed = urlparse(url)
                info['host'] = parsed.hostname
                info['port'] = parsed.port
                info['security'] = parse_qs(parsed.query).get('security', ['reality'])[0]
            except Exception:
                pass
        out['slots'][slot] = info
    return out


async def _activate_slot(slot: str) -> dict:
    """Записывает в /etc/xray/config.json профиль слота и рестартит xray."""
    if slot not in VALID_SLOTS:
        raise HTTPException(status_code=400, detail='Слот должен быть primary или backup')
    profiles = _profiles_read()
    url = profiles.get(slot)
    if not url:
        raise HTTPException(status_code=400, detail=f'Слот {slot} не настроен')
    cfg = _vless_to_config(url)
    _write_config(cfg)
    profiles['active'] = slot
    _profiles_write(profiles)
    code, output = await _systemctl('restart')
    if code != 0:
        raise HTTPException(status_code=500,
                            detail=f'Конфиг записан, но systemctl restart упал: {output}')
    await asyncio.sleep(1)
    return await _xray_status_dict()


# ── Schemas ──────────────────────────────────────────────────────────

class PinBody(BaseModel):
    pin: str


class ApplyBody(BaseModel):
    pin: str
    vless: str


class ApplyAuthBody(BaseModel):
    vless: str


class SaveProfileBody(BaseModel):
    pin: str
    slot: str   # 'primary' | 'backup'
    vless: str


class SaveProfileAuthBody(BaseModel):
    slot: str
    vless: str


class ActivateBody(BaseModel):
    pin: str
    slot: str


class ActivateAuthBody(BaseModel):
    slot: str


class SlotPinBody(BaseModel):
    pin: str
    slot: str


class SlotAuthBody(BaseModel):
    slot: str


# ── Endpoints с PIN (без auth) ──────────────────────────────────────

@router.post('/api/xray/setup/status')
async def setup_status(body: PinBody):
    _check_pin(body.pin)
    return await _xray_status_dict()


@router.post('/api/xray/setup/apply')
async def setup_apply(body: ApplyBody):
    _check_pin(body.pin)
    cfg = _vless_to_config(body.vless)
    _write_config(cfg)
    code, output = await _systemctl('restart')
    if code != 0:
        raise HTTPException(status_code=500,
                            detail=f'Конфиг записан, но systemctl restart упал: {output}')
    # Даём xray секунду подняться и снова забираем статус
    await asyncio.sleep(1)
    return await _xray_status_dict()


@router.post('/api/xray/setup/start')
async def setup_start(body: PinBody):
    _check_pin(body.pin)
    code, output = await _systemctl('start')
    if code != 0:
        raise HTTPException(status_code=500, detail=f'systemctl start xray: {output}')
    await asyncio.sleep(1)
    return await _xray_status_dict()


@router.post('/api/xray/setup/stop')
async def setup_stop(body: PinBody):
    _check_pin(body.pin)
    code, output = await _systemctl('stop')
    if code != 0:
        raise HTTPException(status_code=500, detail=f'systemctl stop xray: {output}')
    return await _xray_status_dict()


@router.post('/api/xray/setup/save_profile')
async def setup_save_profile(body: SaveProfileBody):
    _check_pin(body.pin)
    if body.slot not in VALID_SLOTS:
        raise HTTPException(status_code=400, detail='Слот должен быть primary или backup')
    # Валидируем что строка парсится — не сохраняем мусор
    _vless_to_config(body.vless)
    profiles = _profiles_read()
    profiles[body.slot] = body.vless.strip()
    _profiles_write(profiles)
    return await _xray_status_dict()


@router.post('/api/xray/setup/activate')
async def setup_activate(body: ActivateBody):
    _check_pin(body.pin)
    return await _activate_slot(body.slot)


# ── Endpoints с auth (внутри платформы) ──────────────────────────────

@router.get('/api/xray/status')
async def auth_status(login: str = Depends(get_current_user)):
    return await _xray_status_dict()


@router.post('/api/xray/apply')
async def auth_apply(body: ApplyAuthBody, login: str = Depends(get_current_user)):
    cfg = _vless_to_config(body.vless)
    _write_config(cfg)
    code, output = await _systemctl('restart')
    if code != 0:
        raise HTTPException(status_code=500,
                            detail=f'Конфиг записан, но systemctl restart упал: {output}')
    await asyncio.sleep(1)
    return await _xray_status_dict()


@router.post('/api/xray/start')
async def auth_start(login: str = Depends(get_current_user)):
    code, output = await _systemctl('start')
    if code != 0:
        raise HTTPException(status_code=500, detail=f'systemctl start xray: {output}')
    await asyncio.sleep(1)
    return await _xray_status_dict()


@router.post('/api/xray/stop')
async def auth_stop(login: str = Depends(get_current_user)):
    code, output = await _systemctl('stop')
    if code != 0:
        raise HTTPException(status_code=500, detail=f'systemctl stop xray: {output}')
    return await _xray_status_dict()


@router.post('/api/xray/save_profile')
async def auth_save_profile(body: SaveProfileAuthBody, login: str = Depends(get_current_user)):
    if body.slot not in VALID_SLOTS:
        raise HTTPException(status_code=400, detail='Слот должен быть primary или backup')
    _vless_to_config(body.vless)
    profiles = _profiles_read()
    profiles[body.slot] = body.vless.strip()
    _profiles_write(profiles)
    return await _xray_status_dict()


@router.post('/api/xray/activate')
async def auth_activate(body: ActivateAuthBody, login: str = Depends(get_current_user)):
    return await _activate_slot(body.slot)
