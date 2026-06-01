app.register('settings', {
    _defaults: {
        notify_compile:        true,
        notify_code_access:    true,
        browser_notifications: false,
    },

    _load() {
        try { return { ...this._defaults, ...JSON.parse(localStorage.getItem('settings') || '{}') }; } catch { return { ...this._defaults }; }
    },
    _save(s) { try { localStorage.setItem('settings', JSON.stringify(s)); } catch {} },

    render(root) {
        const s = this._load();
        root.innerHTML = `
        <div class="card">
            <div class="card-header"><span class="card-title">Уведомления</span></div>
            <div class="stat-rows">
                ${this._row('notify_compile',        'Уведомление о завершении компиляции',    s.notify_compile)}
                ${this._row('notify_code_access',    'Уведомление об одобрении запроса кода',  s.notify_code_access)}
                ${this._row('browser_notifications', 'Браузерные push-уведомления',            s.browser_notifications)}
            </div>
            <div id="notif-hint" style="margin-top:12px;font-size:12px;color:var(--text-2)"></div>
        </div>

        <div class="card" id="totp-card">
            <div class="card-header">
                <span class="card-title">🔐 Двухфакторная аутентификация</span>
            </div>
            <div id="totp-body" style="padding:4px 0">
                <div style="color:var(--text-3);font-size:13px">Загрузка...</div>
            </div>
        </div>

        <div class="card">
            <div class="card-header"><span class="card-title">Данные</span></div>
            <div class="btn-row">
                <button class="btn btn-ghost btn-sm" id="btn-clear-console">🗑 Очистить консоль</button>
                <button class="btn btn-ghost btn-sm" id="btn-clear-history">🗑 Очистить историю компиляций</button>
            </div>
        </div>`;

        root.querySelectorAll('input[type=checkbox]').forEach(cb => {
            cb.addEventListener('change', () => {
                const cur = this._load();
                cur[cb.dataset.key] = cb.checked;
                this._save(cur);
                if (cb.dataset.key === 'browser_notifications' && cb.checked) this._requestNotifPerm(root);
                app.toast('Настройки сохранены', 'info');
            });
        });

        document.getElementById('btn-clear-console').addEventListener('click', () => {
            localStorage.removeItem('console_lines');
            app.toast('Консоль очищена', 'info');
        });
        document.getElementById('btn-clear-history').addEventListener('click', () => {
            localStorage.removeItem('compile_history');
            localStorage.removeItem('compile_last');
            app.toast('История компиляций очищена', 'info');
        });

        this._loadTotpStatus(root);
    },

    // ── TOTP ──────────────────────────────────────────────────────

    async _loadTotpStatus(root) {
        const body = document.getElementById('totp-body');
        if (!body) return;
        try {
            const res = await API.get('/api/totp/status');
            this._renderTotpSection(body, res.enabled, res.has_secret);
        } catch (e) {
            body.innerHTML = `<div style="color:var(--red);font-size:13px">${e.message}</div>`;
        }
    },

    _renderTotpSection(body, enabled, hasSecret) {
        if (enabled) {
            body.innerHTML = `
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
                <span style="font-size:13px;color:var(--green);font-weight:500">✅ Включена</span>
                <span style="font-size:12px;color:var(--text-3)">Google Authenticator активен</span>
            </div>
            <div style="font-size:13px;color:var(--text-2);margin-bottom:14px;line-height:1.6">
                При каждом входе будет запрашиваться 6-значный код из приложения.
            </div>
            <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
                <div style="display:flex;flex-direction:column;gap:6px">
                    <label style="font-size:12px;color:var(--text-3)">Код для подтверждения отключения</label>
                    <input id="totp-dis-code" type="text" placeholder="6 цифр" maxlength="6" inputmode="numeric"
                        style="width:140px;letter-spacing:0.2em;font-family:var(--mono);text-align:center;font-size:16px" />
                </div>
                <button class="btn btn-danger btn-sm" id="totp-disable-btn">Отключить 2FA</button>
            </div>
            <div id="totp-err" style="margin-top:8px;font-size:12px;color:var(--red)"></div>`;

            document.getElementById('totp-disable-btn').addEventListener('click', async () => {
                const code = document.getElementById('totp-dis-code').value.trim();
                const errEl = document.getElementById('totp-err');
                if (code.length !== 6) { errEl.textContent = 'Введите 6-значный код'; return; }
                try {
                    await API.post('/api/totp/disable', { code });
                    app.toast('2FA отключена', 'info');
                    this._renderTotpSection(body, false, false);
                } catch (e) {
                    errEl.textContent = e.message;
                }
            });
            document.getElementById('totp-dis-code').addEventListener('keydown', e => {
                if (e.key === 'Enter') document.getElementById('totp-disable-btn').click();
            });

        } else {
            body.innerHTML = `
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
                <span style="font-size:13px;color:var(--text-3);font-weight:500">⬜ Отключена</span>
            </div>
            <div style="font-size:13px;color:var(--text-2);margin-bottom:16px;line-height:1.6">
                Двухфакторная аутентификация добавляет второй уровень защиты.<br>
                После включения при каждом входе нужно будет вводить код из Google Authenticator.
            </div>
            <button class="btn btn-primary btn-sm" id="totp-setup-btn">Настроить Google Authenticator</button>
            <div id="totp-setup-area" style="margin-top:16px"></div>`;

            document.getElementById('totp-setup-btn').addEventListener('click', () => this._startSetup(body));
        }
    },

    async _startSetup(body) {
        const btn = document.getElementById('totp-setup-btn');
        btn.disabled = true; btn.textContent = 'Генерация...';
        const area = document.getElementById('totp-setup-area');
        area.innerHTML = '';
        try {
            const res = await API.post('/api/totp/setup');
            btn.style.display = 'none';
            area.innerHTML = `
            <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">
                <div>
                    <div style="font-size:12px;color:var(--text-3);margin-bottom:8px">1. Отсканируйте QR-код в Google Authenticator</div>
                    <img src="${res.qr}" style="width:180px;height:180px;border-radius:var(--radius-sm);display:block" />
                    <details style="margin-top:8px">
                        <summary style="font-size:11px;color:var(--text-3);cursor:pointer">Ввести вручную</summary>
                        <div style="font-family:var(--mono);font-size:12px;color:var(--text-2);margin-top:6px;word-break:break-all;background:var(--surface2);padding:8px;border-radius:var(--radius-xs)">${res.secret}</div>
                    </details>
                </div>
                <div style="display:flex;flex-direction:column;gap:10px;min-width:200px">
                    <div style="font-size:12px;color:var(--text-3)">2. Введите код из приложения для подтверждения</div>
                    <input id="totp-confirm-code" type="text" placeholder="6 цифр" maxlength="6" inputmode="numeric"
                        style="width:140px;letter-spacing:0.25em;font-family:var(--mono);text-align:center;font-size:20px" autofocus />
                    <button class="btn btn-primary btn-sm" id="totp-enable-btn" style="width:fit-content">✓ Включить 2FA</button>
                    <div id="totp-err" style="font-size:12px;color:var(--red)"></div>
                </div>
            </div>`;

            const enableBtn = document.getElementById('totp-enable-btn');
            const codeInput = document.getElementById('totp-confirm-code');
            codeInput.focus();

            const doEnable = async () => {
                const code = codeInput.value.trim();
                const errEl = document.getElementById('totp-err');
                if (code.length !== 6) { errEl.textContent = 'Введите 6-значный код'; return; }
                enableBtn.disabled = true; enableBtn.textContent = 'Проверка...';
                try {
                    await API.post('/api/totp/enable', { code });
                    app.toast('✅ 2FA включена!', 'success');
                    this._renderTotpSection(body, true, true);
                } catch (e) {
                    errEl.textContent = e.message;
                    enableBtn.disabled = false; enableBtn.textContent = '✓ Включить 2FA';
                }
            };

            enableBtn.addEventListener('click', doEnable);
            codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') doEnable(); });
            codeInput.addEventListener('input', e => {
                if (e.target.value.replace(/\D/g, '').length === 6) doEnable();
            });

        } catch (e) {
            area.innerHTML = `<div style="color:var(--red);font-size:13px">${e.message}</div>`;
            btn.disabled = false; btn.textContent = 'Настроить Google Authenticator';
        }
    },

    _row(key, label, checked) {
        return `<div class="stat-row">
            <span class="stat-label">${label}</span>
            <label style="cursor:pointer">
                <input type="checkbox" data-key="${key}" ${checked ? 'checked' : ''} />
            </label>
        </div>`;
    },

    async _requestNotifPerm(root) {
        if (Notification.permission === 'denied') {
            const h = document.getElementById('notif-hint');
            if (h) h.textContent = 'Браузер запретил уведомления. Разрешите их в настройках браузера.';
            return;
        }
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') {
            const h = document.getElementById('notif-hint');
            if (h) h.textContent = 'Разрешение не получено.';
        }
    },
});
