"""
Хранит Anthropic API key и настройки модели per-user в web/claude.json.

Формат файла:
{
  "login_a": {"api_key": "...", "model": "claude-opus-4-7"},
  "login_b": {"api_key": "...", "model": "claude-sonnet-4-6"}
}
"""
import json
from pathlib import Path
from typing import Optional

_PATH = Path(__file__).parent.parent / 'claude.json'

DEFAULT_MODEL = 'claude-opus-4-7'


def _read() -> dict:
    try:
        data = json.loads(_PATH.read_text())
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _write(data: dict):
    _PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False))


def _user_config(login: str) -> dict:
    entry = _read().get(login)
    return entry if isinstance(entry, dict) else {}


def is_configured(login: str) -> bool:
    return bool(_user_config(login).get('api_key'))


def save_config(login: str, api_key: str, model: Optional[str] = None):
    data = _read()
    entry = data.get(login, {}) if isinstance(data.get(login), dict) else {}
    entry['api_key'] = api_key
    entry['model'] = model or entry.get('model') or DEFAULT_MODEL
    data[login] = entry
    _write(data)


def get_api_key(login: str) -> Optional[str]:
    return _user_config(login).get('api_key')


def get_model(login: str) -> str:
    return _user_config(login).get('model') or DEFAULT_MODEL


def set_model(login: str, model: str):
    data = _read()
    if login not in data or not isinstance(data[login], dict):
        return
    data[login]['model'] = model
    _write(data)


def clear(login: str):
    data = _read()
    data.pop(login, None)
    _write(data)
