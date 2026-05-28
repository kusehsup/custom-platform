const app = {
    _pages: {},
    _current: null,
    _ws: null,
    _wsLog: [],
    _wsLogMax: 40,
    state: { server: 'unknown', compile: false },

    register(name, page) { this._pages[name] = page; },

    navigate(name) {
        if (this._current === name) return;
        this._current = name;
        document.querySelectorAll('.sidebar a').forEach(a =>
            a.classList.toggle('active', a.dataset.page === name)
        );
        const main = document.getElementById('main');
        if (!main) return;
        main.innerHTML = '';
        const page = this._pages[name];
        if (page) page.render(main);
        // Показываем кнопки только вне страницы сервера
        this._updateTopbarActions();
    },

    _lastCompileResult: null,

    _updateTopbarActions() {
        const wrap = document.getElementById('topbar-actions');
        if (!wrap) return;
        const onServer = this._current === 'server';
        wrap.classList.toggle('hidden', onServer);
        if (onServer) return;

        const btn = document.getElementById('tb-server-btn');
        const isOn = this.state.server === 'on';
        if (btn) {
            btn.textContent = isOn ? '⏹ Стоп' : '▶ Старт';
            btn.className   = isOn ? 'btn btn-danger btn-sm' : 'btn btn-success btn-sm';
        }

        // Кнопка компиляции меняется в зависимости от состояния
        const cWrap = document.getElementById('tb-compile-wrap');
        if (!cWrap) return;
        if (this.state.compile) {
            cWrap.innerHTML = `<button class="btn btn-ghost btn-sm" disabled style="opacity:.6">⏳ Компилируется...</button>`;
        } else if (this._lastCompileResult) {
            const hasErr = /error/i.test(this._lastCompileResult);
            const icon   = hasErr ? '❌' : '✅';
            cWrap.innerHTML = `
            <div style="display:flex;gap:0;border:1px solid var(--border);border-radius:var(--radius-sm);overflow:hidden">
                <button class="btn btn-ghost btn-sm" id="tb-compile-btn" style="border-radius:0;border:none;border-right:1px solid var(--border)">🔨</button>
                <button class="btn btn-ghost btn-sm" id="tb-compile-result" style="border-radius:0;border:none">${icon} Результат</button>
            </div>`;
            document.getElementById('tb-compile-btn').addEventListener('click', () => this._doCompile());
            document.getElementById('tb-compile-result').addEventListener('click', () => {
                this._pages['server']?._openModal?.(this._lastCompileResult, 'Последний результат');
            });
        } else {
            cWrap.innerHTML = `<button class="btn btn-ghost btn-sm" id="tb-compile-btn">🔨 Компилировать</button>`;
            document.getElementById('tb-compile-btn').addEventListener('click', () => this._doCompile());
        }
    },

    async _doCompile() {
        if (this.state.compile) return;
        try {
            await API.post('/api/compile');
            this.state.compile = true;
            this._updateTopbarActions();
            this._pages['server']?.onState?.();
            app.toast('🔨 Компиляция запущена', 'info');
        } catch (e) { app.toast('Ошибка: ' + e.message, 'error'); }
    },

    // ── WS Log widget ─────────────────────────────────────────────────
    _logWS(msg, type = 'info') {
        const ts = new Date().toLocaleTimeString('ru-RU');
        this._wsLog.unshift({ ts, msg, type });
        if (this._wsLog.length > this._wsLogMax) this._wsLog.pop();
        this._renderWsLog();
    },

    _renderWsLog() {
        const el = document.getElementById('ws-log-body');
        if (!el) return;
        const dot = document.getElementById('ws-log-dot');
        if (dot) dot.style.background = this._ws?.readyState === WebSocket.OPEN ? 'var(--green)' : 'var(--red)';
        el.innerHTML = this._wsLog.map(e => {
            const color = e.type === 'error' ? 'var(--red)' : e.type === 'success' ? 'var(--green)' : e.type === 'warn' ? 'var(--yellow)' : 'var(--text-2)';
            return `<div style="display:flex;gap:6px;padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.04)">
                <span style="color:var(--text-3);flex-shrink:0;font-size:10px">${e.ts}</span>
                <span style="color:${color};word-break:break-all;font-size:11px">${e.msg}</span>
            </div>`;
        }).join('');
    },

    toggleDebug() {
        if (!document.getElementById('widget-wslog')) {
            Widgets.create({
                id: 'widget-wslog',
                title: '<span id="ws-log-dot" style="width:7px;height:7px;border-radius:50%;background:var(--red);display:inline-block;margin-right:6px"></span>WS Log',
                content: '<div id="ws-log-body" style="overflow-y:auto;flex:1;padding:6px 10px;font-family:var(--mono)"></div>',
                width: 340, height: 280,
                defaultPos: { right: 24, bottom: 80 },
            });
            this._renderWsLog();
        } else {
            Widgets.toggle('widget-wslog');
        }
    },

    // ── Console widget ────────────────────────────────────────────────
    _consoleLines: [],
    _consolePaused: false,
    _consoleFilter: '',

    toggleConsole() {
        if (!document.getElementById('widget-console')) {
            Widgets.create({
                id: 'widget-console',
                title: '📋 Консоль',
                content: `
                <div style="display:flex;gap:6px;padding:6px 10px;border-bottom:1px solid var(--border);flex-shrink:0">
                    <input id="con-filter" type="text" placeholder="Фильтр..." style="flex:1;padding:3px 8px;font-size:12px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--text);outline:none" />
                    <button id="con-pause" style="background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-2);cursor:pointer;padding:3px 8px;font-size:11px">⏸</button>
                    <button id="con-clear" style="background:none;border:1px solid var(--border);border-radius:6px;color:var(--text-2);cursor:pointer;padding:3px 8px;font-size:11px">🗑</button>
                </div>
                <div id="con-body" style="overflow-y:auto;flex:1;padding:6px 10px;font-family:var(--mono);font-size:11.5px;line-height:1.6"></div>`,
                width: 420, height: 320,
                defaultPos: { right: 24, bottom: 80 },
            });
            // Восстанавливаем строки
            this._renderConsoleWidget();
            document.getElementById('con-filter').addEventListener('input', e => {
                this._consoleFilter = e.target.value.toLowerCase();
                this._renderConsoleWidget();
            });
            document.getElementById('con-pause').addEventListener('click', e => {
                this._consolePaused = !this._consolePaused;
                e.target.textContent = this._consolePaused ? '▶' : '⏸';
            });
            document.getElementById('con-clear').addEventListener('click', () => {
                this._consoleLines = [];
                try { localStorage.removeItem('console_lines'); } catch {}
                this._renderConsoleWidget();
                this._pages['server']?._lines && (this._pages['server']._lines = []);
            });
        } else {
            Widgets.toggle('widget-console');
        }
    },

    pushConsoleLog(data) {
        this._consoleLines.push(data);
        if (this._consoleLines.length > 200) this._consoleLines.shift();
        if (!this._consolePaused) this._renderConsoleWidget();
    },

    _renderConsoleWidget() {
        const el = document.getElementById('con-body');
        if (!el) return;
        const filter = this._consoleFilter;
        const lines  = this._consoleLines.join('').split('\n');
        const filtered = filter ? lines.filter(l => l.toLowerCase().includes(filter)) : lines;
        el.innerHTML = filtered.map(line => this._colorizeConsoleLine(line)).join('<br>');
        el.scrollTop = el.scrollHeight;
    },

    _colorizeConsoleLine(line) {
        const safe = line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        if (/\[fatal\]|\[crash\]/i.test(line))  return `<span style="color:#FF3B30;font-weight:600">${safe}</span>`;
        if (/\[error\]|error:/i.test(line))      return `<span style="color:#F87171">${safe}</span>`;
        if (/\[warn\]|warning/i.test(line))      return `<span style="color:#FBBF24">${safe}</span>`;
        if (/\[debug\]/i.test(line))             return `<span style="color:#8E8E93">${safe}</span>`;
        if (/\[info\]/i.test(line))              return `<span style="color:#C8D3F5">${safe}</span>`;
        return `<span style="color:#8E8E93">${safe}</span>`;
    },

    // ── Toast ─────────────────────────────────────────────────────────
    toast(message, type = 'info') {
        let wrap = document.getElementById('toast-wrap');
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.id = 'toast-wrap';
            wrap.className = 'toast-wrap';
            document.body.appendChild(wrap);
        }
        const el = document.createElement('div');
        el.className = `toast ${type}`;
        el.textContent = message;
        wrap.appendChild(el);
        setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(() => el.remove(), 300); }, 3000);
    },

    // ── Browser notifications ─────────────────────────────────────────
    async notify(title, body) {
        const s = this._getSettings();
        if (!s.browser_notifications) return;
        if (Notification.permission === 'default') await Notification.requestPermission();
        if (Notification.permission === 'granted') new Notification(title, { body });
    },

    _getSettings() {
        try { return JSON.parse(localStorage.getItem('settings') || '{}'); } catch { return {}; }
    },

    // ── WebSocket ─────────────────────────────────────────────────────
    connectWS() {
        if (this._ws) this._ws.close();
        if (this._pingInterval) clearInterval(this._pingInterval);

        this._logWS('Подключение к WS...', 'info');
        this._ws = API.connectWS(msg => this._onWS(msg));

        this._ws.onopen = () => {
            this._setWsStatus(true);
            this._logWS('WS подключён', 'success');
            this._pingInterval = setInterval(() => {
                if (this._ws?.readyState === WebSocket.OPEN) {
                    this._ws.send('ping');
                    this._logWS('ping →', 'info');
                }
            }, 20000);
        };

        this._ws.onclose = (e) => {
            this._setWsStatus(false);
            this._logWS(`WS закрыт (code=${e.code}, reason=${e.reason || '—'})`, 'error');
            clearInterval(this._pingInterval);
            setTimeout(() => { if (API.hasToken()) this.connectWS(); }, 3000);
        };

        this._ws.onerror = (e) => {
            this._setWsStatus(false);
            this._logWS('WS ошибка', 'error');
        };
    },

    _setWsStatus(online) {
        const el = document.getElementById('ws-status');
        if (!el) return;
        el.className = 'ws-status ' + (online ? 'ws-online' : 'ws-offline');
        el.title = online ? 'Соединение активно' : 'Переподключение...';
    },

    _onWS(msg) {
        this._logWS(`← ${msg.type}`, 'info');
        if (msg.type === 'status') {
            this.state.server  = msg.server;
            this.state.compile = msg.compile;
            this._logWS(`  server=${msg.server} compile=${msg.compile}`, 'info');
            this._pages['server']?.onState?.();
            this._pages['files']?.onFilesUpdate?.();
            this._updateTopbarActions();
        } else if (msg.type === 'log') {
            this._pages['server']?.onLog?.(msg.data);
            this.pushConsoleLog(msg.data);
        } else if (msg.type === 'compile_result') {
            this.state.compile = false;
            this._lastCompileResult = msg.data;
            this._updateTopbarActions();
            this._pages['server']?.onCompileResult?.(msg.data);
            // Уведомления
            const s = this._getSettings();
            const hasErr = /error/i.test(msg.data);
            if (s.notify_compile !== false) {
                this.toast(hasErr ? '❌ Компиляция завершена с ошибками' : '✅ Компиляция завершена', hasErr ? 'error' : 'success');
                this.notify('CustomPlatform', hasErr ? 'Компиляция завершена с ошибками' : 'Компиляция успешна');
            }
        } else if (msg.type === 'queries_update') {
            // Уведомление об одобрении запроса
            const s = this._getSettings();
            if (s.notify_code_access !== false) this._checkNewAccess(msg.queries);
        }
    },

    _checkNewAccess(queries) {
        let known = [];
        try { known = JSON.parse(localStorage.getItem('known_query_ids') || '[]'); } catch {}
        const newlyAccepted = Object.entries(queries || {})
            .filter(([id, q]) => q.status === 'accept' && !known.includes(id));
        if (newlyAccepted.length) {
            newlyAccepted.forEach(([, q]) => {
                this.toast(`✅ Доступ разрешён: ${q.fileName || ''}`, 'success');
                this.notify('CustomPlatform', `Доступ к коду разрешён: ${q.fileName || ''}`);
            });
            const allKnown = [...known, ...newlyAccepted.map(([id]) => id)];
            try { localStorage.setItem('known_query_ids', JSON.stringify(allKnown)); } catch {}
        }
    },

    // ── Boot ──────────────────────────────────────────────────────────
    async boot() {
        try {
            const info = await API.get('/api/info');
            this.platformHost = info.platform_host || '';
        } catch { this.platformHost = ''; }

        if (!API.hasToken()) { this._showAuth(); return; }
        try {
            const s = await API.get('/api/status');
            if (s.session_lost) {
                // JWT валидный но сессия потеряна (рестарт) — показываем переподключение
                this._showReconnect();
                return;
            }
            this.state = { server: s.server, compile: s.compile };
            this._showApp();
        } catch { this._showAuth(); }
    },

    _showReconnect() {
        document.body.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.className = 'auth-wrap';
        wrap.innerHTML = `
        <div class="auth-box">
            <div class="auth-logo">
                <h1>CustomPlatform</h1>
                <p>Сервер был перезапущен.<br>Войдите снова для продолжения.</p>
            </div>
            <input type="password" id="rc-pass" placeholder="Пароль" autocomplete="current-password" />
            <div class="auth-error" id="rc-error"></div>
            <button class="btn btn-primary btn-full" id="rc-btn">Переподключиться</button>
        </div>`;
        document.body.appendChild(wrap);

        // Логин уже известен из токена
        const login = this._getLoginFromToken();

        const doReconnect = async () => {
            const password = document.getElementById('rc-pass').value;
            const err = document.getElementById('rc-error');
            const btn = document.getElementById('rc-btn');
            if (!password) { err.textContent = 'Введите пароль'; return; }
            btn.disabled = true; btn.textContent = 'Подключение...'; err.textContent = '';
            try {
                const data = await API.post('/api/login', { login, password });
                API.setToken(data.token);
                const s = await API.get('/api/status');
                this.state = { server: s.server, compile: s.compile };
                this._showApp();
            } catch (e) {
                err.textContent = e.message;
                btn.disabled = false; btn.textContent = 'Переподключиться';
            }
        };

        document.getElementById('rc-btn').addEventListener('click', doReconnect);
        document.getElementById('rc-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doReconnect(); });
    },

    _getLoginFromToken() {
        try {
            const token = localStorage.getItem('token');
            if (!token) return '';
            const payload = JSON.parse(atob(token.split('.')[1]));
            return payload.sub || '';
        } catch { return ''; }
    },

    _showAuth() {
        document.body.innerHTML = '';
        this._pages['login'].render(document.body);
    },

    _showApp() {
        document.body.innerHTML = `
        <div class="layout">
            <header class="topbar">
                <span class="topbar-logo"><span>⚡</span>CustomPlatform</span>
                <span style="flex:1"></span>
                <div id="topbar-actions" class="topbar-actions hidden">
                    <button class="btn btn-sm" id="tb-server-btn">—</button>
                    <span class="topbar-compile-wrap" id="tb-compile-wrap">
                        <button class="btn btn-ghost btn-sm" id="tb-compile-btn">🔨 Компилировать</button>
                    </span>
                </div>
                <span style="flex:1"></span>
                <button class="btn btn-ghost btn-sm" id="btn-console" title="Консоль" style="font-size:11px;padding:5px 10px">📋</button>
                <button class="btn btn-ghost btn-sm" id="btn-debug" title="WS лог" style="font-size:11px;padding:5px 10px">WS</button>
                <span id="ws-status" class="ws-status ws-offline" title="Подключение..."></span>
                <button class="btn btn-ghost btn-sm" id="btn-logout">Выйти</button>
            </header>
            <nav class="sidebar">
                <span class="sidebar-section">Управление</span>
                <a data-page="server"><span class="icon">🖥</span>Сервер</a>
                <span class="sidebar-section">Код</span>
                <a data-page="files"><span class="icon">📁</span>Файлы</a>
                <span class="sidebar-section">Прочее</span>
                <a data-page="settings"><span class="icon">⚙️</span>Настройки</a>
            </nav>
            <main class="main" id="main"></main>
        </div>
        <div id="toast-wrap" class="toast-wrap"></div>`;

        document.querySelectorAll('.sidebar a').forEach(a =>
            a.addEventListener('click', () => this.navigate(a.dataset.page))
        );
        document.getElementById('btn-debug').addEventListener('click', () => this.toggleDebug());
        document.getElementById('btn-console').addEventListener('click', () => this.toggleConsole());

        // Кнопка сервера в топбаре
        document.getElementById('topbar-actions').addEventListener('click', async e => {
            if (e.target.id === 'tb-server-btn') {
                const isOn = this.state.server === 'on';
                try {
                    await API.post(isOn ? '/api/server/stop' : '/api/server/start');
                    this.state.server = isOn ? 'off' : 'on';
                    this._updateTopbarActions();
                    this._pages['server']?.onState?.();
                    app.toast(isOn ? '🔴 Сервер остановлен' : '🟢 Сервер запущен', isOn ? 'info' : 'success');
                } catch (e) { app.toast('Ошибка: ' + e.message, 'error'); }
            }
        });

        document.getElementById('btn-logout').addEventListener('click', async () => {
            await API.post('/api/logout').catch(() => {});
            API.clearToken();
            if (this._ws) this._ws.close();
            this._showAuth();
        });

        this.connectWS();
        this.navigate('server');
    },
};

window.app = app;
