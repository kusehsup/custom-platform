app.register('login', {
    render(root) {
        root.innerHTML = `
        <div class="auth-wrap">
            <div class="auth-box">
                <div class="auth-logo">
                    <h1>CustomPlatform</h1>
                    <p>Войдите с данными от платформы</p>
                </div>
                <input type="text" id="inp-login" placeholder="Логин" autocomplete="username" />
                <input type="password" id="inp-pass" placeholder="Пароль" autocomplete="current-password" />
                <div class="auth-error" id="auth-error"></div>
                <button class="btn btn-primary btn-full" id="btn-login">Войти</button>
            </div>
        </div>`;

        const doLogin = async () => {
            const login    = document.getElementById('inp-login').value.trim();
            const password = document.getElementById('inp-pass').value;
            const err      = document.getElementById('auth-error');
            const btn      = document.getElementById('btn-login');
            if (!login || !password) { err.textContent = 'Введите логин и пароль'; return; }
            btn.disabled = true; btn.textContent = 'Подключаемся...'; err.textContent = '';
            try {
                const data = await API.post('/api/login', { login, password });
                API.setToken(data.token);
                const s = await API.get('/api/status');
                app.state = { server: s.server, compile: s.compile };
                app._showApp();
            } catch (e) {
                err.textContent = e.message;
                btn.disabled = false; btn.textContent = 'Войти';
            }
        };

        document.getElementById('btn-login').addEventListener('click', doLogin);
        document.getElementById('inp-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
        document.getElementById('inp-login').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('inp-pass').focus(); });
    },
});
