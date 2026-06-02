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
            <div>
                ${this._row('notify_compile',        '🔨', 'Компиляция',          'Уведомление при завершении компиляции',     s.notify_compile)}
                ${this._row('notify_code_access',    '✅', 'Доступ к коду',       'Уведомление при одобрении запроса кода',    s.notify_code_access)}
                ${this._row('browser_notifications', '🔔', 'Push-уведомления',    'Браузерные уведомления через Notification API', s.browser_notifications)}
            </div>
            <div id="notif-hint" style="margin-top:10px;font-size:12px;color:var(--text-3)"></div>
        </div>

        <div class="card" id="totp-card">
            <div class="card-header">
                <span class="card-title">Безопасность</span>
            </div>
            <div id="totp-body" style="padding:2px 0">
                <div style="color:var(--text-3);font-size:13px">Загрузка...</div>
            </div>
        </div>

        <div class="card">
            <div class="card-header"><span class="card-title">Данные</span></div>
            <div>
                ${this._actionRow('🗑', 'Очистить консоль', 'Удалить все сохранённые строки из консоли', 'btn-clear-console', 'Очистить')}
                ${this._actionRow('📋', 'История компиляций', 'Удалить журнал результатов компиляций', 'btn-clear-history', 'Очистить')}
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

    _row(key, icon, title, desc, checked) {
        return `<div class="settings-row">
            <div class="settings-row-icon">${icon}</div>
            <div class="settings-row-body">
                <div class="settings-row-title">${title}</div>
                <div class="settings-row-desc">${desc}</div>
            </div>
            <div class="settings-row-action">
                <label class="toggle">
                    <input type="checkbox" data-key="${key}" ${checked ? 'checked' : ''} />
                    <span class="toggle-track"></span>
                </label>
            </div>
        </div>`;
    },

    _actionRow(icon, title, desc, btnId, btnLabel) {
        return `<div class="settings-row">
            <div class="settings-row-icon">${icon}</div>
            <div class="settings-row-body">
                <div class="settings-row-title">${title}</div>
                <div class="settings-row-desc">${desc}</div>
            </div>
            <div class="settings-row-action">
                <button class="btn btn-ghost btn-sm" id="${btnId}">${btnLabel}</button>
            </div>
        </div>`;
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
            <div class="settings-row">
                <div class="settings-row-icon">🔐</div>
                <div class="settings-row-body">
                    <div class="settings-row-title">Google Authenticator</div>
                    <div class="settings-row-desc" style="color:var(--green)">Двухфакторная аутентификация включена</div>
                </div>
                <div class="settings-row-action">
                    <span style="font-size:11px;color:var(--green);font-weight:600;background:var(--green-dim);border:1px solid rgba(52,211,153,0.2);padding:3px 10px;border-radius:99px">Активна</span>
                </div>
            </div>
            <div style="padding:14px 0 4px;border-top:1px solid var(--border);margin-top:4px">
                <div style="font-size:12px;color:var(--text-3);margin-bottom:10px">Для отключения введите код из приложения:</div>
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                    <input id="totp-dis-code" type="text" placeholder="000 000" maxlength="6" inputmode="numeric"
                        style="width:140px;letter-spacing:0.25em;font-family:var(--mono);text-align:center;font-size:18px" />
                    <button class="btn btn-danger btn-sm" id="totp-disable-btn">Отключить 2FA</button>
                </div>
                <div id="totp-err" style="margin-top:8px;font-size:12px;color:var(--red)"></div>
            </div>`;

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
            <div class="settings-row">
                <div class="settings-row-icon">🔐</div>
                <div class="settings-row-body">
                    <div class="settings-row-title">Google Authenticator</div>
                    <div class="settings-row-desc">Добавляет второй уровень защиты при входе</div>
                </div>
                <div class="settings-row-action">
                    <span style="font-size:11px;color:var(--text-3);font-weight:500;background:var(--surface2);border:1px solid var(--border);padding:3px 10px;border-radius:99px">Не активна</span>
                </div>
            </div>
            <div style="padding:14px 0 4px;border-top:1px solid var(--border);margin-top:4px">
                <div style="font-size:12px;color:var(--text-3);margin-bottom:12px">После включения при каждом входе нужно будет вводить 6-значный код из Google Authenticator.</div>
                <button class="btn btn-primary btn-sm" id="totp-setup-btn">Настроить 2FA</button>
            </div>
            <div id="totp-setup-area" style="margin-top:0"></div>`;

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
            <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border);display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">
                <div>
                    <div style="font-size:12px;color:var(--text-3);margin-bottom:8px">1. Отсканируйте QR-код в Google Authenticator</div>
                    <img src="${res.qr}" style="width:172px;height:172px;border-radius:var(--radius-sm);display:block;border:1px solid var(--border)" />
                    <details style="margin-top:8px">
                        <summary style="font-size:11px;color:var(--text-3);cursor:pointer;user-select:none">Ввести ключ вручную</summary>
                        <div style="font-family:var(--mono);font-size:11px;color:var(--text-2);margin-top:6px;word-break:break-all;background:var(--surface2);padding:8px 10px;border-radius:var(--radius-xs);border:1px solid var(--border)">${res.secret}</div>
                    </details>
                </div>
                <div style="display:flex;flex-direction:column;gap:10px;min-width:200px">
                    <div style="font-size:12px;color:var(--text-3)">2. Введите код из приложения для подтверждения</div>
                    <input id="totp-confirm-code" type="text" placeholder="000000" maxlength="6" inputmode="numeric"
                        style="width:140px;letter-spacing:0.25em;font-family:var(--mono);text-align:center;font-size:20px" autofocus />
                    <button class="btn btn-primary btn-sm" id="totp-enable-btn" style="width:fit-content">Включить 2FA</button>
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
                    app.toast('2FA включена', 'success');
                    this._renderTotpSection(body, true, true);
                } catch (e) {
                    errEl.textContent = e.message;
                    enableBtn.disabled = false; enableBtn.textContent = 'Включить 2FA';
                }
            };

            enableBtn.addEventListener('click', doEnable);
            codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') doEnable(); });
            codeInput.addEventListener('input', e => {
                if (e.target.value.replace(/\D/g, '').length === 6) doEnable();
            });

        } catch (e) {
            area.innerHTML = `<div style="color:var(--red);font-size:13px">${e.message}</div>`;
            btn.disabled = false; btn.textContent = 'Настроить 2FA';
        }
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
