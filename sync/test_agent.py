"""
End-to-end проверка sync-агента против мок-платформы.

Запуск:  PYTHONPATH=/workspace .venv/bin/python -m sync.test_agent

Поднимает мок-платформу в этом процессе, запускает агент отдельным процессом,
гоняет JSON-RPC сценарии (connect → list → get → save → compile → server) и
проверяет ответы и события (server_log).
"""

import asyncio
import json
import os
import sys

from sync import mock_platform

PORT = 8799


class AgentHarness:
    def __init__(self, proc):
        self.proc = proc
        self._id = 0
        self._pending = {}
        self.events = []
        self._event_waiters = []
        self._reader = asyncio.create_task(self._read_loop())

    async def _read_loop(self):
        while True:
            line = await self.proc.stdout.readline()
            if not line:
                break
            try:
                msg = json.loads(line.decode('utf-8').strip())
            except Exception:
                continue
            if 'id' in msg:
                fut = self._pending.pop(msg['id'], None)
                if fut and not fut.done():
                    fut.set_result(msg)
            elif 'event' in msg:
                self.events.append(msg)
                for w in list(self._event_waiters):
                    if not w['fut'].done() and w['name'] == msg['event']:
                        w['fut'].set_result(msg)

    async def call(self, method, **params):
        self._id += 1
        rid = self._id
        fut = asyncio.get_event_loop().create_future()
        self._pending[rid] = fut
        self.proc.stdin.write((json.dumps({'id': rid, 'method': method, 'params': params}) + '\n').encode())
        await self.proc.stdin.drain()
        msg = await asyncio.wait_for(fut, timeout=30)
        if 'error' in msg:
            raise RuntimeError(msg['error'])
        return msg['result']

    async def wait_event(self, name, timeout=10):
        fut = asyncio.get_event_loop().create_future()
        self._event_waiters.append({'name': name, 'fut': fut})
        # если уже приходило — вернём первое такое
        for e in self.events:
            if e['event'] == name:
                return e
        return await asyncio.wait_for(fut, timeout=timeout)


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print(f'  OK  {msg}')


async def main():
    mock_task = asyncio.create_task(mock_platform.run('127.0.0.1', PORT))
    await asyncio.sleep(0.3)

    env = dict(os.environ, PYTHONPATH='/workspace')
    proc = await asyncio.create_subprocess_exec(
        sys.executable, '-m', 'sync.agent',
        '--platform-url', f'http://127.0.0.1:{PORT}/', '--proxy-url', '',
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE, env=env, cwd='/workspace',
    )
    h = AgentHarness(proc)
    try:
        ready = await h.wait_event('ready', timeout=10)
        check(ready is not None, 'agent ready')

        r = await h.call('connect', login='tester', password='secret')
        check(r.get('connected') is True, 'connect + login')

        r = await h.call('list_files')
        files = {f['file_id']: f for f in r['files']}
        check('101' in files and '102' in files, 'list_files вернул оба файла')
        check(len(files['101']['parts']) == 1, 'gamemode.pwn — доступ на весь файл (1 блок)')
        check(len(files['102']['parts']) == 2, 'util.inc — доступ на 2 блока')
        check(r['order'] == ['101', '102'], 'порядок файлов из project')

        blk = await h.call('get_block', file_id='101', part_index=0)
        check('main()' in blk['content'], 'get_block вернул содержимое')
        h101 = blk['hash']

        # сохранение блока
        new_content = blk['content'] + '\n// edited via agent\n'
        r = await h.call('save_block', file_id='101', part_index=0, content=new_content, hash=h101)
        check(r.get('new_hash', '').startswith('newhash'), f'save_block → новый hash ({r.get("new_hash")})')

        # повторный get отражает правку (мок обновил блок)
        blk2 = await h.call('get_block', file_id='101', part_index=0)
        check('edited via agent' in blk2['content'], 'правка видна при повторном чтении')

        # конфликт по устаревшему hash
        r = await h.call('save_block', file_id='101', part_index=0, content='x', hash='STALEHASH')
        check(r.get('conflict') is True, 'save_block с устаревшим hash → конфликт')

        # сохранение второго блока файла с частичным доступом
        b2 = await h.call('get_block', file_id='102', part_index=1)
        r = await h.call('save_block', file_id='102', part_index=1, content=b2['content'] + '\n', hash=b2['hash'])
        check(r.get('new_hash', '').startswith('newhash'), 'save_block второго блока (частичный доступ)')

        # компиляция
        r = await h.call('compile')
        check('0 errors' in r['result'], f'compile → результат ({r["result"].splitlines()[-1]})')

        # старт сервера + событие консоли
        r = await h.call('start_server')
        check(r['server'] == 'on', 'start_server → server=on')
        ev = await h.wait_event('server_log', timeout=5)
        check('Started game server' in ev['data']['line'], 'получено событие server_log')

        r = await h.call('stop_server')
        check(r['server'] == 'off', 'stop_server → server=off')

        # консоль из буфера
        r = await h.call('console', limit=10)
        check(any('Started game server' in x['line'] for x in r['lines']), 'console буфер содержит лог')

        print('\nALL AGENT E2E TESTS PASSED')
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
        try:
            await asyncio.wait_for(proc.wait(), timeout=5)
        except Exception:
            proc.kill()
        mock_task.cancel()


if __name__ == '__main__':
    asyncio.run(main())
