import asyncio
from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect, Request
from pydantic import BaseModel

from hassle_platform import PlatformClient
from .auth import create_token, get_current_user, decode_token
from .sessions import get_session, set_session, remove_session
from .totp_routes import check_rate_limit, reset_rate_limit
from . import totp_store
from . import trusted_devices

router = APIRouter()


# ------------------------------------------------------------------ #
#  Схемы                                                               #
# ------------------------------------------------------------------ #

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
    html: str = ''


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

class LoginRequest(BaseModel):
    login: str
    password: str
    totp_code: str = ''


@router.post('/api/login')
async def login(body: LoginRequest, request: Request):
    ip = request.client.host
    user_agent = request.headers.get('user-agent', '')
    check_rate_limit(ip)

    # Проверяем TOTP если включён — но пропускаем для доверенных устройств
    if totp_store.is_enabled():
        device_trusted = trusted_devices.is_trusted(body.login, ip, user_agent)
        if not device_trusted:
            if not body.totp_code:
                raise HTTPException(status_code=401, detail='TOTP_REQUIRED')
            import pyotp
            secret = totp_store.get_secret()
            if not pyotp.TOTP(secret).verify(body.totp_code, valid_window=1):
                raise HTTPException(status_code=401, detail='Неверный код аутентификатора')

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

    reset_rate_limit(ip)
    set_session(body.login, client)
    # После успешного входа делаем устройство доверенным (или продлеваем срок)
    if totp_store.is_enabled():
        trusted_devices.trust(body.login, ip, user_agent)
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
    return {
        'files': accessible,
        'project_files': ordered,
        'all_files': all_files,   # все файлы для поиска (имена)
    }


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
    # Не проверяем _check_access — get_code это запрос доступа к коду,
    # платформа сама решает давать его или нет
    file_id_int = int(body.file_id) if body.file_id.isdigit() else body.file_id
    try:
        result = await client.get_code_ack(
            body.type, file_id_int, body.code_path, body.query_name,
        )
    except asyncio.TimeoutError:
        if body.type == 'preview':
            # Для preview таймаут нормален — платформа уже ответила через update_code
            # Возвращаем пустой результат, фронт уже получил данные через WS
            return {'result': None}
        # Для edit таймаут означает запрос на модерацию — тоже нормально
        return {'result': 'pending'}
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

        # Pre-flight: проверяем что part_index ещё существует и hash совпадает
        # с тем, что у нас в кэше. Если расхождение — значит платформа уже
        # прислала свежую версию (сдвинули блок / отозвали доступ).
        # Возвращаем 409 чтобы фронт показал понятную ошибку и не ждал 10с
        # таймаута платформы.
        cached_parts = client.code.get(body.file_id, [])
        if not cached_parts or body.part_index >= len(cached_parts):
            raise HTTPException(
                status_code=409,
                detail='Блок недоступен или был отозван. Перезагрузите файл.',
            )
        cached_hash = cached_parts[body.part_index].get('hash')
        if body.hash and cached_hash and body.hash != cached_hash:
            raise HTTPException(
                status_code=409,
                detail='Блок был обновлён на сервере. Перезагрузите файл и повторите сохранение.',
            )

        # Получаем hash: сначала из запроса, потом из кэша
        save_hash = body.hash or cached_hash

        import logging
        fname = client.files.get(body.file_id, {}).get('fullPath', '?')
        logging.getLogger('platform.client').warning(
            f'SAVE: file={file_id} ({fname}) part={body.part_index} hash={save_hash} len={len(body.code)}'
        )
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

    # Автокоммит в GitHub архив (fire-and-forget, не блокирует ответ)
    asyncio.create_task(_github_autocommit(login, client, body.file_id, body.part_index))

    return {'hash': new_hash}


async def _github_autocommit(login: str, client, file_id: str, part_index: int):
    """Коммитит актуальный файл в персональный GitHub архив после сохранения."""
    from . import github_store
    from .github_routes import commit_file, _file_path_for, _build_content
    if not github_store.is_configured(login):
        return
    try:
        pat = github_store.get_pat(login)
        repo = github_store.get_repo(login)
        content = _build_content(client, file_id)
        if not content.strip():
            return
        file_path = _file_path_for(client, file_id)
        fname = client.files.get(file_id, {}).get('name', file_path)
        await commit_file(pat, repo, file_path, content,
                          f'auto: save {fname} (part {part_index})')
    except Exception as e:
        import logging
        import traceback
        logging.getLogger('github').warning(
            f'Autocommit failed ({login}): {e}\n{traceback.format_exc()}'
        )


# ------------------------------------------------------------------ #
#  Консольный лог                                                      #
# ------------------------------------------------------------------ #

@router.get('/api/console/recent')
async def console_recent(limit: int = 500, login: str = Depends(get_current_user)):
    """Последние строки серверного лога из ring buffer."""
    client = _require_client(login)
    return {'lines': client.get_console_log(limit=limit)}


@router.post('/api/console/clear')
async def console_clear(login: str = Depends(get_current_user)):
    client = _require_client(login)
    client.clear_console_log()
    return {'ok': True}


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
            # send_app_data может содержать обновлённый code — шлём дифф,
            # если он непустой (client.py заполняет last_code_diff).
            diff = client.last_code_diff or {}
            if diff.get('lost') or diff.get('changed') or diff.get('added'):
                await ws.send_json({
                    'type': 'code_updated',
                    'lost':    diff.get('lost') or [],
                    'changed': diff.get('changed') or [],
                    'added':   diff.get('added') or [],
                })
        except Exception:
            pass

    async def on_queries_update(queries):
        try:
            await ws.send_json({'type': 'queries_update', 'queries': queries})
        except Exception:
            pass

    async def on_update_code(*args):
        # Когда платформа обновила доступы / содержимое — шлём:
        #  1) status (как раньше — чтобы перерисовать список файлов);
        #  2) code_updated с диффом: какие file_id потеряли доступ, какие
        #     были изменены. Фронт показывает баннер «файл обновлён» или
        #     блокирует сохранение / закрывает вкладку.
        try:
            await ws.send_json({
                'type': 'status',
                'server': client.server_status,
                'compile': client.is_compiling,
            })
            diff = client.last_code_diff or {}
            if diff.get('lost') or diff.get('changed') or diff.get('added'):
                await ws.send_json({
                    'type': 'code_updated',
                    'lost':    diff.get('lost') or [],
                    'changed': diff.get('changed') or [],
                    'added':   diff.get('added') or [],
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
