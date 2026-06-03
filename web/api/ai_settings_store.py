"""
Хранилище настроек AI per-user в web/ai_settings.json.

Сейчас содержит только daily_budget_usd — мягкий лимит. При
превышении показывается баннер; запросы НЕ блокируются.
"""
import json
from pathlib import Path
from threading import Lock
from typing import Optional

_PATH = Path(__file__).parent.parent / 'ai_settings.json'
_LOCK = Lock()

DEFAULT_DAILY_BUDGET = 5.0  # $


def _read() -> dict:
    try:
        return json.loads(_PATH.read_text(encoding='utf-8'))
    except Exception:
        return {}


def _write(data: dict):
    _PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False),
                       encoding='utf-8')


def get_settings(login: str) -> dict:
    return _read().get(login) or {'daily_budget_usd': DEFAULT_DAILY_BUDGET}


def set_daily_budget(login: str, value: Optional[float]):
    with _LOCK:
        data = _read()
        bucket = data.setdefault(login, {})
        if value is None or value <= 0:
            bucket.pop('daily_budget_usd', None)
        else:
            bucket['daily_budget_usd'] = float(value)
        _write(data)


def get_daily_budget(login: str) -> Optional[float]:
    s = get_settings(login)
    val = s.get('daily_budget_usd')
    return float(val) if val and val > 0 else None
