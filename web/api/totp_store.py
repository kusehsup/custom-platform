"""
Хранит TOTP-секрет и флаг включения в файле totp.json рядом с проектом.
Не кладём в БД — платформа может быть недоступна при старте.
"""
import json
from pathlib import Path

_PATH = Path(__file__).parent.parent.parent / 'totp.json'


def _read() -> dict:
    try:
        return json.loads(_PATH.read_text())
    except Exception:
        return {}


def _write(data: dict):
    _PATH.write_text(json.dumps(data, indent=2))


def get_secret() -> str | None:
    return _read().get('secret')


def is_enabled() -> bool:
    d = _read()
    return bool(d.get('enabled') and d.get('secret'))


def setup(secret: str):
    d = _read()
    d['secret'] = secret
    d['enabled'] = False          # включается отдельно после проверки кода
    _write(d)


def enable():
    d = _read()
    d['enabled'] = True
    _write(d)


def disable():
    d = _read()
    d['enabled'] = False
    _write(d)


def remove():
    d = _read()
    d.pop('secret', None)
    d['enabled'] = False
    _write(d)
