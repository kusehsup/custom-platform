const API = {
    _token: localStorage.getItem('token'),

    _headers() {
        return {
            'Content-Type': 'application/json',
            ...(this._token ? { 'Authorization': `Bearer ${this._token}` } : {}),
        };
    },

    async _fetch(method, url, body) {
        const res = await fetch(url, {
            method,
            headers: this._headers(),
            body: body ? JSON.stringify(body) : undefined,
        });
        if (res.status === 401) {
            this.clearToken();
            app.toast('Сессия истекла, войдите снова', 'error');
            setTimeout(() => app._showAuth(), 1500);
            throw new Error('Сессия истекла');
        }
        const data = await res.json();
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
