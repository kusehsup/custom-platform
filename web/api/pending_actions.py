"""
Хранилище pending-действий, которые AI попросил выполнить.

Используется MCP-сервером (создаёт записи) и Claude CLI routes
(читает и approve выполняет действие).

Формат web/pending_actions.json:
{
  "login": {
    "<aid>": {
      "id": str,
      "kind": "server_action" | "compile" | "console_clear" | "db_write",
      "payload": {...},
      "summary": str,
      "status": "pending" | "approved" | "rejected" | "failed",
      "result": str | None,
      "created_at": float,
      "resolved_at": float | None
    }
  }
}
"""
from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from threading import Lock
from typing import Optional

_PATH = Path(__file__).parent.parent / 'pending_actions.json'
_LOCK = Lock()

# Максимум сколько pending храним на юзера (старые архивируются)
MAX_KEEP = 50


def _read() -> dict:
    try:
        return json.loads(_PATH.read_text(encoding='utf-8'))
    except Exception:
        return {}


def _write(data: dict):
    _PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False),
                       encoding='utf-8')


def list_pending(login: str, include_resolved: bool = False) -> list[dict]:
    with _LOCK:
        bucket = _read().get(login, {})
        items = list(bucket.values())
    if not include_resolved:
        items = [x for x in items if x.get('status') == 'pending']
    items.sort(key=lambda x: x.get('created_at') or 0, reverse=True)
    return items


def list_recent_changes(login: str, since: float) -> list[dict]:
    """Записи, у которых статус изменился после `since`."""
    with _LOCK:
        bucket = _read().get(login, {})
        return [
            x for x in bucket.values()
            if (x.get('resolved_at') or x.get('created_at') or 0) > since
        ]


def get(login: str, aid: str) -> Optional[dict]:
    with _LOCK:
        return _read().get(login, {}).get(aid)


def create(login: str, kind: str, payload: dict, summary: str) -> str:
    with _LOCK:
        data = _read()
        bucket = data.setdefault(login, {})
        aid = uuid.uuid4().hex[:12]
        bucket[aid] = {
            'id': aid,
            'kind': kind,
            'payload': payload,
            'summary': summary,
            'status': 'pending',
            'result': None,
            'created_at': time.time(),
            'resolved_at': None,
        }
        # Чистим старые архивные
        if len(bucket) > MAX_KEEP:
            sorted_items = sorted(
                bucket.values(),
                key=lambda x: x.get('created_at') or 0,
                reverse=True,
            )
            keep = {x['id']: x for x in sorted_items[:MAX_KEEP]}
            data[login] = keep
        _write(data)
        return aid


def update_status(login: str, aid: str, status: str, result: Optional[str] = None):
    with _LOCK:
        data = _read()
        bucket = data.get(login) or {}
        item = bucket.get(aid)
        if not item:
            return None
        item['status'] = status
        if result is not None:
            item['result'] = result[:5000]
        item['resolved_at'] = time.time()
        _write(data)
        return item


def cleanup_old(login: str, max_age_seconds: int = 24 * 3600):
    """Удаляет старые resolved записи."""
    with _LOCK:
        data = _read()
        bucket = data.get(login) or {}
        cutoff = time.time() - max_age_seconds
        new_bucket = {
            aid: item for aid, item in bucket.items()
            if item.get('status') == 'pending'
            or (item.get('resolved_at') or 0) > cutoff
        }
        if len(new_bucket) != len(bucket):
            data[login] = new_bucket
            _write(data)
