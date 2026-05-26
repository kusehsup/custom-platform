const CONSOLE_KEY      = 'console_lines';
const CONSOLE_LIMIT    = 200;
const COMPILE_KEY      = 'compile_last';
const COMPILE_HIST_KEY = 'compile_history';
const COMPILE_HIST_MAX = 5;

app.register('server', {
    _el: null,
    _paused: false,
    _lines: [],

    // ── Консоль ──────────────────────────────────────────────────────
    _loadLines() {
        try { this._lines = JSON.parse(localStorage.getItem(CONSOLE_KEY) || '[]'); } catch { this._lines = []; }
    },
    _saveLines() {
        if (this._lines.length > CONSOLE_LIMIT) this._lines = this._lines.slice(-CONSOLE_LIMIT);
        try { localStorage.setItem(CONSOLE_KEY, JSON.stringify(this._lines)); } catch {}
    },
    _flushConsole() {
        if (!this._el) return;
        this._el.textContent = this._lines.join('');
        this._el.scrollTop   = this._el.scrollHeight;
        this._updateCount();
    },
    _updateCount() {
        const el = document.getElementById('console-count');
        if (el) el.textContent = `${this._lines.length} / ${CONSOLE_LIMIT}`;
    },

    // ── Компиляция — хранилище ────────────────────────────────────────
    _saveLast(text) {
        const ts = Date.now();
        const hasErrors   = /error/i.test(text);
        const hasWarnings = /warning/i.test(text);
        try { localStorage.setItem(COMPILE_KEY, JSON.stringify({ text, ts })); } catch {}
        let hist = [];
        try { hist = JSON.parse(localStorage.getItem(COMPILE_HIST_KEY) || '[]'); } catch {}
        hist.unshift({ ts, hasErrors, hasWarnings, preview: text.split('\n').slice(-3).join(' ').trim().slice(0, 120) });
        if (hist.length > COMPILE_HIST_MAX) hist = hist.slice(0, COMPILE_HIST_MAX);
        try { localStorage.setItem(COMPILE_HIST_KEY, JSON.stringify(hist)); } catch {}
    },
    _loadLast()  { try { return JSON.parse(localStorage.getItem(COMPILE_KEY)      || 'null'); } catch { return null; } },
    _loadHist()  { try { return JSON.parse(localStorage.getItem(COMPILE_HIST_KEY) || '[]');  } catch { return []; } },

    _fmtTs(ts) {
        if (!ts) return '—';
        return new Date(ts).toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
    },

    // ── Рендер ───────────────────────────────────────────────────────
    render(root) {
        this._loadLines();
        this._paused = false;
        const saved = this._loadLast();
        const hist  = this._loadHist();

        root.innerHTML = `
        <!-- Сервер -->
        <div class="card">
            <div class="card-header">
                <span class="card-title">Сервер</span>
                <button class="btn btn-ghost btn-sm" id="btn-refresh">↻ Обновить</button>
            </div>
            <div class="stat-rows">
                <div class="stat-row">
                    <span class="stat-label">Состояние</span>
                    <span id="srv-badge"></span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Хост</span>
                    <span class="stat-value" style="font-family:var(--mono);font-size:13px" id="srv-host">—</span>
                </div>
            </div>
            <div class="btn-row" style="margin-top:16px">
                <button class="btn btn-success hidden" id="btn-start">▶ Запустить</button>
                <button class="btn btn-danger  hidden" id="btn-stop">⏹ Остановить</button>
            </div>
            <div id="srv-msg" style="margin-top:10px;color:var(--text-2);font-size:13px;min-height:16px"></div>
        </div>

        <!-- Компиляция -->
        <div class="card">
            <div class="card-header">
                <span class="card-title">Компиляция</span>
                <span id="compile-last-ts" style="color:var(--text-2);font-size:12px">${saved ? 'Последняя: ' + this._fmtTs(saved.ts) : ''}</span>
            </div>
            <div class="btn-row" style="margin-bottom:14px">
                <button class="btn btn-primary" id="btn-compile">🔨 Компилировать</button>
            </div>
            <div id="compile-status" style="color:var(--text-2);font-size:13px;margin-bottom:10px;min-height:16px">
                ${app.state.compile ? '⏳ Компиляция выполняется...' : ''}
            </div>
            <div id="compile-out" class="compile-out ${saved ? '' : 'hidden'}"></div>

            ${hist.length ? `
            <div style="margin-top:16px;border-top:1px solid var(--border);padding-top:14px">
                <div style="font-size:12px;color:var(--text-2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.06em">История компиляций</div>
                ${hist.map(h => `
                <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);font-size:12.5px">
                    <span>${h.hasErrors ? '❌' : h.hasWarnings ? '⚠️' : '✅'}</span>
                    <span style="color:var(--text-2)">${this._fmtTs(h.ts)}</span>
                    <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-3);font-family:var(--mono);font-size:11px">${this._esc(h.preview)}</span>
                </div>`).join('')}
            </div>` : ''}
        </div>

        <!-- Консоль -->
        <div class="card" style="padding:0;overflow:hidden">
            <div class="console-toolbar">
                <span class="card-title" style="margin:0">Консоль</span>
                <span class="spacer"></span>
                <span class="console-count" id="console-count"></span>
                <button class="btn btn-ghost btn-sm" id="btn-pause">⏸ Пауза</button>
                <button class="btn btn-ghost btn-sm" id="btn-download">↓ Скачать</button>
                <button class="btn btn-ghost btn-sm" id="btn-clear">🗑 Очистить</button>
            </div>
            <div class="console" id="console-out"></div>
        </div>`;

        this._el = document.getElementById('console-out');
        const hostEl = document.getElementById('srv-host');
        if (hostEl && app.platformHost) hostEl.textContent = app.platformHost;
        this.onState();
        this._flushConsole();
        if (saved) this._renderCompile(saved.text, false);
        if (app.state.compile) document.getElementById('btn-compile').disabled = true;

        // Сервер
        document.getElementById('btn-refresh').addEventListener('click', async () => {
            try { const s = await API.get('/api/status'); app.state.server = s.server; app.state.compile = s.compile; this.onState(); }
            catch (e) { this._msg(e.message); }
        });
        document.getElementById('btn-start').addEventListener('click', () => this._serverAction('/api/server/start', 'on'));
        document.getElementById('btn-stop').addEventListener('click',  () => this._serverAction('/api/server/stop',  'off'));

        // Компиляция
        document.getElementById('btn-compile').addEventListener('click', async () => {
            try {
                await API.post('/api/compile');
                app.state.compile = true;
                document.getElementById('btn-compile').disabled = true;
                document.getElementById('compile-status').textContent = '⏳ Компиляция запущена, ожидаем результат...';
                document.getElementById('compile-out').classList.add('hidden');
                app.toast('Компиляция запущена', 'info');
            } catch (e) {
                document.getElementById('compile-status').textContent = 'Ошибка: ' + e.message;
                app.toast('Ошибка: ' + e.message, 'error');
            }
        });

        // Консоль
        document.getElementById('btn-pause').addEventListener('click', () => {
            this._paused = !this._paused;
            document.getElementById('btn-pause').textContent = this._paused ? '▶ Продолжить' : '⏸ Пауза';
        });
        document.getElementById('btn-clear').addEventListener('click', () => {
            this._lines = []; this._saveLines(); this._flushConsole();
        });
        document.getElementById('btn-download').addEventListener('click', () => {
            const blob = new Blob([this._lines.join('')], { type: 'text/plain' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `console_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.txt`;
            a.click(); URL.revokeObjectURL(a.href);
        });
    },

    // ── Сервер ───────────────────────────────────────────────────────
    async _serverAction(url, expected) {
        this._setDisabled(true);
        try {
            await API.post(url);
            app.state.server = expected;
            this.onState();
            app.toast(expected === 'on' ? '🟢 Сервер запущен' : '🔴 Сервер остановлен', expected === 'on' ? 'success' : 'info');
        } catch (e) {
            this._msg('Ошибка: ' + e.message);
            app.toast('Ошибка: ' + e.message, 'error');
        } finally {
            this._setDisabled(false);
        }
    },

    onState() {
        const badge    = document.getElementById('srv-badge');
        const btnStart = document.getElementById('btn-start');
        const btnStop  = document.getElementById('btn-stop');
        if (badge) {
            const s = app.state.server;
            if (s === 'on')       badge.innerHTML = '<span class="badge badge-on">Работает</span>';
            else if (s === 'off') badge.innerHTML = '<span class="badge badge-off">Выключен</span>';
            else                  badge.innerHTML = '<span style="color:var(--text-2)">—</span>';
        }
        if (btnStart && btnStop) {
            btnStart.classList.toggle('hidden', app.state.server === 'on');
            btnStop.classList.toggle('hidden',  app.state.server !== 'on');
        }
    },

    // ── Компиляция ────────────────────────────────────────────────────
    onCompileResult(text) {
        app.state.compile = false;
        this._saveLast(text);
        const btn = document.getElementById('btn-compile');
        if (btn) btn.disabled = false;
        const status = document.getElementById('compile-status');
        if (status) status.textContent = '';
        const tsEl = document.getElementById('compile-last-ts');
        if (tsEl) tsEl.textContent = 'Последняя: ' + this._fmtTs(Date.now());
        this._renderCompile(text, true);
        // Обновляем историю в DOM
        const histEl = document.querySelector('.card:nth-child(2) [style*="История"]');
        if (histEl) this.render(document.getElementById('main'));
    },

    _renderCompile(text, isNew) {
        const out = document.getElementById('compile-out');
        if (!out) return;
        out.classList.remove('hidden');
        const existing = out.querySelectorAll('.compile-line').length;
        out.innerHTML = text.split('\n').map((raw, i) => {
            const safe = this._esc(raw);
            let cls = 'compile-line';
            if (/error/i.test(raw))                     cls += ' line-err';
            else if (/warning/i.test(raw))              cls += ' line-warn';
            else if (/done|success|\(0 error/i.test(raw)) cls += ' line-ok';
            if (isNew && i >= existing)                 cls += ' line-new';
            return `<span class="${cls}">${safe}</span>`;
        }).join('\n');
        out.scrollTop = out.scrollHeight;
    },

    // ── Консоль ───────────────────────────────────────────────────────
    onLog(data) {
        this._lines.push(data);
        this._saveLines();
        if (this._paused || !this._el) return;
        this._el.textContent += data;
        this._el.scrollTop = this._el.scrollHeight;
        this._updateCount();
    },

    _msg(t)  { const e = document.getElementById('srv-msg'); if (e) e.textContent = t; },
    _esc(s)  { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); },
    _setDisabled(v) {
        ['btn-start','btn-stop'].forEach(id => { const e = document.getElementById(id); if (e) e.disabled = v; });
    },
});
