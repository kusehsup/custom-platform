"""
Хранит GitHub PAT и настройки репозитория per-user в web/github.json.

Формат файла:
{
  "login_a": {"pat": "...", "repo": "owner/repo"},
  "login_b": {"pat": "...", "repo": "owner/repo"}
}
"""
import json
from pathlib import Path
from typing import Optional

_PATH = Path(__file__).parent.parent / 'github.json'


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


def get_config(login: str) -> dict:
    return _user_config(login)


def is_configured(login: str) -> bool:
    d = _user_config(login)
    return bool(d.get('pat') and d.get('repo'))


def save_config(login: str, pat: str, repo: str):
    data = _read()
    data[login] = {'pat': pat, 'repo': repo}
    _write(data)


def get_pat(login: str) -> Optional[str]:
    return _user_config(login).get('pat')


def get_repo(login: str) -> Optional[str]:
    return _user_config(login).get('repo')


def clear(login: str):
    data = _read()
    data.pop(login, None)
    _write(data)
