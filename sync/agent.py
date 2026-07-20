"""
Sync-агент для редактора (VS Code / Cursor).

Расширение запускает этот процесс и общается с ним по JSON-RPC поверх stdio
(по одному JSON-объекту на строку, UTF-8):

  запрос:  {"id": <int>, "method": "<name>", "params": {...}}
  ответ:   {"id": <int>, "result": {...}}  |  {"id": <int>, "error": "<msg>"}
  событие: {"event": "<name>", "data": {...}}      (без id, агент → редактор)

Почему отдельный процесс: вся механика Engine.IO/Socket.IO, авторизации,
ack-ов, реконнекта, hash-конкурентности и SOCKS5 уже реализована и отлажена
в hassle_platform.PlatformClient — переиспользуем её вместо переписывания на TS.

Модель данных:
  Платформа выдаёт код не файлами, а «блоками» (parts): file_id → [{line,
  content, hash}]. Доступны только те file_id, что есть в code. Поэтому
  агент оперирует блоками; редактор показывает один виртуальный файл на блок
  (при доступе на весь файл это ровно один блок).

PLATFORM_URL и PROXY_URL берутся из аргументов командной строки и кладутся в
окружение ДО импорта hassle_platform (там URL вычисляется на этапе импорта).
"""

import argparse
import asyncio
import json
import os
import sys
import threading


def _install_config_from_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Platform sync agent')
    parser.add_argument('--platform-url', default=os.getenv('PLATFORM_URL', ''),
                        help='URL платформы (ws строится из него)')
    parser.add_argument('--proxy-url', default=os.getenv('PROXY_URL', ''),
                        help='SOCKS5 прокси, напр. socks5://127.0.0.1:10808 (xray)')
    args = parser.parse_args()
    # config.py / hassle_platform.client читают эти переменные на импорте
    if args.platform_url:
        os.environ['PLATFORM_URL'] = args.platform_url
    os.environ['PROXY_URL'] = args.proxy_url or ''
    return args


class Agent:
    def __init__(self, loop: asyncio.AbstractEventLoop):
        self._loop = loop
        self._client = None            # hassle_platform.PlatformClient
        self._out_lock = threading.Lock()
        self._app_data_seen = asyncio.Event()

    # ── stdout: события и ответы ──────────────────────────────────

    def _write(self, obj: dict):
        line = json.dumps(obj, ensure_ascii=False)
        with self._out_lock:
            sys.stdout.write(line + '\n')
            sys.stdout.flush()

    def _emit_event(self, name: str, data):
        self._write({'event': name, 'data': data})

    # ── подписки на события клиента платформы ─────────────────────

    def _wire_client(self, client):
        def on_server_log(line):
            self._emit_event('server_log', {'line': line})

        def on_status(*_):
            self._app_data_seen.set()
            self._emit_event('status', {
                'server': client.server_status,
                'compile': client.is_compiling,
            })
            diff = client.last_code_diff or {}
            if diff.get('lost') or diff.get('added') or diff.get('changed'):
                self._emit_event('code_updated', {
                    'lost': diff.get('lost') or [],
                    'added': diff.get('added') or [],
                    'changed': diff.get('changed') or [],
                })

        def on_compile(result):
            self._emit_event('compile_result', {'result': result})

        client.on('server_log', on_server_log)
        client.on('send_app_data', on_status)
        client.on('update_code', on_status)
        client.on('compile_result', on_compile)

    # ── JSON-RPC методы ───────────────────────────────────────────

    async def m_connect(self, params: dict):
        from hassle_platform import PlatformClient
        login = params.get('login', '')
        password = params.get('password', '')
        if self._client:
            try:
                await self._client.disconnect()
            except Exception:
                pass
            self._client = None
        client = PlatformClient()
        ok = await client.connect()
        if not ok:
            return {'connected': False, 'error': 'Не удалось подключиться к платформе'}
        self._wire_client(client)
        success, err = await client.login(login, password)
        if not success:
            await client.disconnect()
            return {'connected': False, 'error': err or 'Ошибка авторизации'}
        self._client = client
        # ждём первый send_app_data чтобы files/code заполнились
        try:
            await asyncio.wait_for(self._app_data_seen.wait(), timeout=8)
        except asyncio.TimeoutError:
            pass
        return {'connected': True}

    async def m_status(self, params: dict):
        c = self._client
        if not c:
            return {'connected': False, 'server': 'unknown', 'compile': False}
        return {'connected': True, 'server': c.server_status, 'compile': c.is_compiling}

    async def m_list_files(self, params: dict):
        c = self._require()
        # даём платформе дослать данные, если ещё не пришли
        for _ in range(8):
            if c.files and c.code:
                break
            await asyncio.sleep(1)
        files = c.files or {}
        code = c.code or {}
        order = [str(x) for x in (c.project_files or [])]
        out = []
        for fid, meta in files.items():
            parts = code.get(fid, []) or []
            out.append({
                'file_id': str(fid),
                'name': (meta or {}).get('name', str(fid)),
                'fullPath': (meta or {}).get('fullPath') or (meta or {}).get('name', str(fid)),
                'parts': [{
                    'part_index': i,
                    'line': p.get('line'),
                    'hash': p.get('hash'),
                    'lines': len((p.get('content') or '').split('\n')),
                } for i, p in enumerate(parts)],
            })
        return {'files': out, 'order': order}

    async def m_get_block(self, params: dict):
        c = self._require()
        fid = str(params['file_id'])
        idx = int(params['part_index'])
        parts = c.code.get(fid, [])
        if not parts or idx >= len(parts):
            raise RuntimeError('Блок недоступен или отозван')
        p = parts[idx]
        return {'content': p.get('content', ''), 'hash': p.get('hash'), 'line': p.get('line')}

    async def m_save_block(self, params: dict):
        c = self._require()
        fid = str(params['file_id'])
        idx = int(params['part_index'])
        content = params.get('content', '')
        expected_hash = params.get('hash')

        parts = c.code.get(fid, [])
        if not parts or idx >= len(parts):
            raise RuntimeError('Блок недоступен или был отозван. Обновите список.')
        cached_hash = parts[idx].get('hash')
        # Оптимистичная блокировка: если редактор редактировал версию,
        # отличную от текущей серверной — конфликт.
        if expected_hash and cached_hash and expected_hash != cached_hash:
            return {'conflict': True, 'current_hash': cached_hash}

        loop = asyncio.get_event_loop()
        fut = loop.create_future()

        def on_save_finish(*a):
            if not fut.done():
                fut.set_result(a[0] if a else None)

        c.on('save_finish', on_save_finish)
        try:
            file_id = int(fid) if fid.isdigit() else fid
            await c._emit('set_code', file_id, content, idx, cached_hash or None, '')
            new_hash = await asyncio.wait_for(fut, timeout=15)
        finally:
            c.off('save_finish', on_save_finish)

        c.update_cached_code(fid, idx, content, new_hash)
        return {'new_hash': new_hash}

    async def m_request_access(self, params: dict):
        c = self._require()
        fid = params['file_id']
        file_id = int(fid) if str(fid).isdigit() else fid
        try:
            result = await c.get_code_ack('edit', file_id, params.get('code_path', []),
                                          params.get('query_name', ''))
        except asyncio.TimeoutError:
            return {'result': 'pending'}
        return {'result': result}

    async def m_compile(self, params: dict):
        c = self._require()
        result = await c.start_compile()
        return {'result': result}

    async def m_start_server(self, params: dict):
        c = self._require()
        await c.start_server()
        return {'server': c.server_status}

    async def m_stop_server(self, params: dict):
        c = self._require()
        await c.stop_server()
        return {'server': c.server_status}

    async def m_console(self, params: dict):
        c = self._require()
        limit = int(params.get('limit', 500))
        return {'lines': c.get_console_log(limit=limit)}

    async def m_disconnect(self, params: dict):
        if self._client:
            try:
                await self._client.disconnect()
            except Exception:
                pass
            self._client = None
        return {'ok': True}

    # ── диспетчер ─────────────────────────────────────────────────

    def _require(self):
        if not self._client:
            raise RuntimeError('Нет соединения с платформой (сначала connect)')
        return self._client

    async def dispatch(self, msg: dict):
        rid = msg.get('id')
        method = msg.get('method', '')
        params = msg.get('params') or {}
        handler = getattr(self, 'm_' + method, None)
        if handler is None:
            if rid is not None:
                self._write({'id': rid, 'error': f'Неизвестный метод: {method}'})
            return
        try:
            result = await handler(params)
            if rid is not None:
                self._write({'id': rid, 'result': result})
        except Exception as e:
            if rid is not None:
                self._write({'id': rid, 'error': f'{type(e).__name__}: {e}'})


async def _amain():
    _install_config_from_args()
    loop = asyncio.get_event_loop()
    agent = Agent(loop)
    stop = asyncio.Event()
    agent._emit_event('ready', {'pid': os.getpid()})

    # Читаем stdin в отдельном потоке (readline блокирующий), задачи создаём в loop.
    def reader():
        for raw in sys.stdin:
            raw = raw.strip()
            if not raw:
                continue
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            asyncio.run_coroutine_threadsafe(agent.dispatch(msg), loop)
        # stdin закрыт — сигналим завершение
        loop.call_soon_threadsafe(stop.set)

    t = threading.Thread(target=reader, daemon=True)
    t.start()

    try:
        await stop.wait()
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass


def main():
    # stdio строго UTF-8: агент обменивается JSON (в т.ч. с кириллицей —
    # логи сервера), а на Windows дефолт пайпа может быть cp1252 и ронять
    # запись/чтение не-ASCII. Делаем до любого ввода-вывода.
    for stream in (sys.stdout, sys.stdin):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass
    try:
        asyncio.run(_amain())
    except (KeyboardInterrupt, RuntimeError):
        pass


if __name__ == '__main__':
    main()
