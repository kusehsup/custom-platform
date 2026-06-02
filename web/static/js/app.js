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
        main.classList.remove('main--fullscreen');
        main.innerHTML = '';
        const page = this._pages[name];
        if (page) page.render(main);
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
            btn.textContent = isOn ? 'Стоп' : 'Старт';
            btn.className   = isOn ? 'btn btn-danger btn-sm' : 'btn btn-success btn-sm';
        }

        const cWrap = document.getElementById('tb-compile-wrap');
        if (!cWrap) return;
        if (this.state.compile) {
            cWrap.innerHTML = `<button class="btn btn-ghost btn-sm" disabled style="opacity:.5">Компилируется...</button>`;
        } else if (this._lastCompileResult) {
            const hasErr = /error/i.test(this._lastCompileResult);
            cWrap.innerHTML = `
            <div style="display:flex;gap:0;border:1px solid var(--border-2);border-radius:var(--radius);overflow:hidden">
                <button class="btn btn-ghost btn-sm" id="tb-compile-btn" style="border-radius:0;border:none;border-right:1px solid var(--border-2)">Сборка</button>
                <button class="btn btn-ghost btn-sm" id="tb-compile-result" style="border-radius:0;border:none;color:${hasErr ? 'var(--red)' : 'var(--green)'}">● ${hasErr ? 'Ошибки' : 'OK'}</button>
            </div>`;
            document.getElementById('tb-compile-btn').addEventListener('click', () => this._doCompile());
            document.getElementById('tb-compile-result').addEventListener('click', () => {
                this._pages['server']?._openModal?.(this._lastCompileResult, 'Последний результат');
            });
        } else {
            cWrap.innerHTML = `<button class="btn btn-ghost btn-sm" id="tb-compile-btn">Сборка</button>`;
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
            <div id="rc-totp-wrap" style="display:none">
                <input type="text" id="rc-totp" placeholder="000000"
                    autocomplete="one-time-code" inputmode="numeric" maxlength="6"
                    class="totp-input" />
            </div>
            <div class="auth-error" id="rc-error"></div>
            <button class="btn btn-primary btn-full" id="rc-btn">Переподключиться</button>
        </div>`;
        document.body.appendChild(wrap);

        // Логин уже известен из токена
        const login = this._getLoginFromToken();

        const doReconnect = async () => {
            const password  = document.getElementById('rc-pass').value;
            const totpCode  = document.getElementById('rc-totp')?.value.trim() || '';
            const err = document.getElementById('rc-error');
            const btn = document.getElementById('rc-btn');
            if (!password) { err.textContent = 'Введите пароль'; return; }
            btn.disabled = true; btn.textContent = 'Подключение...'; err.textContent = '';
            try {
                const data = await API.post('/api/login', { login, password, totp_code: totpCode });
                API.setToken(data.token);
                const s = await API.get('/api/status');
                this.state = { server: s.server, compile: s.compile };
                this._showApp();
            } catch (e) {
                if (e.message === 'TOTP_REQUIRED') {
                    const totpWrap = document.getElementById('rc-totp-wrap');
                    totpWrap.style.display = 'block';
                    document.getElementById('rc-totp').focus();
                    err.textContent = 'Введите код из Google Authenticator';
                } else {
                    err.textContent = e.message;
                }
                btn.disabled = false; btn.textContent = 'Переподключиться';
            }
        };

        document.getElementById('rc-btn').addEventListener('click', doReconnect);
        document.getElementById('rc-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doReconnect(); });
        document.getElementById('rc-totp').addEventListener('keydown', e => { if (e.key === 'Enter') doReconnect(); });
        document.getElementById('rc-totp').addEventListener('input', e => {
            if (e.target.value.replace(/\D/g, '').length === 6) doReconnect();
        });
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
        // SVG icons
        const ico = {
            server:   `<svg viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="4" rx="1"/><rect x="1" y="10" width="14" height="4" rx="1"/><circle cx="12.5" cy="4" r=".8" fill="currentColor" stroke="none"/><circle cx="12.5" cy="12" r=".8" fill="currentColor" stroke="none"/></svg>`,
            files:    `<svg viewBox="0 0 16 16"><path d="M2 3a1 1 0 011-1h4.586a1 1 0 01.707.293l4.414 4.414A1 1 0 0113 7.414V13a1 1 0 01-1 1H3a1 1 0 01-1-1V3z"/></svg>`,
            todo:     `<svg viewBox="0 0 16 16"><path d="M2 4h12M2 8h8M2 12h10"/></svg>`,
            db:       `<svg viewBox="0 0 16 16"><ellipse cx="8" cy="4" rx="6" ry="2"/><path d="M2 4v4c0 1.1 2.686 2 6 2s6-.9 6-2V4"/><path d="M2 8v4c0 1.1 2.686 2 6 2s6-.9 6-2V8"/></svg>`,
            settings: `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v1M8 13.5v1M1.5 8h1M13.5 8h1M3.4 3.4l.7.7M11.9 11.9l.7.7M3.4 12.6l.7-.7M11.9 4.1l.7-.7"/></svg>`,
            console:  `<svg viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="12" rx="2"/><path d="M4 6l3 2.5L4 11M8 11h4"/></svg>`,
            theme:    `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41"/></svg>`,
            logout:   `<svg viewBox="0 0 16 16"><path d="M6 14H3a1 1 0 01-1-1V3a1 1 0 011-1h3M11 11l3-3-3-3M14 8H6"/></svg>`,
            compile:  `<svg viewBox="0 0 16 16"><path d="M4 4l4 4-4 4M9 12h4"/></svg>`,
            ai:       `<svg viewBox="0 0 16 16"><path d="M8 1.5l1.6 3.5L13 6.6l-2.7 2.3.8 3.6L8 10.7l-3.1 1.8.8-3.6L3 6.6l3.4-1.6L8 1.5z"/></svg>`,
            tasks:    `<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 6.5l1.5 1.5L9 5.5M5 10.5l1.5 1.5L9 9.5"/></svg>`,
            stop:     `<svg viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>`,
            play:     `<svg viewBox="0 0 16 16"><polygon points="4,2 14,8 4,14"/></svg>`,
            ws:       `<svg viewBox="0 0 16 16"><path d="M2 8c0-3.3 2.7-6 6-6M14 8c0 3.3-2.7 6-6 6M5 8c0-1.7 1.3-3 3-3M11 8c0 1.7-1.3 3-3 3"/><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/></svg>`,
        };

        document.body.innerHTML = `
        <div class="layout">
            <header class="topbar">
                <span class="topbar-logo">
                    <span class="topbar-logo-icon">⚡</span>
                    CustomPlatform
                </span>
                <div id="topbar-actions" class="topbar-actions hidden">
                    <button class="btn btn-sm" id="tb-server-btn">—</button>
                    <span id="tb-compile-wrap">
                        <button class="btn btn-ghost btn-sm" id="tb-compile-btn">${ico.compile} Компилировать</button>
                    </span>
                </div>
                <div class="topbar-right">
                    <button class="topbar-btn" id="btn-ai" title="AI ассистент">${ico.ai} AI</button>
                    <button class="topbar-btn" id="btn-console" title="Консоль">${ico.console} Консоль</button>
                    <button class="topbar-btn" id="btn-debug" title="WS лог">${ico.ws} WS</button>
                    <button class="topbar-btn" id="btn-theme" title="Тема">${ico.theme}</button>
                    <span id="ws-status" class="ws-status ws-offline" title="Подключение..." style="margin:0 4px"></span>
                    <button class="topbar-btn" id="btn-logout" title="Выйти">${ico.logout} Выйти</button>
                </div>
            </header>
            <nav class="sidebar">
                <span class="sidebar-section">Управление</span>
                <a data-page="server">${ico.server}<span class="label">Сервер</span></a>
                <span class="sidebar-section">Код</span>
                <a data-page="files">${ico.files}<span class="label">Файлы</span></a>
                <span class="sidebar-section">Инструменты</span>
                <a data-page="ai">${ico.ai}<span class="label">AI ассистент</span></a>
                <a data-page="tasks">${ico.tasks}<span class="label">Задачи</span><span id="tasks-badge" class="sidebar-badge hidden"></span></a>
                <a data-page="todo">${ico.todo}<span class="label">TODO</span><span id="todo-badge" class="sidebar-badge hidden"></span></a>
                <a data-page="db">${ico.db}<span class="label">База данных</span></a>
                <div class="sidebar-spacer"></div>
                <div class="sidebar-footer">
                    <a data-page="settings">${ico.settings}<span class="label">Настройки</span></a>
                </div>
            </nav>
            <main class="main" id="main"></main>
        </div>
        <div id="toast-wrap" class="toast-wrap"></div>`;

        document.querySelectorAll('.sidebar a').forEach(a =>
            a.addEventListener('click', () => this.navigate(a.dataset.page))
        );

        document.getElementById('btn-debug').addEventListener('click', () => this.toggleDebug());
        document.getElementById('btn-console').addEventListener('click', () => this.toggleConsole());
        document.getElementById('btn-ai').addEventListener('click', () => AiWidget.toggle());
        document.getElementById('btn-theme').addEventListener('click', () => this.toggleTheme());

        // Подгружаем задачи в фоне — для бэйджа в сайдбаре и активной задачи в AI
        if (typeof TasksStore !== 'undefined') TasksStore.load().catch(() => {});

        // Кнопка сервера в топбаре
        document.getElementById('topbar-actions').addEventListener('click', async e => {
            if (e.target.id === 'tb-server-btn') {
                const isOn = this.state.server === 'on';
                try {
                    await API.post(isOn ? '/api/server/stop' : '/api/server/start');
                    this.state.server = isOn ? 'off' : 'on';
                    this._updateTopbarActions();
                    this._pages['server']?.onState?.();
                    app.toast(isOn ? 'Сервер остановлен' : 'Сервер запущен', isOn ? 'info' : 'success');
                } catch (e) { app.toast('Ошибка: ' + e.message, 'error'); }
            }
        });

        document.getElementById('btn-logout').addEventListener('click', async () => {
            await API.post('/api/logout').catch(() => {});
            API.clearToken();
            if (this._ws) this._ws.close();
            this._showAuth();
        });

        this._applyTheme(localStorage.getItem('theme') || 'dark');
        this.connectWS();
        this.navigate('server');
        this._registerCommands();
        this._bgScanTodo();
    },

    _registerCommands() {
        if (!window.Palette || Palette._commands.length) return;
        const P = Palette;
        P.register({ id: 'nav.server',   title: 'Перейти: Сервер',     icon: '🖥', group: 'Навигация', run: () => this.navigate('server') });
        P.register({ id: 'nav.files',    title: 'Перейти: Файлы',      icon: '📁', group: 'Навигация', run: () => this.navigate('files') });
        P.register({ id: 'nav.settings', title: 'Перейти: Настройки',  icon: '⚙️', group: 'Навигация', run: () => this.navigate('settings') });
        P.register({ id: 'srv.start',    title: 'Сервер: Запустить',   icon: '▶',  group: 'Сервер', hint: 'Ctrl+Shift+S', when: () => this.state.server !== 'on', run: async () => { await API.post('/api/server/start'); this.state.server='on'; this._updateTopbarActions(); this._pages['server']?.onState?.(); app.toast('Сервер запущен', 'success'); } });
        P.register({ id: 'srv.stop',     title: 'Сервер: Остановить',  icon: '⏹', group: 'Сервер', when: () => this.state.server === 'on', run: async () => { await API.post('/api/server/stop'); this.state.server='off'; this._updateTopbarActions(); this._pages['server']?.onState?.(); app.toast('Сервер остановлен', 'info'); } });
        P.register({ id: 'compile',      title: 'Компилировать',       icon: '🔨', group: 'Сервер', hint: 'Ctrl+Shift+B', run: () => this._doCompile() });
        P.register({ id: 'view.console', title: 'Виджет: Консоль',     icon: '📋', group: 'Виджеты', run: () => this.toggleConsole() });
        P.register({ id: 'view.wslog',   title: 'Виджет: WS Log',      icon: '📡', group: 'Виджеты', run: () => this.toggleDebug() });
        P.register({ id: 'view.ai',      title: 'Виджет: AI ассистент', icon: '✦', group: 'Виджеты', run: () => AiWidget.toggle() });
        P.register({ id: 'tasks.open',   title: 'Перейти к задачам',   icon: '⎘', group: 'Навигация', run: () => this.navigate('tasks') });
        P.register({ id: 'ai.thread',    title: 'AI: выбрать тред...', icon: '✦', hint: 'Ctrl+/', group: 'AI', run: () => { if (typeof AiChat !== 'undefined') { AiChat.init(); AiChat.ensureThreadsLoaded().then(() => AiChat.showThreadPicker()); } } });
        P.register({ id: 'sidebar.toggle', title: 'Свернуть/Развернуть сайдбар', icon: '◧', group: 'Интерфейс', run: () => document.getElementById('sidebar-toggle')?.click() });
        P.register({ id: 'logout',       title: 'Выйти',               icon: '🚪', group: 'Прочее', run: () => document.getElementById('btn-logout')?.click() });
        // Команды редактора
        P.register({ id: 'editor.goto',  title: 'Редактор: Перейти к строке', icon: ':N', hint: 'Ctrl+G', group: 'Редактор', when: () => this._pages['files']?._activeFileId, run: () => this._pages['files']?._showGotoLine() });
        P.register({ id: 'editor.save',  title: 'Редактор: Сохранить файл',   icon: '💾', hint: 'Ctrl+S', group: 'Редактор', when: () => this._pages['files']?._activeFileId, run: () => this._pages['files']?._save() });
        P.register({ id: 'editor.history', title: 'Редактор: История изменений', icon: '🕐', group: 'Редактор', when: () => this._pages['files']?._activeFileId, run: () => this._pages['files']?._showHistory() });
        P.register({ id: 'workspace',     title: 'Workspace: Управление',      icon: '🗂', group: 'Прочее', run: () => Workspace.showManager() });
        P.register({ id: 'ws.save',       title: 'Workspace: Сохранить текущий', icon: '💼', group: 'Прочее', run: () => {
            const name = prompt('Имя workspace:');
            if (name) Workspace.saveCurrent(name) ? app.toast(`💾 Workspace "${name}" сохранён`, 'success') : app.toast('Нет открытого файла', 'error');
        }});
        P.register({ id: 'todo',          title: 'TODO: Показать список',      icon: '✅', group: 'Прочее', run: () => this._pages['todo']?.open?.() || this.navigate('todo') });
        P.register({ id: 'db',            title: 'База данных',                icon: '🗄', group: 'Прочее', run: () => this.navigate('db') });
    },

    _applyTheme(theme) {
        document.body.classList.toggle('light', theme === 'light');
        if (typeof monaco !== 'undefined') {
            monaco.editor.setTheme(theme === 'light' ? 'vs' : 'custom-dark');
        } else {
            // Monaco ещё не загружен — применим когда загрузится
            window._pendingMonacoTheme = theme === 'light' ? 'vs' : 'custom-dark';
        }
    },

    toggleTheme() {
        const cur = localStorage.getItem('theme') || 'dark';
        const next = cur === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem('theme', next); } catch {}
        this._applyTheme(next);
    },

    async _bgScanTodo() {
        await new Promise(r => setTimeout(r, 3000));  // ждём пока платформа отдаст данные
        const filesPage = this._pages['files'];
        if (!filesPage) return;
        // Загружаем список файлов если ещё не загружен
        if (!filesPage._files || !Object.keys(filesPage._files).length) {
            try { await filesPage._loadFiles(); } catch { return; }
        }
        const todo = this._pages['todo'];
        if (todo && !todo._scanning && todo._items === null) {
            // null-заглушка el — _scan работает через document.getElementById для badge/progress
            const nullEl = { querySelector: () => null, querySelectorAll: () => [] };
            todo._scan(nullEl);
        }
    },

    _doCompile() {
        if (this.state.compile) { app.toast('Компиляция уже выполняется', 'info'); return; }
        API.post('/api/compile').then(() => {
            this.state.compile = true;
            this._updateTopbarActions();
            this._pages['server']?.onState?.();
            app.toast('🔨 Компиляция запущена', 'info');
        }).catch(e => app.toast('Ошибка: ' + e.message, 'error'));
    },
};

window.app = app;

// Глобальные хоткеи
document.addEventListener('keydown', e => {
    if (!app._ws) return;
    // Ctrl+/ — AI thread picker
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        if (typeof AiChat !== 'undefined') {
            e.preventDefault();
            AiChat.init();
            AiChat.ensureThreadsLoaded().then(() => AiChat.showThreadPicker());
        }
        return;
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault(); app._doCompile();
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        const isOn = app.state.server === 'on';
        API.post(isOn ? '/api/server/stop' : '/api/server/start').then(() => {
            app.state.server = isOn ? 'off' : 'on';
            app._updateTopbarActions();
            app._pages['server']?.onState?.();
            app.toast(isOn ? '🔴 Сервер остановлен' : '🟢 Сервер запущен', isOn ? 'info' : 'success');
        }).catch(err => app.toast('Ошибка: ' + err.message, 'error'));
    }
});
