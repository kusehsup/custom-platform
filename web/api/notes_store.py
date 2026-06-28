"""
Хранилище заметок per-user в web/notes.json.

Формат файла:
{
  "login": {
    "<note_id>": {
      "id": str,
      "title": str,
      "body": str,           # markdown
      "share_token": str | None,
      "share_enabled": bool,
      "created_at": iso,
      "updated_at": iso
    }
  }
}

Помимо bucket'ов пользователей, держим глобальный обратный индекс
token → (login, note_id) для быстрого resolve публичных ссылок.
"""

import json
import secrets
import uuid
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Optional

_PATH = Path(__file__).parent.parent / 'notes.json'
_LOCK = Lock()


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


def _bucket(data: dict, login: str) -> dict:
    return data.setdefault(login, {})


def list_notes(login: str) -> list[dict]:
    with _LOCK:
        data = _read()
        notes = list(_bucket(data, login).values())
    notes.sort(key=lambda n: n.get('updated_at', ''), reverse=True)
    # Не возвращаем body в списке — он может быть большим
    return [
        {k: v for k, v in n.items() if k != 'body'}
        for n in notes
    ]


def get_note(login: str, note_id: str) -> Optional[dict]:
    with _LOCK:
        data = _read()
        return _bucket(data, login).get(note_id)


VALID_KINDS = {'markdown', 'html'}


def create_note(login: str, title: str = '', body: str = '', kind: str = 'markdown') -> dict:
    nid = uuid.uuid4().hex[:12]
    now = _now()
    if kind not in VALID_KINDS:
        kind = 'markdown'
    note = {
        'id': nid,
        'title': title or 'Без названия',
        'body': body or '',
        'kind': kind,
        'share_token': None,
        'share_enabled': False,
        'created_at': now,
        'updated_at': now,
    }
    with _LOCK:
        data = _read()
        _bucket(data, login)[nid] = note
        _write(data)
    return note


def update_note(login: str, note_id: str, *,
                title: Optional[str] = None,
                body: Optional[str] = None,
                kind: Optional[str] = None) -> Optional[dict]:
    with _LOCK:
        data = _read()
        b = _bucket(data, login)
        note = b.get(note_id)
        if not note:
            return None
        if title is not None:
            note['title'] = title or 'Без названия'
        if body is not None:
            note['body'] = body
        if kind is not None and kind in VALID_KINDS:
            note['kind'] = kind
        note['updated_at'] = _now()
        _write(data)
        return note


def delete_note(login: str, note_id: str) -> bool:
    with _LOCK:
        data = _read()
        b = _bucket(data, login)
        if note_id not in b:
            return False
        b.pop(note_id, None)
        _write(data)
        return True


def set_share(login: str, note_id: str, enabled: bool) -> Optional[dict]:
    """Включить/выключить публичный доступ. Возвращает обновлённую заметку."""
    with _LOCK:
        data = _read()
        b = _bucket(data, login)
        note = b.get(note_id)
        if not note:
            return None
        if enabled:
            if not note.get('share_token'):
                note['share_token'] = secrets.token_urlsafe(12)
            note['share_enabled'] = True
        else:
            note['share_enabled'] = False
            # Токен оставляем, чтобы при повторном включении ссылка
            # осталась прежней. Если хочешь revoke — выключи и снова включи
            # с regenerate (см. regenerate_token).
        note['updated_at'] = _now()
        _write(data)
        return note


def regenerate_token(login: str, note_id: str) -> Optional[dict]:
    with _LOCK:
        data = _read()
        b = _bucket(data, login)
        note = b.get(note_id)
        if not note:
            return None
        note['share_token'] = secrets.token_urlsafe(12)
        note['updated_at'] = _now()
        _write(data)
        return note


def find_by_token(token: str) -> Optional[dict]:
    """Найти публичную (share_enabled=True) заметку по токену."""
    if not token:
        return None
    with _LOCK:
        data = _read()
    for login, bucket in data.items():
        if not isinstance(bucket, dict):
            continue
        for note in bucket.values():
            if (
                isinstance(note, dict)
                and note.get('share_enabled')
                and note.get('share_token') == token
            ):
                return note
    return None
