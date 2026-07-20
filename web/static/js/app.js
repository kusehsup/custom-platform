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
        const prev = this._current;
        this._current = name;
        document.querySelectorAll('.sidebar a').forEach(a =>
            a.classList.toggle('active', a.dataset.page === name)
        );
        const main = document.getElementById('main');
        if (!main) return;
        main.classList.remove('main--fullscreen');
        main.innerHTML = '';
        const page = this._pages[name];

        // Защита: если render() кинет — main останется пустым. Ловим и
        // показываем понятную плашку с возможностью вернуться на сервер.
        if (page) {
            try {
                const r = page.render(main);
                if (r && typeof r.catch === 'function') {
                    r.catch((e) => this._renderPageError(main, name, e));
                }
            } catch (e) {
                this._renderPageError(main, name, e);
            }
        } else {
            this._renderPageError(main, name, new Error('Страница не зарегистрирована'));
        }

        this._updateTopbarActions();
        // Auto-workspace: запоминаем текущую вкладку и пытаемся
        // восстановить её прежнее содержимое (открытый файл/часть/курсор,
        // активную заметку и т.п.).
        if (typeof Session !== 'undefined') {
            if (!Session.isSuspended()) Session.setPage(name);
            // Restore — после микро-таймаута, чтобы page.render успел
            // навесить начальные DOM-узлы.
            setTimeout(() => Session.restorePageContents(name), 0);
        }
    },

    _renderPageError(main, name, err) {
        if (!main) return;
        const msg = (err && err.message) || String(err || 'Неизвестная ошибка');
        main.innerHTML = `
        <div style="max-width:520px;margin:80px auto;padding:24px;text-align:center;color:var(--text)">
            <div style="font-size:28px;margin-bottom:8px">⚠️</div>
            <div style="font-size:16px;font-weight:600;margin-bottom:6px">Не удалось открыть вкладку</div>
            <div style="font-size:13px;color:var(--text-3);margin-bottom:4px;font-family:var(--mono)">${name}</div>
            <div style="font-size:12px;color:var(--text-2);margin-bottom:20px">${msg}</div>
            <button class="btn btn-primary btn-sm" id="page-err-server">↩ Открыть «Сервер»</button>
        </div>`;
        const btn = document.getElementById('page-err-server');
        if (btn) btn.addEventListener('click', () => {
            this._current = null;
            this.navigate('server');
        });
        console.error('[navigate] page render failed:', name, err);
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
            // Стартуем тикер если ещё не запущен; начало компиляции — _compileStartTs
            if (!this._compileStartTs) this._compileStartTs = Date.now();
            cWrap.innerHTML = `<button class="btn btn-ghost btn-sm" disabled style="opacity:.7">
                <span class="compile-spinner"></span>Компиляция <span id="tb-compile-timer">0.0с</span>
            </button>`;
            this._startCompileTimer();
        } else if (this._lastCompileResult) {
            this._stopCompileTimer();
            const hasErr = /error/i.test(this._lastCompileResult);
            const dur = this._lastCompileDuration;
            const durLabel = dur != null
                ? (dur < 60 ? `${dur.toFixed(1)}с` : `${Math.floor(dur/60)}м ${Math.floor(dur%60)}с`)
                : '';
            cWrap.innerHTML = `
            <div style="display:flex;gap:0;border:1px solid var(--border-2);border-radius:var(--radius);overflow:hidden">
                <button class="btn btn-ghost btn-sm" id="tb-compile-btn" style="border-radius:0;border:none;border-right:1px solid var(--border-2)">Сборка</button>
                <button class="btn btn-ghost btn-sm" id="tb-compile-result" style="border-radius:0;border:none;color:${hasErr ? 'var(--red)' : 'var(--green)'}">● ${hasErr ? 'Ошибки' : 'OK'}${durLabel ? ` <span style="color:var(--text-3);font-weight:normal;margin-left:4px">${durLabel}</span>` : ''}</button>
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
            this._compileStartTs = Date.now();
            this._updateTopbarActions();
            this._pages['server']?.onState?.();
            app.toast('🔨 Компиляция запущена', 'info');
        } catch (e) { app.toast('Ошибка: ' + e.message, 'error'); }
    },

    _startCompileTimer() {
        if (this._compileTimerId) return;
        // Если timestamp не известен (например, компиляция началась до рефреша
        // страницы), стартуем с текущего момента — лучше показать "0.0с" чем
        // ничего.
        if (!this._compileStartTs) this._compileStartTs = Date.now();
        const tick = () => {
            if (!this.state.compile) { this._stopCompileTimer(); return; }
            const el = document.getElementById('tb-compile-timer');
            if (el && this._compileStartTs) {
                const sec = (Date.now() - this._compileStartTs) / 1000;
                el.textContent = sec < 10
                    ? sec.toFixed(1) + 'с'
                    : Math.floor(sec) + 'с';
            }
        };
        tick();
        this._compileTimerId = setInterval(tick, 100);
    },

    _stopCompileTimer() {
        if (this._compileTimerId) {
            clearInterval(this._compileTimerId);
            this._compileTimerId = null;
        }
        this._compileStartTs = null;
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
    // Храним УЖЕ разбитые на строки данные. Чанки от платформы режутся
    // в pushConsoleLog по '\n'; незавершённый хвост держим в _consoleTail.
    // Лимит на хранение убран — копится всё до ручной очистки.
    _consoleLines: [],
    _consoleTail: '',
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
        // Платформа шлёт чанки — в одном могут быть несколько строк
        // или половина строки. Аккуратно режем по '\n', хвост держим
        // в _consoleTail до прихода следующего чанка.
        if (typeof data !== 'string') return;
        const combined = this._consoleTail + data;
        const parts = combined.split('\n');
        this._consoleTail = parts.pop() || '';
        if (parts.length) {
            this._consoleLines.push(...parts);
        }
        if (!this._consolePaused) this._scheduleConsoleRender();
    },

    // Throttle перерисовки: при потоке логов 50-100/сек не рендерим каждое.
    _scheduleConsoleRender() {
        if (this._consoleRenderQueued) return;
        this._consoleRenderQueued = true;
        requestAnimationFrame(() => {
            this._consoleRenderQueued = false;
            this._renderConsoleWidget();
        });
    },

    _renderConsoleWidget() {
        const el = document.getElementById('con-body');
        if (!el) return;
        const filter = this._consoleFilter;
        let lines = this._consoleLines;
        // Хвост (незавершённая строка) тоже показываем
        if (this._consoleTail) lines = [...lines, this._consoleTail];
        const filtered = filter ? lines.filter(l => l.toLowerCase().includes(filter)) : lines;
        el.innerHTML = filtered.map(line => this._colorizeConsoleLine(line)).join('<br>');
        el.scrollTop = el.scrollHeight;
        // Обновляем счётчик в шапке виджета
        const counter = document.getElementById('con-count');
        if (counter) counter.textContent = `${filtered.length.toLocaleString('ru-RU')} строк`;
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
    // Защита от петли переподключения: пропускаем повторный connectWS
    // если сокет уже открыт или мы только что попытались подключиться.
    // Раньше при быстром двойном вызове (setTimeout из onclose + другой
    // источник) старый сокет закрывался кодом 1005, тут же открывался
    // новый, тоже закрывался — так по кругу пока не Ctrl+F5.
    connectWS() {
        // Если сокет уже установлен и живой — не трогаем.
        if (this._ws && (this._ws.readyState === WebSocket.OPEN
                      || this._ws.readyState === WebSocket.CONNECTING)) {
            return;
        }
        // Rate-limit: не даём вызывать чаще раза в секунду.
        const now = Date.now();
        if (this._lastConnectAt && (now - this._lastConnectAt) < 1000) return;
        this._lastConnectAt = now;

        // Гарантированно закрываем предыдущий сокет с явным кодом (1000),
        // чтобы отличать намеренное закрытие от «code=1005 no status».
        if (this._ws) {
            try {
                this._ws.onclose = null;
                this._ws.onerror = null;
                this._ws.onmessage = null;
                this._ws.close(1000, 'reconnect');
            } catch {}
        }
        if (this._pingInterval) clearInterval(this._pingInterval);
        if (this._reconnectTimer) clearTimeout(this._reconnectTimer);

        this._logWS('Подключение к WS...', 'info');
        const ws = API.connectWS(msg => this._onWS(msg));
        this._ws = ws;

        ws.onopen = () => {
            if (this._ws !== ws) return; // устаревший сокет
            this._setWsStatus(true);
            this._logWS('WS подключён', 'success');
            this._pingInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send('ping');
                }
            }, 20000);
        };

        ws.onclose = (e) => {
            if (this._ws !== ws) return; // старый сокет — не реагируем
            this._setWsStatus(false);
            this._logWS(`WS закрыт (code=${e.code}, reason=${e.reason || '—'})`, 'error');
            clearInterval(this._pingInterval);
            // Пере-подключаемся только если есть токен и мы не в процессе logout'а.
            this._reconnectTimer = setTimeout(() => {
                if (API.hasToken()) this.connectWS();
            }, 3000);
        };

        ws.onerror = () => {
            if (this._ws !== ws) return;
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
            const compileStarted = !this.state.compile && msg.compile;
            const compileEnded   = this.state.compile && !msg.compile;
            this.state.server  = msg.server;
            this.state.compile = msg.compile;
            this._logWS(`  server=${msg.server} compile=${msg.compile}`, 'info');
            if (compileStarted) {
                if (!this._compileStartTs) this._compileStartTs = Date.now();
                this._startCompileTimer();
            } else if (compileEnded) {
                this._stopCompileTimer();
            }
            this._pages['server']?.onState?.();
            this._pages['files']?.onFilesUpdate?.();
            this._updateTopbarActions();
        } else if (msg.type === 'log') {
            this._pages['server']?.onLog?.(msg.data);
            this.pushConsoleLog(msg.data);
        } else if (msg.type === 'compile_result') {
            // Запоминаем длительность последней компиляции до сброса стартового ts
            if (this._compileStartTs) {
                this._lastCompileDuration = (Date.now() - this._compileStartTs) / 1000;
            }
            this.state.compile = false;
            this._stopCompileTimer();
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
        } else if (msg.type === 'code_updated') {
            // Платформа прислала обновлённые доступы / содержимое.
            // Уведомляем страницу файлов чтобы она показала баннер /
            // пометила вкладки stale / закрыла отозванные.
            this._pages['files']?.onCodeUpdated?.({
                lost:    msg.lost    || [],
                changed: msg.changed || [],
                added:   msg.added   || [],
            });
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
        // Регистрируем Service Worker — нужен чтобы браузер предлагал
        // "Установить как приложение". Кэширования агрессивного нет,
        // ошибки регистрации игнорируем (на http не запустится — это норма).
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker
                .register('/service-worker.js', { scope: '/' })
                .catch(() => {});
        }

        // PWA install prompt — кнопка "Установить" в топбаре
        // (показывается только когда браузер реально предложит установку)
        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            this._installPrompt = e;
            const btn = document.getElementById('btn-install');
            if (btn) btn.classList.remove('hidden');
        });
        window.addEventListener('appinstalled', () => {
            this._installPrompt = null;
            document.getElementById('btn-install')?.classList.add('hidden');
            this.toast('Установлено как приложение', 'success');
        });

        // Показываем лоадер только когда есть токен — тогда предстоит
        // реальная работа (fetch /status, showApp, connectWS).
        // Форма логина показывается без лоадера.
        if (API.hasToken()) Loader.show('Подключение…');

        try {
            const info = await API.get('/api/info');
            this.platformHost = info.platform_host || '';
            this.ideUrl = info.ide_url || '/ide/';
        } catch { this.platformHost = ''; this.ideUrl = '/ide/'; }

        if (!API.hasToken()) { Loader.hide(); this._showAuth(); return; }
        try {
            const s = await API.get('/api/status');
            if (s.session_lost) {
                // JWT валидный но сессия потеряна (рестарт) — показываем переподключение
                Loader.hide();
                this._showReconnect();
                return;
            }
            this.state = { server: s.server, compile: s.compile };
            this._showApp();
            Loader.hide();
        } catch {
            Loader.hide();
            this._showAuth();
        }
    },

    _showReconnect() {
        document.body.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.className = 'auth-wrap';
        wrap.innerHTML = `
        <div class="auth-box">
            <div class="auth-logo">
                <h1>CustomPlatform</h1>
                <p>Нужно подтвердить сессию.<br>Введи пароль для продолжения.</p>
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
            Loader.show('Подключение…');
            try {
                const data = await API.post('/api/login', { login, password, totp_code: totpCode });
                API.setToken(data.token);
                const s = await API.get('/api/status');
                this.state = { server: s.server, compile: s.compile };
                this._showApp();
                Loader.hide();
            } catch (e) {
                Loader.hide();
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
            extcmd:   `<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M4 6l2.2 2L4 10M8 10h4"/></svg>`,
            notes:    `<svg viewBox="0 0 16 16"><path d="M3 2h7l3 3v9a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z"/><path d="M10 2v3h3"/><path d="M5 8h6M5 11h4"/></svg>`,
            ide:      `<svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M6 6L4 8l2 2M10 6l2 2-2 2"/></svg>`,
            more:     `<svg viewBox="0 0 16 16"><circle cx="3.5" cy="8" r="1.4" fill="currentColor" stroke="none"/><circle cx="8"   cy="8" r="1.4" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r="1.4" fill="currentColor" stroke="none"/></svg>`,
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
                    <button class="topbar-btn hidden" id="btn-install" title="Установить как приложение">⬇ Установить</button>
                    <button class="topbar-btn" id="btn-db" title="БД (быстрый запрос)">${ico.db} БД</button>
                    <button class="topbar-btn" id="btn-console" title="Консоль">${ico.console} Консоль</button>
                    <button class="topbar-btn" id="btn-debug" title="WS лог">${ico.ws} WS</button>
                    <button class="topbar-btn" id="btn-theme" title="Тема">${ico.theme}</button>
                    <span id="ws-status" class="ws-status ws-offline" title="Подключение..." style="margin:0 4px"></span>
                    <button class="topbar-btn" id="btn-logout" title="Выйти">${ico.logout} Выйти</button>
                </div>
            </header>
            <nav class="sidebar">
                <span class="sidebar-section">Управление</span>
                <a data-page="server" class="nav-primary">${ico.server}<span class="label">Сервер</span></a>
                <span class="sidebar-section">Код</span>
                <a data-page="files" class="nav-primary">${ico.files}<span class="label">Файлы</span></a>
                <a data-page="ide" class="nav-primary">${ico.ide}<span class="label">IDE</span></a>
                <span class="sidebar-section">Инструменты</span>
                <a data-page="todo">${ico.todo}<span class="label">TODO</span><span id="todo-badge" class="sidebar-badge hidden"></span></a>
                <a data-page="db" class="nav-primary">${ico.db}<span class="label">База данных</span></a>
                <a data-page="extcmd" class="nav-primary">${ico.extcmd}<span class="label">Внешние команды</span></a>
                <a data-page="notes">${ico.notes}<span class="label">Заметки</span></a>
                <div class="sidebar-spacer"></div>
                <div class="sidebar-footer">
                    <a data-page="settings">${ico.settings}<span class="label">Настройки</span></a>
                </div>
                <!-- Только для мобильной bottom-nav: 5-я кнопка «Ещё» -->
                <a class="nav-more nav-primary" id="nav-more">${ico.more}<span class="label">Ещё</span></a>
            </nav>
            <main class="main" id="main"></main>
        </div>
        <div id="toast-wrap" class="toast-wrap"></div>`;

        document.querySelectorAll('.sidebar a').forEach(a =>
            a.addEventListener('click', () => {
                if (a.id === 'nav-more') { this._showMobileMore(); return; }
                this.navigate(a.dataset.page);
            })
        );

        document.getElementById('btn-debug').addEventListener('click', () => this.toggleDebug());
        document.getElementById('btn-console').addEventListener('click', () => this.toggleConsole());
        document.getElementById('btn-db').addEventListener('click', () => DbWidget.toggle());
        document.getElementById('btn-theme').addEventListener('click', () => this.toggleTheme());

        // PWA install
        document.getElementById('btn-install')?.addEventListener('click', async () => {
            if (!this._installPrompt) return;
            try {
                this._installPrompt.prompt();
                await this._installPrompt.userChoice;
            } catch {}
            this._installPrompt = null;
            document.getElementById('btn-install')?.classList.add('hidden');
        });
        // Если событие пришло до того как топбар был отрисован — показываем сразу
        if (this._installPrompt) {
            document.getElementById('btn-install')?.classList.remove('hidden');
        }

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
            if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
            if (this._ws) {
                try { this._ws.onclose = null; this._ws.close(1000, 'logout'); } catch {}
                this._ws = null;
            }
            this._showAuth();
        });

        this._applyTheme(localStorage.getItem('theme') || 'dark');
        this.connectWS();
        // Восстанавливаем последнюю активную вкладку и место в редакторе.
        // Session.restore() сам решает что делать — если ничего не сохранено,
        // открывает 'server' (через navigate в restore).
        if (typeof Session !== 'undefined') {
            const last = Session.getPage();
            if (last && last !== 'server') {
                Session.restore();
            } else {
                this.navigate('server');
            }
        } else {
            this.navigate('server');
        }
        this._registerCommands();
        this._bgScanTodo();
    },

    _showMobileMore() {
        // Bottom-sheet с непервичными пунктами навигации и виджетами.
        const existing = document.getElementById('mobile-more-sheet');
        if (existing) { existing.remove(); return; }

        const navItems = [
            {page: 'todo',     icon: '✅', label: 'TODO'},
            {page: 'notes',    icon: '📝', label: 'Заметки'},
            {page: 'settings', icon: '⚙', label: 'Настройки'},
        ];
        const widgetItems = [
            {action: 'db',      icon: '🗄', label: 'БД виджет'},
            {action: 'console', icon: '📋', label: 'Консоль'},
            {action: 'theme',   icon: '◐', label: 'Тема'},
            {action: 'logout',  icon: '⎋', label: 'Выйти'},
        ];

        const sheet = document.createElement('div');
        sheet.id = 'mobile-more-sheet';
        sheet.className = 'mobile-sheet';
        sheet.innerHTML = `
            <div class="mobile-sheet-backdrop"></div>
            <div class="mobile-sheet-panel">
                <div class="mobile-sheet-grab"></div>
                <div class="mobile-sheet-title">Навигация</div>
                <div class="mobile-sheet-grid">
                    ${navItems.map((n) => `
                        <button class="mobile-sheet-item" data-nav="${n.page}">
                            <span class="mobile-sheet-icon">${n.icon}</span>
                            <span>${n.label}</span>
                        </button>`).join('')}
                </div>
                <div class="mobile-sheet-title">Инструменты</div>
                <div class="mobile-sheet-grid">
                    ${widgetItems.map((w) => `
                        <button class="mobile-sheet-item" data-action="${w.action}">
                            <span class="mobile-sheet-icon">${w.icon}</span>
                            <span>${w.label}</span>
                        </button>`).join('')}
                </div>
            </div>`;
        document.body.appendChild(sheet);

        const close = () => sheet.remove();
        sheet.querySelector('.mobile-sheet-backdrop').addEventListener('click', close);
        sheet.querySelectorAll('[data-nav]').forEach((b) =>
            b.addEventListener('click', () => { this.navigate(b.dataset.nav); close(); }),
        );
        sheet.querySelectorAll('[data-action]').forEach((b) =>
            b.addEventListener('click', () => {
                const a = b.dataset.action;
                if (a === 'db') DbWidget.toggle();
                else if (a === 'console') this.toggleConsole();
                else if (a === 'theme')   this.toggleTheme();
                else if (a === 'logout')  document.getElementById('btn-logout')?.click();
                close();
            }),
        );
        // ESC закрытие
        const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
        document.addEventListener('keydown', onKey);
    },

    _registerCommands() {
        if (!window.Palette || Palette._commands.length) return;
        const P = Palette;
        P.register({ id: 'nav.server',   title: 'Перейти: Сервер',     icon: '🖥', group: 'Навигация', run: () => this.navigate('server') });
        P.register({ id: 'nav.files',    title: 'Перейти: Файлы',      icon: '📁', group: 'Навигация', run: () => this.navigate('files') });
        P.register({ id: 'nav.ide',      title: 'Перейти: IDE',        icon: '🧩', group: 'Навигация', run: () => this.navigate('ide') });
        P.register({ id: 'nav.settings', title: 'Перейти: Настройки',  icon: '⚙️', group: 'Навигация', run: () => this.navigate('settings') });
        P.register({ id: 'srv.start',    title: 'Сервер: Запустить',   icon: '▶',  group: 'Сервер', hint: 'Ctrl+Shift+S', when: () => this.state.server !== 'on', run: async () => { await API.post('/api/server/start'); this.state.server='on'; this._updateTopbarActions(); this._pages['server']?.onState?.(); app.toast('Сервер запущен', 'success'); } });
        P.register({ id: 'srv.stop',     title: 'Сервер: Остановить',  icon: '⏹', group: 'Сервер', when: () => this.state.server === 'on', run: async () => { await API.post('/api/server/stop'); this.state.server='off'; this._updateTopbarActions(); this._pages['server']?.onState?.(); app.toast('Сервер остановлен', 'info'); } });
        P.register({ id: 'compile',      title: 'Компилировать',       icon: '🔨', group: 'Сервер', hint: 'Ctrl+Shift+B', run: () => this._doCompile() });
        P.register({ id: 'view.console', title: 'Виджет: Консоль',     icon: '📋', group: 'Виджеты', run: () => this.toggleConsole() });
        P.register({ id: 'view.wslog',   title: 'Виджет: WS Log',      icon: '📡', group: 'Виджеты', run: () => this.toggleDebug() });
        P.register({ id: 'view.db',      title: 'Виджет: БД (быстрый запрос)', icon: '🗄', group: 'Виджеты', run: () => DbWidget.toggle() });
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
        P.register({ id: 'extcmd',        title: 'Внешние команды',            icon: '▸', group: 'Сервер', run: () => this.navigate('extcmd') });
        P.register({ id: 'notes',         title: 'Заметки (markdown)',         icon: '📝', group: 'Навигация', run: () => this.navigate('notes') });
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
