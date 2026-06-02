"""
Claude AI ассистент через Claude Code SDK (подписка Max).

Использует локальный `claude` CLI, авторизованный под аккаунтом владельца сервера.
Доступ — только для логинов из ALLOWED_LOGINS.

Endpoints:
  GET  /api/claude/status  — статус подключения (есть ли claude CLI и логин)
  POST /api/claude/login   — запустить OAuth (возвращает URL для браузера)
  POST /api/claude/chat    — стриминговый ответ (SSE)
"""

import asyncio
import json
import logging
import os
import shutil
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .auth import get_current_user
from .sessions import get_session

logger = logging.getLogger('claude')
router = APIRouter()

# Только эти логины могут пользоваться AI ассистентом — он работает через
# Max-подписку владельца сервера, расходы идут на его аккаунт.
ALLOWED_LOGINS = {'Vladislav Marvin_Y5sA3Li8'}

AVAILABLE_MODELS = [
    {'id': 'sonnet', 'label': 'Sonnet 4.6 (быстрый, баланс)'},
    {'id': 'opus',   'label': 'Opus 4.7 (самый мощный)'},
    {'id': 'haiku',  'label': 'Haiku 4.5 (самый быстрый)'},
]
DEFAULT_MODEL = 'sonnet'


def _require_allowed(login: str):
    if login not in ALLOWED_LOGINS:
        raise HTTPException(
            status_code=403,
            detail='AI ассистент доступен только владельцу платформы',
        )


def _claude_bin() -> Optional[str]:
    """Путь к локальному `claude` CLI или None если не установлен."""
    path = shutil.which('claude')
    if path:
        return path
    # Fallback: глобальный npm-путь
    for candidate in ('/usr/local/bin/claude', '/usr/bin/claude', os.path.expanduser('~/.npm-global/bin/claude')):
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


# ── Schemas ─────────────────────────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str       # 'user' | 'assistant'
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    model: Optional[str] = None
    include_console: bool = False
    console_lines: int = 200
    include_file: Optional[str] = None


# ── Endpoints ───────────────────────────────────────────────────────────

@router.get('/api/claude/status')
async def claude_status(login: str = Depends(get_current_user)):
    if login not in ALLOWED_LOGINS:
        return {
            'allowed': False,
            'reason': 'AI ассистент доступен только владельцу платформы',
        }

    bin_path = _claude_bin()
    if not bin_path:
        return {
            'allowed': True,
            'cli_installed': False,
            'logged_in': False,
            'models': AVAILABLE_MODELS,
        }

    # Проверяем что CLI авторизован — спрашиваем версию или дёргаем простой запрос.
    # Используем `claude --version`: если CLI установлен — выведет версию.
    # Логин проверяется отдельно через наличие конфига ~/.claude/.credentials.json.
    creds_path = os.path.expanduser('~/.claude/.credentials.json')
    logged_in = os.path.isfile(creds_path)

    version = None
    try:
        proc = await asyncio.create_subprocess_exec(
            bin_path, '--version',
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
        version = out.decode().strip()
    except Exception:
        pass

    return {
        'allowed': True,
        'cli_installed': True,
        'cli_version': version,
        'logged_in': logged_in,
        'models': AVAILABLE_MODELS,
        'default_model': DEFAULT_MODEL,
    }


def _build_system_prompt(client, body: ChatRequest) -> str:
    parts = [
        'Ты — встроенный ассистент в платформу разработки Pawn-серверов SA-MP.',
        'Отвечай на русском. Будь краток и конкретен. Код оборачивай в ```pawn ... ```.',
    ]

    if body.include_file:
        meta = client.files.get(body.include_file, {})
        fname = meta.get('fullPath') or meta.get('name') or body.include_file
        code_parts = client.code.get(body.include_file, [])
        if code_parts:
            sorted_parts = sorted(code_parts, key=lambda p: p.get('line', 0))
            content = '\n\n'.join(p.get('content', '') for p in sorted_parts)
            parts.append(f'\n# Открытый файл: {fname}\n```pawn\n{content}\n```')

    if body.include_console:
        log = client.get_console_log(limit=max(1, min(body.console_lines, 2000)))
        if log:
            lines = '\n'.join(entry['line'] for entry in log)
            parts.append(f'\n# Последние строки серверного лога:\n```\n{lines}\n```')

    return '\n'.join(parts)


def _build_user_prompt(messages: list[ChatMessage]) -> str:
    """
    Claude Code CLI принимает один prompt. Чтобы сохранить контекст беседы,
    склеиваем историю в один текст с метками ролей.
    """
    if not messages:
        return ''
    if len(messages) == 1:
        return messages[0].content

    lines = []
    for m in messages[:-1]:
        prefix = 'User' if m.role == 'user' else 'Assistant'
        lines.append(f'{prefix}: {m.content}')
    lines.append(f'User: {messages[-1].content}')
    return '\n\n'.join(lines)


@router.post('/api/claude/chat')
async def claude_chat(body: ChatRequest, login: str = Depends(get_current_user)):
    _require_allowed(login)

    bin_path = _claude_bin()
    if not bin_path:
        raise HTTPException(status_code=400, detail='Claude CLI не установлен на сервере')

    client = get_session(login)
    if not client:
        raise HTTPException(status_code=401, detail='Сессия не найдена')

    model = body.model or DEFAULT_MODEL
    if model not in {m['id'] for m in AVAILABLE_MODELS}:
        raise HTTPException(status_code=400, detail='Неизвестная модель')

    system_prompt = _build_system_prompt(client, body)
    user_prompt = _build_user_prompt(body.messages)
    if not user_prompt.strip():
        raise HTTPException(status_code=400, detail='Пустой запрос')

    # Claude Code CLI: --print не-интерактивный режим, --output-format stream-json
    # отдаёт NDJSON со всеми событиями (включая token deltas).
    args = [
        bin_path,
        '--print',
        '--output-format', 'stream-json',
        '--verbose',
        '--model', model,
        '--append-system-prompt', system_prompt,
        user_prompt,
    ]

    async def event_stream():
        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except Exception as e:
            yield f'event: error\ndata: {json.dumps({"error": str(e)})}\n\n'
            return

        async def forward_stderr():
            try:
                async for raw in proc.stderr:
                    text = raw.decode('utf-8', errors='replace').rstrip()
                    if text:
                        logger.warning(f'claude stderr: {text}')
            except Exception:
                pass

        stderr_task = asyncio.create_task(forward_stderr())

        try:
            async for raw in proc.stdout:
                line = raw.decode('utf-8', errors='replace').strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue

                # Claude Code SDK NDJSON events. Извлекаем текст ассистента.
                msg_type = msg.get('type')
                if msg_type == 'assistant':
                    content = msg.get('message', {}).get('content', [])
                    for block in content:
                        if block.get('type') == 'text':
                            text = block.get('text', '')
                            if text:
                                yield f'event: delta\ndata: {json.dumps({"text": text})}\n\n'
                elif msg_type == 'result':
                    # финальный итог; завершаем
                    yield f'event: done\ndata: {json.dumps({"usage": msg.get("usage")})}\n\n'

            await proc.wait()
            if proc.returncode != 0:
                yield f'event: error\ndata: {json.dumps({"error": f"claude CLI exit code {proc.returncode}"})}\n\n'
        except Exception as e:
            logger.exception('claude stream failed')
            yield f'event: error\ndata: {json.dumps({"error": str(e)})}\n\n'
            try:
                proc.kill()
            except Exception:
                pass
        finally:
            stderr_task.cancel()

    return StreamingResponse(event_stream(), media_type='text/event-stream')
