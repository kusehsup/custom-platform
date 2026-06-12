// ── DB Browse: compact widget ────────────────────────────────────────
//
// Лёгкий виджет «БД под рукой» — быстро посмотреть строки конкретной
// таблицы из любой страницы. Слева — список таблиц (с поиском и
// избранным, шарится с DbPage), справа — превью данных с пагинацией.
//
// Для сложной работы (Monaco SQL, редактирование ячеек, структура)
// есть кнопка «↗ В страницу».

const DbWidget = {
    _DATABASE: 'crmp_cloud',
    _FAV_KEY: 'db_fav_tables',
    _LAST_TABLE_KEY: 'db_widget_last_table',

    _tables: [],
    _table: '',
    _offset: 0,
    _limit: 50,
    _total: 0,
    _tableSearch: '',

    toggle() {
        const existing = document.getElementById('widget-db');
        if (existing) { Widgets.toggle('widget-db'); return; }

        Widgets.create({
            id: 'widget-db',
            title: '🗄 БД',
            width: 720,
            height: 460,
            defaultPos: { right: 24, bottom: 80 },
            content: this._template(),
        });

        this._bind();
        this._loadTables();
    },

    _template() {
        return `
        <div class="dbw">
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
                    <button class="btn btn-ghost btn-sm" id="dbw-open-page" title="Открыть в полной странице БД">↗</button>
                </div>
                <div id="dbw-result" class="dbw-result"></div>
                <div id="dbw-status" class="dbw-status"></div>
            </div>
        </div>`;
    },

    _bind() {
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
        $('dbw-open-page').addEventListener('click', () => {
            if (this._table) {
                // db.js читает это поле как-то? Нет — но сам факт перехода
                // покажет полное представление; пользователь повторно
                // кликнет таблицу в боковой панели.
                try { localStorage.setItem(this._LAST_TABLE_KEY, this._table); } catch {}
            }
            app.navigate('db');
        });
    },

    async _loadTables() {
        const list = document.getElementById('dbw-table-list');
        if (list) list.innerHTML = '<div class="dbw-loading">Загрузка…</div>';
        try {
            const res = await API.get(`/api/db/tables?database=${encodeURIComponent(this._DATABASE)}`);
            this._tables = res.tables || [];
            this._renderTableList();
            // Восстановим последнюю таблицу, если есть
            try {
                const last = localStorage.getItem(this._LAST_TABLE_KEY);
                if (last && this._tables.includes(last)) {
                    this._selectTable(last);
                }
            } catch {}
        } catch (e) {
            if (list) list.innerHTML = `<div class="dbw-err">Не удалось: ${this._esc(e.message)}</div>`;
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
            if (resultEl) resultEl.appendChild ? (resultEl.innerHTML = '', resultEl.appendChild(this._renderTable(res))) : null;
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

    _renderTable(res) {
        const wrap = document.createElement('div');
        wrap.className = 'dbw-table-wrap';
        if (!res.rows || !res.rows.length) {
            wrap.innerHTML = '<div class="dbw-empty">Пустая таблица</div>';
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

    // ── избранные таблицы (шарятся с DbPage) ────────────────────
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
