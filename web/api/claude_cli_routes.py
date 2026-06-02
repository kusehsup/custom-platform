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
    # Список file_id прикреплённых файлов (через @ или другой UI)
    attached_files: list[str] = []


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
        '# Кто ты',
        'Ты встроен в веб-платформу для разработки и обслуживания игрового сервера SA-MP, написанного на языке Pawn.',
        'Это НЕ обычный программный проект — здесь нет Python, JS, README, тестов, .git, скриптов деплоя.',
        'Это серверная Pawn-кодовая база — файлы .pwn и .inc, ничего больше.',
        'Доступ к коду у пользователя ограничен — он видит только те части файлов, которые ему открыли модераторы платформы.',
        '',
        '# Жёсткие запреты',
        '- НИКОГДА не выдумывай файлы. Если в системном промпте нет списка файлов или конкретного файла — так и скажи "у меня нет доступа к списку файлов".',
        '- НИКОГДА не упоминай файлы вроде config.py, web/app.py, hassle_platform/, bot/, deploy/setup.sh, .env, README — этого здесь нет. Это окружающая платформа, а не Pawn-проект.',
        '- НЕ показывай "структуру проекта" наугад. Опирайся только на список ниже.',
        '',
        '# Правила ответов',
        '- Отвечай на русском.',
        '- Будь краток и конкретен, без дисклеймеров.',
        '- Pawn-код всегда оборачивай в ```pawn ... ```.',
        '- Если нужен файл, которого нет в прикреплённых — попроси прикрепить через @имя_файла.',
    ]

    # Структура проекта — всегда. Список всех доступных файлов с их fullPath.
    files = client.files or {}
    accessible_ids = set((client.code or {}).keys())

    listing = []
    if files and accessible_ids:
        seen_ids = set()
        for pid in (client.project_files or []):
            sid = str(pid)
            if sid in accessible_ids and sid not in seen_ids:
                meta = files.get(sid) or {}
                path = meta.get('fullPath') or meta.get('name') or sid
                listing.append(f'- {path}')
                seen_ids.add(sid)
        # Остальные доступные файлы, которых нет в project_files
        for fid in accessible_ids:
            sid = str(fid)
            if sid in seen_ids:
                continue
            meta = files.get(sid) or files.get(fid) or {}
            path = meta.get('fullPath') or meta.get('name') or sid
            listing.append(f'- {path}')

    parts.append('')
    if listing:
        parts.append('# Файлы Pawn-проекта, к которым у пользователя есть доступ')
        parts.append('(содержимое НЕ приложено — попроси прикрепить через @ если нужно)')
        parts.extend(listing)
    else:
        parts.append('# Файлы Pawn-проекта')
        parts.append('Список файлов ещё не загружен из платформы — попроси пользователя подождать пару секунд и спросить снова, либо прикрепить нужный файл через @.')

    # Прикреплённые файлы — их содержимое целиком
    attached = body.attached_files or []
    if attached:
        parts.append('')
        parts.append('# Прикреплённые файлы (содержимое)')
        for fid in attached:
            meta = files.get(fid) or {}
            fname = meta.get('fullPath') or meta.get('name') or fid
            code_parts = (client.code or {}).get(fid, [])
            if not code_parts:
                parts.append(f'\n## {fname}')
                parts.append('_(нет доступного содержимого)_')
                continue
            sorted_parts = sorted(code_parts, key=lambda p: p.get('line', 0))
            content = '\n\n'.join(p.get('content', '') for p in sorted_parts)
            parts.append(f'\n## {fname}')
            parts.append(f'```pawn\n{content}\n```')

    if body.include_console:
        log = client.get_console_log(limit=max(1, min(body.console_lines, 2000)))
        if log:
            lines = '\n'.join(entry['line'] for entry in log)
            parts.append('')
            parts.append('# Последние строки серверного лога')
            parts.append(f'```\n{lines}\n```')

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

    # Ждём пока данные платформы загрузятся (files + code), иначе модель
    # не увидит список доступных файлов и начнёт фантазировать.
    for _ in range(8):
        if client.files and client.code:
            break
        await asyncio.sleep(0.5)

    model = body.model or DEFAULT_MODEL
    if model not in {m['id'] for m in AVAILABLE_MODELS}:
        raise HTTPException(status_code=400, detail='Неизвестная модель')

    system_prompt = _build_system_prompt(client, body)
    user_prompt = _build_user_prompt(body.messages)
    if not user_prompt.strip():
        raise HTTPException(status_code=400, detail='Пустой запрос')

    # Claude Code CLI: --print не-интерактивный режим, --output-format stream-json
    # отдаёт NDJSON. --include-partial-messages включает token-level deltas
    # (stream_event с raw Anthropic SSE), чтобы пользователь видел ответ по мере
    # генерации, а не одной вспышкой в конце.
    args = [
        bin_path,
        '--print',
        '--output-format', 'stream-json',
        '--include-partial-messages',
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

        # Если CLI шлёт partial stream_event'ы (token deltas), не дублируем
        # их финальным `assistant` блоком.
        got_partial_text = False

        try:
            async for raw in proc.stdout:
                line = raw.decode('utf-8', errors='replace').strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue

                msg_type = msg.get('type')

                # 1) Token-level стриминг через partial messages
                if msg_type == 'stream_event':
                    ev = msg.get('event') or {}
                    ev_type = ev.get('type')
                    if ev_type == 'content_block_delta':
                        delta = ev.get('delta') or {}
                        if delta.get('type') == 'text_delta':
                            text = delta.get('text', '')
                            if text:
                                got_partial_text = True
                                yield f'event: delta\ndata: {json.dumps({"text": text})}\n\n'
                    continue

                # 2) Полное assistant сообщение — fallback если partial выключен
                if msg_type == 'assistant':
                    if got_partial_text:
                        continue  # уже стримили — не дублируем
                    content = msg.get('message', {}).get('content', [])
                    for block in content:
                        if block.get('type') == 'text':
                            text = block.get('text', '')
                            if text:
                                yield f'event: delta\ndata: {json.dumps({"text": text})}\n\n'
                    continue

                if msg_type == 'result':
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

    return StreamingResponse(
        event_stream(),
        media_type='text/event-stream',
        headers={
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no',  # отключает буферизацию nginx
            'Connection': 'keep-alive',
        },
    )
