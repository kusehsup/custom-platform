import asyncio
import socket
from typing import Any

import pymysql
import pymysql.cursors
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .auth import get_current_user

router = APIRouter(prefix='/api/db', tags=['db'])

DB_HOST     = '37.187.157.171'
DB_PORT     = 3306
DB_USER     = 'crmp_cloud'
DB_PASS     = 'fL7oV4dZ4o'
DB_NAME     = 'crmp_cloud'
PROXY_HOST  = '127.0.0.1'
PROXY_PORT  = 10808

# ------------------------------------------------------------------ #
#  Sync DB connection via SOCKS5 (run in executor)                   #
# ------------------------------------------------------------------ #

def _socks5_connect_sync(proxy_host: str, proxy_port: int, target_host: str, target_port: int) -> socket.socket:
    s = socket.create_connection((proxy_host, proxy_port), timeout=10)
    s.sendall(b'\x05\x01\x00')
    resp = s.recv(2)
    if resp != b'\x05\x00':
        s.close()
        raise ConnectionError(f'SOCKS5 greeting failed: {resp!r}')
    host_bytes = target_host.encode()
    s.sendall(
        b'\x05\x01\x00\x03' +
        bytes([len(host_bytes)]) + host_bytes +
        target_port.to_bytes(2, 'big')
    )
    hdr = s.recv(4)
    if len(hdr) < 4 or hdr[1] != 0:
        s.close()
        raise ConnectionError(f'SOCKS5 connect failed: {hdr!r}')
    atype = hdr[3]
    if atype == 1:
        s.recv(4)
    elif atype == 3:
        n = ord(s.recv(1))
        s.recv(n)
    elif atype == 4:
        s.recv(16)
    s.recv(2)
    return s


# ------------------------------------------------------------------ #
#  Разбивка на отдельные SQL-инструкции                              #
# ------------------------------------------------------------------ #
#  MySQL/MariaDB по протоколу не выполняет несколько инструкций в
#  одном execute() (нет CLIENT.MULTI_STATEMENTS), поэтому «пакет»
#  запросов от пользователя приходит одной строкой и падает с 1064.
#  Разбиваем сами, аккуратно учитывая строковые литералы, кавычки-
#  идентификаторы и комментарии, чтобы `;` внутри них не считался
#  разделителем. Пустые инструкции и «только комментарий» пропускаем.

def _split_sql_statements(sql: str) -> list[str]:
    statements: list[str] = []
    buf: list[str] = []
    has_content = False   # есть ли в текущей инструкции реальный (не коммент/не пробел) текст

    in_single = in_double = in_backtick = False
    in_line_comment = in_block_comment = False

    i, n = 0, len(sql)
    while i < n:
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < n else ''

        if in_line_comment:
            buf.append(ch)
            if ch == '\n':
                in_line_comment = False
            i += 1
            continue

        if in_block_comment:
            buf.append(ch)
            if ch == '*' and nxt == '/':
                buf.append(nxt)
                i += 2
                in_block_comment = False
                continue
            i += 1
            continue

        if in_single:
            buf.append(ch)
            if ch == '\\' and nxt:
                buf.append(nxt); i += 2; continue
            if ch == "'":
                if nxt == "'":
                    buf.append(nxt); i += 2; continue
                in_single = False
            i += 1
            continue

        if in_double:
            buf.append(ch)
            if ch == '\\' and nxt:
                buf.append(nxt); i += 2; continue
            if ch == '"':
                if nxt == '"':
                    buf.append(nxt); i += 2; continue
                in_double = False
            i += 1
            continue

        if in_backtick:
            buf.append(ch)
            if ch == '`':
                if nxt == '`':
                    buf.append(nxt); i += 2; continue
                in_backtick = False
            i += 1
            continue

        # Начало комментариев
        if ch == '-' and nxt == '-' and (i + 2 >= n or sql[i + 2] in ' \t\r\n'):
            in_line_comment = True; buf.append(ch); i += 1; continue
        if ch == '#':
            in_line_comment = True; buf.append(ch); i += 1; continue
        if ch == '/' and nxt == '*':
            in_block_comment = True; buf.append(ch); buf.append(nxt); i += 2; continue

        # Начало строк / идентификаторов
        if ch == "'":
            in_single = True; has_content = True; buf.append(ch); i += 1; continue
        if ch == '"':
            in_double = True; has_content = True; buf.append(ch); i += 1; continue
        if ch == '`':
            in_backtick = True; has_content = True; buf.append(ch); i += 1; continue

        # Разделитель инструкций
        if ch == ';':
            if has_content:
                statements.append(''.join(buf).strip())
            buf = []
            has_content = False
            i += 1
            continue

        if not ch.isspace():
            has_content = True
        buf.append(ch)
        i += 1

    if has_content:
        statements.append(''.join(buf).strip())

    return [s for s in statements if s]


def _db_connect_sync() -> pymysql.Connection:
    # Открываем SOCKS5-туннель сами и передаём готовый сокет в pymysql
    # через Connection.connect(sock=...). Это thread-safe — никаких
    # глобальных подмен socket.create_connection.
    raw_sock = _socks5_connect_sync(PROXY_HOST, PROXY_PORT, DB_HOST, DB_PORT)
    raw_sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    raw_sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
    raw_sock.settimeout(None)

    conn = pymysql.Connection(
        host=DB_HOST,
        port=DB_PORT,
        user=DB_USER,
        password=DB_PASS,
        database=DB_NAME,
        charset='utf8mb4',
        autocommit=True,
        connect_timeout=10,
        defer_connect=True,
    )
    try:
        conn.connect(sock=raw_sock)
    except Exception:
        try:
            raw_sock.close()
        except Exception:
            pass
        raise
    return conn




# ------------------------------------------------------------------ #
#  Schema models                                                      #
# ------------------------------------------------------------------ #

class QueryRequest(BaseModel):
    sql: str
    database: str = ''


class TableBrowseRequest(BaseModel):
    database: str
    table: str
    limit: int = 200
    offset: int = 0
    order_by: str = ''
    order_dir: str = 'ASC'


class CellUpdateRequest(BaseModel):
    database: str
    table: str
    pk_col: str
    pk_val: Any
    col: str
    value: Any


class TableStructureRequest(BaseModel):
    database: str
    table: str


# ------------------------------------------------------------------ #
#  Endpoints — все DB-операции синхронные, выполняются в executor    #
# ------------------------------------------------------------------ #

@router.get('/databases')
async def list_databases(login: str = Depends(get_current_user)):
    def _run():
        conn = _db_connect_sync()
        try:
            with conn.cursor() as cur:
                cur.execute('SHOW DATABASES')
                return {'databases': [r[0] for r in cur.fetchall()]}
        finally:
            conn.close()
    try:
        return await asyncio.get_event_loop().run_in_executor(None, _run)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get('/tables')
async def list_tables(database: str, login: str = Depends(get_current_user)):
    def _run():
        conn = _db_connect_sync()
        try:
            with conn.cursor() as cur:
                cur.execute(f'USE `{database}`')
                cur.execute('SHOW TABLES')
                return {'tables': [r[0] for r in cur.fetchall()]}
        finally:
            conn.close()
    try:
        return await asyncio.get_event_loop().run_in_executor(None, _run)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


MAX_QUERY_ROWS = 2000


@router.post('/query')
async def run_query(body: QueryRequest, login: str = Depends(get_current_user)):
    statements = _split_sql_statements(body.sql)
    if not statements:
        raise HTTPException(status_code=400, detail='Пустой запрос')

    def _run():
        conn = _db_connect_sync()
        try:
            results = []
            with conn.cursor(pymysql.cursors.DictCursor) as cur:
                if body.database:
                    cur.execute(f'USE `{body.database}`')
                for idx, stmt in enumerate(statements):
                    try:
                        cur.execute(stmt)
                    except Exception as e:
                        # Понятная привязка ошибки к конкретной инструкции пакета
                        prefix = f'Запрос #{idx + 1}: ' if len(statements) > 1 else ''
                        raise RuntimeError(f'{prefix}{e}') from e
                    if cur.description:
                        rows = cur.fetchmany(MAX_QUERY_ROWS)
                        columns = [d[0] for d in cur.description]
                        results.append({
                            'columns': columns,
                            'rows': [list(r.values()) for r in rows],
                            'affected': cur.rowcount,
                            'kind': 'select',
                            'statement': stmt,
                            'truncated': len(rows) >= MAX_QUERY_ROWS,
                        })
                    else:
                        results.append({
                            'columns': [],
                            'rows': [],
                            'affected': cur.rowcount,
                            'kind': 'dml',
                            'statement': stmt,
                            'truncated': False,
                        })
            return {'results': results}
        finally:
            conn.close()
    try:
        return await asyncio.get_event_loop().run_in_executor(None, _run)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post('/browse')
async def browse_table(body: TableBrowseRequest, login: str = Depends(get_current_user)):
    def _run():
        conn = _db_connect_sync()
        try:
            with conn.cursor(pymysql.cursors.DictCursor) as cur:
                cur.execute(f'USE `{body.database}`')
                order = ''
                if body.order_by:
                    dir_ = 'DESC' if body.order_dir.upper() == 'DESC' else 'ASC'
                    order = f'ORDER BY `{body.order_by}` {dir_}'
                cur.execute(f'SELECT COUNT(*) as cnt FROM `{body.table}`')
                total = cur.fetchone()['cnt']
                cur.execute(f'SELECT * FROM `{body.table}` {order} LIMIT %s OFFSET %s',
                            (body.limit, body.offset))
                rows = cur.fetchall()
                columns = [d[0] for d in cur.description] if cur.description else []
                return {
                    'columns': columns,
                    'rows': [list(r.values()) for r in rows],
                    'total': total,
                }
        finally:
            conn.close()
    try:
        return await asyncio.get_event_loop().run_in_executor(None, _run)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post('/structure')
async def table_structure(body: TableStructureRequest, login: str = Depends(get_current_user)):
    def _run():
        conn = _db_connect_sync()
        try:
            with conn.cursor(pymysql.cursors.DictCursor) as cur:
                cur.execute(f'USE `{body.database}`')
                cur.execute(f'SHOW FULL COLUMNS FROM `{body.table}`')
                cols = cur.fetchall()
                cur.execute(f'SHOW INDEXES FROM `{body.table}`')
                idxs = cur.fetchall()
                return {
                    'columns': [list(c.values()) for c in cols],
                    'columns_headers': list(cols[0].keys()) if cols else [],
                    'indexes': [list(i.values()) for i in idxs],
                    'indexes_headers': list(idxs[0].keys()) if idxs else [],
                }
        finally:
            conn.close()
    try:
        return await asyncio.get_event_loop().run_in_executor(None, _run)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post('/cell')
async def update_cell(body: CellUpdateRequest, login: str = Depends(get_current_user)):
    def _run():
        conn = _db_connect_sync()
        try:
            with conn.cursor() as cur:
                cur.execute(f'USE `{body.database}`')
                cur.execute(
                    f'UPDATE `{body.table}` SET `{body.col}` = %s WHERE `{body.pk_col}` = %s',
                    (body.value, body.pk_val),
                )
                return {'affected': cur.rowcount}
        finally:
            conn.close()
    try:
        return await asyncio.get_event_loop().run_in_executor(None, _run)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
