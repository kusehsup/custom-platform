// ── DB Quick Query: compact widget ───────────────────────────────────
//
// Лёгкий виджет «БД под рукой»: выполнить SELECT/INSERT/UPDATE прямо
// из любой страницы. Не дублирует полноценную страницу /db — для тяжёлой
// работы (структура, browse, Monaco) есть кнопка «открыть в полной странице».
//
// История запросов шарится с DbPage через localStorage ключ 'db_query_hist'.

const DbWidget = {
    _DATABASE: 'crmp_cloud',
    _HIST_KEY: 'db_query_hist',
    _HIST_MAX: 10,
    _LAST_SQL_KEY: 'db_widget_last_sql',
    _lastResult: null,

    toggle() {
        const existing = document.getElementById('widget-db');
        if (existing) { Widgets.toggle('widget-db'); return; }

        Widgets.create({
            id: 'widget-db',
            title: '🗄 БД',
            width: 480,
            height: 420,
            defaultPos: { right: 24, bottom: 80 },
            content: this._template(),
        });

        this._bind();
        // Восстановим последний SQL, чтобы юзер не вводил заново
        try {
            const last = localStorage.getItem(this._LAST_SQL_KEY) || '';
            const ta = document.getElementById('dbw-sql');
            if (ta && last) ta.value = last;
        } catch {}
    },

    _template() {
        return `
        <div class="dbw">
            <div class="dbw-toolbar">
                <button class="btn btn-primary btn-sm" id="dbw-run" title="Выполнить (Ctrl+Enter)">▶ Выполнить</button>
                <button class="btn btn-ghost btn-sm" id="dbw-hist" title="История">🕐</button>
                <button class="btn btn-ghost btn-sm" id="dbw-clear" title="Очистить">✕</button>
                <span style="flex:1"></span>
                <button class="btn btn-ghost btn-sm" id="dbw-open-page" title="Открыть полноразмерную страницу БД">↗ В страницу</button>
            </div>
            <textarea id="dbw-sql" class="dbw-sql" rows="3"
                placeholder="SELECT * FROM accounts WHERE id = 1305630 LIMIT 10"
                spellcheck="false"></textarea>
            <div id="dbw-status" class="dbw-status"></div>
            <div id="dbw-result" class="dbw-result"></div>
        </div>`;
    },

    _bind() {
        const $ = (id) => document.getElementById(id);

        $('dbw-run').addEventListener('click', () => this._run());
        $('dbw-clear').addEventListener('click', () => {
            $('dbw-sql').value = '';
            $('dbw-status').textContent = '';
            $('dbw-result').innerHTML = '';
            try { localStorage.removeItem(this._LAST_SQL_KEY); } catch {}
        });
        $('dbw-hist').addEventListener('click', (e) => this._showHistory(e.target));
        $('dbw-open-page').addEventListener('click', () => {
            // Сохраним SQL, чтобы потом подтянуть в полную страницу при желании
            try { localStorage.setItem(this._LAST_SQL_KEY, $('dbw-sql').value); } catch {}
            app.navigate('db');
        });

        const ta = $('dbw-sql');
        ta.addEventListener('keydown', (e) => {
            // Ctrl/Cmd + Enter → выполнить
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                this._run();
            }
        });
        ta.addEventListener('input', () => {
            try { localStorage.setItem(this._LAST_SQL_KEY, ta.value); } catch {}
        });
    },

    async _run() {
        const ta = document.getElementById('dbw-sql');
        const status = document.getElementById('dbw-status');
        const resultEl = document.getElementById('dbw-result');
        if (!ta || !status || !resultEl) return;

        const sql = (ta.value || '').trim();
        if (!sql) { status.textContent = 'Введите запрос'; status.className = 'dbw-status err'; return; }

        status.textContent = 'Выполнение…';
        status.className = 'dbw-status';
        resultEl.innerHTML = '';

        const t0 = Date.now();
        try {
            const res = await API.post('/api/db/query', { sql, database: this._DATABASE });
            const ms = Date.now() - t0;
            this._pushHist(sql);
            this._lastResult = res;
            const rowsCount = (res.rows || []).length;
            if (res.kind === 'select') {
                status.innerHTML = `<span class="dbw-ok">✓ ${rowsCount} строк</span> · ${ms} мс`;
                status.className = 'dbw-status ok';
                resultEl.appendChild(this._renderTable(res));
            } else {
                status.innerHTML = `<span class="dbw-ok">✓ изменено: ${res.affected ?? 0}</span> · ${ms} мс`;
                status.className = 'dbw-status ok';
            }
        } catch (e) {
            status.innerHTML = `<span class="dbw-err">✗ ${this._esc(e.message)}</span>`;
            status.className = 'dbw-status err';
        }
    },

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
                return `<td>${s}</td>`;
            }).join('');
            return `<tr>${tds}</tr>`;
        }).join('');
        wrap.innerHTML = `<table class="dbw-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
        return wrap;
    },

    _showHistory(anchor) {
        // Закроем уже открытый popup
        const existing = document.getElementById('dbw-hist-pop');
        if (existing) { existing.remove(); return; }

        let hist = [];
        try { hist = JSON.parse(localStorage.getItem(this._HIST_KEY) || '[]'); } catch {}
        if (!hist.length) {
            app.toast('История пуста', 'info');
            return;
        }
        const pop = document.createElement('div');
        pop.id = 'dbw-hist-pop';
        pop.className = 'dbw-hist-pop';
        pop.innerHTML = hist.map((sql, i) => `
            <div class="dbw-hist-item" data-i="${i}">
                <pre>${this._esc(sql)}</pre>
            </div>
        `).join('');

        // Позиционируем под кнопкой истории
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

        // Клик вне попапа закрывает
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

    _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    },
};

window.DbWidget = DbWidget;
