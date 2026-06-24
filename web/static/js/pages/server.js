const CONSOLE_KEY      = 'console_lines';
// Лимит в памяти убран — храним все строки текущей сессии.
// В localStorage пишем не больше CONSOLE_PERSIST_MAX, чтобы quota не лопнула
// при многотысячных логах; в памяти при этом видно всё.
const CONSOLE_PERSIST_MAX = 2000;
const COMPILE_KEY      = 'compile_last';
const COMPILE_HIST_KEY = 'compile_history';
const COMPILE_HIST_MAX = 5;

app.register('server', {
    _el: null,
    _paused: false,
    _autoScroll: true,
    _lines: [],          // массив УЖЕ разбитых строк
    _tail: '',           // незавершённая строка (хвост последнего чанка)
    _filter: '',
    _serverStartTs: null,
    _renderQueued: false,

    // ── Консоль ──────────────────────────────────────────────────────
    // Новый формат localStorage: {v:2, lines:[..]}. Старый формат
    // ({array of chunks}) определяем по наличию символов '\n' в элементах
    // и однократно мигрируем.
    _loadLines() {
        // Если в этой сессии мы уже инициализированы — не перетираем стрим из памяти.
        if (this._loaded) return;
        try {
            const raw = JSON.parse(localStorage.getItem(CONSOLE_KEY) || '[]');
            if (raw && raw.v === 2 && Array.isArray(raw.lines)) {
                // Любые элементы со встроенными '\n' дочистим
                const cleaned = [];
                for (const l of raw.lines) {
                    if (typeof l !== 'string') continue;
                    if (l.includes('\n')) for (const p of l.split('\n')) cleaned.push(p);
                    else cleaned.push(l);
                }
                this._lines = cleaned;
            } else if (Array.isArray(raw)) {
                // Старый формат: массив чанков с возможными '\n' внутри
                const joined = raw.join('');
                const parts = joined.split('\n');
                // Последний "хвост" приклеиваем как обычную строку (старая сессия закончена)
                this._lines = parts.filter(l => l !== '');
            } else {
                this._lines = [];
            }
            this._tail = '';
            this._trim();
            this._saveLines();   // сразу пишем новый формат, чтобы миграция не повторялась
        } catch {
            this._lines = []; this._tail = '';
        }
        this._loaded = true;
    },
    _saveLines() {
        try {
            // В localStorage пишем хвост последних CONSOLE_PERSIST_MAX строк,
            // в памяти держим всё.
            const persisted = this._lines.length > CONSOLE_PERSIST_MAX
                ? this._lines.slice(-CONSOLE_PERSIST_MAX)
                : this._lines;
            localStorage.setItem(CONSOLE_KEY, JSON.stringify({ v: 2, lines: persisted }));
        } catch {
            // localStorage переполнен — ничего страшного, в памяти всё на месте
        }
    },
    _trim() {
        // Раньше срезали до CONSOLE_LIMIT — теперь не срезаем.
    },

    _colorize(line) {
        const s = line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        if (/\[fatal\]|\[crash\]/i.test(line))  return `<span class="con-fatal">${s}</span>`;
        if (/\[error\]|error:/i.test(line))      return `<span class="con-error">${s}</span>`;
        if (/\[warn\]|warning/i.test(line))      return `<span class="con-warn">${s}</span>`;
        if (/\[debug\]/i.test(line))             return `<span class="con-debug">${s}</span>`;
        if (/\[info\]/i.test(line))              return `<span class="con-info">${s}</span>`;
        return `<span class="con-default">${s}</span>`;
    },

    _flushConsole() {
        const el = this._el;
        if (!el) return;
        const filter = this._filter.toLowerCase();
        // Defensiveness: если каким-то образом в _lines есть элемент с '\n',
        // разрежем ещё раз. Это страхует от старых данных в localStorage.
        let lines = [];
        for (const item of this._lines) {
            if (typeof item !== 'string') continue;
            if (item.includes('\n')) {
                for (const p of item.split('\n')) lines.push(p);
            } else {
                lines.push(item);
            }
        }
        if (this._tail) lines.push(this._tail);
        lines = lines.filter(l => l && l.trim());
        const visible = filter ? lines.filter(l => l.toLowerCase().includes(filter)) : lines;
        el.innerHTML = visible.map(l => this._colorize(l)).join('\n');
        this._updateCount(visible.length);
        if (this._autoScroll) el.scrollTop = el.scrollHeight;
    },

    _updateCount(n) {
        const el = document.getElementById('console-count');
        if (el) el.textContent = `${(n ?? this._lines.length).toLocaleString('ru-RU')} строк`;
    },

    // ── Компиляция — хранилище ────────────────────────────────────────
    _previewFor(text) {
        // Берём первую информативную строку с error/warning, иначе первую
        // непустую. Старая логика "последние 3 строки" давала один и тот же
        // финальный warning для каждой компиляции.
        const lines = (text || '').split('\n');
        const firstError = lines.find(l => /error \d+|: error|fatal error/i.test(l));
        if (firstError) return firstError.trim().slice(0, 200);
        const firstWarn = lines.find(l => /warning \d+|: warning/i.test(l));
        if (firstWarn) return firstWarn.trim().slice(0, 200);
        const firstNonEmpty = lines.find(l => l.trim());
        return (firstNonEmpty || '').trim().slice(0, 200);
    },

    _saveLast(text) {
        const ts = Date.now();
        const errMatch  = text.match(/(\d+)\s+Error/i);
        const warnMatch = text.match(/(\d+)\s+Warning/i);
        const hasErrors   = /error/i.test(text);
        const hasWarnings = /warning/i.test(text);
        const errCount    = errMatch  ? parseInt(errMatch[1])  : (hasErrors   ? '?' : 0);
        const warnCount   = warnMatch ? parseInt(warnMatch[1]) : (hasWarnings ? '?' : 0);
        const prev = this._loadLast();
        try { localStorage.setItem(COMPILE_KEY, JSON.stringify({ text, ts, prevText: prev?.text || '' })); } catch {}
        let hist = [];
        try { hist = JSON.parse(localStorage.getItem(COMPILE_HIST_KEY) || '[]'); } catch {}
        // Храним полный text в каждой записи истории — иначе при открытии
        // модалки для старой компиляции мы видим только превью.
        hist.unshift({ ts, hasErrors, hasWarnings, errCount, warnCount,
            preview: this._previewFor(text), text });
        if (hist.length > COMPILE_HIST_MAX) hist = hist.slice(0, COMPILE_HIST_MAX);
        try { localStorage.setItem(COMPILE_HIST_KEY, JSON.stringify(hist)); }
        catch (e) {
            // Если квота localStorage переполнена — дропаем старые до тех
            // пор, пока не влезет (минимум одну запись пытаемся сохранить).
            while (hist.length > 1) {
                hist.pop();
                try { localStorage.setItem(COMPILE_HIST_KEY, JSON.stringify(hist)); break; }
                catch {}
            }
        }
    },
    _loadLast() { try { return JSON.parse(localStorage.getItem(COMPILE_KEY) || 'null'); } catch { return null; } },
    _loadHist() {
        try {
            const hist = JSON.parse(localStorage.getItem(COMPILE_HIST_KEY) || '[]');
            // Миграция: если в старых записях нет поля text, добавим из последнего
            // сохранённого результата (только для idx=0).
            const last = this._loadLast();
            if (Array.isArray(hist) && hist.length && !hist[0].text && last) {
                hist[0].text = last.text;
            }
            return hist;
        } catch { return []; }
    },

    _fmtTs(ts) {
        if (!ts) return '—';
        return new Date(ts).toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
    },

    _fmtUptime(ts) {
        if (!ts) return '';
        const s = Math.floor((Date.now() - ts) / 1000);
        if (s < 60)   return `${s}с`;
        if (s < 3600) return `${Math.floor(s/60)}м ${s%60}с`;
        return `${Math.floor(s/3600)}ч ${Math.floor((s%3600)/60)}м`;
    },

    // ── Рендер ───────────────────────────────────────────────────────
    render(root) {
        this._loadLines();
        this._paused    = false;
        this._autoScroll= true;
        this._filter    = '';
        const saved = this._loadLast();
        const hist  = this._loadHist();

        root.innerHTML = `
        <!-- Сервер -->
        <div class="card" style="position:relative;overflow:hidden">
            <div class="server-glow" id="server-glow"></div>
            <div class="card-header">
                <span class="card-title">Сервер</span>
                <button class="btn btn-ghost btn-sm" id="btn-refresh">↻</button>
            </div>
            <div class="stat-rows">
                <div class="stat-row">
                    <span class="stat-label">Состояние</span>
                    <span id="srv-badge"></span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Хост</span>
                    <span class="stat-value" style="font-family:var(--mono);font-size:13px" id="srv-host">—</span>
                </div>
                <div class="stat-row" id="srv-uptime-row" style="display:none">
                    <span class="stat-label">Uptime</span>
                    <span class="stat-value" id="srv-uptime">—</span>
                </div>
            </div>
            <div class="btn-row" style="margin-top:16px">
                <button class="btn btn-success hidden" id="btn-start">▶ Запустить</button>
                <button class="btn btn-danger  hidden" id="btn-stop">⏹ Остановить</button>
            </div>
            <div id="srv-msg" style="margin-top:10px;color:var(--text-2);font-size:13px;min-height:16px"></div>
        </div>

        <!-- Компиляция -->
        <div class="card">
            <div class="card-header">
                <span class="card-title">Компиляция</span>
                <span id="compile-last-ts" style="color:var(--text-2);font-size:12px">${saved ? this._fmtTs(saved.ts) : ''}</span>
            </div>
            <div class="btn-row" style="margin-bottom:14px">
                <button class="btn btn-primary" id="btn-compile">🔨 Компилировать</button>
                ${saved ? `<button class="btn btn-ghost btn-sm" id="btn-show-last">Последний результат</button>` : ''}
            </div>
            <div id="compile-status" style="color:var(--text-2);font-size:13px;margin-bottom:10px;min-height:16px">
                ${app.state.compile ? `<span class="compile-spinner"></span>Компиляция <span id="compile-page-timer">0.0с</span>` : ''}
            </div>
            <div id="compile-hist-wrap">${this._renderHistHtml(hist)}</div>
        </div>

        <!-- Консоль -->
        <div class="card" style="padding:0;overflow:hidden">
            <div class="console-toolbar">
                <span class="card-title" style="margin:0">Консоль</span>
                <input id="con-filter" type="text" placeholder="Фильтр строк..." style="flex:1;margin:0 10px;padding:4px 10px;font-size:12px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-xs);color:var(--text);outline:none;max-width:260px" />
                <span class="console-count" id="console-count"></span>
                <button class="btn btn-ghost btn-sm" id="btn-pause">⏸</button>
                <button class="btn btn-ghost btn-sm" id="btn-autoscroll" title="Автоскролл" style="color:var(--green)">↓</button>
                <button class="btn btn-ghost btn-sm" id="btn-download">↓ .txt</button>
                <button class="btn btn-ghost btn-sm" id="btn-clear">🗑</button>
            </div>
            <div class="console" id="console-out"></div>
        </div>`;

        this._el = document.getElementById('console-out');
        const hostEl = document.getElementById('srv-host');
        if (hostEl && app.platformHost) hostEl.textContent = app.platformHost;
        this.onState();
        this._flushConsole();

        if (app.state.compile) {
            document.getElementById('btn-compile').disabled = true;
            const cs = document.getElementById('compile-status');
            cs.innerHTML = `<span class="compile-spinner"></span>Компиляция <span id="compile-page-timer">0.0с</span>`;
            this._startPageTimer();
        }

        if (this._pendingResult) {
            const { text: pText, now: pNow } = this._pendingResult;
            this._pendingResult = null;
            const ls = this._loadLast();
            const btnRow2 = document.getElementById('btn-compile')?.closest('.btn-row');
            if (btnRow2 && !document.getElementById('btn-show-last')) {
                const b2 = document.createElement('button');
                b2.className = 'btn btn-ghost btn-sm'; b2.id = 'btn-show-last';
                b2.textContent = 'Последний результат';
                b2.addEventListener('click', () => { const s = this._loadLast(); this._openModal(pText, this._fmtTs(pNow), s?.prevText||''); });
                btnRow2.appendChild(b2);
            }
            const hw2 = document.getElementById('compile-hist-wrap');
            if (hw2) hw2.innerHTML = this._renderHistHtml(this._loadHist());
            this._bindHistButtons();
            const tsEl2 = document.getElementById('compile-last-ts');
            if (tsEl2) tsEl2.textContent = this._fmtTs(pNow);
            this._openModal(pText, this._fmtTs(pNow), ls?.prevText||'');
        }

        document.getElementById('btn-show-last')?.addEventListener('click', () => {
            if (saved) this._openModal(saved.text, this._fmtTs(saved.ts), saved.prevText||'');
        });
        this._bindHistButtons();

        document.getElementById('btn-refresh').addEventListener('click', async () => {
            try { const s = await API.get('/api/status'); app.state.server = s.server; app.state.compile = s.compile; this.onState(); }
            catch (e) { this._msg(e.message); }
        });
        document.getElementById('btn-start').addEventListener('click', () => this._serverAction('/api/server/start', 'on'));
        document.getElementById('btn-stop').addEventListener('click',  () => this._serverAction('/api/server/stop',  'off'));

        document.getElementById('btn-compile').addEventListener('click', async () => {
            try {
                await API.post('/api/compile');
                app.state.compile = true;
                if (!app._compileStartTs) app._compileStartTs = Date.now();
                app._startCompileTimer?.();
                document.getElementById('btn-compile').disabled = true;
                const cs = document.getElementById('compile-status');
                cs.innerHTML = `<span class="compile-spinner"></span>Компиляция <span id="compile-page-timer">0.0с</span>`;
                this._startPageTimer();
                app.toast('Компиляция запущена', 'info');
            } catch (e) {
                document.getElementById('compile-status').textContent = 'Ошибка: ' + e.message;
                app.toast('Ошибка: ' + e.message, 'error');
            }
        });

        // Консоль
        document.getElementById('con-filter').addEventListener('input', e => {
            this._filter = e.target.value;
            this._flushConsole();
        });
        document.getElementById('btn-pause').addEventListener('click', () => {
            this._paused = !this._paused;
            document.getElementById('btn-pause').textContent = this._paused ? '▶' : '⏸';
        });
        document.getElementById('btn-autoscroll').addEventListener('click', () => {
            this._autoScroll = !this._autoScroll;
            const btn = document.getElementById('btn-autoscroll');
            btn.style.color = this._autoScroll ? 'var(--green)' : 'var(--text-3)';
            if (this._autoScroll && this._el) this._el.scrollTop = this._el.scrollHeight;
        });
        // Умный автоскролл — отключается при скролле вверх
        this._el.addEventListener('scroll', () => {
            const el = this._el;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            if (!atBottom && this._autoScroll) {
                this._autoScroll = false;
                const btn = document.getElementById('btn-autoscroll');
                if (btn) btn.style.color = 'var(--text-3)';
            } else if (atBottom && !this._autoScroll) {
                this._autoScroll = true;
                const btn = document.getElementById('btn-autoscroll');
                if (btn) btn.style.color = 'var(--green)';
            }
        });
        document.getElementById('btn-clear').addEventListener('click', () => {
            this._lines = []; this._saveLines(); this._flushConsole();
            app._consoleLines = [];
        });
        document.getElementById('btn-download').addEventListener('click', () => {
            const blob = new Blob([this._lines.join('')], { type: 'text/plain' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `console_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.txt`;
            a.click(); URL.revokeObjectURL(a.href);
        });

        // Uptime ticker
        this._uptimeTick();
    },

    _uptimeTick() {
        const tick = () => {
            const el = document.getElementById('srv-uptime');
            if (!el) return;
            if (this._serverStartTs) el.textContent = this._fmtUptime(this._serverStartTs);
            setTimeout(tick, 5000);
        };
        tick();
    },

    // ── Сервер ───────────────────────────────────────────────────────
    async _serverAction(url, expected) {
        this._setDisabled(true);
        try {
            await API.post(url);
            app.state.server = expected;
            if (expected === 'on') this._serverStartTs = Date.now();
            else this._serverStartTs = null;
            this.onState();
            app.toast(expected === 'on' ? '🟢 Сервер запущен' : '🔴 Сервер остановлен', expected === 'on' ? 'success' : 'info');
        } catch (e) {
            this._msg('Ошибка: ' + e.message);
            app.toast('Ошибка: ' + e.message, 'error');
        } finally { this._setDisabled(false); }
    },

    onState() {
        const badge    = document.getElementById('srv-badge');
        const btnStart = document.getElementById('btn-start');
        const btnStop  = document.getElementById('btn-stop');
        const uptimeRow = document.getElementById('srv-uptime-row');

        if (badge) {
            const s = app.state.server;
            if (s === 'on')       badge.innerHTML = '<span class="badge badge-on">Работает</span>';
            else if (s === 'off') badge.innerHTML = '<span class="badge badge-off">Выключен</span>';
            else                  badge.innerHTML = '<span style="color:var(--text-2)">—</span>';
        }
        const glow = document.getElementById('server-glow');
        if (glow) {
            glow.className = 'server-glow ' + (app.state.server === 'on' ? 'server-glow-on' : 'server-glow-off');
        }
        if (btnStart && btnStop) {
            btnStart.classList.toggle('hidden', app.state.server === 'on');
            btnStop.classList.toggle('hidden',  app.state.server !== 'on');
        }
        if (uptimeRow) {
            uptimeRow.style.display = app.state.server === 'on' ? '' : 'none';
            if (app.state.server === 'on' && !this._serverStartTs)
                this._serverStartTs = Date.now();
            if (app.state.server !== 'on') this._serverStartTs = null;
        }
        // Если идёт компиляция — гарантируем работающий таймер
        if (app.state.compile && document.getElementById('compile-status')) {
            if (!document.getElementById('compile-page-timer')) {
                const cs = document.getElementById('compile-status');
                cs.innerHTML = `<span class="compile-spinner"></span>Компиляция <span id="compile-page-timer">0.0с</span>`;
            }
            this._startPageTimer();
        }
    },

    // ── Компиляция ────────────────────────────────────────────────────
    _pendingResult: null,

    onCompileResult(text) {
        app.state.compile = false;
        this._stopPageTimer();
        this._saveLast(text);
        const now = Date.now();
        const onPage = !!document.getElementById('btn-compile');
        if (!onPage) { this._pendingResult = { text, now }; return; }
        if (onPage) {
            const btn = document.getElementById('btn-compile');
            if (btn) btn.disabled = false;
            const status = document.getElementById('compile-status');
            if (status) {
                const dur = app._lastCompileDuration;
                const durLabel = dur != null
                    ? (dur < 60 ? `${dur.toFixed(1)}с` : `${Math.floor(dur/60)}м ${Math.floor(dur%60)}с`)
                    : '';
                const hasErr = /error/i.test(text);
                status.innerHTML = `<span style="color:${hasErr ? 'var(--red)' : 'var(--green)'}">● ${hasErr ? 'Завершена с ошибками' : 'Завершена'}</span>${durLabel ? ` <span style="color:var(--text-3)">за ${durLabel}</span>` : ''}`;
            }
            const tsEl = document.getElementById('compile-last-ts');
            if (tsEl) tsEl.textContent = this._fmtTs(now);
            const btnRow = btn?.closest('.btn-row');
            if (btnRow && !document.getElementById('btn-show-last')) {
                const btn2 = document.createElement('button');
                btn2.className = 'btn btn-ghost btn-sm'; btn2.id = 'btn-show-last';
                btn2.textContent = 'Последний результат';
                btn2.addEventListener('click', () => { const s = this._loadLast(); this._openModal(text, this._fmtTs(now), s?.prevText||''); });
                btnRow.appendChild(btn2);
            }
            const histWrap = document.getElementById('compile-hist-wrap');
            if (histWrap) histWrap.innerHTML = this._renderHistHtml(this._loadHist());
            this._bindHistButtons();
            this._openModal(text, this._fmtTs(now), this._loadLast()?.prevText||'');
        }
    },

    _renderHistHtml(hist) {
        if (!hist.length) return '';
        return `<div style="border-top:1px solid var(--border);padding-top:14px;margin-top:4px">
            <div style="font-size:11px;color:var(--text-2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.06em">История</div>
            ${hist.map((h, i) => {
                const icon = h.hasErrors ? '❌' : h.hasWarnings ? '⚠️' : '✅';
                const errBadge  = h.hasErrors   ? `<span style="background:rgba(248,113,113,0.15);color:var(--red);font-size:10px;padding:1px 6px;border-radius:3px;margin-left:4px">${h.errCount} err</span>` : '';
                const warnBadge = h.hasWarnings  ? `<span style="background:rgba(251,191,36,0.12);color:var(--yellow);font-size:10px;padding:1px 6px;border-radius:3px;margin-left:4px">${h.warnCount} warn</span>` : '';
                return `<div class="compile-hist-row" data-idx="${i}" style="display:flex;align-items:center;gap:6px;padding:6px 0;border-bottom:1px solid var(--border);font-size:12.5px;cursor:pointer;transition:background .1s" onmouseover="this.style.background='rgba(255,255,255,0.03)'" onmouseout="this.style.background=''">
                    <span>${icon}</span>
                    <span style="color:var(--text-2);flex-shrink:0;font-size:12px">${this._fmtTs(h.ts)}</span>
                    ${errBadge}${warnBadge}
                    <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-3);font-family:var(--mono);font-size:11px;margin-left:4px">${this._esc(h.preview)}</span>
                    <span style="color:var(--text-3);font-size:11px;flex-shrink:0">↗</span>
                </div>`;
            }).join('')}
        </div>`;
    },

    _bindHistButtons() {
        document.querySelectorAll('.compile-hist-row').forEach(row => {
            row.addEventListener('click', () => {
                const idx = parseInt(row.dataset.idx);
                const hist = this._loadHist();
                const h = hist[idx];
                if (!h) return;
                // Полный текст хранится в самой записи (после фикса). Fallback на
                // _loadLast.text если запись пришла из старого формата без text.
                let text = h.text;
                if (!text && idx === 0) text = this._loadLast()?.text;
                if (!text) text = h.preview;   // совсем крайний случай
                // Для diff передаём предыдущую (более старую) компиляцию.
                const prev = hist[idx + 1];
                const prevText = prev?.text || '';
                this._openModal(text, this._fmtTs(h.ts), prevText);
            });
        });
    },

    _openModal(text, title, prevText) {
        document.getElementById('compile-modal')?.remove();
        const modal = document.createElement('div');
        modal.id = 'compile-modal';
        modal.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px)';
        modal.innerHTML = `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);width:100%;max-width:1100px;max-height:92vh;display:flex;flex-direction:column;overflow:hidden">
            <div style="display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--border);flex-shrink:0">
                <span style="font-size:13px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.06em">Результат компиляции</span>
                <span style="font-size:12px;color:var(--text-3)">${title||''}</span>
                <span style="flex:1"></span>
                <button id="compile-modal-close" style="background:none;border:none;color:var(--text-2);cursor:pointer;font-size:18px;line-height:1;padding:4px">✕</button>
            </div>
            <div style="overflow:auto;padding:14px 20px;flex:1">
                <pre class="compile-out" style="max-height:none;border:none;padding:0;background:transparent;white-space:pre;overflow-x:auto">${this._colorizeText(text, prevText)}</pre>
            </div>
        </div>`;
        document.body.appendChild(modal);
        modal.addEventListener('click', e => {
            if (e.target === modal) { modal.remove(); return; }
            const link = e.target.closest('.compile-file-link');
            if (link) { modal.remove(); this._navigateToFileLine(link.dataset.file, parseInt(link.dataset.line)); }
        });
        document.getElementById('compile-modal-close').addEventListener('click', () => modal.remove());
    },

    _colorizeText(text, prevText) {
        const prevLines   = new Set((prevText||'').split('\n').map(l=>l.trim()).filter(Boolean));
        const filesPage   = app._pages['files'];
        const accessFiles = filesPage ? Object.values(filesPage._files||{}).map(f=>f.fullPath) : [];
        const hasAccess   = f => accessFiles.some(fp => fp===f || fp.endsWith('/'+f) || fp.endsWith(f));

        return text.split('\n').map(raw => {
            const safe   = this._esc(raw);
            const trimmed= raw.trim();
            const isErr  = /error/i.test(raw);
            const isWarn = /warning/i.test(raw);
            const isOk   = /done|success|\(0 error/i.test(raw);

            if (!isErr && !isWarn) {
                if (isOk) return `<span class="line-ok">${safe}</span>`;
                return `<span style="color:#C8D3F5">${safe}</span>`;
            }

            const isNew = trimmed && !prevLines.has(trimmed);
            const cls   = isErr ? 'line-err' : 'line-warn';
            const badge = isNew ? `<span style="display:inline-block;background:${isErr?'#7F1D1D':'#1C1917'};color:${isErr?'#FCA5A5':'#FDE68A'};font-size:10px;padding:1px 6px;border-radius:3px;margin-right:6px;vertical-align:middle;font-weight:600;border:1px solid ${isErr?'#7F1D1D':'#92400E'}">NEW</span>` : '';

            const linked = safe.replace(/(\.\.\/)?([\w\/\-\.]+\.(pwn|inc))\((\d+)\)/g, (match, _dd, file, _ext, line) => {
                if (!hasAccess(file)) return match;
                return `<a class="compile-file-link" data-file="${file}" data-line="${line}" style="color:inherit;text-decoration:underline;text-underline-offset:2px;cursor:pointer">${match}</a>`;
            });

            return `<span class="${cls}">${badge}${linked}</span>`;
        }).join('\n');
    },

    _navigateToFileLine(fileName, line) {
        const filesPage = app._pages['files'];
        if (!filesPage) { app.navigate('files'); return; }
        app.navigate('files');
        setTimeout(() => {
            const files = filesPage._files || {};
            const fileId = Object.keys(files).find(id => (files[id].fullPath||'').endsWith(fileName) || files[id].fullPath === fileName);
            if (!fileId) { app.toast(`Файл ${fileName} не найден`, 'error'); return; }
            filesPage._openFile(fileId).then(() => {
                setTimeout(() => {
                    const parts = filesPage._parts || [];
                    let bestIdx = 0;
                    parts.forEach((p, i) => { if ((p.line||1) <= line) bestIdx = i; });
                    if (bestIdx !== filesPage._activePartIdx) { filesPage._activePartIdx = bestIdx; filesPage._renderPartTabs(); filesPage._loadPartIntoEditor(bestIdx); }
                    setTimeout(() => {
                        const editor = filesPage._editor;
                        if (!editor) return;
                        const el = Math.max(1, line - ((parts[bestIdx]?.line||1)) + 1);
                        editor.revealLineInCenter(el);
                        editor.setPosition({ lineNumber: el, column: 1 });
                        editor.focus();
                    }, 300);
                }, 500);
            });
        }, 200);
    },

    // ── Консоль ───────────────────────────────────────────────────────
    onLog(data) {
        if (typeof data !== 'string') return;
        // Гарантируем что localStorage прочитан, даже если страница ещё не рендерилась
        if (!this._loaded) this._loadLines();
        // Чанк может содержать несколько строк или быть половиной — режем
        // аккуратно. Хвост (без \n в конце) держим до следующего чанка.
        const combined = this._tail + data;
        const parts = combined.split('\n');
        this._tail = parts.pop() || '';
        if (parts.length) {
            this._lines.push(...parts);
            this._trim();
            this._saveLines();
        }
        if (this._paused || !this._el) return;
        this._scheduleFlush();
    },

    _startPageTimer() {
        if (this._pageTimerId) return;
        const tick = () => {
            const el = document.getElementById('compile-page-timer');
            if (!el) { this._stopPageTimer(); return; }
            if (!app.state.compile || !app._compileStartTs) { this._stopPageTimer(); return; }
            const sec = (Date.now() - app._compileStartTs) / 1000;
            el.textContent = sec < 10 ? sec.toFixed(1) + 'с' : Math.floor(sec) + 'с';
        };
        tick();
        this._pageTimerId = setInterval(tick, 100);
    },

    _stopPageTimer() {
        if (this._pageTimerId) {
            clearInterval(this._pageTimerId);
            this._pageTimerId = null;
        }
    },

    _scheduleFlush() {
        if (this._renderQueued) return;
        this._renderQueued = true;
        requestAnimationFrame(() => {
            this._renderQueued = false;
            this._flushConsole();
        });
    },

    _msg(t)  { const e = document.getElementById('srv-msg'); if (e) e.textContent = t; },
    _esc(s)  { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); },
    _setDisabled(v) {
        ['btn-start','btn-stop'].forEach(id => { const e = document.getElementById(id); if (e) e.disabled = v; });
    },
});
