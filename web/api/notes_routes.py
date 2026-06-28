"""
Endpoints управления заметками.

GET    /api/notes                       — список (без body)
POST   /api/notes                       — создать
GET    /api/notes/{nid}                 — открыть
PUT    /api/notes/{nid}                 — сохранить (title/body)
DELETE /api/notes/{nid}                 — удалить
POST   /api/notes/{nid}/share           — включить/выключить публичный доступ
POST   /api/notes/{nid}/share/regenerate — пересоздать токен

Публичный endpoint без auth:
GET    /api/public/notes/{token}        — JSON заметки (read-only)
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .auth import get_current_user
from . import notes_store


router = APIRouter()


# ── Schemas ─────────────────────────────────────────────────────────

class CreateNoteRequest(BaseModel):
    title: str = ''
    body: str = ''
    kind: str = 'markdown'   # 'markdown' | 'html'


class UpdateNoteRequest(BaseModel):
    title: Optional[str] = None
    body: Optional[str] = None
    kind: Optional[str] = None   # 'markdown' | 'html'


class ShareRequest(BaseModel):
    enabled: bool


# Лимит на размер тела заметки (особенно для HTML-загрузок).
# 1 MB достаточно для типичных дашборд-страниц и не утяжеляет notes.json.
MAX_BODY_BYTES = 1 * 1024 * 1024


# ── Private endpoints (auth required) ──────────────────────────────

@router.get('/api/notes')
async def list_notes(login: str = Depends(get_current_user)):
    return {'items': notes_store.list_notes(login)}


@router.post('/api/notes')
async def create_note(body: CreateNoteRequest, login: str = Depends(get_current_user)):
    if len((body.body or '').encode('utf-8')) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail='Размер заметки превышает 1 МБ')
    return notes_store.create_note(login, title=body.title, body=body.body, kind=body.kind)


@router.get('/api/notes/{nid}')
async def get_note(nid: str, login: str = Depends(get_current_user)):
    note = notes_store.get_note(login, nid)
    if not note:
        raise HTTPException(status_code=404, detail='Заметка не найдена')
    return note


@router.put('/api/notes/{nid}')
async def update_note(nid: str, body: UpdateNoteRequest,
                      login: str = Depends(get_current_user)):
    if body.body is not None and len(body.body.encode('utf-8')) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail='Размер заметки превышает 1 МБ')
    note = notes_store.update_note(
        login, nid, title=body.title, body=body.body, kind=body.kind,
    )
    if not note:
        raise HTTPException(status_code=404, detail='Заметка не найдена')
    return note


@router.delete('/api/notes/{nid}')
async def delete_note(nid: str, login: str = Depends(get_current_user)):
    if not notes_store.delete_note(login, nid):
        raise HTTPException(status_code=404, detail='Заметка не найдена')
    return {'ok': True}


@router.post('/api/notes/{nid}/share')
async def share_note(nid: str, body: ShareRequest,
                     login: str = Depends(get_current_user)):
    note = notes_store.set_share(login, nid, body.enabled)
    if not note:
        raise HTTPException(status_code=404, detail='Заметка не найдена')
    return note


@router.post('/api/notes/{nid}/share/regenerate')
async def regenerate_token(nid: str, login: str = Depends(get_current_user)):
    note = notes_store.regenerate_token(login, nid)
    if not note:
        raise HTTPException(status_code=404, detail='Заметка не найдена')
    return note


# ── Public endpoint (no auth) ──────────────────────────────────────

@router.get('/api/public/notes/{token}')
async def public_note(token: str):
    note = notes_store.find_by_token(token)
    if not note:
        raise HTTPException(status_code=404, detail='Заметка не найдена или доступ закрыт')
    # Возвращаем только то, что нужно публичному просмотру
    return {
        'title': note.get('title', ''),
        'body': note.get('body', ''),
        'kind': note.get('kind', 'markdown'),
        'updated_at': note.get('updated_at'),
    }
