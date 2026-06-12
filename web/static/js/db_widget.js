// ── DB Widget: browse + SQL ──────────────────────────────────────────
//
// Два режима в одном виджете:
//   - Browse  — список таблиц + превью данных с пагинацией
//   - SQL     — быстрый запрос (textarea + Ctrl+Enter)
//
// История запросов и избранные таблицы шарятся с DbPage через те же
// localStorage-ключи.

const DbWidget = {
    _DATABASE: 'crmp_cloud',
    _FAV_KEY: 'db_fav_tables',
    _HIST_KEY: 'db_query_hist',
    _HIST_MAX: 10,
    _LAST_TABLE_KEY: 'db_widget_last_table',
    _LAST_SQL_KEY: 'db_widget_last_sql',
    _MODE_KEY: 'db_widget_mode',

    _mode: 'browse',    // 'browse' | 'sql'
    _tables: [],
    _table: '',
    _offset: 0,
    _limit: 50,
    _total: 0,
    _tableSearch: '',
    _lastResult: null,

    toggle() {
        const existing = document.getElementById('widget-db');
        if (existing) { Widgets.toggle('widget-db'); return; }

        try { this._mode = localStorage.getItem(this._MODE_KEY) || 'browse'; } catch {}

        Widgets.create({
            id: 'widget-db',
            title: '🗄 БД',
            width: 740,
            height: 480,
            defaultPos: { right: 24, bottom: 80 },
            content: this._template(),
        });

        this._bindCommon();
        this._renderMode();
    },

    _template() {
        return `
        <div class="dbw">
            <div class="dbw-tabs">
                <button class="dbw-tab" data-mode="browse">Таблицы</button>
                <button class="dbw-tab" data-mode="sql">SQL</button>
                <span style="flex:1"></span>
                <button class="btn btn-ghost btn-sm" id="dbw-open-page" title="Открыть полноразмерную страницу БД">↗ В страницу</button>
            </div>
            <div id="dbw-mode" class="dbw-mode"></div>
        </div>`;
    },

    _bindCommon() {
        const root = document.getElementById('widget-db');
        if (!root) return;
        root.querySelectorAll('.dbw-tab').forEach((b) =>
            b.addEventListener('click', () => {
                this._mode = b.dataset.mode;
                try { localStorage.setItem(this._MODE_KEY, this._mode); } catch {}
                this._renderMode();
            }),
        );
        document.getElementById('dbw-open-page').addEventListener('click', () => {
            if (this._table) {
                try { localStorage.setItem(this._LAST_TABLE_KEY, this._table); } catch {}
            }
            app.navigate('db');
        });
    },

    _renderMode() {
        const wrap = document.getElementById('dbw-mode');
        if (!wrap) return;
        // Подсветить активную вкладку
        document.querySelectorAll('.dbw-tab').forEach((b) =>
            b.classList.toggle('active', b.dataset.mode === this._mode),
        );
        if (this._mode === 'sql') {
            this._renderSqlMode(wrap);
        } else {
            this._renderBrowseMode(wrap);
        }
    },

    // ── BROWSE ───────────────────────────────────────────────────

    _renderBrowseMode(wrap) {
        wrap.innerHTML = `
        <div class="dbw-browse">
            <div class="dbw-sidebar">
                <div class="dbw-side-head">
                    <input id="dbw-search" type="search" placeholder="Поиск таблицы…" autocomplete="off" />
                    <button id="dbw-reload" title="Обновить список таблиц">↻</button>
                </div>
                <div id="dbw-table-list" class="dbw-table-list"></div>
            </div>
            <div class="dbw-main">
                <div class="dbw-toolbar">
                    <span id="dbw-cur-table" class="dbw-cur-table">← выбери таблицу</span>
                    <span style="flex:1"></span>
                    <button class="btn btn-ghost btn-sm" id="dbw-prev" disabled title="Назад">◀</button>
                    <span id="dbw-page-info" class="dbw-page-info"></span>
                    <button class="btn btn-ghost btn-sm" id="dbw-next" disabled title="Вперёд">▶</button>
                    <button class="btn btn-ghost btn-sm" id="dbw-refresh" title="Обновить данные">↻</button>
                </div>
                <div id="dbw-result" class="dbw-result"></div>
                <div id="dbw-status" class="dbw-status"></div>
            </div>
        </div>`;

        const $ = (id) => document.getElementById(id);
        $('dbw-search').addEventListener('input', (e) => {
            this._tableSearch = (e.target.value || '').toLowerCase().trim();
            this._renderTableList();
        });
        $('dbw-reload').addEventListener('click', () => this._loadTables());
        $('dbw-refresh').addEventListener('click', () => this._browse());
        $('dbw-prev').addEventListener('click', () => {
            this._offset = Math.max(0, this._offset - this._limit);
            this._browse();
        });
        $('dbw-next').addEventListener('click', () => {
            this._offset += this._limit;
            this._browse();
        });

        this._loadTables();
    },

    async _loadTables() {
        const list = document.getElementById('dbw-table-list');
        if (list) list.innerHTML = '<div class="dbw-loading">Загрузка…</div>';
        try {
            const res = await API.get(`/api/db/tables?database=${encodeURIComponent(this._DATABASE)}`);
            this._tables = res.tables || [];
            this._renderTableList();
            try {
                const last = localStorage.getItem(this._LAST_TABLE_KEY);
                if (last && this._tables.includes(last)) {
                    this._selectTable(last);
                }
            } catch {}
        } catch (e) {
            if (list) list.innerHTML = `<div class="dbw-err-block">Не удалось: ${this._esc(e.message)}</div>`;
        }
    },

    _renderTableList() {
        const list = document.getElementById('dbw-table-list');
        if (!list) return;
        const favs = this._loadFavs();
        const filter = this._tableSearch;
        const filterFn = (t) => !filter || t.toLowerCase().includes(filter);
        const favTables = this._tables.filter((t) => favs.includes(t) && filterFn(t));
        const otherTables = this._tables.filter((t) => !favs.includes(t) && filterFn(t));

        const row = (t) => {
            const active = t === this._table ? ' active' : '';
            const fav = favs.includes(t);
            return `
            <div class="dbw-table-item${active}" data-name="${this._esc(t)}">
                <button class="dbw-fav${fav ? ' on' : ''}" data-fav="${this._esc(t)}" title="${fav ? 'Убрать из избранного' : 'В избранное'}">${fav ? '★' : '☆'}</button>
                <span class="dbw-table-name">${this._esc(t)}</span>
            </div>`;
        };

        let html = '';
        if (favTables.length) {
            html += `<div class="dbw-group-title">★ Избранные</div>`;
            html += favTables.map(row).join('');
        }
        if (otherTables.length) {
            if (favTables.length) html += `<div class="dbw-group-title">Все таблицы</div>`;
            html += otherTables.map(row).join('');
        }
        if (!favTables.length && !otherTables.length) {
            html = '<div class="dbw-empty-small">Ничего не найдено</div>';
        }
        list.innerHTML = html;

        list.querySelectorAll('.dbw-table-item').forEach((node) =>
            node.addEventListener('click', (e) => {
                if (e.target.closest('.dbw-fav')) return;
                this._selectTable(node.dataset.name);
            }),
        );
        list.querySelectorAll('.dbw-fav').forEach((btn) =>
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._toggleFav(btn.dataset.fav);
                this._renderTableList();
            }),
        );
    },

    _selectTable(name) {
        this._table = name;
        this._offset = 0;
        try { localStorage.setItem(this._LAST_TABLE_KEY, name); } catch {}
        this._renderTableList();
        this._browse();
    },

    async _browse() {
        if (!this._table) return;
        const resultEl = document.getElementById('dbw-result');
        const statusEl = document.getElementById('dbw-status');
        const curEl = document.getElementById('dbw-cur-table');
        const pageInfo = document.getElementById('dbw-page-info');
        const prev = document.getElementById('dbw-prev');
        const next = document.getElementById('dbw-next');

        if (curEl) curEl.textContent = `${this._DATABASE} › ${this._table}`;
        if (resultEl) resultEl.innerHTML = '<div class="dbw-loading">Загрузка…</div>';
        if (statusEl) { statusEl.textContent = '…'; statusEl.className = 'dbw-status'; }

        const t0 = Date.now();
        try {
            const res = await API.post('/api/db/browse', {
                database: this._DATABASE,
                table: this._table,
                limit: this._limit,
                offset: this._offset,
                order_by: '',
                order_dir: 'ASC',
            });
            const ms = Date.now() - t0;
            this._total = res.total;

            const from = this._offset + 1;
            const to = Math.min(this._offset + this._limit, res.total);
            if (pageInfo) pageInfo.textContent = res.total ? `${from}–${to} из ${res.total}` : '0 строк';
            if (prev) prev.disabled = this._offset === 0;
            if (next) next.disabled = to >= res.total;
            if (resultEl) {
                resultEl.innerHTML = '';
                resultEl.appendChild(this._renderTable(res));
            }
            if (statusEl) {
                statusEl.innerHTML = `<span class="dbw-ok">✓ ${res.rows.length} строк</span> · ${ms} мс`;
                statusEl.className = 'dbw-status ok';
            }
        } catch (e) {
            if (resultEl) resultEl.innerHTML = `<div class="dbw-err-block">${this._esc(e.message)}</div>`;
            if (statusEl) {
                statusEl.innerHTML = `<span class="dbw-err">✗ ${this._esc(e.message)}</span>`;
                statusEl.className = 'dbw-status err';
            }
        }
    },

    // ── SQL ──────────────────────────────────────────────────────

    _renderSqlMode(wrap) {
        let lastSql = '';
        try { lastSql = localStorage.getItem(this._LAST_SQL_KEY) || ''; } catch {}

        wrap.innerHTML = `
        <div class="dbw-sql-mode">
            <div class="dbw-toolbar dbw-toolbar-sql">
                <button class="btn btn-primary btn-sm" id="dbw-run" title="Выполнить (Ctrl+Enter)">▶ Выполнить</button>
                <button class="btn btn-ghost btn-sm" id="dbw-hist" title="История">🕐</button>
                <button class="btn btn-ghost btn-sm" id="dbw-clear-sql" title="Очистить">✕</button>
                <span style="flex:1"></span>
                <span id="dbw-sql-hint" class="dbw-page-info">Ctrl+Enter — запустить</span>
            </div>
            <textarea id="dbw-sql" class="dbw-sql"
                placeholder="SELECT * FROM accounts WHERE id = 1305630 LIMIT 10"
                spellcheck="false">${this._esc(lastSql)}</textarea>
            <div id="dbw-result" class="dbw-result"></div>
            <div id="dbw-status" class="dbw-status"></div>
        </div>`;

        const $ = (id) => document.getElementById(id);
        $('dbw-run').addEventListener('click', () => this._runSql());
        $('dbw-clear-sql').addEventListener('click', () => {
            $('dbw-sql').value = '';
            $('dbw-status').textContent = '';
            $('dbw-result').innerHTML = '';
            try { localStorage.removeItem(this._LAST_SQL_KEY); } catch {}
        });
        $('dbw-hist').addEventListener('click', (e) => this._showHistory(e.currentTarget));

        const ta = $('dbw-sql');
        ta.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                this._runSql();
            }
        });
        ta.addEventListener('input', () => {
            try { localStorage.setItem(this._LAST_SQL_KEY, ta.value); } catch {}
        });
    },

    async _runSql() {
        const ta = document.getElementById('dbw-sql');
        const status = document.getElementById('dbw-status');
        const resultEl = document.getElementById('dbw-result');
        if (!ta || !status || !resultEl) return;

        const sql = (ta.value || '').trim();
        if (!sql) {
            status.textContent = 'Введите запрос';
            status.className = 'dbw-status err';
            return;
        }
        status.textContent = 'Выполнение…';
        status.className = 'dbw-status';
        resultEl.innerHTML = '<div class="dbw-loading">…</div>';

        const t0 = Date.now();
        try {
            const res = await API.post('/api/db/query', { sql, database: this._DATABASE });
            const ms = Date.now() - t0;
            this._pushHist(sql);
            this._lastResult = res;
            if (res.kind === 'select') {
                status.innerHTML = `<span class="dbw-ok">✓ ${res.rows.length} строк</span> · ${ms} мс`;
                status.className = 'dbw-status ok';
                resultEl.innerHTML = '';
                resultEl.appendChild(this._renderTable(res));
            } else {
                status.innerHTML = `<span class="dbw-ok">✓ изменено: ${res.affected ?? 0}</span> · ${ms} мс`;
                status.className = 'dbw-status ok';
                resultEl.innerHTML = '';
            }
        } catch (e) {
            resultEl.innerHTML = `<div class="dbw-err-block">${this._esc(e.message)}</div>`;
            status.innerHTML = `<span class="dbw-err">✗ ${this._esc(e.message)}</span>`;
            status.className = 'dbw-status err';
        }
    },

    _showHistory(anchor) {
        const existing = document.getElementById('dbw-hist-pop');
        if (existing) { existing.remove(); return; }

        let hist = [];
        try { hist = JSON.parse(localStorage.getItem(this._HIST_KEY) || '[]'); } catch {}
        if (!hist.length) { app.toast('История пуста', 'info'); return; }

        const pop = document.createElement('div');
        pop.id = 'dbw-hist-pop';
        pop.className = 'dbw-hist-pop';
        pop.innerHTML = hist.map((sql, i) => `
            <div class="dbw-hist-item" data-i="${i}">
                <pre>${this._esc(sql)}</pre>
            </div>
        `).join('');
        const rect = anchor.getBoundingClientRect();
        pop.style.left = `${rect.left}px`;
        pop.style.top  = `${rect.bottom + 4}px`;
        document.body.appendChild(pop);

        pop.querySelectorAll('.dbw-hist-item').forEach((it) =>
            it.addEventListener('click', () => {
                const i = parseInt(it.dataset.i, 10);
                const sql = hist[i];
                const ta = document.getElementById('dbw-sql');
                if (ta) {
                    ta.value = sql;
                    try { localStorage.setItem(this._LAST_SQL_KEY, sql); } catch {}
                    ta.focus();
                }
                pop.remove();
            }),
        );
        const closer = (e) => {
            if (!pop.contains(e.target) && e.target !== anchor) {
                pop.remove();
                document.removeEventListener('mousedown', closer);
            }
        };
        setTimeout(() => document.addEventListener('mousedown', closer), 0);
    },

    _pushHist(sql) {
        let hist = [];
        try { hist = JSON.parse(localStorage.getItem(this._HIST_KEY) || '[]'); } catch {}
        hist = hist.filter((s) => s !== sql);
        hist.unshift(sql);
        if (hist.length > this._HIST_MAX) hist = hist.slice(0, this._HIST_MAX);
        try { localStorage.setItem(this._HIST_KEY, JSON.stringify(hist)); } catch {}
    },

    // ── общая отрисовка таблицы ─────────────────────────────────

    _renderTable(res) {
        const wrap = document.createElement('div');
        wrap.className = 'dbw-table-wrap';
        if (!res.rows || !res.rows.length) {
            wrap.innerHTML = '<div class="dbw-empty">Пустой результат</div>';
            return wrap;
        }
        const head = res.columns.map((c) => `<th>${this._esc(c)}</th>`).join('');
        const body = res.rows.map((row) => {
            const tds = row.map((v) => {
                const s = v == null ? '<span class="dbw-null">NULL</span>' : this._esc(String(v));
                return `<td title="${v == null ? 'NULL' : this._esc(String(v))}">${s}</td>`;
            }).join('');
            return `<tr>${tds}</tr>`;
        }).join('');
        wrap.innerHTML = `<table class="dbw-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
        return wrap;
    },

    // ── избранное (шарится с DbPage) ────────────────────────────
    _loadFavs() {
        try { return JSON.parse(localStorage.getItem(this._FAV_KEY) || '[]'); } catch { return []; }
    },
    _toggleFav(t) {
        let favs = this._loadFavs();
        favs = favs.includes(t) ? favs.filter((x) => x !== t) : [...favs, t];
        try { localStorage.setItem(this._FAV_KEY, JSON.stringify(favs)); } catch {}
    },

    _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    },
};

window.DbWidget = DbWidget;
