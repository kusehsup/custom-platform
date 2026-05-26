const app = {
    _pages: {},
    _current: null,
    _ws: null,
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

        this._ws = API.connectWS(msg => this._onWS(msg));

        this._ws.onopen = () => {
            this._setWsStatus(true);
            this._pingInterval = setInterval(() => {
                if (this._ws?.readyState === WebSocket.OPEN) this._ws.send('ping');
            }, 20000);
        };

        this._ws.onclose = () => {
            this._setWsStatus(false);
            clearInterval(this._pingInterval);
            setTimeout(() => { if (API.hasToken()) this.connectWS(); }, 3000);
        };

        this._ws.onerror = () => this._setWsStatus(false);
    },

    _setWsStatus(online) {
        const el = document.getElementById('ws-status');
        if (!el) return;
        el.className = 'ws-status ' + (online ? 'ws-online' : 'ws-offline');
        el.title = online ? 'Соединение активно' : 'Переподключение...';
    },

    _onWS(msg) {
        if (msg.type === 'status') {
            this.state.server  = msg.server;
            this.state.compile = msg.compile;
            this._pages['server']?.onState?.();
            // Реактивное обновление списка файлов при любом обновлении данных платформы
            this._pages['files']?.onFilesUpdate?.();
        } else if (msg.type === 'log') {
            this._pages['server']?.onLog?.(msg.data);
        } else if (msg.type === 'compile_result') {
            this.state.compile = false;
            this._pages['server']?.onCompileResult?.(msg.data);
            // Уведомления
            const s = this._getSettings();
            const hasErr = /error/i.test(msg.data);
            if (s.notify_compile !== false) {
                this.toast(hasErr ? '❌ Компиляция завершена с ошибками' : '✅ Компиляция завершена', hasErr ? 'error' : 'success');
                this.notify('CustomPlatform', hasErr ? 'Компиляция завершена с ошибками' : 'Компиляция успешна');
            }
        } else if (msg.type === 'queries_update') {
            this._pages['queries']?.onUpdate?.(msg.queries);
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
                <span id="ws-status" class="ws-status ws-offline" title="Подключение..."></span>
                <button class="btn btn-ghost btn-sm" id="btn-logout">Выйти</button>
            </header>
            <nav class="sidebar">
                <span class="sidebar-section">Управление</span>
                <a data-page="server"><span class="icon">🖥</span>Сервер</a>
                <span class="sidebar-section">Код</span>
                <a data-page="files"><span class="icon">📁</span>Файлы</a>
                <a data-page="queries"><span class="icon">📨</span>Запросы кода</a>
                <span class="sidebar-section">Прочее</span>
                <a data-page="settings"><span class="icon">⚙️</span>Настройки</a>
            </nav>
            <main class="main" id="main"></main>
        </div>
        <div id="toast-wrap" class="toast-wrap"></div>`;

        document.querySelectorAll('.sidebar a').forEach(a =>
            a.addEventListener('click', () => this.navigate(a.dataset.page))
        );
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
