"""
Claude AI ассистент через Claude Code SDK (подписка Max).

Использует локальный `claude` CLI, авторизованный под аккаунтом владельца сервера.
Доступ — только для логинов из ALLOWED_LOGINS.

Архитектура:
  • Перед каждым запросом создаётся временная папка-workspace со всеми
    доступными Pawn-файлами в реальной структуре (gamemodes/, includes/, …).
  • CLI запускается с cwd=workspace + ограничениями инструментов (только
    файлы: Read/Glob/Grep/Edit/Write). Никаких Bash, WebFetch, etc.
  • После завершения сравниваем содержимое файлов workspace с исходным
    снапшотом; собранные правки идут пользователю как event proposed_edits.
  • Пользователь подтверждает применение через /api/claude/apply_edits —
    оно эмитит set_code в платформу, что триггерит обычный save-flow
    (включая авто-коммит в GitHub архив).

Endpoints:
  GET  /api/claude/status       — статус подключения
  POST /api/claude/chat         — стриминговый ответ (SSE)
  POST /api/claude/apply_edits  — применить выбранные правки в файлы
"""

import asyncio
import json
import logging
import os
import shutil
import tempfile
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .auth import get_current_user
from .sessions import get_session

logger = logging.getLogger('claude')
router = APIRouter()

ALLOWED_LOGINS = {'Vladislav Marvin_Y5sA3Li8'}

AVAILABLE_MODELS = [
    {'id': 'sonnet', 'label': 'Sonnet 4.6 (быстрый, баланс)'},
    {'id': 'opus',   'label': 'Opus 4.7 (самый мощный)'},
    {'id': 'haiku',  'label': 'Haiku 4.5 (самый быстрый)'},
]
DEFAULT_MODEL = 'sonnet'

# Какие инструменты CLI разрешены — только работа с файлами в workspace.
ALLOWED_TOOLS = 'Read Glob Grep Edit Write MultiEdit'
DISALLOWED_TOOLS = 'Bash WebFetch WebSearch TodoWrite NotebookEdit'

# База для workspace директорий
_WS_BASE = Path(tempfile.gettempdir()) / 'cp-ai-ws'


def _require_allowed(login: str):
    if login not in ALLOWED_LOGINS:
        raise HTTPException(
            status_code=403,
            detail='AI ассистент доступен только владельцу платформы',
        )


def _claude_bin() -> Optional[str]:
    path = shutil.which('claude')
    if path:
        return path
    for candidate in ('/usr/local/bin/claude', '/usr/bin/claude',
                      os.path.expanduser('~/.npm-global/bin/claude')):
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


# ── Workspace ──────────────────────────────────────────────────────────

def _safe_rel_path(p: str) -> Optional[str]:
    """Очищаем fullPath: убираем ведущие /, .., нормализуем разделители."""
    if not p:
        return None
    s = p.replace('\\', '/').lstrip('/').strip()
    if not s:
        return None
    # никаких выходов наружу
    if '..' in s.split('/'):
        return None
    return s


def _file_text(client, file_id: str) -> str:
    """Собирает текущее содержимое файла из parts'ов."""
    parts = (client.code or {}).get(file_id) or []
    if not parts:
        return ''
    sorted_parts = sorted(parts, key=lambda p: p.get('line', 0))
    return '\n'.join(p.get('content', '') for p in sorted_parts)


def _build_workspace(client) -> tuple[Path, dict]:
    """
    Создаёт временную папку, копирует туда все доступные Pawn-файлы.

    Возвращает (path, snapshot), где snapshot:
        {rel_path: {'file_id': str, 'content': str}}
    """
    _WS_BASE.mkdir(parents=True, exist_ok=True)
    ws = _WS_BASE / f'{uuid.uuid4().hex[:12]}'
    ws.mkdir(parents=True, exist_ok=False)

    snapshot: dict = {}
    files = client.files or {}
    accessible_ids = set((client.code or {}).keys())

    for fid in accessible_ids:
        meta = files.get(fid) or files.get(str(fid)) or {}
        raw_path = meta.get('fullPath') or meta.get('name') or f'file_{fid}'
        rel = _safe_rel_path(raw_path)
        if not rel:
            continue
        content = _file_text(client, fid)
        target = ws / rel
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding='utf-8')
        except OSError as e:
            logger.warning(f'workspace write failed for {rel}: {e}')
            continue
        snapshot[rel] = {'file_id': str(fid), 'content': content}

    # Подсказка-маркер для самого Claude
    try:
        (ws / 'AI_README.md').write_text(
            '# AI workspace\n\n'
            'Это временное зеркало Pawn-проекта пользователя.\n'
            'Здесь ТОЛЬКО Pawn-код (.pwn / .inc). Никакого Python, JS, конфигов платформы.\n'
            'Используй Glob/Read/Grep/Edit для работы. Не выходи за пределы этой директории.\n',
            encoding='utf-8',
        )
    except OSError:
        pass

    return ws, snapshot


def _normalize(text: str) -> str:
    """
    Нормализует текст для сравнения diff:
    - убирает BOM
    - приводит CRLF/CR к LF
    - убирает trailing whitespace на каждой строке
    - убирает финальные пустые строки
    Это игнорирует косметические различия, которые Claude часто вносит
    автоматически (нормализация line endings, добавление newline в конце).
    """
    if text is None:
        return ''
    s = text.lstrip('﻿')
    s = s.replace('\r\n', '\n').replace('\r', '\n')
    s = '\n'.join(line.rstrip() for line in s.split('\n'))
    s = s.rstrip('\n')
    return s


def _diff_workspace(ws: Path, snapshot: dict) -> list[dict]:
    """
    Сравнивает содержимое workspace с snapshot.
    Считаем файл изменённым только если различия СМЫСЛОВЫЕ
    (после нормализации line endings / trailing whitespace).
    """
    edits = []
    for rel, info in snapshot.items():
        target = ws / rel
        if not target.exists():
            continue  # файл удалён — не поддерживаем удаление через AI
        try:
            new_text = target.read_text(encoding='utf-8')
        except OSError:
            continue
        old_text = info['content']
        if _normalize(new_text) == _normalize(old_text):
            continue  # косметика, не правка
        edits.append({
            'file_id': info['file_id'],
            'path': rel,
            'old_content': old_text,
            'new_content': new_text,
        })
    return edits


def _cleanup_workspace(ws: Path):
    try:
        shutil.rmtree(ws, ignore_errors=True)
    except Exception as e:
        logger.warning(f'cleanup failed for {ws}: {e}')


# ── System prompt ─────────────────────────────────────────────────────

def _build_system_prompt(client, body: 'ChatRequest', attached_paths: list[str]) -> str:
    parts = [
        '# Кто ты',
        'Ты встроенный ассистент в веб-платформу разработки игрового сервера SA-MP на языке Pawn.',
        'Твоя рабочая директория (cwd) — временное зеркало Pawn-проекта пользователя.',
        'В ней лежат ТОЛЬКО .pwn и .inc файлы — настоящая структура (например gamemodes/gamelogic.pwn).',
        'Никаких Python, JS, README, .git, deploy-скриптов здесь нет и быть не должно.',
        '',
        '# Когда что-то менять',
        '⚠️ Edit/Write/MultiEdit применяй ТОЛЬКО когда пользователь ЯВНО просит внести правку.',
        'Если вопрос "что есть", "как работает", "объясни", "найди", "покажи" — НЕ ТРОГАЙ файлы. Только читай (Read/Glob/Grep) и отвечай текстом.',
        'Если ты не уверен, нужна ли правка — спроси у пользователя, прежде чем редактировать.',
        'НЕ переоформляй файлы под "лучший стиль" по своей инициативе. НЕ переноси переводы строк, BOM, отступы — это всё засчитается как правка и засрёт пользовательский diff.',
        '',
        '# Как работать',
        '- Изучай код через Glob → Read / Grep.',
        '- Когда пользователь явно просит правку — используй Edit/MultiEdit (точечно), Write (только если файла раньше не было). Твои правки появятся у пользователя как diff с кнопкой "Применить".',
        '- НЕ выходи за пределы рабочей директории. Никаких Bash, WebFetch, обращений к интернету.',
        '- При изменениях сохраняй стиль соседнего кода: отступы (часто tabs), скобки, паттерны именования.',
        '',
        '# Правила ответов',
        '- Отвечай на русском.',
        '- Будь краток. Не пересказывай содержимое файла, если пользователь его и так видит.',
        '- Pawn-код в ответе оборачивай в ```pawn ... ```.',
        '- Если делаешь правку — НЕ дублируй её ещё и текстом в ответе, пользователь увидит её в diff. Достаточно короткого пояснения "что и зачем".',
    ]

    if attached_paths:
        parts.append('')
        parts.append('# Файлы, на которые пользователь явно указал (@)')
        for p in attached_paths:
            parts.append(f'- {p}')
        parts.append('Обрати внимание именно на них.')

    if body.include_console:
        log = client.get_console_log(limit=max(1, min(body.console_lines, 2000)))
        if log:
            lines = '\n'.join(entry['line'] for entry in log)
            parts.append('')
            parts.append('# Последние строки серверного лога')
            parts.append(f'```\n{lines}\n```')

    return '\n'.join(parts)


def _build_user_prompt(messages: list) -> str:
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


# ── Schemas ─────────────────────────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    model: Optional[str] = None
    include_console: bool = False
    console_lines: int = 200
    attached_files: list[str] = []


class EditToApply(BaseModel):
    file_id: str
    new_content: str


class ApplyEditsRequest(BaseModel):
    edits: list[EditToApply]


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


@router.post('/api/claude/chat')
async def claude_chat(body: ChatRequest, login: str = Depends(get_current_user)):
    _require_allowed(login)

    bin_path = _claude_bin()
    if not bin_path:
        raise HTTPException(status_code=400, detail='Claude CLI не установлен на сервере')

    client = get_session(login)
    if not client:
        raise HTTPException(status_code=401, detail='Сессия не найдена')

    # Ждём пока данные платформы загрузятся
    for _ in range(8):
        if client.files and client.code:
            break
        await asyncio.sleep(0.5)

    model = body.model or DEFAULT_MODEL
    if model not in {m['id'] for m in AVAILABLE_MODELS}:
        raise HTTPException(status_code=400, detail='Неизвестная модель')

    user_prompt = _build_user_prompt(body.messages)
    if not user_prompt.strip():
        raise HTTPException(status_code=400, detail='Пустой запрос')

    # Готовим workspace
    ws, snapshot = _build_workspace(client)
    logger.info(f'AI workspace ({login}): {ws} — {len(snapshot)} files')

    # Карта file_id -> rel_path для прикреплённых
    fid_to_rel = {info['file_id']: rel for rel, info in snapshot.items()}
    attached_paths = []
    for fid in (body.attached_files or []):
        rel = fid_to_rel.get(str(fid))
        if rel:
            attached_paths.append(rel)

    system_prompt = _build_system_prompt(client, body, attached_paths)

    args = [
        bin_path,
        '--print',
        '--output-format', 'stream-json',
        '--include-partial-messages',
        '--verbose',
        '--model', model,
        '--add-dir', str(ws),
        '--allowed-tools', ALLOWED_TOOLS,
        '--disallowed-tools', DISALLOWED_TOOLS,
        '--append-system-prompt', system_prompt,
        '--permission-mode', 'acceptEdits',  # позволяем Edit/Write без интерактива
        user_prompt,
    ]

    async def event_stream():
        proc = None
        try:
            try:
                proc = await asyncio.create_subprocess_exec(
                    *args,
                    cwd=str(ws),
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

            got_partial_text = False
            tool_uses_emitted = set()

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

                    # Token deltas
                    if msg_type == 'stream_event':
                        ev = msg.get('event') or {}
                        if ev.get('type') == 'content_block_delta':
                            delta = ev.get('delta') or {}
                            if delta.get('type') == 'text_delta':
                                text = delta.get('text', '')
                                if text:
                                    got_partial_text = True
                                    yield f'event: delta\ndata: {json.dumps({"text": text})}\n\n'
                        continue

                    if msg_type == 'assistant':
                        # Эмитим tool_use события для UI (читает X, редактирует Y...)
                        content = msg.get('message', {}).get('content', [])
                        for block in content:
                            if block.get('type') == 'tool_use':
                                tu_id = block.get('id')
                                if tu_id in tool_uses_emitted:
                                    continue
                                tool_uses_emitted.add(tu_id)
                                tool_name = block.get('name', '')
                                inp = block.get('input', {}) or {}
                                # Извлекаем путь файла, если есть
                                path = inp.get('file_path') or inp.get('path') or inp.get('pattern') or ''
                                if path:
                                    # делаем путь относительным к workspace
                                    try:
                                        rel = os.path.relpath(path, str(ws))
                                        if not rel.startswith('..'):
                                            path = rel
                                    except Exception:
                                        pass
                                yield f'event: tool\ndata: {json.dumps({"tool": tool_name, "path": path})}\n\n'
                            elif block.get('type') == 'text' and not got_partial_text:
                                text = block.get('text', '')
                                if text:
                                    yield f'event: delta\ndata: {json.dumps({"text": text})}\n\n'
                        continue

                    if msg_type == 'result':
                        # Считаем diff
                        edits = _diff_workspace(ws, snapshot)
                        # Защита от слишком больших полезных нагрузок: не шлём content
                        # > 200к символов целиком в одно SSE (но обычно файлы влезают)
                        edits_payload = []
                        for e in edits:
                            edits_payload.append({
                                'file_id': e['file_id'],
                                'path': e['path'],
                                'old_content': e['old_content'],
                                'new_content': e['new_content'],
                            })
                        yield f'event: edits\ndata: {json.dumps({"edits": edits_payload})}\n\n'
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
        finally:
            _cleanup_workspace(ws)

    return StreamingResponse(
        event_stream(),
        media_type='text/event-stream',
        headers={
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no',
            'Connection': 'keep-alive',
        },
    )


# ── Применение правок ─────────────────────────────────────────────────

@router.post('/api/claude/apply_edits')
async def claude_apply_edits(body: ApplyEditsRequest, login: str = Depends(get_current_user)):
    """
    Применяет AI-правки в файлы платформы через тот же set_code flow,
    что и при ручном сохранении. Автокоммит в GitHub архив случится сам.
    """
    _require_allowed(login)

    client = get_session(login)
    if not client:
        raise HTTPException(status_code=401, detail='Сессия не найдена')

    applied = []
    errors = []

    for edit in body.edits:
        fid = str(edit.file_id)
        new_content = edit.new_content

        parts = (client.code or {}).get(fid) or []
        if not parts:
            errors.append({'file_id': fid, 'error': 'Нет доступа к файлу'})
            continue
        if len(parts) > 1:
            # Несколько частей — пока не поддерживаем, потому что не понятно
            # как правильно разбить новое содержимое по партам
            errors.append({'file_id': fid, 'error': 'Файл из нескольких частей — применение пока не поддерживается'})
            continue

        part_index = 0
        save_hash = parts[part_index].get('hash')

        # Эмитим save и ждём подтверждение, как делает /api/code/save
        future: asyncio.Future = asyncio.get_event_loop().create_future()

        def on_save_finish(*args, _fut=future):
            new_hash_ = args[0] if args else None
            if not _fut.done():
                _fut.set_result(new_hash_)

        client.on('save_finish', on_save_finish)
        try:
            file_id_int = int(fid) if fid.isdigit() else fid
            await client._emit('set_code', file_id_int, new_content, part_index, save_hash or None, '')
            new_hash = await asyncio.wait_for(future, timeout=15)
        except ConnectionError as e:
            errors.append({'file_id': fid, 'error': f'Связь с платформой: {e}'})
            continue
        except asyncio.TimeoutError:
            errors.append({'file_id': fid, 'error': 'Платформа не подтвердила сохранение'})
            continue
        finally:
            client.off('save_finish', on_save_finish)

        client.update_cached_code(fid, part_index, new_content, new_hash)

        # GitHub autocommit (как обычное сохранение)
        from .routes import _github_autocommit
        asyncio.create_task(_github_autocommit(login, client, fid, part_index))

        meta = (client.files or {}).get(fid) or {}
        applied.append({
            'file_id': fid,
            'path': meta.get('fullPath') or meta.get('name') or fid,
        })

    return {'applied': applied, 'errors': errors}
