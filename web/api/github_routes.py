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


async def _ensure_branch(pat: str, repo: str, branch: str, base: str = 'main'):
    """Создать ветку если её нет."""
    try:
        await _gh('GET', f'/repos/{repo}/branches/{branch}', pat)
        return  # уже есть
    except HTTPException as e:
        if e.status_code != 404:
            raise

    # Получаем SHA базовой ветки
    try:
        base_data = await _gh('GET', f'/repos/{repo}/branches/{base}', pat)
        sha = base_data['commit']['sha']
    except HTTPException:
        # Попробуем master
        try:
            base_data = await _gh('GET', f'/repos/{repo}/branches/master', pat)
            sha = base_data['commit']['sha']
        except HTTPException:
            raise HTTPException(status_code=400, detail='Не найдена базовая ветка main/master')

    await _gh('POST', f'/repos/{repo}/git/refs', pat, json={
        'ref': f'refs/heads/{branch}',
        'sha': sha,
    })


async def _get_file_sha(pat: str, repo: str, path: str, branch: str) -> Optional[str]:
    """Получить SHA существующего файла (нужен для update)."""
    try:
        data = await _gh('GET', f'/repos/{repo}/contents/{path}', pat,
                         params={'ref': branch})
        return data.get('sha')
    except HTTPException as e:
        if e.status_code == 404:
            return None
        raise


async def commit_file(pat: str, repo: str, file_path: str, content: str,
                      message: str, branch: str = 'platform/archive'):
    """Закоммитить один файл в репо."""
    encoded = base64.b64encode(content.encode()).decode()
    sha = await _get_file_sha(pat, repo, file_path, branch)
    body: dict = {
        'message': message,
        'content': encoded,
        'branch': branch,
    }
    if sha:
        body['sha'] = sha

    await _gh('PUT', f'/repos/{repo}/contents/{file_path}', pat, json=body)


# ── Schemas ────────────────────────────────────────────────────────────

class ConnectRequest(BaseModel):
    pat: str
    repo: str  # "owner/repo"


# ── Endpoints ──────────────────────────────────────────────────────────

@router.post('/api/github/connect')
async def github_connect(body: ConnectRequest, login: str = Depends(get_current_user)):
    """Проверить PAT + repo и сохранить конфигурацию."""
    import traceback
    try:
        return await _github_connect_impl(body)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f'[DEBUG] {type(e).__name__}: {e}\n{traceback.format_exc()}')


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
    """Ручная синхронизация всех доступных файлов в архив."""
    if not github_store.is_configured():
        raise HTTPException(status_code=400, detail='GitHub не подключён')

    client = get_session(login)
    if not client:
        raise HTTPException(status_code=401, detail='Сессия не найдена')

    pat = github_store.get_pat()
    repo = github_store.get_repo()

    await _ensure_branch(pat, repo, 'platform/archive')

    synced = []
    errors = []

    for file_id in list(client.code.keys()):
        content = _build_content(client, file_id)
        if not content.strip():
            continue
        file_path = _file_path_for(client, file_id)
        try:
            ts = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
            await commit_file(pat, repo, file_path, content,
                              f'sync: {file_path} [{ts}]')
            synced.append(file_path)
        except HTTPException as e:
            errors.append({'file': file_path, 'error': e.detail})
        except Exception as e:
            errors.append({'file': file_path, 'error': str(e)})

    return {'synced': synced, 'errors': errors}
