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

import os
import shutil
from pathlib import Path
from typing import Optional

_ROOT = Path(__file__).parent.parent / 'ai_memory'

# Имя поддиректории внутри workspace где Claude увидит память.
WORKSPACE_DIR_NAME = 'memory'

# Какие расширения считаются «памятью» (для синка обратно)
ALLOWED_EXTENSIONS = {'.md', '.txt'}


def _claude_projects_dir() -> Path:
    """~/.claude/projects — где Claude Code сам кэширует автопамять."""
    return Path(os.path.expanduser('~/.claude/projects'))


def _workspace_claude_hash_dir(workspace: Path) -> Path:
    """
    Каталог автопамяти Claude для конкретного workspace.
    Claude Code превращает абсолютный путь cwd в slug (точки/слэши
    становятся дефисами) и хранит там memory/, history.jsonl и т.п.
    """
    abs_path = str(workspace.resolve())
    slug = abs_path.replace('/', '-').replace('\\', '-').replace('.', '-')
    return _claude_projects_dir() / slug


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

def _migrate_orphan_claude_memory(login: str):
    """
    Однократно при первом обращении: подбираем .md/.txt из всех
    оставленных каталогов Claude Code (~/.claude/projects/-tmp-cp-ai-ws-*/memory/).
    Это покрывает старые запросы, чья память записалась до того
    как мы научились синкать её обратно.
    """
    base = _user_dir(login)
    flag = base / '.claude_orphan_imported'
    if flag.exists():
        return
    projects = _claude_projects_dir()
    if not projects.exists():
        flag.write_text('', encoding='utf-8')
        return
    summary = {'updated': [], 'created': [], 'deleted': []}
    for hash_dir in projects.iterdir():
        if not hash_dir.is_dir():
            continue
        # Берём только наши воркспейсы (содержат 'tmp-cp-ai-ws')
        if 'tmp-cp-ai-ws' not in hash_dir.name and 'cp-ai-ws' not in hash_dir.name:
            continue
        mem = hash_dir / 'memory'
        if mem.exists():
            _sync_from_dir(base, mem, summary, prefix='claude_auto/')
    flag.write_text('', encoding='utf-8')


def list_files(login: str) -> list[dict]:
    """Возвращает список файлов в памяти юзера."""
    base = _user_dir(login)
    _migrate_orphan_claude_memory(login)
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
    Раскладывает накопленную память в два места, чтобы Claude её увидел:
      1) workspace/<WORKSPACE_DIR_NAME>/ — основное расположение, через
         системный промпт направляем сюда Read/Glob/Write.
      2) ~/.claude/projects/<workspace-slug>/memory/ — куда Claude
         сам кэширует автопамять. Кладём туда же файлы из claude_auto/
         нашего стора, чтобы в этом разговоре он видел свои прошлые заметки.
    Возвращает путь основного каталога (1).
    """
    base = _user_dir(login)
    target = workspace / WORKSPACE_DIR_NAME
    target.mkdir(parents=True, exist_ok=True)
    claude_dir = _workspace_claude_hash_dir(workspace) / 'memory'
    claude_dir.mkdir(parents=True, exist_ok=True)

    for f in base.rglob('*'):
        if not f.is_file():
            continue
        if f.suffix.lower() not in ALLOWED_EXTENSIONS:
            continue
        rel = f.relative_to(base)
        rel_str = str(rel).replace('\\', '/')

        if rel_str.startswith('claude_auto/'):
            # Это автопамять Claude — кладём обратно в его системную папку
            sub_rel = Path(*rel.parts[1:])  # отрезаем 'claude_auto'
            dest = claude_dir / sub_rel
        else:
            dest = target / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.copy2(f, dest)
        except OSError:
            pass
    return target


def _sync_from_dir(base: Path, src: Path, summary: dict, prefix: str = ''):
    """Пройти src и записать новые/изменённые .md/.txt в base.

    `prefix` — опциональный подкаталог под который складывать
    (например 'claude_auto/' чтобы отделить автопамять Claude от
    того что юзер сам пишет в корне).
    """
    if not src.exists():
        return
    for f in src.rglob('*'):
        if not f.is_file():
            continue
        if f.suffix.lower() not in ALLOWED_EXTENSIONS:
            continue
        rel = f.relative_to(src)
        rel_str = str(rel).replace('\\', '/')
        if prefix:
            dest_rel = Path(prefix) / rel
        else:
            dest_rel = rel
        dest = base / dest_rel
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
        dest_rel_str = str(dest_rel).replace('\\', '/')
        if is_new:
            summary['created'].append(dest_rel_str)
        else:
            summary['updated'].append(dest_rel_str)


def sync_from_workspace(login: str, workspace: Path) -> dict:
    """
    Сливает обратно в стор:
      1) workspace/<WORKSPACE_DIR_NAME>/ — то что мы подсовывали и AI редактировал
      2) ~/.claude/projects/<workspace-slug>/memory/ — автопамять Claude Code
         (он пишет туда независимо от наших папок)

    Удалённые файлы памяти НЕ удаляются из стора — защита от случайной
    потери, если AI что-то снёс.
    """
    base = _user_dir(login)
    summary = {'updated': [], 'created': [], 'deleted': []}

    # 1) Наш каталог в workspace
    _sync_from_dir(base, workspace / WORKSPACE_DIR_NAME, summary)

    # 2) Системная автопамять Claude — кладём под claude_auto/ чтобы не конфликтовать
    claude_mem = _workspace_claude_hash_dir(workspace) / 'memory'
    _sync_from_dir(base, claude_mem, summary, prefix='claude_auto/')

    return summary
