"""
Claude AI ассистент — персональный аккаунт для каждого юзера.

Endpoints:
  POST /api/claude/connect    — сохранить API key, проверить доступ
  DELETE /api/claude/connect  — отключить
  GET  /api/claude/status     — статус подключения
  POST /api/claude/model      — сменить модель
  POST /api/claude/chat       — отправить сообщение (стриминг SSE)
"""

import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .auth import get_current_user
from .sessions import get_session
from . import claude_store

logger = logging.getLogger('claude')
router = APIRouter()

ANTHROPIC_API = 'https://api.anthropic.com'
ANTHROPIC_VERSION = '2023-06-01'

AVAILABLE_MODELS = [
    {'id': 'claude-opus-4-7',           'label': 'Opus 4.7 (самый мощный)'},
    {'id': 'claude-sonnet-4-6',         'label': 'Sonnet 4.6 (баланс)'},
    {'id': 'claude-haiku-4-5-20251001', 'label': 'Haiku 4.5 (быстрый/дешёвый)'},
]


def _headers(api_key: str) -> dict:
    return {
        'x-api-key': api_key,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
    }


async def _validate_key(api_key: str, model: str) -> bool:
    """Минимальный запрос для проверки ключа."""
    try:
        import httpx
    except ImportError:
        raise HTTPException(status_code=500, detail='httpx не установлен')

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            f'{ANTHROPIC_API}/v1/messages',
            headers=_headers(api_key),
            json={
                'model': model,
                'max_tokens': 8,
                'messages': [{'role': 'user', 'content': 'ping'}],
            },
        )

    if resp.status_code == 401:
        raise HTTPException(status_code=401, detail='Неверный API key')
    if resp.status_code == 404:
        raise HTTPException(status_code=400, detail=f'Модель {model} недоступна для этого ключа')
    if resp.status_code >= 400:
        try:
            err = resp.json().get('error', {}).get('message', resp.text)
        except Exception:
            err = resp.text
        raise HTTPException(status_code=resp.status_code, detail=f'Anthropic: {err}')
    return True


# ── Schemas ─────────────────────────────────────────────────────────────

class ConnectRequest(BaseModel):
    api_key: str
    model: Optional[str] = None


class ModelRequest(BaseModel):
    model: str


class ChatMessage(BaseModel):
    role: str  # 'user' | 'assistant'
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    include_console: bool = False
    console_lines: int = 200
    include_file: Optional[str] = None  # file_id, контент подгрузим из сессии
    max_tokens: int = 4096


# ── Endpoints ───────────────────────────────────────────────────────────

@router.post('/api/claude/connect')
async def claude_connect(body: ConnectRequest, login: str = Depends(get_current_user)):
    api_key = body.api_key.strip()
    model = (body.model or claude_store.DEFAULT_MODEL).strip()

    if not api_key.startswith('sk-ant-'):
        raise HTTPException(status_code=400, detail='Ключ должен начинаться с sk-ant-')

    await _validate_key(api_key, model)
    claude_store.save_config(login, api_key, model)
    logger.info(f'Claude подключён ({login}) → {model}')
    return {'ok': True, 'model': model}


@router.delete('/api/claude/connect')
async def claude_disconnect(login: str = Depends(get_current_user)):
    claude_store.clear(login)
    return {'ok': True}


@router.get('/api/claude/status')
async def claude_status(login: str = Depends(get_current_user)):
    if not claude_store.is_configured(login):
        return {'connected': False, 'models': AVAILABLE_MODELS}
    return {
        'connected': True,
        'model': claude_store.get_model(login),
        'models': AVAILABLE_MODELS,
    }


@router.post('/api/claude/model')
async def claude_set_model(body: ModelRequest, login: str = Depends(get_current_user)):
    if not claude_store.is_configured(login):
        raise HTTPException(status_code=400, detail='Claude не подключён')
    if body.model not in [m['id'] for m in AVAILABLE_MODELS]:
        raise HTTPException(status_code=400, detail='Неизвестная модель')
    claude_store.set_model(login, body.model)
    return {'ok': True, 'model': body.model}


def _build_system_prompt(client, body: ChatRequest) -> str:
    parts = [
        'Ты — встроенный ассистент в платформу разработки Pawn-серверов SA-MP.',
        'Отвечай на русском. Будь краток и конкретен. Код оборачивай в ```pawn ... ```.',
    ]

    # Контекст: активный файл
    if body.include_file:
        meta = client.files.get(body.include_file, {})
        fname = meta.get('fullPath') or meta.get('name') or body.include_file
        code_parts = client.code.get(body.include_file, [])
        if code_parts:
            sorted_parts = sorted(code_parts, key=lambda p: p.get('line', 0))
            content = '\n\n'.join(p.get('content', '') for p in sorted_parts)
            parts.append(f'\n# Открытый файл: {fname}\n```pawn\n{content}\n```')

    # Контекст: консоль сервера
    if body.include_console:
        log = client.get_console_log(limit=max(1, min(body.console_lines, 2000)))
        if log:
            lines = '\n'.join(entry['line'] for entry in log)
            parts.append(f'\n# Последние строки серверного лога:\n```\n{lines}\n```')

    return '\n'.join(parts)


@router.post('/api/claude/chat')
async def claude_chat(body: ChatRequest, login: str = Depends(get_current_user)):
    if not claude_store.is_configured(login):
        raise HTTPException(status_code=400, detail='Claude не подключён')

    client = get_session(login)
    if not client:
        raise HTTPException(status_code=401, detail='Сессия не найдена')

    api_key = claude_store.get_api_key(login)
    model = claude_store.get_model(login)

    system = _build_system_prompt(client, body)
    messages = [{'role': m.role, 'content': m.content} for m in body.messages]

    try:
        import httpx
    except ImportError:
        raise HTTPException(status_code=500, detail='httpx не установлен')

    payload = {
        'model': model,
        'max_tokens': body.max_tokens,
        'system': system,
        'messages': messages,
        'stream': True,
    }

    async def event_stream():
        try:
            async with httpx.AsyncClient(timeout=None) as cli:
                async with cli.stream(
                    'POST',
                    f'{ANTHROPIC_API}/v1/messages',
                    headers=_headers(api_key),
                    json=payload,
                ) as resp:
                    if resp.status_code >= 400:
                        body_text = (await resp.aread()).decode('utf-8', errors='replace')
                        try:
                            err = json.loads(body_text).get('error', {}).get('message', body_text)
                        except Exception:
                            err = body_text
                        yield f'event: error\ndata: {json.dumps({"error": err})}\n\n'
                        return

                    # Anthropic уже отдаёт SSE — пробрасываем построчно
                    async for raw_line in resp.aiter_lines():
                        if raw_line:
                            yield raw_line + '\n'
                        else:
                            yield '\n'
        except Exception as e:
            logger.exception('Claude stream failed')
            yield f'event: error\ndata: {json.dumps({"error": str(e)})}\n\n'

    return StreamingResponse(event_stream(), media_type='text/event-stream')
