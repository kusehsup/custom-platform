"""
TOTP-секреты per-user. Хранятся в web/totp.json.

Формат файла (v2):
{
  "users": {
    "login": {
      "secret":  "BASE32...",
      "enabled": true|false
    }
  }
}

Совместимость с легаси (v1, до правок безопасности):
{
  "secret": "BASE32...",
  "enabled": true|false
}
— это «глобальный» секрет, который ошибочно применялся ко всем юзерам.
При загрузке мы НЕ применяем его автоматически (это была бы дыра),
а сохраняем под отдельным ключом users['__legacy__']. Юзер должен
явно настроить свой TOTP заново через /settings.
"""

import json
from pathlib import Path
from threading import Lock
from typing import Optional

_PATH = Path(__file__).parent.parent / 'totp.json'
_LOCK = Lock()


def _read() -> dict:
    try:
        data = json.loads(_PATH.read_text(encoding='utf-8'))
    except Exception:
        return {'users': {}}
    if not isinstance(data, dict):
        return {'users': {}}
    # Уже v2 — возвращаем как есть, гарантируя users ключ
    if 'users' in data and isinstance(data['users'], dict):
        return data
    # Legacy v1: миграция в v2. Никаких юзеров, легаси-секрет под спец-ключом.
    migrated = {'users': {}}
    if data.get('secret'):
        migrated['users']['__legacy__'] = {
            'secret': data.get('secret'),
            'enabled': False,   # не применяем автоматически
            'note': 'Legacy global TOTP, не активен. Настрой 2FA заново.',
        }
    return migrated


def _write(data: dict):
    _PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding='utf-8')


def _user(data: dict, login: str) -> dict:
    users = data.setdefault('users', {})
    if not isinstance(users, dict):
        users = {}
        data['users'] = users
    return users.setdefault(login, {})


# ── Per-user API ────────────────────────────────────────────────────

def is_enabled(login: str) -> bool:
    if not login:
        return False
    with _LOCK:
        data = _read()
        u = data.get('users', {}).get(login) or {}
        return bool(u.get('enabled') and u.get('secret'))


def get_secret(login: str) -> Optional[str]:
    if not login:
        return None
    with _LOCK:
        data = _read()
        u = data.get('users', {}).get(login) or {}
        return u.get('secret')


def has_secret(login: str) -> bool:
    return get_secret(login) is not None


def setup(login: str, secret: str):
    """Кладёт новый секрет (но НЕ включает — нужен enable() после verify)."""
    if not login:
        return
    with _LOCK:
        data = _read()
        u = _user(data, login)
        u['secret'] = secret
        u['enabled'] = False
        _write(data)


def enable(login: str):
    if not login:
        return
    with _LOCK:
        data = _read()
        u = _user(data, login)
        u['enabled'] = True
        _write(data)


def disable(login: str):
    if not login:
        return
    with _LOCK:
        data = _read()
        u = _user(data, login)
        u['enabled'] = False
        _write(data)


def remove(login: str):
    """Полностью убирает TOTP у юзера."""
    if not login:
        return
    with _LOCK:
        data = _read()
        users = data.get('users', {})
        if login in users:
            users.pop(login, None)
            _write(data)
