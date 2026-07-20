"""
Мок SA-MP веб-платформы: минимальный Engine.IO(3)/Socket.IO(v3) сервер,
достаточный, чтобы гонять sync-агент и клиента без реальной платформы.

Понимает те же кадры, что и hassle_platform.client:
  - handshake: '0{...}' → ждём '40' → отвечаем '40'
  - ping '2' → '3'
  - события '42[event,args]' и ack-запросы '42<id>[event,args]' → '43<id>[data]'

Реализованы события, которые использует агент: log_in, set_code, start_compile,
start_server, stop_server, get_code (ack), open_page.
"""

import asyncio
import json

import websockets

# Демо-данные: один файл с полным доступом (1 блок) и один с доступом на 2 блока.
FILES = {
    '101': {'name': 'gamemode.pwn', 'fullPath': 'gamemodes/gamemode.pwn'},
    '102': {'name': 'util.inc', 'fullPath': 'includes/util.inc'},
}
CODE = {
    '101': [
        {'line': 1, 'hash': 'h101a',
         'content': '#include <a_samp>\n\nmain()\n{\n    print("hello");\n}\n'},
    ],
    '102': [
        {'line': 10, 'hash': 'h102a',
         'content': 'stock IsNearby(playerid)\n{\n    return 1;\n}'},
        {'line': 50, 'hash': 'h102b',
         'content': 'stock GetName(playerid)\n{\n    return "x";\n}'},
    ],
}
PROJECT = {'files': [101, 102]}


def _encode(event, *args):
    return '42' + json.dumps([event, *args])


async def _send_app_data(ws, **overrides):
    data = {
        'files': FILES,
        'code': CODE,
        'project': PROJECT,
        'server': 'off',
        'compile': False,
    }
    data.update(overrides)
    await ws.send(_encode('send_app_data', data))


async def handler(ws):
    # Engine.IO handshake
    await ws.send('0' + json.dumps({
        'sid': 'mock-sid', 'pingInterval': 25000, 'pingTimeout': 5000, 'upgrades': [],
    }))
    first = await ws.recv()          # ожидаем '40'
    if first != '40':
        await ws.close()
        return
    await ws.send('40')

    server_state = {'server': 'off'}
    hash_counter = {'n': 0}

    try:
        await _serve_loop(ws, server_state, hash_counter)
    except websockets.exceptions.ConnectionClosed:
        pass


async def _serve_loop(ws, server_state, hash_counter):
    async for raw in ws:
        if raw == '2':               # ping
            await ws.send('3')
            continue
        if not raw.startswith('42'):
            continue

        rest = raw[2:]
        ack_id = None
        j = 0
        while j < len(rest) and rest[j].isdigit():
            j += 1
        if j > 0:
            ack_id = rest[:j]
            rest = rest[j:]
        try:
            payload = json.loads(rest)
        except Exception:
            continue
        event = payload[0]
        args = payload[1:]

        if event == 'log_in':
            await ws.send(_encode('log_in_result', {'type': 'success'}))
            await ws.send(_encode('set_cookie', {'session': 'mock-session'}))
            await _send_app_data(ws)

        elif event == 'set_code':
            # args = [file_id, content, part_index, hash, '']
            hash_counter['n'] += 1
            new_hash = f'newhash{hash_counter["n"]}'
            # Обновляем содержимое блока в моке (чтобы повторный get видел правку)
            try:
                fid = str(args[0]); idx = int(args[2])
                CODE[fid][idx]['content'] = args[1]
                CODE[fid][idx]['hash'] = new_hash
            except Exception:
                pass
            await ws.send(_encode('save_finish', new_hash))

        elif event == 'start_compile':
            await asyncio.sleep(0.2)
            await ws.send(_encode('compile_result',
                                  'Pawn compiler 3.10\n\n2 lines, 0 errors.'))

        elif event == 'start_server':
            server_state['server'] = 'on'
            await ws.send(_encode('server_log', '[server] Started game server on 0.0.0.0:7777'))
            await _send_app_data(ws, server='on')

        elif event == 'stop_server':
            server_state['server'] = 'off'
            await ws.send(_encode('server_log', '[server] Stopped.'))
            await _send_app_data(ws, server='off')

        elif event == 'get_code':
            # ack-ответ с содержимым первого блока запрошенного файла
            if ack_id is not None:
                fid = str(args[1]) if len(args) > 1 else ''
                parts = CODE.get(fid, [])
                result = parts[0] if parts else None
                await ws.send('43' + ack_id + json.dumps([result]))

        elif event == 'open_page':
            if ack_id is not None:
                await ws.send('43' + ack_id + json.dumps([{}]))


async def run(host='127.0.0.1', port=8799):
    async with websockets.serve(handler, host, port):
        await asyncio.Future()


if __name__ == '__main__':
    asyncio.run(run())
