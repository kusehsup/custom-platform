// ── Database Interface ────────────────────────────────────────────

const DbPage = {
    _db: '',
    _table: '',
    _tables: [],
    _cols: [],
    _total: 0,
    _offset: 0,
    _limit: 100,
    _orderBy: '',
    _orderDir: 'ASC',
    _pkCol: '',
    _view: 'query',
    _tableSearch: '',
    _queryResult: null,  // последний результат SELECT для редактирования

    _FAV_KEY:  'db_fav_tables',
    _HIST_KEY: 'db_query_hist',
    _LOG_KEY:  'db_query_log',
    _HIST_MAX: 10,
    _LOG_MAX:  200,

    // ── Избранные таблицы ─────────────────────────────────────────
    _loadFavs()   { try { return JSON.parse(localStorage.getItem(this._FAV_KEY) || '[]'); } catch { return []; } },
    _saveFavs(f)  { try { localStorage.setItem(this._FAV_KEY, JSON.stringify(f)); } catch {} },
    _isFav(t)     { return this._loadFavs().includes(t); },
    _toggleFav(t) {
        let favs = this._loadFavs();
        favs = favs.includes(t) ? favs.filter(f => f !== t) : [...favs, t];
        this._saveFavs(favs);
    },

    // ── История запросов ──────────────────────────────────────────
    _loadHist()  { try { return JSON.parse(localStorage.getItem(this._HIST_KEY) || '[]'); } catch { return []; } },
    _pushHist(sql) {
        let h = this._loadHist().filter(s => s !== sql);
        h.unshift(sql);
        if (h.length > this._HIST_MAX) h = h.slice(0, this._HIST_MAX);
        try { localStorage.setItem(this._HIST_KEY, JSON.stringify(h)); } catch {}
    },

    // ── Лог запросов ─────────────────────────────────────────────
    _loadLog()  { try { return JSON.parse(localStorage.getItem(this._LOG_KEY) || '[]'); } catch { return []; } },
    _pushLog(entry) {
        let log = this._loadLog();
        log.unshift(entry);
        if (log.length > this._LOG_MAX) log = log.slice(0, this._LOG_MAX);
        try { localStorage.setItem(this._LOG_KEY, JSON.stringify(log)); } catch {}
        this._renderLogWidget();
    },
    _renderLogWidget() {
        const el = document.getElementById('db-log-body');
        if (!el) return;
        const log = this._loadLog();
        el.innerHTML = log.map(e => {
            const color = e.ok ? 'var(--green)' : 'var(--red)';
            const ts = new Date(e.ts).toLocaleTimeString('ru-RU');
            return `<div style="padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04)">
                <div style="display:flex;gap:6px;align-items:center">
                    <span style="color:var(--text-3);font-size:10px;flex-shrink:0">${ts}</span>
                    <span style="color:${color};font-size:10px;flex-shrink:0">${e.ok ? '✓' : '✗'}</span>
                    <span style="color:var(--text-3);font-size:10px;flex-shrink:0">${e.ms}мс</span>
                    ${e.rows != null ? `<span style="color:var(--text-3);font-size:10px">${e.rows} стр.</span>` : ''}
                </div>
                <div style="color:var(--text-2);font-size:11px;font-family:var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px" title="${this._esc(e.sql)}">${this._esc(e.sql)}</div>
                ${e.err ? `<div style="color:var(--red);font-size:10px;margin-top:2px">${this._esc(e.err)}</div>` : ''}
            </div>`;
        }).join('') || '<div style="color:var(--text-3);font-size:12px;padding:8px 0">Нет запросов</div>';
    },

    toggleLog() {
        if (!document.getElementById('widget-dblog')) {
            Widgets.create({
                id: 'widget-dblog',
                title: '🗄 DB Log',
                content: '<div id="db-log-body" style="overflow-y:auto;flex:1;padding:6px 10px;font-family:var(--mono)"></div>',
                width: 420, height: 340,
                defaultPos: { right: 24, bottom: 80 },
            });
            this._renderLogWidget();
        } else {
            Widgets.toggle('widget-dblog');
        }
    },

    // ── Render ────────────────────────────────────────────────────
    render(el) {
        el.innerHTML = `
        <div class="db-layout">
            <div class="db-sidebar">
                <div class="db-sidebar-header">
                    <span>🗄</span>
                    <span style="flex:1;font-size:12px;color:var(--text-2);font-family:var(--mono)">crmp_cloud</span>
                    <button id="db-log-btn" title="Лог запросов" style="background:none;border:none;color:var(--text-3);cursor:pointer;font-size:12px;padding:2px 5px">📋</button>
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
                        <div id="db-sql-editor" style="height:120px;border:1px solid var(--border);border-radius:var(--radius-sm);overflow:hidden"></div>
                        <div style="display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap">
                            <button class="btn btn-primary btn-sm" id="db-run">▶ Выполнить</button>
                            <button class="btn btn-ghost btn-sm" id="db-clear-sql">Очистить</button>
                            <button class="btn btn-ghost btn-sm" id="db-hist-btn" title="История запросов">🕐 История</button>
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
        this._el = el;
        this._loadTables(el);

        // Monaco SQL редактор — грузим лениво если ещё не загружен
        this._sqlEditor = null;
        this._initSqlEditor(el);

        el.querySelector('#db-reload').addEventListener('click', () => this._loadTables(el));
        el.querySelector('#db-log-btn').addEventListener('click', () => this.toggleLog());
        el.querySelector('#db-table-search').addEventListener('input', e => {
            this._tableSearch = e.target.value.toLowerCase();
            this._renderTableList(el);
        });
        el.querySelector('#db-run').addEventListener('click', () => this._runQuery(el));
        el.querySelector('#db-clear-sql').addEventListener('click', () => {
            this._sqlEditor.setValue('');
        });
        el.querySelector('#db-hist-btn').addEventListener('click', () => this._showHistModal(el));
        el.querySelector('#db-prev').addEventListener('click', () => {
            if (this._offset >= this._limit) { this._offset -= this._limit; this._browse(el); }
        });
        el.querySelector('#db-next').addEventListener('click', () => {
            if (this._offset + this._limit < this._total) { this._offset += this._limit; this._browse(el); }
        });

        ['query', 'browse', 'structure'].forEach(view => {
            el.querySelector(`#dbt-${view}`).addEventListener('click', () => this._switchView(el, view));
        });

        this._switchView(el, 'query');
    },

    // ── Monaco SQL редактор ───────────────────────────────────────
    _initSqlEditor(el) {
        const container = el.querySelector('#db-sql-editor');
        if (!container) return;
        const create = () => {
            if (this._sqlEditor) return;
            // Регистрируем тему если ещё не определена (files.js мог не загружаться)
            if (!window._monacoThemeDefined) {
                monaco.editor.defineTheme('custom-dark', {
                    base: 'vs-dark', inherit: true, rules: [],
                    colors: {
                        'editor.background': '#141416',
                        'editor.lineHighlightBackground': '#1C1C1F',
                        'editorLineNumber.foreground': '#48484A',
                        'editorGutter.background': '#141416',
                    },
                });
                window._monacoThemeDefined = true;
            }
            const theme = localStorage.getItem('theme') === 'light' ? 'vs' : 'custom-dark';
            this._sqlEditor = monaco.editor.create(container, {
                value: '',
                language: 'sql',
                theme,
                minimap: { enabled: false },
                lineNumbers: 'off',
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                fontSize: 13,
                padding: { top: 8, bottom: 8 },
                suggestOnTriggerCharacters: true,
                quickSuggestions: true,
                scrollbar: { vertical: 'hidden', horizontal: 'hidden' },
                overviewRulerLanes: 0,
                renderLineHighlight: 'none',
                contextmenu: false,
            });
            this._sqlEditor.addCommand(
                monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
                () => this._runQuery(el)
            );
        };

        if (window.monaco) {
            create();
        } else {
            // Грузим Monaco через тот же loader что и files.js
            if (!document.querySelector('script[src*="monaco-editor"]')) {
                const s = document.createElement('script');
                s.src = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs/loader.js';
                s.onload = () => {
                    require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' } });
                    require(['vs/editor/editor.main'], () => create());
                };
                document.head.appendChild(s);
            } else {
                // Loader уже грузится — ждём
                const wait = setInterval(() => {
                    if (window.monaco) { clearInterval(wait); create(); }
                }, 100);
            }
        }
    },

    // ── История запросов — модал ──────────────────────────────────
    _showHistModal(el) {
        const hist = this._loadHist();
        const modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;inset:0;z-index:50000;display:flex;align-items:flex-start;justify-content:center;padding-top:80px;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px)';
        modal.innerHTML = `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);width:100%;max-width:640px;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,0.6)">
            <div style="display:flex;align-items:center;gap:10px;padding:13px 18px;border-bottom:1px solid var(--border)">
                <span style="font-size:13px;font-weight:600;color:var(--text)">🕐 История запросов</span>
                <span style="flex:1"></span>
                <button id="dbh-clear" class="btn btn-ghost btn-sm" style="color:var(--red)">Очистить</button>
                <button id="dbh-close" style="background:none;border:none;color:var(--text-2);cursor:pointer;font-size:18px;padding:2px 6px">✕</button>
            </div>
            <div style="max-height:480px;overflow-y:auto">
                ${hist.length === 0
                    ? '<div style="padding:20px;color:var(--text-3);font-size:13px;text-align:center">История пуста</div>'
                    : hist.map((sql, i) => `
                    <div class="dbh-item" data-idx="${i}" style="display:flex;align-items:flex-start;gap:10px;padding:10px 18px;border-bottom:1px solid var(--border);cursor:pointer;transition:background .08s">
                        <div style="flex:1;font-family:var(--mono);font-size:12px;color:var(--text-2);white-space:pre-wrap;word-break:break-all">${this._esc(sql)}</div>
                        <button class="btn btn-ghost btn-sm dbh-use" data-idx="${i}" style="flex-shrink:0;font-size:11px">Вставить</button>
                    </div>`).join('')
                }
            </div>
        </div>`;
        document.body.appendChild(modal);

        modal.querySelector('#dbh-close').addEventListener('click', () => modal.remove());
        modal.querySelector('#dbh-clear')?.addEventListener('click', () => {
            try { localStorage.removeItem(this._HIST_KEY); } catch {}
            modal.remove();
        });
        modal.querySelectorAll('.dbh-use').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const sql = hist[parseInt(btn.dataset.idx)];
                this._sqlEditor?.setValue(sql);
                modal.remove();
            });
        });
        modal.querySelectorAll('.dbh-item').forEach(item => {
            item.addEventListener('click', e => {
                if (e.target.classList.contains('dbh-use')) return;
                const sql = hist[parseInt(item.dataset.idx)];
                this._sqlEditor?.setValue(sql);
                modal.remove();
            });
            item.addEventListener('mouseenter', () => item.style.background = 'rgba(255,255,255,0.03)');
            item.addEventListener('mouseleave', () => item.style.background = '');
        });
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    },

    _switchView(el, view) {
        this._view = view;
        ['query', 'browse', 'structure'].forEach(v => {
            const btn   = el.querySelector(`#dbt-${v}`);
            const panel = el.querySelector(`#db-${v}-panel`);
            if (btn) btn.classList.toggle('active', v === view);
            if (panel) {
                if (v === view) {
                    // Все панели — flex-колонки: только так вложенная область
                    // результата получает ограниченную высоту и скроллится
                    // (при display:block высокая таблица растягивала панель).
                    panel.style.display = 'flex';
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

    async _loadTables(el) {
        const list = el.querySelector('#db-table-list');
        list.innerHTML = '<div style="padding:12px 14px;color:var(--text-3);font-size:12px">Загрузка...</div>';
        try {
            const res = await API.get(`/api/db/tables?database=${encodeURIComponent(this._db)}`);
            this._tables = res.tables;
            this._renderTableList(el);
            this._setStatus(`${res.tables.length} таблиц`, 'ok');
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
            <span class="db-fav-btn" data-table="${this._esc(t)}" title="Избранное"
                style="opacity:${favs.includes(t)?'1':'0'};color:var(--yellow);font-size:12px;flex-shrink:0;cursor:pointer;padding:0 2px">★</span>
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
        const sql = (this._sqlEditor?.getValue() ?? '').trim();
        if (!sql) return;
        const result = el.querySelector('#db-query-result');
        result.innerHTML = '<div style="padding:20px;color:var(--text-2);font-size:13px;text-align:center">Выполнение...</div>';
        const btn = el.querySelector('#db-run');
        btn.disabled = true;
        const t0 = Date.now();
        try {
            const res = await API.post('/api/db/query', { sql, database: this._db });
            const ms = Date.now() - t0;
            this._pushHist(sql);

            // Бэкенд возвращает массив результатов (по одному на инструкцию).
            // Поддерживаем и старый формат на всякий случай.
            const results = res.results
                ? res.results
                : [{ columns: res.columns, rows: res.rows, affected: res.affected, kind: res.kind, statement: sql }];

            const selectCount = results.filter(r => r.kind === 'select').length;
            const multi = results.length > 1;

            // Заголовок-сводка по всему пакету
            const dmlAffected = results
                .filter(r => r.kind !== 'select')
                .reduce((a, r) => a + (r.affected || 0), 0);
            const summaryParts = [];
            if (selectCount) summaryParts.push(`${selectCount} результат${selectCount > 1 ? 'а' : ''}`);
            if (results.some(r => r.kind !== 'select')) summaryParts.push(`затронуто ${dmlAffected} строк`);
            summaryParts.push(`${ms}мс`);

            const blocksHtml = results.map((r, i) => this._renderResultBlock(r, i, multi)).join('');

            result.innerHTML = `
                <div style="display:flex;gap:6px;padding:6px 8px;border-bottom:1px solid var(--border);flex-shrink:0;align-items:center">
                    <span style="font-size:12px;color:var(--text-3);flex:1">${summaryParts.join(' · ')}</span>
                </div>
                <div class="db-result-inner db-multi-results">${blocksHtml}</div>`;

            // Экспорт + грид-улучшения по каждому SELECT-результату
            results.forEach((r, i) => {
                if (r.kind !== 'select') return;
                result.querySelector(`#db-export-csv-${i}`)?.addEventListener('click', () =>
                    this._exportCSV(r.columns, r.rows));
                result.querySelector(`#db-export-sql-${i}`)?.addEventListener('click', () =>
                    this._exportSQL(r.columns, r.rows, r.statement || sql));
                const body = result.querySelector(`.db-result-block[data-idx="${i}"] .db-result-block-body`);
                this._enhanceTable(body, r.columns, r.rows);
            });

            // Редактирование ячеек доступно только когда ровно один SELECT
            // (иначе неоднозначно, к какой таблице относится строка).
            if (selectCount === 1 && !multi) {
                const only = results[0];
                this._queryResult = { columns: only.columns, rows: only.rows, sql: only.statement || sql };
                const inner = result.querySelector('.db-result-block[data-idx="0"]');
                if (inner) this._bindCellEditQuery(inner, el, only.columns, only.rows);
            } else {
                this._queryResult = null;
            }

            const totalRows = results.reduce((a, r) => a + (r.rows ? r.rows.length : 0), 0);
            this._setStatus(`${summaryParts.join(' · ')}`, 'ok');
            this._pushLog({ ts: Date.now(), sql, ok: true, ms, rows: selectCount ? totalRows : null });
            if (selectCount === 0 && this._view === 'browse' && this._table) this._browse(el);
        } catch (e) {
            result.innerHTML = `<div style="padding:20px;color:var(--red);font-size:13px;font-family:var(--mono);white-space:pre-wrap">${this._esc(e.message)}</div>`;
            this._setStatus('Ошибка запроса', 'err');
            this._pushLog({ ts: Date.now(), sql, ok: false, ms: Date.now() - t0, err: e.message });
        } finally {
            btn.disabled = false;
        }
    },

    // Рендер одного результата (SELECT → таблица, DML → строка статуса).
    // При нескольких результатах каждая таблица скроллится независимо.
    _renderResultBlock(r, idx, multi) {
        const label = multi ? `#${idx + 1} · ` : '';
        if (r.kind === 'select') {
            const trunc = r.truncated
                ? `<span style="color:var(--yellow);font-size:11px">показаны первые ${r.rows.length}</span>`
                : '';
            const stmt = multi && r.statement
                ? `<span style="color:var(--text-3);font-size:11px;font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:340px" title="${this._esc(r.statement)}">${this._esc(r.statement)}</span>`
                : '';
            return `
            <div class="db-result-block" data-idx="${idx}">
                <div class="db-result-block-head">
                    <span style="font-size:11px;color:var(--text-2);font-weight:600">${label}${r.rows.length} строк</span>
                    ${trunc}
                    ${stmt}
                    <span style="flex:1"></span>
                    <button class="btn btn-ghost btn-sm" id="db-export-csv-${idx}" style="font-size:11px">↓ CSV</button>
                    <button class="btn btn-ghost btn-sm" id="db-export-sql-${idx}" style="font-size:11px">↓ SQL</button>
                </div>
                <div class="db-result-block-body">${this._renderTable(r.columns, r.rows, true, null)}</div>
            </div>`;
        }
        return `
        <div class="db-result-block" data-idx="${idx}">
            <div class="db-result-block-head">
                <span style="color:var(--green);font-size:12px">${label}OK · затронуто ${r.affected} строк</span>
                ${multi && r.statement ? `<span style="color:var(--text-3);font-size:11px;font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:340px" title="${this._esc(r.statement)}">${this._esc(r.statement)}</span>` : ''}
            </div>
        </div>`;
    },

    _exportCSV(columns, rows) {
        const escape = v => {
            const s = v === null || v === undefined ? '' : String(v);
            return s.includes(',') || s.includes('"') || s.includes('\n')
                ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const lines = [columns.map(escape).join(',')];
        for (const row of rows) {
            const vals = Array.isArray(row) ? row : Object.values(row);
            lines.push(vals.map(escape).join(','));
        }
        this._download('export.csv', lines.join('\r\n'), 'text/csv;charset=utf-8;');
    },

    _exportSQL(columns, rows, querySql) {
        const tableMatch = querySql.match(/\bFROM\s+`?(\w+)`?/i);
        const table = tableMatch?.[1] || 'export';
        const lines = rows.map(row => {
            const vals = (Array.isArray(row) ? row : Object.values(row))
                .map(v => v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
            return `INSERT INTO \`${table}\` (\`${columns.join('`, `')}\`) VALUES (${vals.join(', ')});`;
        });
        this._download(`${table}.sql`, lines.join('\n'), 'text/plain;charset=utf-8;');
    },

    _download(filename, content, mime) {
        const blob = new Blob([content], { type: mime });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    },

    async _browse(el) {
        if (!this._db || !this._table) return;
        const result = el.querySelector('#db-browse-result');
        result.innerHTML = '<div style="padding:20px;color:var(--text-2);font-size:13px;text-align:center">Загрузка...</div>';
        const t0 = Date.now();
        try {
            const res = await API.post('/api/db/browse', {
                database: this._db, table: this._table,
                limit: this._limit, offset: this._offset,
                order_by: this._orderBy, order_dir: this._orderDir,
            });
            const ms = Date.now() - t0;
            this._total = res.total;
            this._cols  = res.columns;
            this._pkCol = res.columns[0] || '';
            const from  = this._offset + 1;
            const to    = Math.min(this._offset + this._limit, res.total);
            el.querySelector('#db-page-info').textContent = `${from}–${to} из ${res.total}`;
            el.querySelector('#db-browse-info').textContent = `${this._db} › ${this._table}`;
            el.querySelector('#db-prev').disabled = this._offset === 0;
            el.querySelector('#db-next').disabled = to >= res.total;
            result.innerHTML = this._renderTable(res.columns, res.rows, true, this._orderBy);
            this._setStatus(`${res.total} строк · ${ms}мс`, 'ok');
            this._enhanceTable(result, res.columns, res.rows);
            this._bindCellEdit(result, el);
            this._bindSortHeaders(result, el);
            const sql = `SELECT * FROM \`${this._table}\` LIMIT ${this._limit} OFFSET ${this._offset}`;
            this._pushLog({ ts: Date.now(), sql, ok: true, ms, rows: res.rows.length });
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
            const res = await API.post('/api/db/structure', { database: this._db, table: this._table });
            result.innerHTML = `
            <div style="padding:12px 16px;font-size:12px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Столбцы</div>
            ${this._renderTable(res.columns_headers, res.columns)}
            <div style="padding:12px 16px;font-size:12px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-top:8px;border-top:1px solid var(--border)">Индексы</div>
            ${this._renderTable(res.indexes_headers, res.indexes)}`;
            const tbls = result.querySelectorAll('table.db-table-result');
            if (tbls[0]) this._enhanceTable(tbls[0], res.columns_headers, res.columns);
            if (tbls[1]) this._enhanceTable(tbls[1], res.indexes_headers, res.indexes);
            this._setStatus(`Структура ${this._table}`, 'ok');
        } catch (e) {
            result.innerHTML = `<div style="padding:20px;color:var(--red);font-size:13px">${this._esc(e.message)}</div>`;
        }
    },

    _renderTable(columns, rows, editable = false, orderBy = null) {
        if (!columns.length) return '<div style="padding:20px;color:var(--text-3);font-size:13px;text-align:center">Нет данных</div>';
        const headerHtml = columns.map(c => {
            const arrow = editable && orderBy != null && c === orderBy
                ? (this._orderDir === 'ASC' ? ' ↑' : ' ↓') : '';
            return `<th ${editable ? `data-col="${this._esc(c)}" style="cursor:pointer;user-select:none"` : ''} title="${this._esc(String(c))}"><span class="db-th-label">${this._esc(String(c))}${arrow}</span><span class="db-col-resizer"></span></th>`;
        }).join('');
        const bodyHtml = rows.map((row, ri) => {
            const cells = (Array.isArray(row) ? row : Object.values(row)).map((val, ci) => {
                const isNull = val === null || val === undefined;
                const isNum  = !isNull && typeof val === 'number';
                const display = isNull ? 'NULL' : String(val);
                const cls = isNull ? 'db-null' : isNum ? 'db-num' : 'db-str';
                // title = полное значение → видно обрезанный контент при наведении
                const attrs = editable
                    ? `data-ri="${ri}" data-ci="${ci}" data-col="${this._esc(columns[ci])}" data-orig="${this._esc(display)}" class="${cls}" style="cursor:pointer" title="${this._esc(display)}"`
                    : `class="${cls}" title="${this._esc(display)}"`;
                return `<td ${attrs}>${this._esc(display)}</td>`;
            }).join('');
            return `<tr><td class="db-gut" data-row-idx="${ri}" title="Открыть строку">${ri + 1}</td>${cells}</tr>`;
        }).join('');
        return `<table class="db-table-result"><thead><tr><th class="db-gut"></th>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`;
    },

    // Пост-обработка таблицы: ресайз колонок + карточный просмотр строки.
    // scope — контейнер или сама <table> (для видов с несколькими таблицами).
    _enhanceTable(scope, columns, rows) {
        if (!scope) return;
        const table = scope.matches && scope.matches('table.db-table-result')
            ? scope : scope.querySelector('table.db-table-result');
        if (!table) return;

        // Карточный просмотр строки по клику на номер (удобно для «широких» таблиц)
        table.querySelectorAll('td.db-gut[data-row-idx]').forEach(td => {
            td.addEventListener('click', () => {
                const idx = parseInt(td.dataset.rowIdx, 10);
                this._openRowCard(columns, rows[idx]);
            });
        });

        // Замораживаем текущие (авто) ширины и переключаемся на table-layout:
        // fixed. Иначе браузер игнорирует заданную ширину колонки и ресайз не
        // работает. Внешний вид сохраняется (ширины = как были в auto).
        try {
            const ths = [...table.querySelectorAll('thead th')];
            let total = 0;
            const widths = ths.map(th => {
                const w = th.classList.contains('db-gut') ? 40 : Math.min(Math.max(th.offsetWidth, 48), 340);
                total += w;
                return w;
            });
            table.style.tableLayout = 'fixed';
            table.style.width = total + 'px';
            ths.forEach((th, i) => {
                th.style.width = widths[i] + 'px';
                th.style.minWidth = widths[i] + 'px';
                th.style.maxWidth = widths[i] + 'px';
            });
        } catch {}

        this._bindColResize(table);
    },

    _bindColResize(table) {
        table.querySelectorAll('th .db-col-resizer').forEach(handle => {
            handle.addEventListener('mousedown', e => {
                e.preventDefault();
                e.stopPropagation();
                const th = handle.closest('th');
                const startX = e.clientX;
                const startW = th.offsetWidth;
                const startTableW = table.offsetWidth;
                const onMove = ev => {
                    const w = Math.max(44, startW + (ev.clientX - startX));
                    th.style.width = w + 'px';
                    th.style.minWidth = w + 'px';
                    th.style.maxWidth = w + 'px';
                    // Растягиваем таблицу на ту же дельту → колонка реально
                    // расширяется, остальные сохраняют ширину (появляется скролл).
                    table.style.width = (startTableW + (w - startW)) + 'px';
                };
                const onUp = () => {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    document.body.style.cursor = '';
                    document.body.style.userSelect = '';
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
            });
        });
    },

    // Карточка строки: все столбцы столбиком, полные значения, копирование.
    _openRowCard(columns, row) {
        if (row == null) return;
        const vals = Array.isArray(row) ? row : columns.map(c => row[c]);
        const rowsHtml = columns.map((c, i) => {
            const v = vals[i];
            const isNull = v === null || v === undefined;
            const display = isNull ? 'NULL' : String(v);
            return `<div class="db-card-row">
                <div class="db-card-key" title="${this._esc(c)}">${this._esc(c)}</div>
                <div class="db-card-val ${isNull ? 'db-null' : ''}">${this._esc(display)}</div>
                <button class="db-card-copy" data-i="${i}" title="Копировать значение">⧉</button>
            </div>`;
        }).join('');

        const modal = document.createElement('div');
        modal.className = 'db-card-modal';
        modal.style.cssText = 'position:fixed;inset:0;z-index:50000;display:flex;align-items:flex-start;justify-content:center;padding-top:64px;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px)';
        modal.innerHTML = `
        <div class="db-card-box">
            <div class="db-card-head">
                <span style="font-size:13px;font-weight:600;color:var(--text)">Строка · ${columns.length} столбцов</span>
                <span style="flex:1"></span>
                <button id="dbc-copyall" class="btn btn-ghost btn-sm" style="font-size:11px">Копировать всё</button>
                <button id="dbc-close" style="background:none;border:none;color:var(--text-2);cursor:pointer;font-size:18px;padding:2px 6px">✕</button>
            </div>
            <div class="db-card-body">${rowsHtml}</div>
        </div>`;
        document.body.appendChild(modal);

        const close = () => modal.remove();
        modal.querySelector('#dbc-close').addEventListener('click', close);
        modal.addEventListener('click', e => { if (e.target === modal) close(); });
        const onKey = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
        document.addEventListener('keydown', onKey);

        modal.querySelectorAll('.db-card-copy').forEach(btn => {
            btn.addEventListener('click', () => {
                const v = vals[parseInt(btn.dataset.i, 10)];
                navigator.clipboard?.writeText(v == null ? '' : String(v));
                btn.textContent = '✓';
                setTimeout(() => { btn.textContent = '⧉'; }, 900);
            });
        });
        modal.querySelector('#dbc-copyall').addEventListener('click', () => {
            const obj = {};
            columns.forEach((c, i) => { obj[c] = vals[i] === undefined ? null : vals[i]; });
            navigator.clipboard?.writeText(JSON.stringify(obj, null, 2));
            app.toast?.('Строка скопирована как JSON', 'success');
        });
    },

    _bindSortHeaders(result, el) {
        result.querySelectorAll('th[data-col]').forEach(th => {
            th.addEventListener('click', () => {
                const col = th.dataset.col;
                this._orderBy  = this._orderBy === col && this._orderDir === 'ASC' ? col : col;
                this._orderDir = this._orderBy === col && this._orderDir === 'ASC' ? 'DESC' : 'ASC';
                this._orderBy  = col;
                this._offset   = 0;
                this._browse(el);
            });
        });
    },

    // Редактирование ячеек в режиме browse (знаем таблицу + pk)
    _bindCellEdit(result, el) {
        result.querySelectorAll('td[data-col]').forEach(td => {
            td.addEventListener('dblclick', e => {
                e.stopPropagation();
                const pkCell = td.parentElement.querySelector('td[data-col]');
                this._openCellEditor(td, async (newVal) => {
                    await API.post('/api/db/cell', {
                        database: this._db, table: this._table,
                        pk_col: this._pkCol, pk_val: pkCell?.dataset.orig ?? '',
                        col: td.dataset.col,
                        value: newVal === '' ? null : newVal,
                    });
                    this._pushLog({ ts: Date.now(), sql: `UPDATE \`${this._table}\` SET \`${td.dataset.col}\` = '${newVal}'`, ok: true, ms: 0 });
                    this._setStatus(`Обновлено ${td.dataset.col}`, 'ok');
                });
            });
        });
    },

    // Редактирование ячеек в результате произвольного SELECT
    // Пытаемся угадать таблицу из SQL, pk — первый столбец
    _bindCellEditQuery(result, el, columns, rows) {
        const sql = this._queryResult?.sql || '';
        // Извлекаем имя таблицы из FROM
        const tableMatch = sql.match(/\bFROM\s+`?(\w+)`?/i);
        const table = tableMatch?.[1] || '';
        const pkCol = columns[0] || '';

        result.querySelectorAll('td[data-col]').forEach(td => {
            td.addEventListener('dblclick', e => {
                e.stopPropagation();
                if (!table) { app.toast('Таблица не определена из запроса', 'error'); return; }
                const pkCell = td.parentElement.querySelector('td[data-col]');
                this._openCellEditor(td, async (newVal) => {
                    await API.post('/api/db/cell', {
                        database: this._db, table,
                        pk_col: pkCol, pk_val: pkCell?.dataset.orig ?? '',
                        col: td.dataset.col,
                        value: newVal === '' ? null : newVal,
                    });
                    this._pushLog({ ts: Date.now(), sql: `UPDATE \`${table}\` SET \`${td.dataset.col}\` = '${newVal}'`, ok: true, ms: 0 });
                    this._setStatus(`Обновлено ${td.dataset.col}`, 'ok');
                });
            });
        });
    },

    // Общий inline-редактор ячейки
    _openCellEditor(td, onCommit) {
        const orig = td.dataset.orig;
        const rect = td.getBoundingClientRect();
        const input = document.createElement('input');
        input.className = 'db-cell-edit';
        input.value = orig === 'NULL' ? '' : orig;
        input.style.left  = rect.left + 'px';
        input.style.top   = rect.top  + 'px';
        input.style.width = Math.max(rect.width, 160) + 'px';
        document.body.appendChild(input);
        input.focus();
        input.select();

        let committed = false;
        const commit = async () => {
            if (committed) return;
            committed = true;
            input.remove();
            const newVal = input.value;
            if (newVal === orig || (orig === 'NULL' && newVal === '')) return;
            try {
                await onCommit(newVal);
                td.textContent = newVal === '' ? 'NULL' : newVal;
                td.dataset.orig = newVal === '' ? 'NULL' : newVal;
                td.className = newVal === '' ? 'db-null' : 'db-str';
            } catch (err) {
                this._setStatus('Ошибка: ' + err.message, 'err');
                app.toast('Ошибка обновления: ' + err.message, 'error');
            }
        };

        input.addEventListener('blur', commit);
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter')  { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { committed = true; input.remove(); }
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
