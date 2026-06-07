"""
Endpoints для управления задачами per-user.

GET    /api/tasks                       — список задач (фильтр по status)
GET    /api/tasks/active                — активная задача
POST   /api/tasks                       — создать
PATCH  /api/tasks/{tid}                 — обновить поля
DELETE /api/tasks/{tid}                 — удалить
POST   /api/tasks/{tid}/active          — сделать активной (без body)
POST   /api/tasks/active/clear          — снять активность
POST   /api/tasks/{tid}/notes           — добавить заметку
POST   /api/tasks/{tid}/attachments     — загрузить файл (multipart/form-data)
DELETE /api/tasks/{tid}/attachments/{aid} — удалить вложение
GET    /api/tasks/attachments/{aid}/{filename} — отдать содержимое вложения
"""

import os
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .auth import get_current_user
from . import tasks_store

router = APIRouter()

UPLOAD_ROOT = Path(__file__).parent.parent / 'uploads' / 'tasks'
UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)

# Лимит на размер файла (10 МБ)
MAX_UPLOAD_SIZE = 10 * 1024 * 1024
ALLOWED_EXTS = {
    # images
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
    # docs
    '.txt', '.md', '.log', '.json', '.pwn', '.inc', '.pdf',
}


def _is_image(ext: str) -> bool:
    return ext.lower() in {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'}


# ── Schemas ─────────────────────────────────────────────────────────────

class CreateTaskRequest(BaseModel):
    title: str
    description: str = ''
    priority: str = 'medium'
    attached_files: list[str] = []
    make_active: bool = True


class UpdateTaskRequest(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None
    priority: Optional[str] = None
    attached_files: Optional[list[str]] = None


class NoteRequest(BaseModel):
    text: str


class CreateCaseRequest(BaseModel):
    title: str
    description: str = ''
    priority: str = 'medium'
    attached_files: list[str] = []


class UpdateCaseRequest(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None
    priority: Optional[str] = None
    attached_files: Optional[list[str]] = None
    ai_analysis: Optional[str] = None
    ai_proposal: Optional[str] = None


class UpdateCaseEditStatusRequest(BaseModel):
    edit_index: int
    status: str  # applied | rejected | pending


# ── Endpoints ───────────────────────────────────────────────────────────

@router.get('/api/tasks')
async def list_tasks(status: Optional[str] = None, login: str = Depends(get_current_user)):
    return {'tasks': tasks_store.list_tasks(login, status=status),
            'active_task_id': tasks_store.get_active_task_id(login)}


@router.get('/api/tasks/active')
async def get_active(login: str = Depends(get_current_user)):
    task = tasks_store.get_active_task(login)
    return {'task': task}


@router.post('/api/tasks')
async def create_task(body: CreateTaskRequest, login: str = Depends(get_current_user)):
    title = (body.title or '').strip()
    if not title:
        raise HTTPException(status_code=400, detail='Заголовок обязателен')
    task = tasks_store.create_task(
        login,
        title=title,
        description=body.description or '',
        priority=body.priority,
        attached_files=body.attached_files,
        make_active=body.make_active,
    )
    return {'task': task, 'active_task_id': tasks_store.get_active_task_id(login)}


@router.patch('/api/tasks/{task_id}')
async def update_task(task_id: str, body: UpdateTaskRequest,
                      login: str = Depends(get_current_user)):
    payload = {k: v for k, v in body.dict().items() if v is not None}
    try:
        task = tasks_store.update_task(login, task_id, **payload)
    except KeyError:
        raise HTTPException(status_code=404, detail='Задача не найдена')
    return {'task': task}


@router.delete('/api/tasks/{task_id}')
async def delete_task(task_id: str, login: str = Depends(get_current_user)):
    # Удаляем привязанные файлы с диска
    task = tasks_store.get_task(login, task_id)
    if task:
        for att in task.get('attachments', []):
            _safe_remove_attachment_file(att)
    ok = tasks_store.delete_task(login, task_id)
    if not ok:
        raise HTTPException(status_code=404, detail='Задача не найдена')
    return {'ok': True}


@router.post('/api/tasks/{task_id}/active')
async def make_active(task_id: str, login: str = Depends(get_current_user)):
    try:
        tasks_store.set_active_task(login, task_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {'active_task_id': task_id}


@router.post('/api/tasks/active/clear')
async def clear_active(login: str = Depends(get_current_user)):
    tasks_store.set_active_task(login, None)
    return {'active_task_id': None}


@router.post('/api/tasks/{task_id}/notes')
async def add_note(task_id: str, body: NoteRequest,
                   login: str = Depends(get_current_user)):
    text = (body.text or '').strip()
    if not text:
        raise HTTPException(status_code=400, detail='Пустая заметка')
    try:
        task = tasks_store.add_note(login, task_id, text)
    except KeyError:
        raise HTTPException(status_code=404, detail='Задача не найдена')
    return {'task': task}


# ── Кейсы внутри задачи ──────────────────────────────────────────

@router.post('/api/tasks/{task_id}/cases')
async def create_case(task_id: str, body: CreateCaseRequest,
                       login: str = Depends(get_current_user)):
    title = (body.title or '').strip()
    if not title:
        raise HTTPException(status_code=400, detail='Заголовок обязателен')
    try:
        task = tasks_store.add_case(
            login, task_id,
            title=title,
            description=body.description or '',
            priority=body.priority,
            attached_files=body.attached_files,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail='Задача не найдена')
    return {'task': task}


@router.patch('/api/tasks/{task_id}/cases/{case_id}')
async def update_case(task_id: str, case_id: str, body: UpdateCaseRequest,
                       login: str = Depends(get_current_user)):
    payload = {k: v for k, v in body.dict().items() if v is not None}
    try:
        task = tasks_store.update_case(login, task_id, case_id, **payload)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {'task': task}


@router.delete('/api/tasks/{task_id}/cases/{case_id}')
async def delete_case(task_id: str, case_id: str,
                       login: str = Depends(get_current_user)):
    try:
        task = tasks_store.delete_case(login, task_id, case_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {'task': task}


@router.post('/api/tasks/{task_id}/cases/{case_id}/edit_status')
async def set_case_edit_status(task_id: str, case_id: str,
                                body: UpdateCaseEditStatusRequest,
                                login: str = Depends(get_current_user)):
    task = tasks_store.update_case_edit_status(
        login, task_id, case_id, body.edit_index, body.status,
    )
    if not task:
        raise HTTPException(status_code=404, detail='Кейс или edit не найден')
    return {'task': task}


@router.post('/api/tasks/{task_id}/attachments')
async def upload_attachment(task_id: str,
                            file: UploadFile = File(...),
                            login: str = Depends(get_current_user)):
    # Проверка существования задачи
    if not tasks_store.get_task(login, task_id):
        raise HTTPException(status_code=404, detail='Задача не найдена')

    # Расширение и имя
    orig_name = os.path.basename(file.filename or 'file')
    ext = os.path.splitext(orig_name)[1].lower()
    if ext not in ALLOWED_EXTS:
        raise HTTPException(status_code=400, detail=f'Расширение {ext} не разрешено')

    # Читаем с лимитом
    contents = await file.read()
    if len(contents) > MAX_UPLOAD_SIZE:
        raise HTTPException(status_code=400, detail='Файл больше 10 МБ')

    # Каждое вложение лежит в отдельной поддиректории по id
    att_id = uuid.uuid4().hex[:12]
    dir_path = UPLOAD_ROOT / att_id
    dir_path.mkdir(parents=True, exist_ok=True)
    # Имя файла — оригинальное, но безопасно очищенное
    safe_name = ''.join(c for c in orig_name if c.isalnum() or c in '._- ')[:120] or f'file{ext}'
    file_path = dir_path / safe_name
    file_path.write_bytes(contents)

    attachment = {
        'id': att_id,
        'name': safe_name,
        'url': f'/api/tasks/attachments/{att_id}/{safe_name}',
        'size': len(contents),
        'kind': 'image' if _is_image(ext) else 'file',
    }
    try:
        task = tasks_store.add_attachment(login, task_id, attachment)
    except KeyError:
        # На случай гонки — чистим
        _safe_remove_attachment_file(attachment)
        raise HTTPException(status_code=404, detail='Задача не найдена')
    return {'task': task, 'attachment': attachment}


@router.delete('/api/tasks/{task_id}/attachments/{attachment_id}')
async def delete_attachment(task_id: str, attachment_id: str,
                            login: str = Depends(get_current_user)):
    try:
        removed = tasks_store.remove_attachment(login, task_id, attachment_id)
    except KeyError:
        raise HTTPException(status_code=404, detail='Задача не найдена')
    if not removed:
        raise HTTPException(status_code=404, detail='Вложение не найдено')
    _safe_remove_attachment_file(removed)
    return {'ok': True}


@router.get('/api/tasks/attachments/{attachment_id}/{filename}')
async def get_attachment(attachment_id: str, filename: str,
                         login: str = Depends(get_current_user)):
    # Авторизация: проверяем что у юзера есть задача с таким attachment
    for task in tasks_store.list_tasks(login):
        for att in task.get('attachments', []):
            if att.get('id') == attachment_id and att.get('name') == filename:
                path = UPLOAD_ROOT / attachment_id / filename
                if path.exists():
                    return FileResponse(str(path), filename=filename)
                raise HTTPException(status_code=404, detail='Файл удалён')
    raise HTTPException(status_code=403, detail='Нет доступа к этому вложению')


def _safe_remove_attachment_file(att: dict):
    att_id = att.get('id') or ''
    if not att_id or not all(c.isalnum() for c in att_id):
        return
    dir_path = UPLOAD_ROOT / att_id
    if not dir_path.exists():
        return
    try:
        for f in dir_path.iterdir():
            try:
                f.unlink()
            except OSError:
                pass
        dir_path.rmdir()
    except OSError:
        pass
