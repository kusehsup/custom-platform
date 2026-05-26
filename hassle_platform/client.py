import asyncio
import json
import urllib.parse
import websockets
from typing import Callable, Any

from config import PLATFORM_URL, PROXY_URL

_host = urllib.parse.urlparse(PLATFORM_URL).netloc
_path_param = urllib.parse.quote(PLATFORM_URL, safe='')
_path_queries = urllib.parse.quote(PLATFORM_URL + 'code_queries', safe='')
WS_URL = f'ws://{_host}/socket.io/?path={_path_param}&EIO=3&transport=websocket'
WS_URL_QUERIES = f'ws://{_host}/socket.io/?path={_path_queries}&EIO=3&transport=websocket'

WS_HEADERS = {
    'Origin': PLATFORM_URL.rstrip('/'),
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
}


def _make_proxy():
    """Возвращает proxy параметр для websockets если PROXY_URL задан."""
    if not PROXY_URL:
        return None
    try:
        from python_socks.async_.asyncio import Proxy
        return Proxy.from_url(PROXY_URL)
    except Exception:
        return None


def _encode(event: str, *args) -> str:
    return '42' + json.dumps([event, *args])


def _encode_ack(ack_id: int, *args) -> str:
    return '43' + str(ack_id) + json.dumps(list(args))


def _decode(raw: str) -> tuple[str, Any]:
    # Ack пакет: 43<id>[...data]
    if raw.startswith('43'):
        rest = raw[2:]
        # Читаем id до первого '['
        bracket = rest.index('[')
        ack_id = int(rest[:bracket])
        data = json.loads(rest[bracket:])
        return '__ack__', (ack_id, data)
    if raw.startswith('42'):
        data = json.loads(raw[2:])
        return data[0], data[1:]
    return '__raw__', raw


class PlatformClient:
    def __init__(self):
        self._ws = None
        self._session_token: str | None = None
        self._login: str | None = None
        self._password: str | None = None
        self._app_data: dict = {}
        self._listeners: dict[str, list[Callable]] = {}
        self._ack_futures: dict[str, asyncio.Future] = {}
        self._pending_acks: dict[int, asyncio.Future] = {}
        self._ack_counter: int = 0
        self._connected = False
        self._reconnecting = False
        self._reconnect_event = asyncio.Event()
        self._reconnect_event.set()  # изначально «не переподключаемся»
        self._task: asyncio.Task | None = None

    # ------------------------------------------------------------------ #
    #  Публичные свойства                                                  #
    # ------------------------------------------------------------------ #

    @property
    def server_status(self) -> str:
        return self._app_data.get('server', 'unknown')

    @property
    def is_compiling(self) -> bool:
        return bool(self._app_data.get('compile', False))

    @property
    def files(self) -> dict:
        return self._app_data.get('files', {})

    @property
    def queries(self) -> dict:
        return self._app_data.get('queries', {})

    @property
    def project_files(self) -> list:
        return self._app_data.get('project', {}).get('files', [])

    @property
    def code(self) -> dict:
        return self._app_data.get('code', {})

    # ------------------------------------------------------------------ #
    #  Подключение                                                         #
    # ------------------------------------------------------------------ #

    async def connect(self) -> bool:
        proxy = _make_proxy()
        kwargs = dict(
            additional_headers=WS_HEADERS,
            max_size=16 * 1024 * 1024,
            ping_interval=None,
        )
        if proxy:
            sock = await proxy.connect(dest_host=_host.split(':')[0], dest_port=int(_host.split(':')[1]) if ':' in _host else 80)
            kwargs['sock'] = sock
        self._ws = await websockets.connect(WS_URL, **kwargs)
        await self._ws.recv()   # Engine.IO handshake
        await self._ws.send('40')
        raw = await self._ws.recv()
        if raw != '40':
            return False
        self._connected = True
        self._task = asyncio.create_task(self._receive_loop())
        return True

    async def _reconnect(self):
        if not self._login or self._reconnecting:
            return
        self._reconnecting = True
        self._reconnect_event.clear()  # сигнал: идёт переподключение
        try:
            for attempt in range(1, 6):
                await asyncio.sleep(attempt * 2)
                try:
                    ok = await self.connect()
                    if not ok:
                        continue
                    success, _ = await self.login(self._login, self._password)
                    if success:
                        return
                except Exception:
                    pass
        finally:
            self._reconnecting = False
            self._reconnect_event.set()  # сигнал: переподключение завершено (успешно или нет)

    async def disconnect(self):
        self._connected = False
        if self._task:
            self._task.cancel()
        if self._ws:
            await self._ws.close()

    # ------------------------------------------------------------------ #
    #  Авторизация                                                         #
    # ------------------------------------------------------------------ #

    async def login(self, login: str, password: str) -> tuple[bool, str]:
        self._login = login
        self._password = password
        future: asyncio.Future = asyncio.get_event_loop().create_future()
        self._ack_futures['log_in_result'] = future
        await self._emit('log_in', login, password)
        try:
            result = await asyncio.wait_for(future, timeout=10)
        except asyncio.TimeoutError:
            return False, 'Timeout'
        if result.get('type') == 'success':
            return True, ''
        return False, result.get('message', 'Ошибка авторизации')

    # ------------------------------------------------------------------ #
    #  Управление сервером                                                 #
    # ------------------------------------------------------------------ #

    async def start_server(self):
        await self._emit('start_server')
        self._app_data['server'] = 'on'

    async def stop_server(self):
        await self._emit('stop_server')
        self._app_data['server'] = 'off'

    # ------------------------------------------------------------------ #
    #  Компиляция                                                          #
    # ------------------------------------------------------------------ #

    async def start_compile(self) -> str:
        if self.is_compiling:
            return 'already_running'
        future: asyncio.Future = asyncio.get_event_loop().create_future()
        self._ack_futures['compile_result'] = future
        await self._emit('start_compile')
        self._app_data['compile'] = True
        try:
            result = await asyncio.wait_for(future, timeout=120)
        except asyncio.TimeoutError:
            return 'Timeout: компиляция не завершилась за 2 минуты'
        return result

    # ------------------------------------------------------------------ #
    #  Запросы кода — отдельный WS endpoint                               #
    # ------------------------------------------------------------------ #

    async def fetch_queries(self, timeout: float = 8.0) -> dict:
        """Запрашивает актуальные запросы через основное соединение."""
        if not self._connected:
            return self._app_data.get('queries', {})

        future: asyncio.Future = asyncio.get_event_loop().create_future()

        def on_queries(queries):
            self._app_data['queries'] = queries
            if not future.done():
                future.set_result(queries)

        self.on('code_queries_update', on_queries)
        try:
            # Переключаемся на страницу запросов — платформа пришлёт code_queries_update
            await self._emit('open_page', 'code_queries')
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            return self._app_data.get('queries', {})
        except Exception:
            return self._app_data.get('queries', {})
        finally:
            self.off('code_queries_update', on_queries)
            # Возвращаемся на главную страницу
            try:
                await self._emit('open_page', 'main')
            except Exception:
                pass

    # ------------------------------------------------------------------ #
    #  Обновление кэша после сохранения                                    #
    # ------------------------------------------------------------------ #

    def update_cached_code(self, file_id: str, part_index: int, new_content: str, new_hash: str):
        """Обновляет кэш кода файла после успешного сохранения."""
        code = self._app_data.get('code', {})
        parts = code.get(file_id)
        if parts and part_index < len(parts):
            parts[part_index]['content'] = new_content
            parts[part_index]['hash']    = new_hash

    def invalidate_file_code(self, file_id: str):
        """Нет-оп: не сбрасываем кэш, он обновляется через update_cached_code."""
        pass

    # ------------------------------------------------------------------ #
    #  Поиск с ack-callback                                                #
    # ------------------------------------------------------------------ #

    async def map_find(self, request: dict, timeout: float = 15.0) -> Any:
        future: asyncio.Future = asyncio.get_event_loop().create_future()
        ack_id = self._next_ack_id()
        self._pending_acks[ack_id] = future
        packet = '42' + str(ack_id) + json.dumps(['map_find', request])
        await self._raw_send(packet)
        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending_acks.pop(ack_id, None)
            raise

    async def get_code_ack(self, type_: str, file_id, code_path: list, query_name: str, timeout: float = 10.0) -> Any:
        future: asyncio.Future = asyncio.get_event_loop().create_future()
        ack_id = self._next_ack_id()
        self._pending_acks[ack_id] = future
        packet = '42' + str(ack_id) + json.dumps(['get_code', type_, file_id, code_path, query_name])
        await self._raw_send(packet)
        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending_acks.pop(ack_id, None)
            raise

    # ------------------------------------------------------------------ #
    #  Подписка на события                                                 #
    # ------------------------------------------------------------------ #

    def on(self, event: str, callback: Callable):
        self._listeners.setdefault(event, []).append(callback)

    def off(self, event: str, callback: Callable):
        if event in self._listeners:
            self._listeners[event] = [c for c in self._listeners[event] if c != callback]

    # ------------------------------------------------------------------ #
    #  Внутренние методы                                                   #
    # ------------------------------------------------------------------ #

    def _next_ack_id(self) -> int:
        self._ack_counter += 1
        return self._ack_counter

    async def _emit(self, event: str, *args):
        await self._wait_for_connection()
        try:
            await self._ws.send(_encode(event, *args))
        except websockets.ConnectionClosed:
            self._connected = False
            asyncio.create_task(self._reconnect())
            raise ConnectionError('Соединение разорвано во время отправки')

    async def _raw_send(self, packet: str):
        await self._wait_for_connection()
        try:
            await self._ws.send(packet)
        except websockets.ConnectionClosed:
            self._connected = False
            asyncio.create_task(self._reconnect())
            raise ConnectionError('Соединение разорвано во время отправки')

    async def _wait_for_connection(self, timeout: float = 15.0):
        if self._reconnecting:
            # Ждём завершения переподключения, но не дольше timeout секунд
            try:
                await asyncio.wait_for(self._reconnect_event.wait(), timeout=timeout)
            except asyncio.TimeoutError:
                raise ConnectionError('Не удалось переподключиться к платформе')
        if not self._connected or not self._ws:
            raise ConnectionError('Нет соединения с платформой')

    async def _receive_loop(self):
        try:
            async for raw in self._ws:
                if raw == '2':
                    await self._ws.send('3')
                    continue
                if not raw.startswith('4'):
                    continue
                event, args = _decode(raw)
                if event == '__ack__':
                    ack_id, data = args
                    fut = self._pending_acks.pop(ack_id, None)
                    if fut and not fut.done():
                        fut.set_result(data[0] if data else None)
                elif event != '__raw__':
                    await self._handle_event(event, args)
        except (websockets.ConnectionClosed, asyncio.CancelledError):
            pass
        finally:
            if self._login:
                self._connected = False
                asyncio.create_task(self._reconnect())

    async def _handle_event(self, event: str, args: list):
        if event == 'set_cookie':
            cookie_data = args[0] if args else {}
            self._session_token = cookie_data.get('session')

        elif event == 'code_queries_update':
            queries = args[0] if args else {}
            self._app_data['queries'] = queries

        elif event == 'send_app_data':
            data = args[0] if args else {}
            self._app_data.update(data)

        elif event == 'update_code':
            if len(args) >= 2:
                _, data = args[0], args[1]
                self._app_data['code'] = data.get('code', self._app_data.get('code', {}))

        elif event == 'compile_result':
            result = args[0] if args else ''
            self._app_data['compile'] = False
            self._app_data['compileResult'] = result
            if 'compile_result' in self._ack_futures:
                fut = self._ack_futures.pop('compile_result')
                if not fut.done():
                    fut.set_result(result)

        elif event == 'log_in_result':
            result = args[0] if args else {}
            if 'log_in_result' in self._ack_futures:
                fut = self._ack_futures.pop('log_in_result')
                if not fut.done():
                    fut.set_result(result)

        elif event == 'save_finish':
            new_hash = args[0] if args else None

        for callback in self._listeners.get(event, []):
            try:
                if asyncio.iscoroutinefunction(callback):
                    await callback(*args)
                else:
                    callback(*args)
            except Exception:
                pass
