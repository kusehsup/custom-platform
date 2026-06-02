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
from . import claude_usage
from . import tasks_store
from . import ai_threads_store

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

def _build_system_prompt(client, body: 'ChatRequest', attached_paths: list[str],
                          login: str) -> str:
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

    # Задача треда (если есть) > глобальная активная задача
    active = None
    try:
        thread_id = getattr(body, '_resolved_thread_id', None)
        if thread_id:
            tid = ai_threads_store.thread_task_id(login, thread_id)
            if tid:
                active = tasks_store.get_task(login, tid)
        if not active:
            active = tasks_store.get_active_task(login)
    except Exception:
        active = None
    if active:
        parts.append('')
        parts.append('# Активная задача пользователя')
        parts.append(f'**{active["title"]}** · статус: `{active["status"]}` · приоритет: `{active["priority"]}`')
        desc = (active.get('description') or '').strip()
        if desc:
            parts.append('')
            parts.append(desc[:4000])
        # Прикреплённые к задаче Pawn-файлы — подсказка путей
        task_files = active.get('attached_files') or []
        if task_files and client.files:
            task_paths = []
            for fid in task_files:
                meta = client.files.get(fid) or client.files.get(str(fid)) or {}
                p = meta.get('fullPath') or meta.get('name')
                if p:
                    task_paths.append(p.lstrip('/'))
            if task_paths:
                parts.append('')
                parts.append('Файлы задачи:')
                for p in task_paths:
                    parts.append(f'- {p}')
        # Заметки (последние 10) и AI-журнал (последние 5) — короткая память
        notes = active.get('notes') or []
        if notes:
            parts.append('')
            parts.append('Последние заметки по задаче:')
            for n in notes[-10:]:
                parts.append(f'- {n.get("text", "")[:200]}')
        ai_log = active.get('ai_log') or []
        if ai_log:
            parts.append('')
            parts.append('Что уже делалось AI по этой задаче:')
            for entry in ai_log[-5:]:
                parts.append(f'- [{entry.get("kind")}] {entry.get("summary", "")}')
        parts.append('')
        parts.append('Если выполнишь то, что просили в задаче — кратко упомяни в ответе, что задачу можно перевести в done.')

    # Короткий обзор остальных открытых задач (только заголовки)
    try:
        all_tasks = tasks_store.list_tasks(login)
    except Exception:
        all_tasks = []
    other_open = [t for t in all_tasks
                  if t.get('id') != (active or {}).get('id')
                  and t.get('status') in ('open', 'in_progress')]
    if other_open:
        parts.append('')
        parts.append('# Другие открытые задачи (краткий список)')
        for t in other_open[:15]:
            parts.append(f'- [{t.get("status")}] {t.get("title")}')

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
    # Тред, в который пишется этот запрос. Если не указан — main.
    thread_id: Optional[str] = None


class EditToApply(BaseModel):
    file_id: str
    new_content: str


class ApplyEditsRequest(BaseModel):
    edits: list[EditToApply]


# ── Endpoints ───────────────────────────────────────────────────────────

# ── Threads ────────────────────────────────────────────────────────

class RenameThreadRequest(BaseModel):
    title: str


class SetCurrentRequest(BaseModel):
    thread_id: str


@router.get('/api/claude/threads')
async def list_threads(login: str = Depends(get_current_user)):
    _require_allowed(login)
    return ai_threads_store.list_threads(login)


@router.get('/api/claude/threads/{thread_id:path}')
async def get_thread(thread_id: str, login: str = Depends(get_current_user)):
    _require_allowed(login)
    thread = ai_threads_store.get_thread(login, thread_id)
    if not thread:
        raise HTTPException(status_code=404, detail='Тред не найден')
    return {'thread': thread}


@router.post('/api/claude/threads/current')
async def set_current_thread(body: SetCurrentRequest,
                              login: str = Depends(get_current_user)):
    _require_allowed(login)
    tid = body.thread_id
    if tid.startswith('task:'):
        task_id = tid.split(':', 1)[1]
        task = tasks_store.get_task(login, task_id)
        if not task:
            raise HTTPException(status_code=404, detail='Задача не найдена')
        ai_threads_store.ensure_task_thread(login, task_id, task.get('title', ''))
    elif not ai_threads_store.get_thread(login, tid):
        raise HTTPException(status_code=404, detail='Тред не найден')
    ai_threads_store.set_current(login, tid)
    return {'current_thread': tid}


@router.post('/api/claude/threads/{thread_id:path}/rename')
async def rename_thread(thread_id: str, body: RenameThreadRequest,
                         login: str = Depends(get_current_user)):
    _require_allowed(login)
    if thread_id == ai_threads_store.MAIN_ID:
        raise HTTPException(status_code=400, detail='Нельзя переименовать основной чат')
    if not ai_threads_store.get_thread(login, thread_id):
        raise HTTPException(status_code=404, detail='Тред не найден')
    ai_threads_store.rename_thread(login, thread_id, body.title)
    return {'ok': True}


@router.post('/api/claude/threads/{thread_id:path}/clear')
async def clear_thread(thread_id: str, login: str = Depends(get_current_user)):
    _require_allowed(login)
    if not ai_threads_store.get_thread(login, thread_id):
        raise HTTPException(status_code=404, detail='Тред не найден')
    ai_threads_store.clear_messages(login, thread_id)
    return {'ok': True}


@router.delete('/api/claude/threads/{thread_id:path}')
async def delete_thread(thread_id: str, login: str = Depends(get_current_user)):
    _require_allowed(login)
    ok = ai_threads_store.delete_thread(login, thread_id)
    if not ok:
        raise HTTPException(status_code=400, detail='Нельзя удалить этот тред')
    return {'ok': True}


@router.get('/api/claude/usage')
async def claude_usage_today(login: str = Depends(get_current_user)):
    _require_allowed(login)
    return claude_usage.get_today(login)


@router.get('/api/claude/usage/history')
async def claude_usage_history(days: int = 30, login: str = Depends(get_current_user)):
    _require_allowed(login)
    days = max(1, min(days, 365))
    return claude_usage.get_history(login, days)


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

    # Резолвим thread_id (по умолчанию main, или текущий пользователя)
    requested_thread = body.thread_id or ai_threads_store.get_current(login)
    # Если тред — для задачи, убедимся что он существует
    if requested_thread.startswith('task:'):
        task_id = requested_thread.split(':', 1)[1]
        t = tasks_store.get_task(login, task_id)
        if t:
            ai_threads_store.ensure_task_thread(login, task_id, t.get('title', ''))
        else:
            requested_thread = ai_threads_store.MAIN_ID
    elif not ai_threads_store.get_thread(login, requested_thread):
        requested_thread = ai_threads_store.MAIN_ID
    ai_threads_store.set_current(login, requested_thread)
    # Прокидываем в _build_system_prompt через атрибут body
    body._resolved_thread_id = requested_thread

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

    system_prompt = _build_system_prompt(client, body, attached_paths, login)

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

            # Собираем stderr — пригодится для распознавания rate-limit/quota
            stderr_buffer = []

            async def forward_stderr():
                try:
                    async for raw in proc.stderr:
                        text = raw.decode('utf-8', errors='replace').rstrip()
                        if text:
                            logger.warning(f'claude stderr: {text}')
                            stderr_buffer.append(text)
                except Exception:
                    pass

            stderr_task = asyncio.create_task(forward_stderr())

            got_partial_text = False
            tool_uses_emitted = set()
            # Сборка состояния ответа ассистента для записи в тред
            assistant_text_parts: list = []
            assistant_tools: list = []

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
                                    assistant_text_parts.append(text)
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
                                assistant_tools.append({'tool': tool_name, 'path': path})
                                yield f'event: tool\ndata: {json.dumps({"tool": tool_name, "path": path})}\n\n'
                            elif block.get('type') == 'text' and not got_partial_text:
                                text = block.get('text', '')
                                if text:
                                    assistant_text_parts.append(text)
                                    yield f'event: delta\ndata: {json.dumps({"text": text})}\n\n'
                        continue

                    if msg_type == 'result':
                        # Записываем usage и шлём свежую сводку в UI
                        usage_obj = msg.get('usage') or {}
                        try:
                            claude_usage.record_usage(login, model, usage_obj)
                        except Exception as ex:
                            logger.warning(f'usage record failed: {ex}')

                        today_summary = claude_usage.get_today(login)
                        yield f'event: usage\ndata: {json.dumps(today_summary)}\n\n'

                        # Считаем diff
                        edits = _diff_workspace(ws, snapshot)
                        edits_payload = []
                        for e in edits:
                            edits_payload.append({
                                'file_id': e['file_id'],
                                'path': e['path'],
                                'old_content': e['old_content'],
                                'new_content': e['new_content'],
                            })
                        # Логируем активность AI в задачу (тред задачи > глобальная)
                        try:
                            log_task_id = None
                            resolved_thread = getattr(body, '_resolved_thread_id', None)
                            if resolved_thread:
                                log_task_id = ai_threads_store.thread_task_id(login, resolved_thread)
                            if not log_task_id:
                                act = tasks_store.get_active_task(login)
                                log_task_id = act['id'] if act else None
                            if log_task_id:
                                if edits_payload:
                                    paths = [e['path'] for e in edits_payload]
                                    tasks_store.append_ai_log(
                                        login, log_task_id, 'edit',
                                        f'Предложено правок: {len(paths)}',
                                        files=paths,
                                    )
                                else:
                                    last_user = next((m for m in reversed(body.messages)
                                                       if m.role == 'user'), None)
                                    if last_user:
                                        tasks_store.append_ai_log(
                                            login, log_task_id, 'chat',
                                            last_user.content[:200],
                                        )
                        except Exception as ex:
                            logger.warning(f'ai_log failed: {ex}')

                        yield f'event: edits\ndata: {json.dumps({"edits": edits_payload})}\n\n'

                        # Сохраняем тред: добавляем последнее user-сообщение и
                        # собранный assistant-ответ
                        try:
                            last_user = next((m for m in reversed(body.messages)
                                              if m.role == 'user'), None)
                            new_msgs = []
                            if last_user:
                                new_msgs.append({
                                    'role': 'user',
                                    'content': last_user.content,
                                })
                            assistant_content = ''.join(assistant_text_parts)
                            new_msgs.append({
                                'role': 'assistant',
                                'content': assistant_content,
                                'tools': assistant_tools,
                                'edits': [{
                                    'file_id': e['file_id'],
                                    'path': e['path'],
                                    'old_content': e['old_content'],
                                    'new_content': e['new_content'],
                                    'status': 'pending',
                                } for e in edits_payload],
                            })
                            ai_threads_store.append_messages(
                                login, requested_thread, new_msgs,
                            )
                        except Exception as ex:
                            logger.warning(f'thread save failed: {ex}')

                        yield f'event: done\ndata: {json.dumps({"usage": usage_obj, "thread_id": requested_thread})}\n\n'

                await proc.wait()
                if proc.returncode != 0:
                    # Распознаём типовые причины
                    stderr_text = '\n'.join(stderr_buffer[-20:])
                    err_msg = f'claude CLI exit code {proc.returncode}'
                    low = stderr_text.lower()
                    if 'rate limit' in low or 'rate_limit' in low or 'too many requests' in low:
                        err_msg = 'Достигнут лимит запросов Max-подписки. Подожди до сброса окна (≈5 часов).'
                    elif 'quota' in low or 'usage limit' in low:
                        err_msg = 'Превышена квота Max-подписки. Подожди сброса окна или смени модель на более дешёвую (Haiku).'
                    elif 'unauthorized' in low or 'not logged in' in low:
                        err_msg = 'Сессия Claude CLI не авторизована. Выполни `claude login` на сервере.'
                    elif stderr_text:
                        err_msg = f'{err_msg}: {stderr_text[-300:]}'
                    yield f'event: error\ndata: {json.dumps({"error": err_msg})}\n\n'
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

    # Логируем применение в активную задачу
    if applied:
        try:
            active = tasks_store.get_active_task(login)
            if active:
                paths = [a['path'] for a in applied]
                tasks_store.append_ai_log(
                    login, active['id'], 'edit',
                    f'Применено правок: {len(paths)}',
                    files=paths,
                )
        except Exception as ex:
            logger.warning(f'ai_log apply failed: {ex}')

    return {'applied': applied, 'errors': errors}
