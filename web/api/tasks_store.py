"""
Хранилище задач per-user в web/tasks.json.

Формат файла:
{
  "login": {
    "tasks": {
      "<task_id>": {
        "id": "uuid12",
        "title": str,
        "description": str (markdown),
        "status": "open" | "in_progress" | "done" | "blocked",
        "priority": "low" | "medium" | "high",
        "attached_files": [file_id, ...],       // Pawn-файлы платформы
        "attachments": [                         // скриншоты/файлы (хранятся в web/uploads/)
          {"id": str, "name": str, "url": str, "size": int, "kind": "image"|"file"}
        ],
        "notes": [                               // комменты/история
          {"at": iso, "text": str}
        ],
        "ai_log": [                              // что AI делал по задаче
          {"at": iso, "kind": "edit"|"chat", "summary": str, "files": [path]}
        ],
        "created_at": iso,
        "updated_at": iso,
        "completed_at": iso | null
      }
    },
    "active_task_id": str | null     // одна "активная" задача
  }
}
"""

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Optional

_PATH = Path(__file__).parent.parent / 'tasks.json'
_LOCK = Lock()

VALID_STATUS = {'open', 'in_progress', 'done', 'blocked'}
VALID_PRIORITY = {'low', 'medium', 'high'}


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
    bucket = data.setdefault(login, {'tasks': {}, 'active_task_id': None})
    bucket.setdefault('tasks', {})
    bucket.setdefault('active_task_id', None)
    return bucket


def list_tasks(login: str, status: Optional[str] = None) -> list[dict]:
    data = _read()
    bucket = _user_bucket(data, login)
    tasks = list(bucket['tasks'].values())
    if status:
        tasks = [t for t in tasks if t.get('status') == status]
    # Сортировка: сначала в работе, потом open, потом blocked, потом done
    order = {'in_progress': 0, 'open': 1, 'blocked': 2, 'done': 3}
    tasks.sort(key=lambda t: (order.get(t.get('status'), 9), t.get('updated_at', ''),), reverse=False)
    return tasks


def get_task(login: str, task_id: str) -> Optional[dict]:
    data = _read()
    return _user_bucket(data, login)['tasks'].get(task_id)


def get_active_task(login: str) -> Optional[dict]:
    data = _read()
    bucket = _user_bucket(data, login)
    tid = bucket.get('active_task_id')
    if not tid:
        return None
    return bucket['tasks'].get(tid)


def get_active_task_id(login: str) -> Optional[str]:
    data = _read()
    return _user_bucket(data, login).get('active_task_id')


def set_active_task(login: str, task_id: Optional[str]):
    with _LOCK:
        data = _read()
        bucket = _user_bucket(data, login)
        if task_id and task_id not in bucket['tasks']:
            raise ValueError('Задача не найдена')
        bucket['active_task_id'] = task_id
        _write(data)


def create_task(login: str, title: str, description: str = '',
                priority: str = 'medium',
                attached_files: Optional[list] = None,
                make_active: bool = True) -> dict:
    with _LOCK:
        data = _read()
        bucket = _user_bucket(data, login)
        tid = uuid.uuid4().hex[:12]
        now = _now()
        task = {
            'id': tid,
            'title': title.strip()[:200] or 'Без названия',
            'description': description or '',
            'status': 'open',
            'priority': priority if priority in VALID_PRIORITY else 'medium',
            'attached_files': list(attached_files or []),
            'attachments': [],
            'notes': [],
            'ai_log': [],
            'created_at': now,
            'updated_at': now,
            'completed_at': None,
        }
        bucket['tasks'][tid] = task
        if make_active:
            bucket['active_task_id'] = tid
        _write(data)
        return task


def update_task(login: str, task_id: str, **fields) -> dict:
    """Обновляет произвольные поля задачи."""
    with _LOCK:
        data = _read()
        bucket = _user_bucket(data, login)
        task = bucket['tasks'].get(task_id)
        if not task:
            raise KeyError('Задача не найдена')

        for k, v in fields.items():
            if k == 'status':
                if v not in VALID_STATUS:
                    continue
                task['status'] = v
                task['completed_at'] = _now() if v == 'done' else None
            elif k == 'priority':
                if v in VALID_PRIORITY:
                    task['priority'] = v
            elif k == 'title':
                if isinstance(v, str) and v.strip():
                    task['title'] = v.strip()[:200]
            elif k == 'description':
                if isinstance(v, str):
                    task['description'] = v
            elif k == 'attached_files':
                if isinstance(v, list):
                    task['attached_files'] = [str(x) for x in v]
            else:
                continue

        task['updated_at'] = _now()
        _write(data)
        return task


def delete_task(login: str, task_id: str) -> bool:
    with _LOCK:
        data = _read()
        bucket = _user_bucket(data, login)
        if task_id not in bucket['tasks']:
            return False
        del bucket['tasks'][task_id]
        if bucket.get('active_task_id') == task_id:
            bucket['active_task_id'] = None
        _write(data)
        return True


def add_note(login: str, task_id: str, text: str) -> dict:
    with _LOCK:
        data = _read()
        bucket = _user_bucket(data, login)
        task = bucket['tasks'].get(task_id)
        if not task:
            raise KeyError('Задача не найдена')
        task.setdefault('notes', []).append({'at': _now(), 'text': text})
        task['updated_at'] = _now()
        _write(data)
        return task


def add_attachment(login: str, task_id: str, attachment: dict) -> dict:
    with _LOCK:
        data = _read()
        bucket = _user_bucket(data, login)
        task = bucket['tasks'].get(task_id)
        if not task:
            raise KeyError('Задача не найдена')
        task.setdefault('attachments', []).append(attachment)
        task['updated_at'] = _now()
        _write(data)
        return task


def remove_attachment(login: str, task_id: str, attachment_id: str) -> Optional[dict]:
    """Удаляет attachment, возвращает удалённый (чтобы удалить файл с диска)."""
    with _LOCK:
        data = _read()
        bucket = _user_bucket(data, login)
        task = bucket['tasks'].get(task_id)
        if not task:
            raise KeyError('Задача не найдена')
        attachments = task.get('attachments', [])
        removed = None
        for i, a in enumerate(attachments):
            if a.get('id') == attachment_id:
                removed = attachments.pop(i)
                break
        if removed:
            task['updated_at'] = _now()
            _write(data)
        return removed


def append_ai_log(login: str, task_id: str, kind: str, summary: str,
                  files: Optional[list] = None):
    """Дописывает строку в журнал AI-активности по задаче."""
    with _LOCK:
        data = _read()
        bucket = _user_bucket(data, login)
        task = bucket['tasks'].get(task_id)
        if not task:
            return
        task.setdefault('ai_log', []).append({
            'at': _now(),
            'kind': kind,
            'summary': summary[:500],
            'files': files or [],
        })
        # Ограничим длину лога чтобы файл не пух
        if len(task['ai_log']) > 100:
            task['ai_log'] = task['ai_log'][-100:]
        task['updated_at'] = _now()
        _write(data)
