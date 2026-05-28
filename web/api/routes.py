import asyncio
from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from hassle_platform import PlatformClient
from .auth import create_token, get_current_user, decode_token
from .sessions import get_session, set_session, remove_session

router = APIRouter()


# ------------------------------------------------------------------ #
#  Схемы                                                               #
# ------------------------------------------------------------------ #

class LoginRequest(BaseModel):
    login: str
    password: str


class SearchRequest(BaseModel):
    text: str
    file: str = '-1'
    regexp: bool = False
    start_line: str = ''
    end_line: str = ''


class GetCodeRequest(BaseModel):
    type: str         # 'preview' | 'edit'
    file_id: str
    code_path: list
    query_name: str = ''


class SaveCodeRequest(BaseModel):
    file_id: str
    code: str
    part_index: int
    hash: str | None = None


class GetLineRequest(BaseModel):
    file_id: str
    line: str


class DeleteAccessRequest(BaseModel):
    file_id: str
    start_line: int
    end_line: int


class QueryResponseRequest(BaseModel):
    type: str
    query_id: str


class NotifyQueryRequest(BaseModel):
    file_name: str = ''
    query_name: str = ''


# ------------------------------------------------------------------ #
#  Авторизация                                                         #
# ------------------------------------------------------------------ #

@router.post('/api/login')
async def login(body: LoginRequest):
    client = PlatformClient()
    try:
        connected = await client.connect()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f'Нет связи с платформой: {e}')

    if not connected:
        raise HTTPException(status_code=502, detail='Ошибка Socket.IO соединения')

    success, error = await client.login(body.login, body.password)
    if not success:
        await client.disconnect()
        raise HTTPException(status_code=401, detail=error or 'Неверный логин или пароль')

    set_session(body.login, client)
    token = create_token(body.login)
    return {'token': token}


@router.post('/api/logout')
async def logout(login: str = Depends(get_current_user)):
    remove_session(login)
    return {'ok': True}


# ------------------------------------------------------------------ #
#  Статус                                                              #
# ------------------------------------------------------------------ #

@router.get('/api/info')
async def get_info():
    from bot.config import PLATFORM_URL
    import urllib.parse
    host = urllib.parse.urlparse(PLATFORM_URL).netloc or PLATFORM_URL
    return {'platform_host': host}


@router.get('/api/status')
async def get_status(login: str = Depends(get_current_user)):
    client = get_session(login)
    if not client:
        # Сессия потеряна (рестарт сервера) — возвращаем 200 с флагом
        return {'server': 'unknown', 'compile': False, 'session_lost': True}
    return {'server': client.server_status, 'compile': client.is_compiling, 'session_lost': False}


# ------------------------------------------------------------------ #
#  Сервер                                                              #
# ------------------------------------------------------------------ #

@router.post('/api/server/start')
async def server_start(login: str = Depends(get_current_user)):
    client = _require_client(login)
    await client.start_server()
    return {'server': 'on'}


@router.post('/api/server/stop')
async def server_stop(login: str = Depends(get_current_user)):
    client = _require_client(login)
    await client.stop_server()
    return {'server': 'off'}


# ------------------------------------------------------------------ #
#  Компиляция                                                          #
# ------------------------------------------------------------------ #

@router.post('/api/compile')
async def compile_start(login: str = Depends(get_current_user)):
    client = _require_client(login)
    if client.is_compiling:
        raise HTTPException(status_code=409, detail='Компиляция уже выполняется')
    asyncio.create_task(client.start_compile())
    return {'started': True}


# ------------------------------------------------------------------ #
#  Файлы — только доступные (project_files)                            #
# ------------------------------------------------------------------ #

@router.get('/api/files')
async def get_files(login: str = Depends(get_current_user)):
    client = _require_client(login)
    # Ждём пока send_app_data придёт с данными files и code
    for _ in range(8):
        if client.files and client.code:
            break
        await asyncio.sleep(1)
    all_files = client.files
    accessible_ids = set(client.code.keys())
    accessible = {fid: all_files[fid] for fid in accessible_ids if fid in all_files}
    # Сохраняем порядок из project_files платформы (str-ified)
    ordered = [str(pid) for pid in client.project_files if str(pid) in accessible_ids]
    return {'files': accessible, 'project_files': ordered}


@router.get('/api/file/{file_id}/code')
async def get_file_code(file_id: str, login: str = Depends(get_current_user)):
    client = _require_client(login)
    # Ждём пока send_app_data придёт с данными — до 8 секунд
    for _ in range(8):
        code = client.code.get(file_id)
        if code is not None:
            return {'code': code}
        await asyncio.sleep(1)
    raise HTTPException(status_code=404, detail='Код не загружен — попробуйте позже')


# ------------------------------------------------------------------ #
#  Получение кода (get_code с ack)                                     #
# ------------------------------------------------------------------ #

@router.post('/api/code/get')
async def get_code(body: GetCodeRequest, login: str = Depends(get_current_user)):
    client = _require_client(login)
    _check_access(client, body.file_id)
    try:
        result = await client.get_code_ack(
            body.type,
            int(body.file_id) if body.file_id.isdigit() else body.file_id,
            body.code_path,
            body.query_name,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail='Сервер не ответил')
    return {'result': result}


# ------------------------------------------------------------------ #
#  Сохранение кода                                                     #
# ------------------------------------------------------------------ #

@router.post('/api/code/save')
async def save_code(body: SaveCodeRequest, login: str = Depends(get_current_user)):
    client = _require_client(login)
    _check_access(client, body.file_id)

    future: asyncio.Future = asyncio.get_event_loop().create_future()

    def on_save_finish(*args):
        new_hash = args[0] if args else None
        if not future.done():
            future.set_result(new_hash)

    client.on('save_finish', on_save_finish)
    try:
        file_id = int(body.file_id) if body.file_id.isdigit() else body.file_id

        # Получаем hash: сначала из запроса, потом из кэша
        save_hash = body.hash
        if not save_hash:
            parts = client.code.get(body.file_id, [])
            if body.part_index < len(parts):
                save_hash = parts[body.part_index].get('hash')

        # Платформа принимает None/null как hash для файлов без hash
        await client._emit('set_code', file_id, body.code, body.part_index, save_hash or None, '')
        new_hash = await asyncio.wait_for(future, timeout=10)
    except ConnectionError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail='Сервер не подтвердил сохранение')
    finally:
        client.off('save_finish', on_save_finish)

    # Обновляем кэш кода чтобы перезагрузка страницы показывала актуальные данные
    client.update_cached_code(body.file_id, body.part_index, body.code, new_hash)

    return {'hash': new_hash}


# ------------------------------------------------------------------ #
#  Запросы кода                                                        #
# ------------------------------------------------------------------ #

@router.get('/api/queries')
async def get_queries(login: str = Depends(get_current_user), refresh: bool = False):
    client = _require_client(login)
    if refresh:
        client._app_data.pop('queries_ts', None)  # сбрасываем кэш
    queries = await client.fetch_queries(timeout=8.0)
    return {'queries': queries}


@router.get('/api/debug/appdata')
async def debug_appdata(login: str = Depends(get_current_user)):
    client = _require_client(login)
    keys = list(client._app_data.keys())
    return {'keys': keys, 'queries_val': str(client._app_data.get('queries', 'NOT_FOUND'))[:200]}


@router.get('/api/debug/file/{file_id}')
async def debug_file(file_id: str, login: str = Depends(get_current_user)):
    client = _require_client(login)
    parts = client.code.get(file_id, [])
    return {
        'parts_count': len(parts),
        'parts': [{'line': p.get('line'), 'hash': p.get('hash'), 'content_len': len(p.get('content', ''))} for p in parts]
    }


@router.post('/api/notify/query_accepted')
async def notify_query_accepted(body: NotifyQueryRequest, login: str = Depends(get_current_user)):
    from config import BOT_TOKEN
    from bot.sessions import get_session as get_bot_session
    import aiohttp
    # Находим telegram user_id по login через сессии бота
    from bot import sessions as bot_sessions
    tg_user_id = None
    for uid, client in bot_sessions._sessions.items():
        if client._login == login:
            tg_user_id = uid
            break
    if tg_user_id and BOT_TOKEN:
        text = f'✅ Доступ разрешён\nФайл: {body.file_name}\nБлок: {body.query_name}'
        try:
            async with aiohttp.ClientSession() as session:
                await session.post(
                    f'https://api.telegram.org/bot{BOT_TOKEN}/sendMessage',
                    json={'chat_id': tg_user_id, 'text': text},
                    timeout=aiohttp.ClientTimeout(total=5),
                )
        except Exception:
            pass
    return {'ok': True}


@router.post('/api/code_query_response')
async def code_query_response(body: QueryResponseRequest, login: str = Depends(get_current_user)):
    client = _require_client(login)
    await client._emit('code_query_response', body.type, body.query_id)
    return {'ok': True}


# ------------------------------------------------------------------ #
#  Удаление доступа к диапазону строк                                  #
# ------------------------------------------------------------------ #

@router.post('/api/delete_access')
async def delete_access(body: DeleteAccessRequest, login: str = Depends(get_current_user)):
    client = _require_client(login)
    _check_access(client, body.file_id)
    file_id = int(body.file_id) if body.file_id.isdigit() else body.file_id
    await client._emit('delete_access', file_id, body.start_line, body.end_line)
    # Удаляем части из кэша которые попадают в диапазон
    code = client._app_data.get('code', {})
    parts = code.get(body.file_id, [])
    new_parts = []
    for part in parts:
        part_start = part.get('line', 1)
        part_lines = len(part.get('content', '').split('\n'))
        part_end = part_start + part_lines - 1
        # Оставляем части которые полностью вне диапазона удаления
        if part_end < body.start_line or part_start > body.end_line:
            new_parts.append(part)
    code[body.file_id] = new_parts
    return {'ok': True}


# ------------------------------------------------------------------ #
#  Получить строку по номеру                                           #
# ------------------------------------------------------------------ #

@router.post('/api/get_line')
async def get_line(body: GetLineRequest, login: str = Depends(get_current_user)):
    client = _require_client(login)
    file_id = int(body.file_id) if body.file_id.isdigit() else body.file_id
    await client._emit('get_line', file_id, body.line)
    return {'ok': True}


# ------------------------------------------------------------------ #
#  Поиск (map_find с ack)                                              #
# ------------------------------------------------------------------ #

@router.post('/api/search')
async def search_code(body: SearchRequest, login: str = Depends(get_current_user)):
    client = _require_client(login)
    request = {'text': body.text, 'file': body.file, 'regexp': body.regexp}
    if body.start_line:
        request['startLine'] = body.start_line
    if body.end_line:
        request['endLine'] = body.end_line
    try:
        result = await client.map_find(request, timeout=15)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail='Поиск не завершился вовремя')
    return {'result': result}


# ------------------------------------------------------------------ #
#  WebSocket                                                           #
# ------------------------------------------------------------------ #

@router.websocket('/ws')
async def websocket_endpoint(ws: WebSocket, token: str = ''):
    login = decode_token(token)
    if not login:
        await ws.close(code=4001)
        return

    client = get_session(login)
    if not client:
        await ws.close(code=4002)
        return

    await ws.accept()
    await ws.send_json({
        'type': 'status',
        'server': client.server_status,
        'compile': client.is_compiling,
    })

    async def on_server_log(data: str):
        try:
            await ws.send_json({'type': 'log', 'data': data})
        except Exception:
            pass

    async def on_compile_result(result: str):
        try:
            await ws.send_json({'type': 'compile_result', 'data': result})
        except Exception:
            pass

    async def on_app_data(*args):
        try:
            await ws.send_json({
                'type': 'status',
                'server': client.server_status,
                'compile': client.is_compiling,
            })
        except Exception:
            pass

    async def on_queries_update(queries):
        try:
            await ws.send_json({'type': 'queries_update', 'queries': queries})
        except Exception:
            pass

    async def on_update_code(*args):
        # Когда платформа открыла доступ к файлу — шлём статус чтобы фронт обновил список
        try:
            await ws.send_json({
                'type': 'status',
                'server': client.server_status,
                'compile': client.is_compiling,
            })
        except Exception:
            pass

    client.on('server_log', on_server_log)
    client.on('compile_result', on_compile_result)
    client.on('send_app_data', on_app_data)
    client.on('code_queries_update', on_queries_update)
    client.on('update_code', on_update_code)

    async def heartbeat():
        while True:
            await asyncio.sleep(25)
            try:
                await ws.send_json({'type': 'ping'})
            except Exception:
                break

    hb_task = asyncio.create_task(heartbeat())
    try:
        while True:
            try:
                data = await asyncio.wait_for(ws.receive_text(), timeout=60)
                # клиент прислал 'ping' — отвечаем 'pong' (браузер шлёт ping каждые 20с)
            except asyncio.TimeoutError:
                # 60 секунд тишины — закрываем
                break
            except Exception:
                break
    except WebSocketDisconnect:
        pass
    finally:
        hb_task.cancel()
        client.off('server_log', on_server_log)
        client.off('compile_result', on_compile_result)
        client.off('send_app_data', on_app_data)
        client.off('code_queries_update', on_queries_update)
        client.off('update_code', on_update_code)


# ------------------------------------------------------------------ #
#  Вспомогательное                                                     #
# ------------------------------------------------------------------ #

def _require_client(login: str) -> PlatformClient:
    client = get_session(login)
    if not client:
        raise HTTPException(status_code=401, detail='Сессия не найдена, войдите снова')
    return client


def _check_access(client: PlatformClient, file_id: str):
    if file_id not in client.code:
        raise HTTPException(status_code=403, detail='Нет доступа к этому файлу')
