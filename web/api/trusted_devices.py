"""
Trusted devices — фиксируем пары (login, fingerprint) после успешного
входа с TOTP. На следующих логинах с того же IP+User-Agent TOTP не
требуется, если запись не истекла.

Хранилище: web/trusted_devices.json
{
  "login": [
    {"fp": "<sha256>", "ip": "...", "ua_short": "...",
     "added_at": iso, "last_seen": iso, "expires_at": iso}
  ]
}
"""

import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Lock

_PATH = Path(__file__).parent.parent / 'trusted_devices.json'
_LOCK = Lock()

TRUST_DAYS = 60  # сколько дней доверяем устройству без повторного TOTP


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _read() -> dict:
    try:
        data = json.loads(_PATH.read_text(encoding='utf-8'))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _write(data: dict):
    _PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding='utf-8')


def _fingerprint(ip: str, user_agent: str) -> str:
    """Стабильный отпечаток устройства. UA нормализуем до основной части."""
    ip = (ip or '').strip()
    ua = (user_agent or '').strip()
    src = f'{ip}|{ua}'
    return hashlib.sha256(src.encode('utf-8')).hexdigest()


def is_trusted(login: str, ip: str, user_agent: str) -> bool:
    if not login or not ip:
        return False
    fp = _fingerprint(ip, user_agent)
    now = _now()
    with _LOCK:
        data = _read()
        entries = data.get(login, [])
        changed = False
        result = False
        new_entries = []
        for e in entries:
            try:
                exp = datetime.fromisoformat(e.get('expires_at'))
            except Exception:
                exp = None
            if exp and exp < now:
                changed = True
                continue
            new_entries.append(e)
            if e.get('fp') == fp:
                e['last_seen'] = now.isoformat(timespec='seconds')
                changed = True
                result = True
        if changed:
            data[login] = new_entries
            _write(data)
        return result


def trust(login: str, ip: str, user_agent: str):
    """Добавить устройство в доверенные (или продлить срок)."""
    if not login or not ip:
        return
    fp = _fingerprint(ip, user_agent)
    now = _now()
    expires = now + timedelta(days=TRUST_DAYS)
    with _LOCK:
        data = _read()
        entries = data.get(login, [])
        # Обновляем существующую запись если есть
        found = False
        for e in entries:
            if e.get('fp') == fp:
                e['last_seen'] = now.isoformat(timespec='seconds')
                e['expires_at'] = expires.isoformat(timespec='seconds')
                e['ip'] = ip
                e['ua_short'] = (user_agent or '')[:120]
                found = True
                break
        if not found:
            entries.append({
                'fp': fp,
                'ip': ip,
                'ua_short': (user_agent or '')[:120],
                'added_at': now.isoformat(timespec='seconds'),
                'last_seen': now.isoformat(timespec='seconds'),
                'expires_at': expires.isoformat(timespec='seconds'),
            })
        # Ограничим количество записей
        entries = entries[-20:]
        data[login] = entries
        _write(data)


def list_devices(login: str) -> list[dict]:
    """Список устройств юзера (для будущей UI-страницы)."""
    with _LOCK:
        return list(_read().get(login, []))


def revoke(login: str, fp: str):
    """Удалить устройство из доверенных."""
    with _LOCK:
        data = _read()
        entries = data.get(login, [])
        data[login] = [e for e in entries if e.get('fp') != fp]
        _write(data)
