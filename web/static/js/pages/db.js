// ── Database Interface ────────────────────────────────────────────

const DbPage = {
    _db: '',
    _table: '',
    _tables: [],
    _databases: [],
    _cols: [],
    _total: 0,
    _offset: 0,
    _limit: 100,
    _orderBy: '',
    _orderDir: 'ASC',
    _pkCol: '',
    _view: 'query',  // 'query' | 'browse' | 'structure'
    _tableSearch: '',
    _FAV_KEY: 'db_fav_tables',

    _loadFavs()     { try { return JSON.parse(localStorage.getItem(this._FAV_KEY) || '[]'); } catch { return []; } },
    _saveFavs(f)    { try { localStorage.setItem(this._FAV_KEY, JSON.stringify(f)); } catch {} },
    _isFav(t)       { return this._loadFavs().includes(t); },
    _toggleFav(t)   {
        let favs = this._loadFavs();
        favs = favs.includes(t) ? favs.filter(f => f !== t) : [...favs, t];
        this._saveFavs(favs);
    },

    render(el) {
        el.innerHTML = `
        <div class="db-layout">
            <div class="db-sidebar">
                <div class="db-sidebar-header">
                    <span>🗄</span>
                    <span style="flex:1;font-size:12px;color:var(--text-2);font-family:var(--mono)">crmp_cloud</span>
                    <button id="db-reload" title="Обновить" style="background:none;border:none;color:var(--text-3);cursor:pointer;font-size:14px;padding:2px 4px">↻</button>
                </div>
                <div style="padding:6px 8px;border-bottom:1px solid var(--border);flex-shrink:0">
                    <input id="db-table-search" type="search" placeholder="Поиск таблицы..." style="width:100%;padding:5px 9px;font-size:12px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);outline:none" />
                </div>
                <div class="db-table-list" id="db-table-list">
                    <div style="padding:12px 14px;color:var(--text-3);font-size:12px">Загрузка...</div>
                </div>
            </div>
            <div class="db-main">
                <div class="db-toolbar">
                    <button class="btn btn-ghost btn-sm" id="dbt-query" data-view="query">SQL запрос</button>
                    <button class="btn btn-ghost btn-sm" id="dbt-browse" data-view="browse">Таблица</button>
                    <button class="btn btn-ghost btn-sm" id="dbt-structure" data-view="structure">Структура</button>
                    <span style="flex:1"></span>
                    <span id="db-info" style="font-size:12px;color:var(--text-3);font-family:var(--mono)"></span>
                </div>

                <div id="db-query-panel">
                    <div class="db-query-wrap">
                        <textarea class="db-query-input" id="db-sql" placeholder="SELECT * FROM table LIMIT 100;"></textarea>
                        <div style="display:flex;gap:8px;margin-top:8px;align-items:center">
                            <button class="btn btn-primary btn-sm" id="db-run">▶ Выполнить</button>
                            <button class="btn btn-ghost btn-sm" id="db-clear-sql">Очистить</button>
                            <span style="flex:1"></span>
                            <span style="font-size:12px;color:var(--text-3)">Ctrl+Enter — выполнить</span>
                        </div>
                    </div>
                    <div class="db-result-wrap" id="db-query-result">
                        <div style="display:flex;align-items:center;justify-content:center;height:200px;color:var(--text-3);font-size:13px">
                            Введите SQL запрос и нажмите ▶ Выполнить
                        </div>
                    </div>
                </div>

                <div id="db-browse-panel" style="display:none;flex:1;flex-direction:column;overflow:hidden">
                    <div style="display:flex;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid var(--border);flex-shrink:0;background:var(--surface)">
                        <span id="db-browse-info" style="font-size:12px;color:var(--text-3);font-family:var(--mono)"></span>
                        <span style="flex:1"></span>
                        <button class="btn btn-ghost btn-sm" id="db-prev">← Пред.</button>
                        <span id="db-page-info" style="font-size:12px;color:var(--text-2)"></span>
                        <button class="btn btn-ghost btn-sm" id="db-next">След. →</button>
                    </div>
                    <div class="db-result-wrap" id="db-browse-result" style="flex:1"></div>
                </div>

                <div id="db-structure-panel" style="display:none;flex:1;flex-direction:column;overflow:hidden">
                    <div class="db-result-wrap" id="db-structure-result" style="flex:1"></div>
                </div>

                <div class="db-status" id="db-status"></div>
            </div>
        </div>`;

        this._db = 'crmp_cloud';
        this._tableSearch = '';
        this._loadTables(el);

        el.querySelector('#db-reload').addEventListener('click', () => this._loadTables(el));
        el.querySelector('#db-table-search').addEventListener('input', e => {
            this._tableSearch = e.target.value.toLowerCase();
            this._renderTableList(el);
        });
        el.querySelector('#db-run').addEventListener('click', () => this._runQuery(el));
        el.querySelector('#db-clear-sql').addEventListener('click', () => {
            el.querySelector('#db-sql').value = '';
        });
        el.querySelector('#db-sql').addEventListener('keydown', e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                this._runQuery(el);
            }
        });
        el.querySelector('#db-prev').addEventListener('click', () => {
            if (this._offset >= this._limit) {
                this._offset -= this._limit;
                this._browse(el);
            }
        });
        el.querySelector('#db-next').addEventListener('click', () => {
            if (this._offset + this._limit < this._total) {
                this._offset += this._limit;
                this._browse(el);
            }
        });

        ['query', 'browse', 'structure'].forEach(view => {
            el.querySelector(`#dbt-${view}`).addEventListener('click', () => this._switchView(el, view));
        });

        this._switchView(el, 'query');
    },

    _switchView(el, view) {
        this._view = view;
        ['query', 'browse', 'structure'].forEach(v => {
            const btn = el.querySelector(`#dbt-${v}`);
            const panel = el.querySelector(`#db-${v}-panel`);
            if (btn) btn.classList.toggle('active', v === view);
            if (panel) {
                if (v === view) {
                    panel.style.display = v === 'query' ? 'block' : 'flex';
                    panel.style.flexDirection = 'column';
                    panel.style.flex = '1';
                    panel.style.overflow = 'hidden';
                } else {
                    panel.style.display = 'none';
                }
            }
        });
        if (view === 'browse' && this._table) this._browse(el);
        if (view === 'structure' && this._table) this._loadStructure(el);
    },

    async _loadDatabases(el) {
        try {
            const res = await API.get('/api/db/databases');
            this._databases = res.databases;
            const sel = el.querySelector('#db-sel');
            sel.innerHTML = '<option value="">— база данных —</option>' +
                res.databases.map(d => `<option value="${this._esc(d)}">${this._esc(d)}</option>`).join('');
            this._setStatus(`${res.databases.length} баз данных`, 'ok');
        } catch (e) {
            this._setStatus('Ошибка подключения: ' + e.message, 'err');
        }
    },

    async _loadTables(el) {
        const list = el.querySelector('#db-table-list');
        list.innerHTML = '<div style="padding:12px 14px;color:var(--text-3);font-size:12px">Загрузка...</div>';
        try {
            const res = await API.get(`/api/db/tables?database=${encodeURIComponent(this._db)}`);
            this._tables = res.tables;
            this._renderTableList(el);
            this._setStatus(`${res.tables.length} таблиц в ${this._db}`, 'ok');
        } catch (e) {
            list.innerHTML = `<div style="padding:12px;color:var(--red);font-size:12px">${e.message}</div>`;
            this._setStatus('Ошибка: ' + e.message, 'err');
        }
    },

    _renderTableList(el) {
        const list = el.querySelector('#db-table-list');
        if (!list) return;
        const q    = this._tableSearch;
        const favs = this._loadFavs();

        const favTables = favs.filter(t => this._tables.includes(t) && (!q || t.toLowerCase().includes(q)));
        const allTables = this._tables.filter(t => !favs.includes(t) && (!q || t.toLowerCase().includes(q)));

        const mkItem = t => `
        <div class="db-table-item ${t === this._table ? 'active' : ''}" data-table="${this._esc(t)}">
            <span style="color:var(--text-3);font-size:11px">⊞</span>
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis">${this._esc(t)}</span>
            <span class="db-fav-btn" data-table="${this._esc(t)}" title="Избранное" style="opacity:${favs.includes(t)?'1':'0'};color:var(--yellow);font-size:12px;flex-shrink:0;cursor:pointer;padding:0 2px">★</span>
        </div>`;

        let html = '';
        if (favTables.length) {
            html += `<div style="padding:5px 14px 3px;font-size:10px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">⭐ Избранное</div>`;
            html += favTables.map(mkItem).join('');
            if (allTables.length) html += `<div style="height:1px;background:var(--border);margin:4px 0"></div>`;
        }
        html += allTables.map(mkItem).join('');
        if (!html) html = '<div style="padding:12px 14px;color:var(--text-3);font-size:12px">Ничего не найдено</div>';

        list.innerHTML = html;

        list.querySelectorAll('.db-table-item').forEach(item => {
            item.addEventListener('click', e => {
                if (e.target.classList.contains('db-fav-btn')) return;
                this._table = item.dataset.table;
                this._offset = 0;
                this._orderBy = '';
                el.querySelector('#db-info').textContent = `${this._db} › ${this._table}`;
                this._switchView(el, 'browse');
            });
            // Показываем звёздочку при hover через JS (CSS hover не меняет opacity дочернего)
            item.addEventListener('mouseenter', () => {
                const star = item.querySelector('.db-fav-btn');
                if (star && !this._isFav(item.dataset.table)) star.style.opacity = '0.4';
            });
            item.addEventListener('mouseleave', () => {
                const star = item.querySelector('.db-fav-btn');
                if (star && !this._isFav(item.dataset.table)) star.style.opacity = '0';
            });
        });

        list.querySelectorAll('.db-fav-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                this._toggleFav(btn.dataset.table);
                this._renderTableList(el);
            });
        });
    },

    async _runQuery(el) {
        const sql = el.querySelector('#db-sql').value.trim();
        if (!sql) return;
        const result = el.querySelector('#db-query-result');
        result.innerHTML = '<div style="padding:20px;color:var(--text-2);font-size:13px;text-align:center">Выполнение...</div>';
        const btn = el.querySelector('#db-run');
        btn.disabled = true;
        const t0 = Date.now();
        try {
            const res = await API.post('/api/db/query', { sql, database: this._db });
            const ms = Date.now() - t0;
            if (res.kind === 'select') {
                result.innerHTML = this._renderTable(res.columns, res.rows);
                this._setStatus(`${res.rows.length} строк · ${ms}мс`, 'ok');
            } else {
                result.innerHTML = `<div style="padding:20px;color:var(--green);font-size:13px">OK · затронуто ${res.affected} строк · ${ms}мс</div>`;
                this._setStatus(`OK · ${res.affected} строк · ${ms}мс`, 'ok');
                // Обновляем browse если открыта та же БД
                if (this._view === 'browse' && this._table) this._browse(el);
            }
        } catch (e) {
            result.innerHTML = `<div style="padding:20px;color:var(--red);font-size:13px;font-family:var(--mono);white-space:pre-wrap">${this._esc(e.message)}</div>`;
            this._setStatus('Ошибка запроса', 'err');
        } finally {
            btn.disabled = false;
        }
    },

    async _browse(el) {
        if (!this._db || !this._table) return;
        const result = el.querySelector('#db-browse-result');
        result.innerHTML = '<div style="padding:20px;color:var(--text-2);font-size:13px;text-align:center">Загрузка...</div>';
        try {
            const res = await API.post('/api/db/browse', {
                database: this._db,
                table: this._table,
                limit: this._limit,
                offset: this._offset,
                order_by: this._orderBy,
                order_dir: this._orderDir,
            });
            this._total = res.total;
            this._cols  = res.columns;
            this._pkCol = res.columns[0] || '';
            const from  = this._offset + 1;
            const to    = Math.min(this._offset + this._limit, res.total);
            el.querySelector('#db-page-info').textContent = `${from}–${to} из ${res.total}`;
            el.querySelector('#db-browse-info').textContent = `${this._db} › ${this._table}`;
            el.querySelector('#db-prev').disabled = this._offset === 0;
            el.querySelector('#db-next').disabled = to >= res.total;
            result.innerHTML = this._renderTable(res.columns, res.rows, true);
            this._setStatus(`${res.total} строк всего`, 'ok');
            this._bindCellEdit(result, el);
            this._bindSortHeaders(result, el);
        } catch (e) {
            result.innerHTML = `<div style="padding:20px;color:var(--red);font-size:13px">${this._esc(e.message)}</div>`;
            this._setStatus('Ошибка загрузки', 'err');
        }
    },

    async _loadStructure(el) {
        if (!this._db || !this._table) return;
        const result = el.querySelector('#db-structure-result');
        result.innerHTML = '<div style="padding:20px;color:var(--text-2);font-size:13px;text-align:center">Загрузка...</div>';
        try {
            const res = await API.post('/api/db/structure', {
                database: this._db,
                table: this._table,
            });
            result.innerHTML = `
            <div style="padding:12px 16px;font-size:12px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Столбцы</div>
            ${this._renderTable(res.columns_headers, res.columns)}
            <div style="padding:12px 16px;font-size:12px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-top:8px;border-top:1px solid var(--border)">Индексы</div>
            ${this._renderTable(res.indexes_headers, res.indexes)}`;
            this._setStatus(`Структура ${this._table}`, 'ok');
        } catch (e) {
            result.innerHTML = `<div style="padding:20px;color:var(--red);font-size:13px">${this._esc(e.message)}</div>`;
        }
    },

    _renderTable(columns, rows, editable = false) {
        if (!columns.length) return '<div style="padding:20px;color:var(--text-3);font-size:13px;text-align:center">Нет данных</div>';
        const thClass = editable ? 'style="cursor:pointer;user-select:none" data-sort' : '';
        const headerHtml = columns.map(c => {
            const arrow = editable && c === this._orderBy ? (this._orderDir === 'ASC' ? ' ↑' : ' ↓') : '';
            return `<th ${editable ? `data-col="${this._esc(c)}"` : ''}>${this._esc(String(c))}${arrow}</th>`;
        }).join('');
        const bodyHtml = rows.map((row, ri) => {
            const cells = (Array.isArray(row) ? row : Object.values(row)).map((val, ci) => {
                const isNull = val === null || val === undefined;
                const isNum  = !isNull && typeof val === 'number';
                const display = isNull ? 'NULL' : String(val);
                const cls    = isNull ? 'db-null' : isNum ? 'db-num' : 'db-str';
                const editAttrs = editable
                    ? `data-ri="${ri}" data-ci="${ci}" data-col="${this._esc(columns[ci])}" data-orig="${this._esc(display)}" class="${cls}" style="cursor:pointer" title="Двойной клик для редактирования"`
                    : `class="${cls}"`;
                return `<td ${editAttrs}>${this._esc(display)}</td>`;
            }).join('');
            return `<tr>${cells}</tr>`;
        }).join('');
        return `<table class="db-table-result"><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`;
    },

    _bindSortHeaders(result, el) {
        result.querySelectorAll('th[data-col]').forEach(th => {
            th.addEventListener('click', () => {
                const col = th.dataset.col;
                if (this._orderBy === col) {
                    this._orderDir = this._orderDir === 'ASC' ? 'DESC' : 'ASC';
                } else {
                    this._orderBy  = col;
                    this._orderDir = 'ASC';
                }
                this._offset = 0;
                this._browse(el);
            });
        });
    },

    _bindCellEdit(result, el) {
        result.querySelectorAll('td[data-col]').forEach(td => {
            td.addEventListener('dblclick', e => {
                e.stopPropagation();
                const col  = td.dataset.col;
                const orig = td.dataset.orig;
                const ri   = parseInt(td.dataset.ri);

                // Находим pk value из первого столбца той же строки
                const row    = td.parentElement;
                const pkCell = row.querySelector('td');
                const pkVal  = pkCell?.dataset.orig ?? '';

                const rect = td.getBoundingClientRect();
                const input = document.createElement('input');
                input.className = 'db-cell-edit';
                input.value = orig === 'NULL' ? '' : orig;
                input.style.left   = rect.left + 'px';
                input.style.top    = rect.top  + 'px';
                input.style.width  = Math.max(rect.width, 160) + 'px';
                document.body.appendChild(input);
                input.focus();
                input.select();

                const commit = async () => {
                    input.remove();
                    const newVal = input.value;
                    if (newVal === orig || (orig === 'NULL' && newVal === '')) return;
                    try {
                        await API.post('/api/db/cell', {
                            database: this._db,
                            table:    this._table,
                            pk_col:   this._pkCol,
                            pk_val:   pkVal,
                            col,
                            value:    newVal === '' ? null : newVal,
                        });
                        td.textContent = newVal === '' ? 'NULL' : newVal;
                        td.dataset.orig = newVal === '' ? 'NULL' : newVal;
                        td.className = newVal === '' ? 'db-null' : 'db-str';
                        this._setStatus(`Обновлено ${col} = ${newVal}`, 'ok');
                    } catch (err) {
                        this._setStatus('Ошибка: ' + err.message, 'err');
                        app.toast('Ошибка обновления: ' + err.message, 'error');
                    }
                };

                input.addEventListener('blur', commit);
                input.addEventListener('keydown', e => {
                    if (e.key === 'Enter') { e.preventDefault(); commit(); }
                    if (e.key === 'Escape') { input.remove(); }
                });
            });
        });
    },

    _setStatus(msg, cls = '') {
        const el = document.querySelector('#db-status');
        if (!el) return;
        el.textContent = msg;
        el.className = 'db-status' + (cls ? ' ' + cls : '');
    },

    _esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); },
};

app.register('db', DbPage);
