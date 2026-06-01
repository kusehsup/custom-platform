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
                <div id="totp-wrap" style="display:none">
                    <input type="text" id="inp-totp" placeholder="000000"
                        autocomplete="one-time-code" inputmode="numeric" maxlength="6"
                        class="totp-input" />
                </div>
                <div class="auth-error" id="auth-error"></div>
                <button class="btn btn-primary btn-full" id="btn-login">Войти</button>
            </div>
        </div>`;

        const doLogin = async () => {
            const login    = document.getElementById('inp-login').value.trim();
            const password = document.getElementById('inp-pass').value;
            const totpCode = document.getElementById('inp-totp').value.trim();
            const err      = document.getElementById('auth-error');
            const btn      = document.getElementById('btn-login');
            if (!login || !password) { err.textContent = 'Введите логин и пароль'; return; }
            btn.disabled = true; btn.textContent = 'Подключаемся...'; err.textContent = '';
            try {
                const data = await API.post('/api/login', { login, password, totp_code: totpCode });
                API.setToken(data.token);
                const s = await API.get('/api/status');
                app.state = { server: s.server, compile: s.compile };
                app._showApp();
            } catch (e) {
                if (e.message === 'TOTP_REQUIRED') {
                    // Показываем поле кода и ждём ввода
                    const wrap = document.getElementById('totp-wrap');
                    wrap.style.display = 'block';
                    document.getElementById('inp-totp').focus();
                    err.textContent = 'Введите код из Google Authenticator';
                    btn.disabled = false; btn.textContent = 'Войти';
                } else {
                    err.textContent = e.message;
                    btn.disabled = false; btn.textContent = 'Войти';
                }
            }
        };

        document.getElementById('btn-login').addEventListener('click', doLogin);
        document.getElementById('inp-pass').addEventListener('keydown',  e => { if (e.key === 'Enter') doLogin(); });
        document.getElementById('inp-totp').addEventListener('keydown',  e => { if (e.key === 'Enter') doLogin(); });
        document.getElementById('inp-login').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('inp-pass').focus(); });
        // Автосабмит при вводе 6 цифр
        document.getElementById('inp-totp').addEventListener('input', e => {
            if (e.target.value.replace(/\D/g, '').length === 6) doLogin();
        });
    },
});
