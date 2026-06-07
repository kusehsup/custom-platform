"""
MCP-сервер для Claude Code CLI.

Запускается как отдельный subprocess (stdio JSON-RPC) при каждом
/api/claude/chat. Все доступы к платформе/БД идут HTTP-запросами в
тот же FastAPI на http://127.0.0.1:<port>/api/... — там есть полная
сессия PlatformClient юзера.

Инструменты:
  ▸ Read-only — выполняются сразу:
    - get_server_status, get_console_log, get_last_compile
    - db_list_databases, db_list_tables, db_describe_table, db_select

  ▸ Write — создают pending action; фронт показывает карточку с
    кнопкой подтверждения, исполняется только после approve:
    - server_action (start/stop/restart), compile, console_clear
    - db_write (INSERT/UPDATE/DELETE/REPLACE)

Переменные окружения от FastAPI:
  CP_AI_BASE_URL   — корень API (http://127.0.0.1:PORT)
  CP_AI_AUTH_TOKEN — Bearer токен для запросов
  CP_AI_USER_LOGIN — логин юзера (для pending action ownership)

DROP/TRUNCATE/ALTER и подобные команды запрещены ещё до создания
pending action.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import urllib.error
from pathlib import Path

_ROOT = Path(__file__).parent.parent

# Логи MCP идут в stderr (stdout зарезервирован под JSON-RPC)
def log(msg: str):
    print(f'[mcp] {msg}', file=sys.stderr, flush=True)


LOGIN = os.environ.get('CP_AI_USER_LOGIN', '')
BASE_URL = os.environ.get('CP_AI_BASE_URL', 'http://127.0.0.1:8000').rstrip('/')
AUTH_TOKEN = os.environ.get('CP_AI_AUTH_TOKEN', '')


def _http(method: str, path: str, json_body: dict | None = None,
          params: dict | None = None) -> dict:
    """Синхронный HTTP-запрос к FastAPI."""
    import urllib.parse
    import urllib.request

    url = BASE_URL + path
    if params:
        url += ('&' if '?' in url else '?') + urllib.parse.urlencode(params)
    data = None
    headers = {}
    if AUTH_TOKEN:
        headers['Authorization'] = f'Bearer {AUTH_TOKEN}'
    if json_body is not None:
        data = json.dumps(json_body).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode('utf-8', errors='replace')
            if not body:
                return {}
            try:
                return json.loads(body)
            except Exception:
                return {'_raw': body}
    except urllib.error.HTTPError as e:
        try:
            err_body = e.read().decode('utf-8', errors='replace')
            err_json = json.loads(err_body)
            detail = err_json.get('detail') or err_body
        except Exception:
            detail = str(e)
        return {'_error': f'HTTP {e.code}: {detail}'}
    except Exception as e:
        return {'_error': str(e)}


# ── SQL safety ─────────────────────────────────────────────────────────

_FORBIDDEN_SQL = re.compile(
    r'\b(DROP|TRUNCATE|ALTER|GRANT|REVOKE|RENAME|CREATE\s+DATABASE|'
    r'DROP\s+DATABASE)\b',
    re.IGNORECASE,
)


def is_select(sql: str) -> bool:
    s = sql.strip().lstrip('(').lstrip()
    return s[:6].upper() in ('SELECT', 'SHOW S', 'SHOW T', 'SHOW C',
                              'EXPLAI', 'DESCRI')


def sql_forbidden_reason(sql: str) -> str | None:
    if _FORBIDDEN_SQL.search(sql):
        return ('Эта команда (DROP/TRUNCATE/ALTER/GRANT/REVOKE/RENAME) '
                'полностью запрещена для AI. Попроси пользователя '
                'выполнить её вручную.')
    return None


# ── Pending actions storage (через HTTP endpoint, чтобы избежать
#    race condition с FastAPI поверх одного и того же JSON-файла) ──────

def create_pending(_login: str, kind: str, payload: dict, summary: str) -> str:
    r = _http('POST', '/api/claude/pending_actions/_create', json_body={
        'kind': kind, 'payload': payload, 'summary': summary,
    })
    if r.get('_error'):
        return f'error:{r["_error"]}'
    return r.get('id') or 'unknown'


# ── Tool implementations (HTTP-based) ──────────────────────────────────

def tool_get_server_status(_args: dict) -> str:
    r = _http('GET', '/api/status')
    if r.get('_error'):
        return f'Не удалось получить статус: {r["_error"]}'
    return (
        f'server: {r.get("server", "unknown")}\n'
        f'compile_in_progress: {r.get("compile", False)}'
    )


def tool_get_console_log(args: dict) -> str:
    limit = int(args.get('limit') or 200)
    limit = max(1, min(limit, 2000))
    r = _http('GET', '/api/console/recent', params={'limit': limit})
    if r.get('_error'):
        return f'Не удалось получить логи: {r["_error"]}'
    lines = [e['line'] for e in r.get('lines') or []]
    return '\n'.join(lines) if lines else '(буфер пуст)'


def tool_get_last_compile(_args: dict) -> str:
    """Берём последний результат компиляции из платформы через API."""
    r = _http('GET', '/api/debug/appdata')
    if r.get('_error'):
        return f'Ошибка: {r["_error"]}'
    # У нас есть только summary через debug/appdata. Реальный текст
    # лежит в платформе но наружу не торчит — используем кэш фронта
    # через /api/console/recent если последний компиль попал в лог.
    # Лучше всего попросить юзера явно сохранить.
    return ('Текст последней компиляции наружу не отдаётся напрямую. '
            'Попроси пользователя открыть «Последний результат» в UI '
            'или используй get_console_log чтобы увидеть прогресс.')


def tool_db_list_databases(_args: dict) -> str:
    r = _http('GET', '/api/db/databases')
    if r.get('_error'):
        return f'Ошибка: {r["_error"]}'
    return '\n'.join(r.get('databases') or [])


def tool_db_list_tables(args: dict) -> str:
    db = args.get('database') or ''
    if not db:
        return 'Не указана база. Используй db_list_databases чтобы посмотреть доступные.'
    r = _http('GET', '/api/db/tables', params={'database': db})
    if r.get('_error'):
        return f'Ошибка: {r["_error"]}'
    return '\n'.join(r.get('tables') or [])


def tool_db_describe_table(args: dict) -> str:
    db = args.get('database') or ''
    table = args.get('table') or ''
    if not (db and table):
        return 'Нужны параметры database и table.'
    r = _http('POST', '/api/db/structure', json_body={'database': db, 'table': table})
    if r.get('_error'):
        return f'Ошибка: {r["_error"]}'
    headers = r.get('columns_headers') or []
    cols = r.get('columns') or []
    if not cols:
        return '(структура пуста)'
    lines = [' | '.join(headers[:7])]
    for row in cols:
        lines.append(' | '.join(str(x) for x in row[:7]))
    return '\n'.join(lines)


def tool_db_select(args: dict) -> str:
    sql = args.get('sql') or ''
    if not sql.strip():
        return 'Пустой SQL.'
    if not is_select(sql):
        return ('Этот инструмент принимает ТОЛЬКО SELECT/SHOW/EXPLAIN/DESCRIBE. '
                'Для записи используй db_write — она запросит подтверждение.')
    reason = sql_forbidden_reason(sql)
    if reason:
        return reason
    db = args.get('database') or ''
    r = _http('POST', '/api/db/query', json_body={'sql': sql, 'database': db})
    if r.get('_error'):
        return f'Ошибка SQL: {r["_error"]}'
    cols = r.get('columns') or []
    rows = r.get('rows') or []
    if not cols:
        return f'Затронуто строк: {r.get("affected", 0)}'
    if not rows:
        return '(пусто)'
    lines = [' | '.join(cols)]
    for row in rows[:50]:
        lines.append(' | '.join(str(x) if x is not None else 'NULL' for x in row))
    suffix = ''
    if len(rows) > 50:
        suffix = f'\n\n(показано первые 50 из {len(rows)})'
    return '\n'.join(lines) + suffix


# ── Write tools — создают pending action ───────────────────────────────

def tool_server_action(args: dict) -> str:
    action = (args.get('action') or '').lower()
    if action not in ('start', 'stop', 'restart'):
        return 'action должен быть start | stop | restart'
    r = _http('POST', '/api/claude/mcp_exec/server_action',
              json_body={'action': action})
    if r.get('_error'):
        return f'Ошибка: {r["_error"]}'
    return r.get('message', 'OK')


def tool_compile(_args: dict) -> str:
    r = _http('POST', '/api/claude/mcp_exec/compile', json_body={})
    if r.get('_error'):
        return f'Ошибка: {r["_error"]}'
    return r.get('message', 'OK')


def tool_console_clear(_args: dict) -> str:
    r = _http('POST', '/api/claude/mcp_exec/console_clear', json_body={})
    if r.get('_error'):
        return f'Ошибка: {r["_error"]}'
    return r.get('message', 'OK')


def _flatten_blocks(blocks, depth: int = 0, path: list = None) -> list:
    """Рекурсивно собираем имена блоков из дерева поиска платформы.

    Платформа возвращает {block_id: {name, lines, children: {...}}} или
    плоский dict {block_id: block_data} с возможными вложенностями.
    """
    if path is None:
        path = []
    out = []
    if not isinstance(blocks, dict):
        return out
    for bid, bdata in blocks.items():
        if not isinstance(bdata, dict):
            continue
        name = bdata.get('name') or bdata.get('queryName') or bid
        lines = bdata.get('lines') or bdata.get('line') or ''
        block_path = path + [name]
        out.append({
            'path': ' › '.join(block_path),
            'lines': lines,
        })
        # Children — могут лежать под 'children' или прямо в нём
        children = bdata.get('children')
        if isinstance(children, dict):
            out.extend(_flatten_blocks(children, depth + 1, block_path))
    return out


def tool_search_code(args: dict) -> str:
    """
    Поиск по ВСЕМУ Pawn-коду игрового сервера через платформу (map_find).
    Read-only, выполняется сразу.
    """
    text = args.get('text') or ''
    file = args.get('file') or '-1'
    regexp = bool(args.get('regexp'))
    if not text.strip():
        return 'Пустой поисковый запрос.'
    if len(text) > 200:
        return 'Слишком длинный запрос (>200 символов).'

    body = {'text': text, 'file': file, 'regexp': regexp}
    start_line = args.get('start_line')
    end_line = args.get('end_line')
    if start_line:
        body['start_line'] = str(start_line)
    if end_line:
        body['end_line'] = str(end_line)

    r = _http('POST', '/api/search', json_body=body)
    if r.get('_error'):
        return f'Ошибка поиска: {r["_error"]}'

    result = r.get('result')
    # Спецзначения от платформы
    if result == 'too_much':
        return 'Слишком много результатов — уточни запрос (text/file/range).'
    if result == 'regex_incorrect':
        return 'Некорректный regexp.'
    if not result or not isinstance(result, dict):
        return '(ничего не найдено)'

    # Резолвим file_id → fullPath через /api/files
    files_resp = _http('GET', '/api/files')
    files_map = (files_resp or {}).get('files') or {}

    lines_out = ['# Найдено по всему коду сервера:']
    total_blocks = 0
    total_files = 0

    for file_id, file_data in result.items():
        if not file_data:
            continue
        # file_data — это dict блоков; могут быть пустыми
        blocks = _flatten_blocks(file_data)
        if not blocks:
            continue
        meta = files_map.get(str(file_id)) or files_map.get(file_id) or {}
        fname = meta.get('fullPath') or meta.get('name') or f'#{file_id}'
        lines_out.append(f'\n## {fname}  (file_id={file_id})')
        for b in blocks[:25]:  # ограничение блоков на файл
            ln = b['lines'] or '?'
            lines_out.append(f'  - {b["path"]} (строки {ln})')
            total_blocks += 1
            if total_blocks >= 200:
                break
        total_files += 1
        if total_blocks >= 200 or total_files >= 60:
            lines_out.append('\n…(вывод обрезан, уточни запрос)')
            break

    lines_out.append(
        f'\nИтого: {total_blocks} блоков в {total_files} файлах. '
        f'Если нужен сам код одного из блоков — используй '
        f'mcp__cp-ai__request_code_access (file_name, query_name).'
    )
    return '\n'.join(lines_out)


# Глобальный счётчик запросов доступа в текущей сессии MCP-процесса
# (новый процесс на каждый chat — счётчик автоматически сбрасывается)
_access_requests_count = 0
ACCESS_REQUESTS_PER_CHAT = 3


def tool_request_code_access(args: dict) -> str:
    """Создаёт pending action — запрос доступа к фрагменту кода.

    Ограничение: не более ACCESS_REQUESTS_PER_CHAT в одном ответе AI.
    """
    global _access_requests_count
    if _access_requests_count >= ACCESS_REQUESTS_PER_CHAT:
        return (f'Достигнут лимит запросов доступа в одном ответе '
                f'({ACCESS_REQUESTS_PER_CHAT}). Дай пользователю ответить — '
                f'можно будет запросить ещё.')

    file_name = (args.get('file_name') or '').strip()
    query_name = (args.get('query_name') or '').strip()
    if not file_name or not query_name:
        return 'Нужны параметры file_name и query_name (название/строки нужного фрагмента).'

    aid = create_pending(LOGIN, 'request_code_access',
                          {'file_name': file_name, 'query_name': query_name},
                          f'Запросить доступ к коду: {file_name} → {query_name}')
    _access_requests_count += 1
    return (f'Создано подтверждение #{aid}: «Запросить доступ к коду '
            f'{file_name} → {query_name}». После подтверждения модератор '
            f'получит запрос; код придёт через несколько минут или часов '
            f'(не дожидайся — продолжай разговор без него).')


def tool_task_list_brief(_args: dict) -> str:
    """
    Список существующих задач С ИХ КЕЙСАМИ — нужен AI чтобы не плодить
    дубликаты. Каждый кейс выводим коротким title (≤100 символов).
    """
    r = _http('GET', '/api/tasks')
    if r.get('_error'):
        return f'Ошибка: {r["_error"]}'
    tasks = r.get('tasks') or []
    if not tasks:
        return ('(задач пока нет)\n\n'
                'Можешь смело создавать новые через task_add_case '
                '(он создаст задачу по task_title автоматически).')
    lines = ['# Существующие задачи и их кейсы']
    lines.append('')
    lines.append('⚠️ ВНИМАТЕЛЬНО просмотри ниже перед добавлением — '
                  'если похожий кейс УЖЕ ЕСТЬ, НЕ добавляй повторно.')
    lines.append('')
    for t in tasks[:50]:
        cases = t.get('cases') or []
        lines.append(
            f'## [{t.get("status")}] {t.get("title")} '
            f'(id={t.get("id")}, кейсов: {len(cases)})'
        )
        if cases:
            for c in cases[:50]:
                title = (c.get('title') or '').strip()[:120]
                lines.append(f'  - [{c.get("status")}] {title}')
        lines.append('')
    return '\n'.join(lines).rstrip()


def tool_task_create(args: dict) -> str:
    title = (args.get('title') or '').strip()
    if not title:
        return 'Нужен title.'
    description = args.get('description') or ''
    priority = args.get('priority') or 'medium'
    r = _http('POST', '/api/tasks', json_body={
        'title': title,
        'description': description,
        'priority': priority,
        'make_active': False,
    })
    if r.get('_error'):
        return f'Ошибка: {r["_error"]}'
    task = r.get('task') or {}
    return f'Создана задача "{task.get("title")}" (id={task.get("id")}).'


def tool_task_add_case(args: dict) -> str:
    """
    Добавляет кейс в задачу.
    Если task_id указан — используем его.
    Если task_title — ищем существующую по точному совпадению; не находим — создаём.
    """
    case_title = (args.get('case_title') or '').strip()
    if not case_title:
        return 'Нужен case_title.'

    task_id = args.get('task_id') or ''
    task_title = (args.get('task_title') or '').strip()

    # Резолвим task_id
    if not task_id:
        if not task_title:
            return 'Нужен task_id ИЛИ task_title.'
        # Ищем существующую
        existing = _http('GET', '/api/tasks')
        if not existing.get('_error'):
            for t in existing.get('tasks') or []:
                if (t.get('title') or '').strip().lower() == task_title.lower():
                    task_id = t.get('id')
                    break
        if not task_id:
            # Создаём
            r = _http('POST', '/api/tasks', json_body={
                'title': task_title,
                'description': '',
                'priority': 'medium',
                'make_active': False,
            })
            if r.get('_error'):
                return f'Не удалось создать задачу: {r["_error"]}'
            task_id = (r.get('task') or {}).get('id')
            if not task_id:
                return 'Не удалось получить id новой задачи.'

    # Сначала получим текущий список кейсов чтобы понять создался ли новый
    before = _http('GET', f'/api/tasks')
    before_ids = set()
    if not before.get('_error'):
        for t in before.get('tasks') or []:
            if t.get('id') == task_id:
                before_ids = {c.get('id') for c in (t.get('cases') or [])}
                break

    body = {
        'title': case_title,
        'description': args.get('description') or '',
        'priority': args.get('priority') or 'medium',
        'attached_files': args.get('attached_files') or [],
    }
    r = _http('POST', f'/api/tasks/{task_id}/cases', json_body=body)
    if r.get('_error'):
        return f'Ошибка: {r["_error"]}'

    cases_after = (r.get('task') or {}).get('cases') or []
    new_cases = [c for c in cases_after if c.get('id') not in before_ids]
    if not new_cases:
        return (f'⚠️ Кейс "{case_title}" УЖЕ СУЩЕСТВУЕТ в задаче id={task_id}. '
                f'Пропустил создание дубликата. Перед следующим добавлением '
                f'свежий список существующих кейсов: вызови task_list_brief заново.')

    case_id = new_cases[0].get('id', '')

    # Дозаписываем AI-поля если переданы
    extras = {}
    if args.get('ai_analysis'):
        extras['ai_analysis'] = args['ai_analysis']
    if args.get('ai_proposal'):
        extras['ai_proposal'] = args['ai_proposal']
    if extras and case_id:
        _http('PATCH', f'/api/tasks/{task_id}/cases/{case_id}', json_body=extras)

    return f'Добавлен кейс "{case_title}" в задачу id={task_id} (case_id={case_id}).'


def tool_task_get(args: dict) -> str:
    """Полная карточка одной задачи со ВСЕМИ полями кейсов."""
    task_id = (args.get('task_id') or '').strip()
    if not task_id:
        return 'Нужен task_id.'
    r = _http('GET', '/api/tasks')
    if r.get('_error'):
        return f'Ошибка: {r["_error"]}'
    task = next((t for t in r.get('tasks') or [] if t.get('id') == task_id), None)
    if not task:
        return f'Задача id={task_id} не найдена.'
    lines = [f'# {task.get("title")}  (id={task["id"]})',
             f'статус: {task.get("status")} · приоритет: {task.get("priority")}']
    if task.get('description'):
        lines.append('')
        lines.append('## Описание')
        lines.append(task['description'][:1500])
    cases = task.get('cases') or []
    if cases:
        lines.append('')
        lines.append(f'## Кейсы ({len(cases)})')
        for c in cases:
            lines.append('')
            lines.append(f'### [{c.get("status")}] {c.get("title")}  (case_id={c["id"]})')
            desc = (c.get('description') or '').strip()
            if desc:
                lines.append(f'**Описание:** {desc[:500]}')
            ana = (c.get('ai_analysis') or '').strip()
            if ana:
                lines.append(f'**AI-анализ:** {ana[:400]}')
            prop = (c.get('ai_proposal') or '').strip()
            if prop:
                lines.append(f'**AI-предложение:** {prop[:400]}')
    else:
        lines.append('')
        lines.append('(кейсов нет)')
    return '\n'.join(lines)


def tool_task_delete_batch(args: dict) -> str:
    """
    Запрос на удаление пачки задач/кейсов. Создаёт ОДНО подтверждение
    с полным списком — пользователь подтверждает все сразу либо все
    отклоняет.

    Аргументы:
      items: [{"kind": "task" | "case", "task_id": str, "case_id": str?, "reason": str?}]
    """
    items = args.get('items') or []
    if not isinstance(items, list) or not items:
        return 'Нужно items (непустой массив объектов с kind/task_id[/case_id]).'
    if len(items) > 100:
        return 'Слишком большая пачка (>100). Разбей на несколько вызовов.'

    # Резолвим красивые заголовки чтобы карточка подтверждения была информативной
    tasks_resp = _http('GET', '/api/tasks')
    tasks_map = {}
    if not tasks_resp.get('_error'):
        for t in tasks_resp.get('tasks') or []:
            tasks_map[t.get('id')] = t

    normalized = []
    summary_lines = []
    for it in items:
        kind = (it.get('kind') or '').lower()
        if kind not in ('task', 'case'):
            continue
        task_id = it.get('task_id') or ''
        if not task_id:
            continue
        if kind == 'task':
            t = tasks_map.get(task_id)
            label = t.get('title') if t else f'(id={task_id})'
            normalized.append({'kind': 'task', 'task_id': task_id})
            summary_lines.append(f'• задача «{label}»')
        else:
            case_id = it.get('case_id') or ''
            if not case_id:
                continue
            t = tasks_map.get(task_id) or {}
            c = next((c for c in t.get('cases') or [] if c.get('id') == case_id), {})
            task_title = t.get('title', f'id={task_id}')
            case_title = c.get('title', f'id={case_id}')
            normalized.append({
                'kind': 'case', 'task_id': task_id, 'case_id': case_id,
            })
            summary_lines.append(f'• кейс «{case_title}» из «{task_title}»')

    if not normalized:
        return 'Ничего не распознал для удаления.'

    summary = f'Удалить {len(normalized)} элементов:\n' + '\n'.join(summary_lines[:30])
    if len(summary_lines) > 30:
        summary += f'\n…и ещё {len(summary_lines) - 30}'

    aid = create_pending(LOGIN, 'task_delete_batch',
                          {'items': normalized}, summary)
    return (f'Создано подтверждение #{aid} на удаление {len(normalized)} элементов. '
            f'Пользователь должен нажать «Подтвердить» в чате. '
            f'Не вызывай инструмент повторно — жди решения пользователя.')


def tool_case_merge_batch(args: dict) -> str:
    """
    Запрос на слияние кейсов пачкой. Каждая операция: source-кейс
    сливается в target-кейс и удаляется.

    Аргументы:
      merges: [{"source_task_id", "source_case_id",
                 "target_task_id", "target_case_id", "reason"?}]
    """
    merges = args.get('merges') or []
    if not isinstance(merges, list) or not merges:
        return 'Нужно merges (массив объектов).'
    if len(merges) > 50:
        return 'Слишком большая пачка (>50). Разбей.'

    tasks_resp = _http('GET', '/api/tasks')
    tasks_map = {}
    if not tasks_resp.get('_error'):
        for t in tasks_resp.get('tasks') or []:
            tasks_map[t.get('id')] = t

    normalized = []
    summary_lines = []
    for m in merges:
        s_tid = m.get('source_task_id') or ''
        s_cid = m.get('source_case_id') or ''
        t_tid = m.get('target_task_id') or ''
        t_cid = m.get('target_case_id') or ''
        if not (s_tid and s_cid and t_tid and t_cid):
            continue
        if s_cid == t_cid:
            continue

        s_task = tasks_map.get(s_tid) or {}
        t_task = tasks_map.get(t_tid) or {}
        s_case = next((c for c in s_task.get('cases') or [] if c.get('id') == s_cid), {})
        t_case = next((c for c in t_task.get('cases') or [] if c.get('id') == t_cid), {})
        s_lbl = s_case.get('title', f'id={s_cid}')
        t_lbl = t_case.get('title', f'id={t_cid}')

        normalized.append({
            'source_task_id': s_tid, 'source_case_id': s_cid,
            'target_task_id': t_tid, 'target_case_id': t_cid,
        })
        summary_lines.append(f'• «{s_lbl}» → «{t_lbl}»')

    if not normalized:
        return 'Ничего не распознал для merge.'

    summary = (f'Слить {len(normalized)} пар кейсов '
                f'(source удаляется, его описание добавится к target):\n'
                + '\n'.join(summary_lines[:30]))
    if len(summary_lines) > 30:
        summary += f'\n…и ещё {len(summary_lines) - 30}'

    aid = create_pending(LOGIN, 'case_merge_batch',
                          {'merges': normalized}, summary)
    return (f'Создано подтверждение #{aid} на слияние {len(normalized)} пар. '
            f'Пользователь должен нажать «Подтвердить».')


def tool_db_write(args: dict) -> str:
    sql = args.get('sql') or ''
    db = args.get('database') or ''
    if not sql.strip():
        return 'Пустой SQL.'
    reason = sql_forbidden_reason(sql)
    if reason:
        return reason
    if is_select(sql):
        return ('Это SELECT — используй db_select, она выполняется сразу '
                'без подтверждения.')
    # Грубый sanity check: команда должна начинаться с INSERT/UPDATE/DELETE
    first_word = sql.strip().split(None, 1)[0].upper()
    if first_word not in ('INSERT', 'UPDATE', 'DELETE', 'REPLACE'):
        return ('db_write принимает только INSERT/UPDATE/DELETE/REPLACE. '
                f'Получено: {first_word}.')
    aid = create_pending(LOGIN, 'db_write', {'sql': sql, 'database': db},
                          f'Выполнить SQL: {sql[:200]}')
    return (f'Создано подтверждение #{aid}. SQL:\n```sql\n{sql}\n```\n'
            f'Пользователь должен нажать «Подтвердить».')


# ── Tools registry ─────────────────────────────────────────────────────

TOOLS = {
    'get_server_status': {
        'fn': tool_get_server_status,
        'description': 'Текущий статус игрового сервера и идёт ли компиляция.',
        'input': {'type': 'object', 'properties': {}, 'required': []},
    },
    'get_console_log': {
        'fn': tool_get_console_log,
        'description': 'Последние N строк серверной консоли (логи).',
        'input': {
            'type': 'object',
            'properties': {
                'limit': {'type': 'integer', 'description': 'Сколько строк (по умолчанию 200, макс 2000).'},
            },
        },
    },
    'get_last_compile': {
        'fn': tool_get_last_compile,
        'description': 'Текст последнего результата компиляции.',
        'input': {'type': 'object', 'properties': {}, 'required': []},
    },
    'db_list_databases': {
        'fn': tool_db_list_databases,
        'description': 'Список доступных MySQL-баз.',
        'input': {'type': 'object', 'properties': {}, 'required': []},
    },
    'db_list_tables': {
        'fn': tool_db_list_tables,
        'description': 'Список таблиц в указанной базе.',
        'input': {
            'type': 'object',
            'properties': {'database': {'type': 'string'}},
            'required': ['database'],
        },
    },
    'db_describe_table': {
        'fn': tool_db_describe_table,
        'description': 'Описание колонок и индексов таблицы.',
        'input': {
            'type': 'object',
            'properties': {
                'database': {'type': 'string'},
                'table': {'type': 'string'},
            },
            'required': ['database', 'table'],
        },
    },
    'db_select': {
        'fn': tool_db_select,
        'description': ('Выполнить SELECT/SHOW/EXPLAIN/DESCRIBE. '
                        'Возвращает первые 500 строк (50 в ответе AI). '
                        'НЕ принимает INSERT/UPDATE/DELETE.'),
        'input': {
            'type': 'object',
            'properties': {
                'sql': {'type': 'string'},
                'database': {'type': 'string', 'description': 'Опционально: какую базу использовать.'},
            },
            'required': ['sql'],
        },
    },
    'server_action': {
        'fn': tool_server_action,
        'description': ('Запустить/остановить/перезапустить игровой сервер. '
                        'Выполняется сразу.'),
        'input': {
            'type': 'object',
            'properties': {
                'action': {'type': 'string', 'enum': ['start', 'stop', 'restart']},
            },
            'required': ['action'],
        },
    },
    'compile': {
        'fn': tool_compile,
        'description': 'Запустить компиляцию сразу.',
        'input': {'type': 'object', 'properties': {}, 'required': []},
    },
    'console_clear': {
        'fn': tool_console_clear,
        'description': 'Очистить буфер серверной консоли.',
        'input': {'type': 'object', 'properties': {}, 'required': []},
    },
    'db_write': {
        'fn': tool_db_write,
        'description': ('Запросить подтверждение на INSERT/UPDATE/DELETE/REPLACE. '
                        'DROP/TRUNCATE/ALTER/GRANT/REVOKE/RENAME запрещены. '
                        'Не выполняется автоматически.'),
        'input': {
            'type': 'object',
            'properties': {
                'sql': {'type': 'string'},
                'database': {'type': 'string'},
            },
            'required': ['sql'],
        },
    },
    'search_code': {
        'fn': tool_search_code,
        'description': ('Поиск по Pawn-коду через платформу. Возвращает '
                        'найденные строки с номерами. Это read-only, '
                        'выполняется сразу. Лимит вывода — 100 совпадений.'),
        'input': {
            'type': 'object',
            'properties': {
                'text': {'type': 'string', 'description': 'Что искать'},
                'file': {'type': 'string', 'description': 'ID файла или -1 (по всем)'},
                'regexp': {'type': 'boolean', 'description': 'Использовать regexp'},
                'start_line': {'type': 'string'},
                'end_line': {'type': 'string'},
            },
            'required': ['text'],
        },
    },
    'request_code_access': {
        'fn': tool_request_code_access,
        'description': ('Создать запрос на доступ к фрагменту кода — '
                        'это требует подтверждения пользователя и одобрения '
                        'модератора. Используй только если фрагмент реально '
                        'нужен. Не больше 3 запросов в одном ответе.'),
        'input': {
            'type': 'object',
            'properties': {
                'file_name': {'type': 'string'},
                'query_name': {'type': 'string', 'description': 'Название блока/функции или диапазон строк'},
            },
            'required': ['file_name', 'query_name'],
        },
    },
    'task_list_brief': {
        'fn': tool_task_list_brief,
        'description': ('Короткий обзор существующих задач: title, status, '
                        'id, сколько кейсов. Используй перед добавлением '
                        'нового кейса, чтобы не плодить дубликаты.'),
        'input': {'type': 'object', 'properties': {}, 'required': []},
    },
    'task_create': {
        'fn': tool_task_create,
        'description': ('Создать новую задачу верхнего уровня. Возвращает id. '
                        'Перед созданием убедись через task_list_brief, что '
                        'похожей задачи нет.'),
        'input': {
            'type': 'object',
            'properties': {
                'title': {'type': 'string'},
                'description': {'type': 'string'},
                'priority': {'type': 'string', 'enum': ['low', 'medium', 'high']},
            },
            'required': ['title'],
        },
    },
    'task_get': {
        'fn': tool_task_get,
        'description': ('Полная карточка одной задачи: описание задачи + '
                        'все её кейсы с описанием, ai_analysis, ai_proposal. '
                        'Используй ПЕРЕД анализом на дубликаты — task_list_brief '
                        'показывает только заголовки.'),
        'input': {
            'type': 'object',
            'properties': {'task_id': {'type': 'string'}},
            'required': ['task_id'],
        },
    },
    'task_delete_batch': {
        'fn': tool_task_delete_batch,
        'description': ('Удалить пачку задач/кейсов. Создаёт ОДНУ карточку '
                        'подтверждения со всем списком — пользователь жмёт '
                        '«Подтвердить» один раз и все удаляются. Удаление '
                        'НЕОБРАТИМО, поэтому требуется ручное подтверждение.\n\n'
                        'Используй для дедупа: сначала task_get на каждую '
                        'задачу с подозрением, собери список дублей, ОДИН раз '
                        'вызови этот инструмент с полным items.'),
        'input': {
            'type': 'object',
            'properties': {
                'items': {
                    'type': 'array',
                    'items': {
                        'type': 'object',
                        'properties': {
                            'kind': {'type': 'string', 'enum': ['task', 'case']},
                            'task_id': {'type': 'string'},
                            'case_id': {'type': 'string'},
                            'reason': {'type': 'string'},
                        },
                        'required': ['kind', 'task_id'],
                    },
                },
            },
            'required': ['items'],
        },
    },
    'case_merge_batch': {
        'fn': tool_case_merge_batch,
        'description': ('Слияние нескольких пар кейсов. Source-кейс '
                        'сливается в target (описание добавляется, файлы '
                        'объединяются, AI-поля переносятся если у target '
                        'пусто), потом удаляется. Тоже через подтверждение.\n\n'
                        'Используй когда два кейса похожи но не идентичны: '
                        'тот в котором меньше деталей сливается в более '
                        'богатый.'),
        'input': {
            'type': 'object',
            'properties': {
                'merges': {
                    'type': 'array',
                    'items': {
                        'type': 'object',
                        'properties': {
                            'source_task_id': {'type': 'string'},
                            'source_case_id': {'type': 'string'},
                            'target_task_id': {'type': 'string'},
                            'target_case_id': {'type': 'string'},
                            'reason': {'type': 'string'},
                        },
                        'required': ['source_task_id', 'source_case_id',
                                      'target_task_id', 'target_case_id'],
                    },
                },
            },
            'required': ['merges'],
        },
    },
    'task_add_case': {
        'fn': tool_task_add_case,
        'description': ('Добавить КЕЙС (подзадачу) к задаче. Можно указать '
                        'task_id или task_title — если task_title совпадает '
                        'с существующей задачей, кейс добавится туда; иначе '
                        'будет создана новая задача с этим title.\n\n'
                        'ai_analysis и ai_proposal — твой анализ и предложение '
                        'как фиксить. Они отобразятся отдельными блоками в '
                        'карточке кейса. Не пиши код в proposal — для кода '
                        'есть отдельный шаг (Edit/Write в workspace позже).'),
        'input': {
            'type': 'object',
            'properties': {
                'task_id': {'type': 'string', 'description': 'id существующей задачи (опционально)'},
                'task_title': {'type': 'string', 'description': 'или заголовок: если задача с таким title есть — кейс уйдёт туда, иначе создастся новая задача'},
                'case_title': {'type': 'string'},
                'description': {'type': 'string'},
                'priority': {'type': 'string', 'enum': ['low', 'medium', 'high']},
                'attached_files': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'file_id Pawn-файлов, к которым относится кейс',
                },
                'ai_analysis': {'type': 'string', 'description': 'твой краткий анализ'},
                'ai_proposal': {'type': 'string', 'description': 'твоё предложение по решению (markdown, без кода)'},
            },
            'required': ['case_title'],
        },
    },
}


# ── JSON-RPC server loop ────────────────────────────────────────────────

def respond(req_id, result=None, error=None):
    msg = {'jsonrpc': '2.0', 'id': req_id}
    if error is not None:
        msg['error'] = error
    else:
        msg['result'] = result
    sys.stdout.write(json.dumps(msg) + '\n')
    sys.stdout.flush()


async def serve():
    log(f'starting, login={LOGIN}')
    reader = asyncio.StreamReader()
    proto = asyncio.StreamReaderProtocol(reader)
    loop = asyncio.get_event_loop()
    await loop.connect_read_pipe(lambda: proto, sys.stdin)

    while True:
        try:
            line = await reader.readline()
        except Exception as e:
            log(f'read error: {e}')
            break
        if not line:
            break
        line_s = line.decode('utf-8', errors='replace').strip()
        if not line_s:
            continue
        try:
            req = json.loads(line_s)
        except Exception:
            continue
        req_id = req.get('id')
        method = req.get('method')
        params = req.get('params') or {}

        if method == 'initialize':
            respond(req_id, {
                'protocolVersion': '2024-11-05',
                'capabilities': {'tools': {}},
                'serverInfo': {'name': 'cp-ai-mcp', 'version': '1.0.0'},
            })
        elif method == 'notifications/initialized':
            pass
        elif method == 'tools/list':
            tools = []
            for name, t in TOOLS.items():
                tools.append({
                    'name': name,
                    'description': t['description'],
                    'inputSchema': t['input'],
                })
            respond(req_id, {'tools': tools})
        elif method == 'tools/call':
            tname = params.get('name')
            targs = params.get('arguments') or {}
            tool = TOOLS.get(tname)
            if not tool:
                respond(req_id, error={'code': -32601, 'message': f'Unknown tool {tname}'})
                continue
            try:
                out = tool['fn'](targs)
            except Exception as e:
                log(f'tool {tname} crash: {e}')
                out = f'Ошибка: {e}'
            respond(req_id, {
                'content': [{'type': 'text', 'text': str(out)}],
                'isError': False,
            })
        elif method == 'ping':
            respond(req_id, {})
        else:
            respond(req_id, error={'code': -32601, 'message': f'Unknown method {method}'})


if __name__ == '__main__':
    try:
        asyncio.run(serve())
    except KeyboardInterrupt:
        pass
