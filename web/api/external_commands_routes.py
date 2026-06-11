"""
WEB-интерфейс к таблице `external_commands` Pawn-сервера.

Endpoints:
  GET   /api/external_commands/catalog              — описание всех команд для UI
  POST  /api/external_commands                      — отправить команду на сервер
  GET   /api/external_commands/{cmd_id}             — статус выполнения (для WAIT_RESPONSE)
  DELETE /api/external_commands/{cmd_id}            — удалить запись из таблицы
  GET   /api/external_commands/recent?limit=50      — недавние команды (журнал)
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import pymysql.cursors

from .auth import get_current_user
from .db_routes import _db_connect_sync
from . import external_commands_catalog as catalog

logger = logging.getLogger('external_commands')
router = APIRouter(prefix='/api/external_commands', tags=['external_commands'])

# Типы команд в Pawn
COMMAND_TYPE_EXECUTE = 1
COMMAND_TYPE_WAIT_RESPONSE = 2
# COMMAND_TYPE_PROCESS = 3  — серверное состояние, через UI не используется

VALID_TYPES = {COMMAND_TYPE_EXECUTE, COMMAND_TYPE_WAIT_RESPONSE}


# ── Schemas ───────────────────────────────────────────────────────────

class SendCommandRequest(BaseModel):
    command: int               # значение enum'а из external_commands.pwn
    command_type: int = COMMAND_TYPE_WAIT_RESPONSE
    data_1: Optional[int] = None
    data_2: Optional[int] = None
    data_3: Optional[int] = None
    data_4: Optional[int] = None
    data_string_1: Optional[str] = None


class SendCommandResponse(BaseModel):
    id: int
    command: int
    command_type: int
    state: int
    state_name: str


class CommandStatus(BaseModel):
    id: int
    command: int
    command_type: int
    state: int
    state_name: str
    response: Optional[str] = None
    data_1: Optional[int] = None
    data_2: Optional[int] = None
    data_3: Optional[int] = None
    data_4: Optional[int] = None
    data_string_1: Optional[str] = None


# ── Helpers ───────────────────────────────────────────────────────────

def _row_to_status(row: dict) -> CommandStatus:
    state_code, state_name = catalog.parse_state(row.get('state'))
    return CommandStatus(
        id=int(row['id']),
        command=int(row.get('command') or 0),
        command_type=catalog.parse_command_type(row.get('command_type')),
        state=state_code,
        state_name=state_name,
        response=row.get('response') or None,
        data_1=row.get('data_1'),
        data_2=row.get('data_2'),
        data_3=row.get('data_3'),
        data_4=row.get('data_4'),
        data_string_1=row.get('data_string_1') or None,
    )


def _coerce_int(value: Any) -> int | None:
    if value is None or value == '':
        return None
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, int):
        return value
    try:
        return int(value)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f'Невалидное число: {value!r}')


# ── Endpoints ─────────────────────────────────────────────────────────

@router.get('/catalog')
async def get_catalog(login: str = Depends(get_current_user)):
    """Описание всех команд для построения UI."""
    return {
        'commands': catalog.list_commands(),
        'state_names': catalog.STATE_NAMES,
        'command_types': [
            {'value': COMMAND_TYPE_EXECUTE,        'label': 'EXECUTE (без ответа)'},
            {'value': COMMAND_TYPE_WAIT_RESPONSE,  'label': 'WAIT_RESPONSE (с ответом)'},
        ],
        'reward_types': catalog.REWARD_TYPES,
    }


@router.post('', response_model=SendCommandResponse)
async def send_command(body: SendCommandRequest,
                       login: str = Depends(get_current_user)):
    if body.command_type not in VALID_TYPES:
        raise HTTPException(status_code=400, detail='Недопустимый command_type')

    spec = catalog.find_command(body.command)
    # Не запрещаем «неизвестную» команду (сервер всё равно ответит «Unknown command»),
    # но в каталоге явно отмечена опция «сырой режим». Это позволяет добавить новую
    # команду на стороне Pawn до обновления каталога.

    # Подготавливаем значения
    data_1 = _coerce_int(body.data_1)
    data_2 = _coerce_int(body.data_2)
    data_3 = _coerce_int(body.data_3)
    data_4 = _coerce_int(body.data_4)
    data_string_1 = body.data_string_1

    # Валидация по каталогу (мягкая — только если поле помечено required и пусто)
    if spec:
        for field in spec.get('fields') or []:
            if not field.get('required'):
                continue
            key = field['key']
            if key == 'data_string_1':
                if not data_string_1:
                    raise HTTPException(status_code=400, detail=f'Не заполнено: {field["label"]}')
            else:
                value = {'data_1': data_1, 'data_2': data_2,
                         'data_3': data_3, 'data_4': data_4}.get(key)
                if value is None:
                    raise HTTPException(status_code=400, detail=f'Не заполнено: {field["label"]}')

    # Стартовое состояние:
    #   WAIT_RESPONSE → 'WAIT_RESPONSE' чтобы сервер увидел в SELECT
    #   EXECUTE       → '' (сервер не смотрит на state у EXECUTE)
    command_type_name = catalog.COMMAND_TYPE_NAMES.get(int(body.command_type), 'EXECUTE')
    initial_state_name = 'WAIT_RESPONSE' if body.command_type == COMMAND_TYPE_WAIT_RESPONSE else ''
    initial_state_code = 1 if body.command_type == COMMAND_TYPE_WAIT_RESPONSE else 0

    def _run() -> int:
        conn = _db_connect_sync()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO `external_commands`
                        (`command`, `command_type`, `state`,
                         `data_1`, `data_2`, `data_3`, `data_4`,
                         `data_string_1`)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        int(body.command),
                        command_type_name,
                        initial_state_name,
                        data_1, data_2, data_3, data_4,
                        data_string_1 or '',
                    ),
                )
                return int(cur.lastrowid or 0)
        finally:
            conn.close()

    try:
        new_id = await asyncio.get_event_loop().run_in_executor(None, _run)
    except pymysql.MySQLError as exc:  # type: ignore[attr-defined]
        logger.exception('Failed to insert external_command')
        raise HTTPException(status_code=500, detail=f'MySQL: {exc}') from exc

    return SendCommandResponse(
        id=new_id,
        command=int(body.command),
        command_type=int(body.command_type),
        state=initial_state_code,
        state_name=initial_state_name or 'EXECUTE',
    )


@router.get('/recent')
async def get_recent(limit: int = 50, login: str = Depends(get_current_user)):
    """Последние команды (для журнала в UI)."""
    limit = max(1, min(int(limit), 200))

    def _run() -> list[dict]:
        conn = _db_connect_sync()
        try:
            with conn.cursor(pymysql.cursors.DictCursor) as cur:
                cur.execute(
                    """
                    SELECT `id`, `command`, `command_type`,
                           `state`, `response`,
                           `data_1`, `data_2`, `data_3`, `data_4`, `data_string_1`
                      FROM `external_commands`
                  ORDER BY `id` DESC
                     LIMIT %s
                    """,
                    (limit,),
                )
                return list(cur.fetchall() or [])
        finally:
            conn.close()

    try:
        rows = await asyncio.get_event_loop().run_in_executor(None, _run)
    except pymysql.MySQLError as exc:  # type: ignore[attr-defined]
        raise HTTPException(status_code=500, detail=f'MySQL: {exc}') from exc

    return {'items': [_row_to_status(r).dict() for r in rows]}


@router.get('/{cmd_id}')
async def get_status(cmd_id: int, login: str = Depends(get_current_user)):
    """Текущий статус команды. Для WAIT_RESPONSE UI опрашивает в цикле."""

    def _run() -> dict | None:
        conn = _db_connect_sync()
        try:
            with conn.cursor(pymysql.cursors.DictCursor) as cur:
                cur.execute(
                    """
                    SELECT `id`, `command`, `command_type`,
                           `state`, `response`,
                           `data_1`, `data_2`, `data_3`, `data_4`, `data_string_1`
                      FROM `external_commands`
                     WHERE `id` = %s
                     LIMIT 1
                    """,
                    (cmd_id,),
                )
                return cur.fetchone()
        finally:
            conn.close()

    try:
        row = await asyncio.get_event_loop().run_in_executor(None, _run)
    except pymysql.MySQLError as exc:  # type: ignore[attr-defined]
        raise HTTPException(status_code=500, detail=f'MySQL: {exc}') from exc

    if row is None:
        # EXECUTE-команды сервер сам удаляет после выполнения — это норма
        return {
            'id': cmd_id,
            'state': None,
            'state_name': 'EXECUTED_AND_REMOVED',
            'response': None,
        }

    return _row_to_status(row).dict()


@router.delete('/{cmd_id}')
async def delete_command(cmd_id: int, login: str = Depends(get_current_user)):
    def _run() -> int:
        conn = _db_connect_sync()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    'DELETE FROM `external_commands` WHERE `id` = %s LIMIT 1',
                    (cmd_id,),
                )
                return int(cur.rowcount or 0)
        finally:
            conn.close()

    try:
        affected = await asyncio.get_event_loop().run_in_executor(None, _run)
    except pymysql.MySQLError as exc:  # type: ignore[attr-defined]
        raise HTTPException(status_code=500, detail=f'MySQL: {exc}') from exc

    return {'deleted': affected}
