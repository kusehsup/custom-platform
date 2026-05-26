app.register('settings', {
    _defaults: {
        notify_compile:       true,
        notify_code_access:   true,
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
                ${this._row('notify_compile',       'Уведомление о завершении компиляции', s.notify_compile)}
                ${this._row('notify_code_access',   'Уведомление об одобрении запроса кода', s.notify_code_access)}
                ${this._row('browser_notifications','Браузерные push-уведомления', s.browser_notifications)}
            </div>
            <div id="notif-hint" style="margin-top:12px;font-size:12px;color:var(--text-2)"></div>
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
