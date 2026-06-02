"""
GitHub интеграция — архив/бэкап кода в личный репозиторий.

Endpoints:
  POST /api/github/connect   — сохранить PAT + repo, проверить доступ
  DELETE /api/github/connect — отключить GitHub
  GET  /api/github/status    — статус подключения
  GET  /api/github/history/{file_id} — история коммитов по файлу
  GET  /api/github/file/{file_id}    — содержимое файла из архива (по SHA)
  POST /api/github/sync      — ручная синхронизация всех доступных файлов
"""

import asyncio
import base64
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .auth import get_current_user
from .sessions import get_session
from . import github_store

logger = logging.getLogger('github')
router = APIRouter()

GITHUB_API = 'https://api.github.com'
HEADERS_BASE = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
}


# ── Helpers ────────────────────────────────────────────────────────────

def _headers(pat: str) -> dict:
    return {**HEADERS_BASE, 'Authorization': f'Bearer {pat}'}


async def _gh(method: str, path: str, pat: str, **kwargs) -> dict:
    """Выполнить запрос к GitHub API."""
    try:
        import httpx
    except ImportError:
        raise HTTPException(status_code=500, detail='httpx не установлен. Выполните: pip install httpx')
    url = f'{GITHUB_API}{path}'
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.request(method, url, headers=_headers(pat), **kwargs)
    if resp.status_code >= 400:
        detail = resp.json().get('message', resp.text) if resp.content else resp.status_code
        raise HTTPException(status_code=resp.status_code, detail=f'GitHub: {detail}')
    if resp.status_code == 204:
        return {}
    return resp.json()


def _file_path_for(client, file_id: str) -> str:
    """Построить путь к файлу в репо из метаданных платформы."""
    meta = client.files.get(file_id, {})
    full = meta.get('fullPath') or meta.get('name') or f'file_{file_id}'
    # Убираем ведущий слэш если есть
    return full.lstrip('/')


def _build_content(client, file_id: str) -> str:
    """Собрать текст файла из доступных parts."""
    parts = client.code.get(file_id, [])
    if not parts:
        return ''
    # Сортируем по номеру строки
    sorted_parts = sorted(parts, key=lambda p: p.get('line', 0))
    lines = []
    for part in sorted_parts:
        content = part.get('content', '')
        if lines:
            lines.append('')  # пустая строка-разделитель между частями
        lines.append(content)
    return '\n'.join(lines)


async def _init_repo_if_empty(pat: str, repo: str, branch: str):
    """
    Если репо полностью пустое — создаёт README через /contents/ API
    (единственный способ инициализировать пустой репо).
    После этого Git Data API начинает работать.
    """
    repo_data = await _gh('GET', f'/repos/{repo}', pat)
    if repo_data.get('size', 0) != 0:
        return  # репо не пустое, всё ок

    # Репо пустое — создаём README в нужной ветке
    readme = (
        '# CustomPlatform Archive\n\n'
        'Автоматический архив кода из CustomPlatform.\n'
    )
    await _gh('PUT', f'/repos/{repo}/contents/README.md', pat, json={
        'message': 'init: CustomPlatform archive',
        'content': base64.b64encode(readme.encode()).decode(),
        'branch': branch,
    })


async def _get_branch_sha(pat: str, repo: str, branch: str) -> Optional[str]:
    """Получить SHA последнего коммита ветки. None если ветки нет."""
    try:
        data = await _gh('GET', f'/repos/{repo}/git/ref/heads/{branch}', pat)
        return data['object']['sha']
    except HTTPException as e:
        if e.status_code == 404:
            return None
        raise


async def commit_file(pat: str, repo: str, file_path: str, content: str,
                      message: str, branch: str = 'platform/archive'):
    """Закоммитить один файл через Git Data API."""
    # Инициализируем репо если пустой
    await _init_repo_if_empty(pat, repo, branch)

    # 1. Создаём blob с содержимым файла
    blob = await _gh('POST', f'/repos/{repo}/git/blobs', pat, json={
        'content': content,
        'encoding': 'utf-8',
    })

    # 2. Получаем SHA базового коммита (если ветка существует)
    base_sha = await _get_branch_sha(pat, repo, branch)

    # 3. Получаем базовое дерево (если есть)
    tree_params: dict = {
        'tree': [{
            'path': file_path,
            'mode': '100644',
            'type': 'blob',
            'sha': blob['sha'],
        }]
    }
    if base_sha:
        # Получаем SHA дерева базового коммита
        base_commit = await _gh('GET', f'/repos/{repo}/git/commits/{base_sha}', pat)
        tree_params['base_tree'] = base_commit['tree']['sha']

    # 4. Создаём дерево
    tree = await _gh('POST', f'/repos/{repo}/git/trees', pat, json=tree_params)

    # 5. Создаём коммит
    commit_body: dict = {
        'message': message,
        'tree': tree['sha'],
        'parents': [base_sha] if base_sha else [],
    }
    commit = await _gh('POST', f'/repos/{repo}/git/commits', pat, json=commit_body)

    # 6. Обновляем или создаём ветку
    ref = f'refs/heads/{branch}'
    if base_sha:
        await _gh('PATCH', f'/repos/{repo}/git/refs/heads/{branch}', pat,
                  json={'sha': commit['sha']})
    else:
        await _gh('POST', f'/repos/{repo}/git/refs', pat,
                  json={'ref': ref, 'sha': commit['sha']})


# ── Schemas ────────────────────────────────────────────────────────────

class ConnectRequest(BaseModel):
    pat: str
    repo: str  # "owner/repo"


# ── Endpoints ──────────────────────────────────────────────────────────

@router.post('/api/github/connect')
async def github_connect(body: ConnectRequest, login: str = Depends(get_current_user)):
    """Проверить PAT + repo и сохранить конфигурацию."""
    import traceback as _tb
    try:
        return await _github_connect_impl(body)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f'[DEBUG] {type(e).__name__}: {e}\n{_tb.format_exc()}')


async def _github_connect_impl(body: ConnectRequest):
    pat = body.pat.strip()
    repo = body.repo.strip().strip('/')

    if '/' not in repo:
        raise HTTPException(status_code=400, detail='Репозиторий должен быть в формате owner/repo')

    # Проверяем токен
    try:
        user_data = await _gh('GET', '/user', pat)
    except HTTPException:
        raise HTTPException(status_code=401, detail='Неверный токен GitHub (PAT)')

    # Проверяем доступ к репо
    try:
        repo_data = await _gh('GET', f'/repos/{repo}', pat)
    except HTTPException as e:
        if e.status_code == 404:
            raise HTTPException(status_code=404, detail=f'Репозиторий {repo} не найден или нет доступа')
        raise

    # Проверяем права на запись
    perms = repo_data.get('permissions', {})
    if not perms.get('push', False):
        raise HTTPException(status_code=403, detail='Нет прав на запись в репозиторий')

    # Убеждаемся что ветка platform/archive существует
    try:
        await _ensure_branch(pat, repo, 'platform/archive')
    except HTTPException as e:
        logger.warning(f'Не удалось создать ветку platform/archive: {e.detail}')

    github_store.save_config(pat, repo)
    logger.info(f'GitHub подключён: {user_data.get("login")} → {repo}')

    return {
        'ok': True,
        'github_user': user_data.get('login'),
        'repo': repo,
        'repo_url': repo_data.get('html_url'),
    }


@router.delete('/api/github/connect')
async def github_disconnect(login: str = Depends(get_current_user)):
    github_store.clear()
    return {'ok': True}


@router.get('/api/github/status')
async def github_status(login: str = Depends(get_current_user)):
    if not github_store.is_configured():
        return {'connected': False}

    pat = github_store.get_pat()
    repo = github_store.get_repo()

    try:
        user_data = await _gh('GET', '/user', pat)
        repo_data = await _gh('GET', f'/repos/{repo}', pat)
    except HTTPException:
        return {'connected': False, 'error': 'Токен или репозиторий недоступны'}

    # Последний коммит в platform/archive
    last_commit = None
    try:
        branch_data = await _gh('GET', f'/repos/{repo}/branches/platform%2Farchive', pat)
        commit = branch_data['commit']['commit']
        last_commit = {
            'sha': branch_data['commit']['sha'][:7],
            'message': commit['message'],
            'date': commit['committer']['date'],
        }
    except HTTPException:
        pass

    return {
        'connected': True,
        'github_user': user_data.get('login'),
        'repo': repo,
        'repo_url': repo_data.get('html_url'),
        'last_commit': last_commit,
    }


@router.get('/api/github/history/{file_id}')
async def github_file_history(file_id: str, login: str = Depends(get_current_user)):
    """История коммитов для конкретного файла."""
    if not github_store.is_configured():
        raise HTTPException(status_code=400, detail='GitHub не подключён')

    client = get_session(login)
    if not client:
        raise HTTPException(status_code=401, detail='Сессия не найдена')

    pat = github_store.get_pat()
    repo = github_store.get_repo()
    file_path = _file_path_for(client, file_id)

    try:
        commits = await _gh('GET', f'/repos/{repo}/commits', pat, params={
            'path': file_path,
            'sha': 'platform/archive',
            'per_page': 30,
        })
    except HTTPException as e:
        if e.status_code == 404:
            return {'commits': [], 'file_path': file_path}
        raise

    result = []
    for c in commits:
        result.append({
            'sha': c['sha'],
            'sha_short': c['sha'][:7],
            'message': c['commit']['message'],
            'date': c['commit']['committer']['date'],
            'author': c['commit']['author']['name'],
        })

    return {'commits': result, 'file_path': file_path}


@router.get('/api/github/file/{file_id}')
async def github_file_content(file_id: str, sha: str, login: str = Depends(get_current_user)):
    """Получить содержимое файла из архива по SHA коммита."""
    if not github_store.is_configured():
        raise HTTPException(status_code=400, detail='GitHub не подключён')

    client = get_session(login)
    if not client:
        raise HTTPException(status_code=401, detail='Сессия не найдена')

    pat = github_store.get_pat()
    repo = github_store.get_repo()
    file_path = _file_path_for(client, file_id)

    try:
        data = await _gh('GET', f'/repos/{repo}/contents/{file_path}', pat,
                         params={'ref': sha})
    except HTTPException as e:
        if e.status_code == 404:
            raise HTTPException(status_code=404, detail='Файл не найден в этом коммите')
        raise

    content = base64.b64decode(data['content'].replace('\n', '')).decode('utf-8', errors='replace')
    return {'content': content, 'file_path': file_path, 'sha': sha}


@router.post('/api/github/sync')
async def github_sync(login: str = Depends(get_current_user)):
    """Синхронизировать все доступные файлы одним коммитом."""
    if not github_store.is_configured():
        raise HTTPException(status_code=400, detail='GitHub не подключён')

    client = get_session(login)
    if not client:
        raise HTTPException(status_code=401, detail='Сессия не найдена')

    pat = github_store.get_pat()
    repo = github_store.get_repo()
    branch = 'platform/archive'

    # Собираем все файлы
    files: dict = {}
    for file_id in list(client.code.keys()):
        content = _build_content(client, file_id)
        if not content.strip():
            continue
        file_path = _file_path_for(client, file_id)
        files[file_path] = content

    if not files:
        return {'synced': [], 'errors': [], 'message': 'Нет доступных файлов для синхронизации'}

    try:
        # 0. Инициализируем репо если пустой (Git Data API не работает на пустых репо)
        await _init_repo_if_empty(pat, repo, branch)

        # 1. Создаём blob для каждого файла параллельно
        async def make_blob(path, content):
            blob = await _gh('POST', f'/repos/{repo}/git/blobs', pat, json={
                'content': content,
                'encoding': 'utf-8',
            })
            return path, blob['sha']

        blob_results = await asyncio.gather(*[make_blob(p, c) for p, c in files.items()])

        # 2. Получаем SHA текущей ветки (если есть)
        base_sha = await _get_branch_sha(pat, repo, branch)

        # 3. Строим дерево
        tree_items = [
            {'path': path, 'mode': '100644', 'type': 'blob', 'sha': sha}
            for path, sha in blob_results
        ]
        tree_params: dict = {'tree': tree_items}
        if base_sha:
            base_commit = await _gh('GET', f'/repos/{repo}/git/commits/{base_sha}', pat)
            tree_params['base_tree'] = base_commit['tree']['sha']

        tree = await _gh('POST', f'/repos/{repo}/git/trees', pat, json=tree_params)

        # 4. Коммит
        ts = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
        commit = await _gh('POST', f'/repos/{repo}/git/commits', pat, json={
            'message': f'sync: {len(files)} files [{ts}]',
            'tree': tree['sha'],
            'parents': [base_sha] if base_sha else [],
        })

        # 5. Обновляем или создаём ветку
        if base_sha:
            await _gh('PATCH', f'/repos/{repo}/git/refs/heads/{branch}', pat,
                      json={'sha': commit['sha']})
        else:
            await _gh('POST', f'/repos/{repo}/git/refs', pat,
                      json={'ref': f'refs/heads/{branch}', 'sha': commit['sha']})

    except HTTPException as e:
        raise HTTPException(status_code=e.status_code, detail=f'Ошибка синхронизации: {e.detail}')

    return {'synced': list(files.keys()), 'errors': [], 'commit': commit['sha'][:7]}
