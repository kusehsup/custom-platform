"""
Хранит GitHub PAT и настройки репозитория в web/github.json.
Аналог totp_store.py — простой JSON-файл вне git.
"""
import json
from pathlib import Path
from typing import Optional

_PATH = Path(__file__).parent.parent / 'github.json'


def _read() -> dict:
    try:
        return json.loads(_PATH.read_text())
    except Exception:
        return {}


def _write(data: dict):
    _PATH.write_text(json.dumps(data, indent=2))


def get_config() -> dict:
    return _read()


def is_configured() -> bool:
    d = _read()
    return bool(d.get('pat') and d.get('repo'))


def save_config(pat: str, repo: str):
    d = _read()
    d['pat'] = pat
    d['repo'] = repo  # "owner/repo"
    _write(d)


def get_pat() -> Optional[str]:
    return _read().get('pat')


def get_repo() -> Optional[str]:
    return _read().get('repo')


def clear():
    _write({})
