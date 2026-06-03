"""
Постоянная "память" AI для каждого юзера.

Claude Code хранит свою память в файлах .md (например MEMORY.md, заметки).
По умолчанию память привязывается к рабочей директории — а наша
директория одноразовая (cp-ai-ws-<uuid>, удаляется после запроса).

Поэтому держим память отдельно — в web/ai_memory/<login>/ — и при
каждом запросе:
  1) копируем существующие .md файлы в workspace/memory/
  2) после ответа AI — копируем изменённые/новые .md обратно в стор

UI даёт полный CRUD прямо к web/ai_memory/<login>/.
"""
from __future__ import annotations

import shutil
from pathlib import Path
from typing import Optional

_ROOT = Path(__file__).parent.parent / 'ai_memory'

# Имя поддиректории внутри workspace где Claude увидит память.
WORKSPACE_DIR_NAME = 'memory'

# Какие расширения считаются «памятью» (для синка обратно)
ALLOWED_EXTENSIONS = {'.md', '.txt'}


def _user_dir(login: str) -> Path:
    safe = ''.join(c for c in login if c.isalnum() or c in '_-. ')[:120]
    d = _ROOT / safe
    d.mkdir(parents=True, exist_ok=True)
    return d


def _safe_rel(name: str) -> Optional[Path]:
    """Парсит относительный путь без выхода наружу."""
    if not name:
        return None
    p = Path(name.replace('\\', '/'))
    if p.is_absolute() or any(part == '..' for part in p.parts):
        return None
    if not p.parts:
        return None
    return p


# ── Чтение/CRUD ────────────────────────────────────────────────────

def list_files(login: str) -> list[dict]:
    """Возвращает список файлов в памяти юзера."""
    base = _user_dir(login)
    out = []
    for f in sorted(base.rglob('*')):
        if not f.is_file():
            continue
        if f.suffix.lower() not in ALLOWED_EXTENSIONS:
            continue
        try:
            stat = f.stat()
            out.append({
                'name': str(f.relative_to(base)).replace('\\', '/'),
                'size': stat.st_size,
                'modified': stat.st_mtime,
            })
        except OSError:
            continue
    return out


def read_file(login: str, name: str) -> Optional[str]:
    rel = _safe_rel(name)
    if not rel:
        return None
    base = _user_dir(login)
    f = (base / rel).resolve()
    try:
        f.relative_to(base.resolve())
    except ValueError:
        return None
    if not f.exists() or not f.is_file():
        return None
    if f.suffix.lower() not in ALLOWED_EXTENSIONS:
        return None
    try:
        return f.read_text(encoding='utf-8')
    except Exception:
        return None


def write_file(login: str, name: str, content: str) -> bool:
    rel = _safe_rel(name)
    if not rel:
        return False
    if rel.suffix.lower() not in ALLOWED_EXTENSIONS:
        # Допустим без расширения — добавим .md
        rel = rel.with_suffix('.md')
    base = _user_dir(login)
    f = (base / rel).resolve()
    try:
        f.relative_to(base.resolve())
    except ValueError:
        return False
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(content, encoding='utf-8')
    return True


def delete_file(login: str, name: str) -> bool:
    rel = _safe_rel(name)
    if not rel:
        return False
    base = _user_dir(login)
    f = (base / rel).resolve()
    try:
        f.relative_to(base.resolve())
    except ValueError:
        return False
    if not f.exists() or not f.is_file():
        return False
    try:
        f.unlink()
        # Чистим пустые директории-родителей
        for parent in f.parents:
            if parent == base or parent == base.resolve():
                break
            try:
                parent.rmdir()
            except OSError:
                break
        return True
    except OSError:
        return False


# ── Sync c workspace ────────────────────────────────────────────────

def copy_into_workspace(login: str, workspace: Path) -> Path:
    """
    Копирует все файлы памяти в workspace/<WORKSPACE_DIR_NAME>/.
    Возвращает путь созданной директории.
    """
    target = workspace / WORKSPACE_DIR_NAME
    target.mkdir(parents=True, exist_ok=True)
    base = _user_dir(login)
    for f in base.rglob('*'):
        if not f.is_file():
            continue
        if f.suffix.lower() not in ALLOWED_EXTENSIONS:
            continue
        rel = f.relative_to(base)
        dest = target / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.copy2(f, dest)
        except OSError:
            pass
    return target


def sync_from_workspace(login: str, workspace: Path) -> dict:
    """
    Считывает workspace/<WORKSPACE_DIR_NAME>/ и переносит изменённые/
    новые файлы обратно в стор.

    Возвращает {'updated': [...], 'created': [...], 'deleted': [...]}.
    Удалённые файлы памяти НЕ удаляются из стора автоматически — это
    защита от случайной потери (если AI что-то снёс).
    """
    base = _user_dir(login)
    src = workspace / WORKSPACE_DIR_NAME
    summary = {'updated': [], 'created': [], 'deleted': []}
    if not src.exists():
        return summary

    for f in src.rglob('*'):
        if not f.is_file():
            continue
        if f.suffix.lower() not in ALLOWED_EXTENSIONS:
            continue
        rel = f.relative_to(src)
        dest = base / rel
        is_new = not dest.exists()
        old_content = ''
        if not is_new:
            try:
                old_content = dest.read_text(encoding='utf-8')
            except Exception:
                pass
        try:
            new_content = f.read_text(encoding='utf-8')
        except Exception:
            continue
        if old_content == new_content:
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(new_content, encoding='utf-8')
        if is_new:
            summary['created'].append(str(rel).replace('\\', '/'))
        else:
            summary['updated'].append(str(rel).replace('\\', '/'))
    return summary
