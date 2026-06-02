"""
Учёт расхода токенов Claude per-user per-day.

Хранится в web/claude_usage.json:
{
  "login": {
    "YYYY-MM-DD": {
      "by_model": {
        "sonnet": {"input": int, "output": int, "cache_create": int, "cache_read": int, "requests": int}
      }
    }
  }
}

Стоимости считаются по официальной таблице Anthropic для соответствующих
моделей (input/output/cache). Это оценка, не точный счёт.
"""

import json
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Optional

_PATH = Path(__file__).parent.parent / 'claude_usage.json'
_LOCK = Lock()

# $ за миллион токенов.
PRICING = {
    'sonnet': {'input': 3.00, 'output': 15.00, 'cache_create': 3.75, 'cache_read': 0.30},
    'opus':   {'input': 15.00, 'output': 75.00, 'cache_create': 18.75, 'cache_read': 1.50},
    'haiku':  {'input': 1.00, 'output': 5.00, 'cache_create': 1.25, 'cache_read': 0.10},
}


def _read() -> dict:
    try:
        data = json.loads(_PATH.read_text(encoding='utf-8'))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _write(data: dict):
    _PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding='utf-8')


def _today() -> str:
    return datetime.now(timezone.utc).strftime('%Y-%m-%d')


def record_usage(login: str, model: str, usage: Optional[dict]):
    """
    Записывает потребление. `usage` приходит от claude CLI в финальном
    result-событии. Формат:
        {input_tokens, output_tokens, cache_creation_input_tokens,
         cache_read_input_tokens}
    """
    if not usage:
        return

    with _LOCK:
        data = _read()
        user_data = data.setdefault(login, {})
        day_data = user_data.setdefault(_today(), {'by_model': {}})
        by_model = day_data.setdefault('by_model', {})
        m = by_model.setdefault(model, {
            'input': 0, 'output': 0, 'cache_create': 0, 'cache_read': 0, 'requests': 0,
        })
        m['input']        += int(usage.get('input_tokens') or 0)
        m['output']       += int(usage.get('output_tokens') or 0)
        m['cache_create'] += int(usage.get('cache_creation_input_tokens') or 0)
        m['cache_read']   += int(usage.get('cache_read_input_tokens') or 0)
        m['requests']     += 1
        _write(data)


def _cost_for(model: str, m: dict) -> float:
    p = PRICING.get(model)
    if not p:
        return 0.0
    return (
        m['input']        * p['input']        / 1_000_000 +
        m['output']       * p['output']       / 1_000_000 +
        m['cache_create'] * p['cache_create'] / 1_000_000 +
        m['cache_read']   * p['cache_read']   / 1_000_000
    )


def get_today(login: str) -> dict:
    """Сводка за сегодня."""
    data = _read()
    today = data.get(login, {}).get(_today(), {})
    by_model = today.get('by_model', {})
    total_in = total_out = total_cache_create = total_cache_read = total_requests = 0
    total_cost = 0.0
    models_out = {}
    for model, m in by_model.items():
        cost = _cost_for(model, m)
        models_out[model] = {**m, 'cost_usd': round(cost, 4)}
        total_in            += m['input']
        total_out           += m['output']
        total_cache_create  += m['cache_create']
        total_cache_read    += m['cache_read']
        total_requests      += m['requests']
        total_cost          += cost
    return {
        'date': _today(),
        'by_model': models_out,
        'total_input': total_in,
        'total_output': total_out,
        'total_cache_create': total_cache_create,
        'total_cache_read': total_cache_read,
        'total_requests': total_requests,
        'total_cost_usd': round(total_cost, 4),
    }


def get_history(login: str, days: int = 30) -> dict:
    """История за последние N дней."""
    data = _read()
    user_data = data.get(login, {})
    sorted_days = sorted(user_data.keys(), reverse=True)[:days]
    history = []
    for d in sorted_days:
        day = user_data[d]
        by_model = day.get('by_model', {})
        total_in = total_out = total_requests = 0
        total_cost = 0.0
        for model, m in by_model.items():
            total_in       += m['input']
            total_out      += m['output']
            total_requests += m['requests']
            total_cost     += _cost_for(model, m)
        history.append({
            'date': d,
            'total_input': total_in,
            'total_output': total_out,
            'total_requests': total_requests,
            'total_cost_usd': round(total_cost, 4),
        })
    return {'days': history}
