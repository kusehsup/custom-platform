const API = {
    _token: localStorage.getItem('token'),
    _loggingOut: false,

    _headers() {
        return {
            'Content-Type': 'application/json',
            ...(this._token ? { 'Authorization': `Bearer ${this._token}` } : {}),
        };
    },

    async _fetch(method, url, body, _retry = 0) {
        const res = await fetch(url, {
            method,
            headers: this._headers(),
            body: body ? JSON.stringify(body) : undefined,
        });
        if (res.status === 503 && _retry < 3) {
            // Платформа переподключается — ждём и повторяем
            app.toast('⏳ Переподключение к платформе...', 'info');
            await new Promise(r => setTimeout(r, 3000));
            return this._fetch(method, url, body, _retry + 1);
        }
        const ct = res.headers.get('content-type') || '';
        if (!ct.includes('application/json')) {
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        const data = await res.json();
        if (res.status === 401) {
            // TOTP_REQUIRED — не сбрасываем сессию, пробрасываем дальше
            if (data.detail === 'TOTP_REQUIRED') throw new Error('TOTP_REQUIRED');
            if (!this._loggingOut) {
                this._loggingOut = true;
                this.clearToken();
                app.toast('Сессия истекла, войдите снова', 'error');
                setTimeout(() => { app._showAuth(); this._loggingOut = false; }, 1500);
            }
            throw new Error('Сессия истекла');
        }
        if (!res.ok) throw new Error(data.detail || 'Ошибка запроса');
        return data;
    },

    get(url) { return this._fetch('GET', url); },
    post(url, body) { return this._fetch('POST', url, body); },

    setToken(token) {
        this._token = token;
        localStorage.setItem('token', token);
    },

    clearToken() {
        this._token = null;
        localStorage.removeItem('token');
        // Останавливаем фоновые процессы
        if (typeof TodoPage !== 'undefined') TodoPage.abort();
    },

    hasToken() { return !!this._token; },

    // WebSocket
    connectWS(onMessage) {
        const token = this._token;
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const ws = new WebSocket(`${proto}://${location.host}/ws?token=${token}`);
        ws.onmessage = e => onMessage(JSON.parse(e.data));
        return ws;
    },
};
