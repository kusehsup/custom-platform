"""
Хранилище тредов AI per-user в web/ai_threads.json.

Формат:
{
  "login": {
    "threads": {
      "main": {
        "id": "main",
        "title": "Основной чат",
        "task_id": null,
        "messages": [{"role", "content", "tools": [...], "edits": [...]}],
        "created_at": iso, "updated_at": iso
      },
      "task:<tid>": {
        "id": "task:<tid>",
        "title": "<title задачи>",
        "task_id": "<tid>",
        "messages": [...],
        "created_at": iso, "updated_at": iso
      }
    },
    "current_thread": "main"
  }
}

Тред "main" существует всегда; создаётся лениво при первом обращении.
Треды задач создаются при первом сообщении в чат для этой задачи.
"""

import json
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Optional

_PATH = Path(__file__).parent.parent / 'ai_threads.json'
_LOCK = Lock()

MAIN_ID = 'main'
# Максимум сообщений в треде (ограничение чтобы файл не пух)
MAX_MESSAGES = 200


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def _read() -> dict:
    try:
        data = json.loads(_PATH.read_text(encoding='utf-8'))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _write(data: dict):
    _PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding='utf-8')


def _user_bucket(data: dict, login: str) -> dict:
    bucket = data.setdefault(login, {})
    threads = bucket.setdefault('threads', {})
    # Лениво создаём main
    if MAIN_ID not in threads:
        threads[MAIN_ID] = {
            'id': MAIN_ID,
            'title': 'Основной чат',
            'task_id': None,
            'messages': [],
            'created_at': _now(),
            'updated_at': _now(),
        }
    bucket.setdefault('current_thread', MAIN_ID)
    return bucket


def _thread_id_for_task(task_id: str) -> str:
    return f'task:{task_id}'


def list_threads(login: str) -> dict:
    """
    Возвращает {threads: [{id, title, task_id, message_count, updated_at}], current_thread}
    """
    with _LOCK:
        data = _read()
        bucket = _user_bucket(data, login)
        threads = bucket['threads']
        result = []
        for tid, t in threads.items():
            result.append({
                'id': tid,
                'title': t.get('title') or tid,
                'task_id': t.get('task_id'),
                'message_count': len(t.get('messages') or []),
                'created_at': t.get('created_at'),
                'updated_at': t.get('updated_at'),
            })
        # main сверху, дальше по updated_at desc
        result.sort(key=lambda x: (0 if x['id'] == MAIN_ID else 1, x.get('updated_at') or ''),
                    reverse=False)
        # main first, остальные — самые свежие сверху
        main = [r for r in result if r['id'] == MAIN_ID]
        rest = sorted([r for r in result if r['id'] != MAIN_ID],
                      key=lambda x: x.get('updated_at') or '', reverse=True)
        _write(data)
        return {'threads': main + rest, 'current_thread': bucket.get('current_thread', MAIN_ID)}


def get_thread(login: str, thread_id: str) -> Optional[dict]:
    with _LOCK:
        data = _read()
        bucket = _user_bucket(data, login)
        thread = bucket['threads'].get(thread_id)
        _write(data)
        return thread


def ensure_task_thread(login: str, task_id: str, task_title: str) -> dict:
    """Создаёт тред для задачи если его ещё нет. Возвращает тред."""
    with _LOCK:
        data = _read()
        bucket = _user_bucket(data, login)
        tid = _thread_id_for_task(task_id)
        if tid not in bucket['threads']:
            bucket['threads'][tid] = {
                'id': tid,
                'title': task_title or f'Задача {task_id}',
                'task_id': task_id,
                'messages': [],
                'created_at': _now(),
                'updated_at': _now(),
            }
            _write(data)
        return bucket['threads'][tid]


def set_current(login: str, thread_id: str):
    with _LOCK:
        data = _read()
        bucket = _user_bucket(data, login)
        if thread_id in bucket['threads']:
            bucket['current_thread'] = thread_id
            _write(data)


def get_current(login: str) -> str:
    with _LOCK:
        data = _read()
        bucket = _user_bucket(data, login)
        cur = bucket.get('current_thread') or MAIN_ID
        if cur not in bucket['threads']:
            cur = MAIN_ID
            bucket['current_thread'] = cur
        _write(data)
        return cur


def append_messages(login: str, thread_id: str, messages: list[dict]):
    """Добавляет сообщения и тримит до MAX_MESSAGES."""
    with _LOCK:
        data = _read()
        bucket = _user_bucket(data, login)
        thread = bucket['threads'].get(thread_id)
        if not thread:
            return
        thread.setdefault('messages', [])
        thread['messages'].extend(messages)
        if len(thread['messages']) > MAX_MESSAGES:
            thread['messages'] = thread['messages'][-MAX_MESSAGES:]
        thread['updated_at'] = _now()
        _write(data)


def replace_messages(login: str, thread_id: str, messages: list[dict]):
    """Заменяет всю историю треда (используется при обновлении состояния)."""
    with _LOCK:
        data = _read()
        bucket = _user_bucket(data, login)
        thread = bucket['threads'].get(thread_id)
        if not thread:
            return
        if len(messages) > MAX_MESSAGES:
            messages = messages[-MAX_MESSAGES:]
        thread['messages'] = messages
        thread['updated_at'] = _now()
        _write(data)


def clear_messages(login: str, thread_id: str):
    with _LOCK:
        data = _read()
        bucket = _user_bucket(data, login)
        thread = bucket['threads'].get(thread_id)
        if not thread:
            return
        thread['messages'] = []
        thread['updated_at'] = _now()
        _write(data)


def delete_thread(login: str, thread_id: str) -> bool:
    """main удалять нельзя."""
    if thread_id == MAIN_ID:
        return False
    with _LOCK:
        data = _read()
        bucket = _user_bucket(data, login)
        if thread_id in bucket['threads']:
            del bucket['threads'][thread_id]
            if bucket.get('current_thread') == thread_id:
                bucket['current_thread'] = MAIN_ID
            _write(data)
            return True
        return False


def rename_thread(login: str, thread_id: str, title: str):
    with _LOCK:
        data = _read()
        bucket = _user_bucket(data, login)
        thread = bucket['threads'].get(thread_id)
        if not thread:
            return
        thread['title'] = title.strip()[:100] or thread.get('title', thread_id)
        thread['updated_at'] = _now()
        _write(data)


# Хелпер для AI-роутов — получить task_id треда (если есть)
def thread_task_id(login: str, thread_id: str) -> Optional[str]:
    thread = get_thread(login, thread_id)
    return thread.get('task_id') if thread else None
