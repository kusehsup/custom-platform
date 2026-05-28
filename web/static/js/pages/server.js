const CONSOLE_KEY      = 'console_lines';
const CONSOLE_LIMIT    = 200;
const COMPILE_KEY      = 'compile_last';
const COMPILE_HIST_KEY = 'compile_history';
const COMPILE_HIST_MAX = 5;

app.register('server', {
    _el: null,
    _paused: false,
    _lines: [],

    // ── Консоль ──────────────────────────────────────────────────────
    _loadLines() {
        try { this._lines = JSON.parse(localStorage.getItem(CONSOLE_KEY) || '[]'); } catch { this._lines = []; }
    },
    _saveLines() {
        if (this._lines.length > CONSOLE_LIMIT) this._lines = this._lines.slice(-CONSOLE_LIMIT);
        try { localStorage.setItem(CONSOLE_KEY, JSON.stringify(this._lines)); } catch {}
    },
    _flushConsole() {
        if (!this._el) return;
        this._el.textContent = this._lines.join('');
        this._el.scrollTop   = this._el.scrollHeight;
        this._updateCount();
    },
    _updateCount() {
        const el = document.getElementById('console-count');
        if (el) el.textContent = `${this._lines.length} / ${CONSOLE_LIMIT}`;
    },

    // ── Компиляция — хранилище ────────────────────────────────────────
    _saveLast(text) {
        const ts = Date.now();
        const hasErrors   = /error/i.test(text);
        const hasWarnings = /warning/i.test(text);
        // Сохраняем предыдущий текст перед заменой
        const prev = this._loadLast();
        try { localStorage.setItem(COMPILE_KEY, JSON.stringify({ text, ts, prevText: prev?.text || '' })); } catch {}
        let hist = [];
        try { hist = JSON.parse(localStorage.getItem(COMPILE_HIST_KEY) || '[]'); } catch {}
        hist.unshift({ ts, hasErrors, hasWarnings, preview: text.split('\n').slice(-3).join(' ').trim().slice(0, 120) });
        if (hist.length > COMPILE_HIST_MAX) hist = hist.slice(0, COMPILE_HIST_MAX);
        try { localStorage.setItem(COMPILE_HIST_KEY, JSON.stringify(hist)); } catch {}
    },
    _loadLast()  { try { return JSON.parse(localStorage.getItem(COMPILE_KEY)      || 'null'); } catch { return null; } },
    _loadHist()  { try { return JSON.parse(localStorage.getItem(COMPILE_HIST_KEY) || '[]');  } catch { return []; } },

    _fmtTs(ts) {
        if (!ts) return '—';
        return new Date(ts).toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
    },

    // ── Рендер ───────────────────────────────────────────────────────
    render(root) {
        this._loadLines();
        this._paused = false;
        const saved = this._loadLast();
        const hist  = this._loadHist();

        root.innerHTML = `
        <!-- Сервер -->
        <div class="card">
            <div class="card-header">
                <span class="card-title">Сервер</span>
                <button class="btn btn-ghost btn-sm" id="btn-refresh">↻ Обновить</button>
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
                <span id="compile-last-ts" style="color:var(--text-2);font-size:12px">${saved ? 'Последняя: ' + this._fmtTs(saved.ts) : ''}</span>
            </div>
            <div class="btn-row" style="margin-bottom:14px">
                <button class="btn btn-primary" id="btn-compile">🔨 Компилировать</button>
                ${saved ? `<button class="btn btn-ghost btn-sm" id="btn-show-last">Последний результат</button>` : ''}
            </div>
            <div id="compile-status" style="color:var(--text-2);font-size:13px;margin-bottom:10px;min-height:16px">
                ${app.state.compile ? '⏳ Компиляция выполняется...' : ''}
            </div>

            <div id="compile-hist-wrap" style="margin-top:4px">
                ${this._renderHistHtml(hist)}
            </div>
        </div>

        <!-- Консоль -->
        <div class="card" style="padding:0;overflow:hidden">
            <div class="console-toolbar">
                <span class="card-title" style="margin:0">Консоль</span>
                <span class="spacer"></span>
                <span class="console-count" id="console-count"></span>
                <button class="btn btn-ghost btn-sm" id="btn-pause">⏸ Пауза</button>
                <button class="btn btn-ghost btn-sm" id="btn-download">↓ Скачать</button>
                <button class="btn btn-ghost btn-sm" id="btn-clear">🗑 Очистить</button>
            </div>
            <div class="console" id="console-out"></div>
        </div>`;

        this._el = document.getElementById('console-out');
        const hostEl = document.getElementById('srv-host');
        if (hostEl && app.platformHost) hostEl.textContent = app.platformHost;
        this.onState();
        this._flushConsole();

        // Если компиляция идёт — блокируем кнопку и показываем статус
        if (app.state.compile) {
            document.getElementById('btn-compile').disabled = true;
            document.getElementById('compile-status').textContent = '⏳ Компиляция выполняется...';
        } else {
            document.getElementById('compile-status').textContent = '';
        }

        // Если результат пришёл пока страница была скрыта — показываем сейчас
        if (this._pendingResult) {
            const { text: pText, now: pNow } = this._pendingResult;
            this._pendingResult = null;
            const latestSaved = this._loadLast();
            // Добавляем кнопку если нет
            const btnRow2 = document.getElementById('btn-compile')?.closest('.btn-row');
            if (btnRow2 && !document.getElementById('btn-show-last')) {
                const btn2 = document.createElement('button');
                btn2.className = 'btn btn-ghost btn-sm'; btn2.id = 'btn-show-last';
                btn2.textContent = 'Последний результат';
                btn2.addEventListener('click', () => { const s = this._loadLast(); this._openModal(pText, this._fmtTs(pNow), s?.prevText || ''); });
                btnRow2.appendChild(btn2);
            }
            const histWrap2 = document.getElementById('compile-hist-wrap');
            if (histWrap2) histWrap2.innerHTML = this._renderHistHtml(this._loadHist());
            this._bindHistButtons();
            const tsEl2 = document.getElementById('compile-last-ts');
            if (tsEl2) tsEl2.textContent = 'Последняя: ' + this._fmtTs(pNow);
            // Открываем модалку с результатом
            this._openModal(pText, this._fmtTs(pNow), latestSaved?.prevText || '');
        }

        // Кнопка показа последнего результата
        document.getElementById('btn-show-last')?.addEventListener('click', () => {
            if (saved) this._openModal(saved.text, this._fmtTs(saved.ts), saved.prevText || '');
        });

        // Навешиваем обработчики на строки истории
        this._bindHistButtons();

        // Сервер
        document.getElementById('btn-refresh').addEventListener('click', async () => {
            try { const s = await API.get('/api/status'); app.state.server = s.server; app.state.compile = s.compile; this.onState(); }
            catch (e) { this._msg(e.message); }
        });
        document.getElementById('btn-start').addEventListener('click', () => this._serverAction('/api/server/start', 'on'));
        document.getElementById('btn-stop').addEventListener('click',  () => this._serverAction('/api/server/stop',  'off'));

        // Компиляция
        document.getElementById('btn-compile').addEventListener('click', async () => {
            try {
                await API.post('/api/compile');
                app.state.compile = true;
                document.getElementById('btn-compile').disabled = true;
                document.getElementById('compile-status').textContent = '⏳ Компиляция запущена, ожидаем результат...';
                app.toast('Компиляция запущена', 'info');
            } catch (e) {
                document.getElementById('compile-status').textContent = 'Ошибка: ' + e.message;
                app.toast('Ошибка: ' + e.message, 'error');
            }
        });

        // Консоль
        document.getElementById('btn-pause').addEventListener('click', () => {
            this._paused = !this._paused;
            document.getElementById('btn-pause').textContent = this._paused ? '▶ Продолжить' : '⏸ Пауза';
        });
        document.getElementById('btn-clear').addEventListener('click', () => {
            this._lines = []; this._saveLines(); this._flushConsole();
        });
        document.getElementById('btn-download').addEventListener('click', () => {
            const blob = new Blob([this._lines.join('')], { type: 'text/plain' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `console_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.txt`;
            a.click(); URL.revokeObjectURL(a.href);
        });
    },

    // ── Сервер ───────────────────────────────────────────────────────
    async _serverAction(url, expected) {
        this._setDisabled(true);
        try {
            await API.post(url);
            app.state.server = expected;
            this.onState();
            app.toast(expected === 'on' ? '🟢 Сервер запущен' : '🔴 Сервер остановлен', expected === 'on' ? 'success' : 'info');
        } catch (e) {
            this._msg('Ошибка: ' + e.message);
            app.toast('Ошибка: ' + e.message, 'error');
        } finally {
            this._setDisabled(false);
        }
    },

    onState() {
        const badge    = document.getElementById('srv-badge');
        const btnStart = document.getElementById('btn-start');
        const btnStop  = document.getElementById('btn-stop');
        if (badge) {
            const s = app.state.server;
            if (s === 'on')       badge.innerHTML = '<span class="badge badge-on">Работает</span>';
            else if (s === 'off') badge.innerHTML = '<span class="badge badge-off">Выключен</span>';
            else                  badge.innerHTML = '<span style="color:var(--text-2)">—</span>';
        }
        if (btnStart && btnStop) {
            btnStart.classList.toggle('hidden', app.state.server === 'on');
            btnStop.classList.toggle('hidden',  app.state.server !== 'on');
        }
    },

    // ── Компиляция ────────────────────────────────────────────────────
    _pendingResult: null,  // результат пришёл пока страница была скрыта

    onCompileResult(text) {
        app.state.compile = false;
        this._saveLast(text);
        const now = Date.now();

        // Обновляем DOM только если страница сервера открыта
        const onPage = !!document.getElementById('btn-compile');
        if (!onPage) {
            // Запомним что результат пришёл — покажем при следующем рендере
            this._pendingResult = { text, now };
            return;
        }
        if (onPage) {
            const btn = document.getElementById('btn-compile');
            if (btn) btn.disabled = false;
            const status = document.getElementById('compile-status');
            if (status) status.textContent = '';
            const tsEl = document.getElementById('compile-last-ts');
            if (tsEl) tsEl.textContent = 'Последняя: ' + this._fmtTs(now);

            // Кнопка показа результата
            const btnRow = btn?.closest('.btn-row');
            if (btnRow && !document.getElementById('btn-show-last')) {
                const btn2 = document.createElement('button');
                btn2.className = 'btn btn-ghost btn-sm';
                btn2.id = 'btn-show-last';
                btn2.textContent = 'Последний результат';
                btn2.addEventListener('click', () => { const s = this._loadLast(); this._openModal(text, this._fmtTs(now), s?.prevText || ''); });
                btnRow.appendChild(btn2);
            }

            const histWrap = document.getElementById('compile-hist-wrap');
            if (histWrap) histWrap.innerHTML = this._renderHistHtml(this._loadHist());
            this._bindHistButtons();
            const saved = this._loadLast();
            this._openModal(text, this._fmtTs(now), saved?.prevText || '');
        }
    },

    _renderHistHtml(hist) {
        if (!hist.length) return '';
        return `<div style="border-top:1px solid var(--border);padding-top:14px;margin-top:4px">
            <div style="font-size:12px;color:var(--text-2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.06em">История компиляций</div>
            ${hist.map((h, i) => `
            <div class="compile-hist-row" data-idx="${i}" style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:12.5px;cursor:pointer;transition:background .1s" onmouseover="this.style.background='rgba(255,255,255,0.03)'" onmouseout="this.style.background=''">
                <span>${h.hasErrors ? '❌' : h.hasWarnings ? '⚠️' : '✅'}</span>
                <span style="color:var(--text-2);flex-shrink:0">${this._fmtTs(h.ts)}</span>
                <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-3);font-family:var(--mono);font-size:11px">${this._esc(h.preview)}</span>
                <span style="color:var(--text-3);font-size:11px">↗</span>
            </div>`).join('')}
        </div>`;
    },

    _bindHistButtons() {
        document.querySelectorAll('.compile-hist-row').forEach(row => {
            row.addEventListener('click', () => {
                const idx = parseInt(row.dataset.idx);
                const hist = this._loadHist();
                const h = hist[idx];
                if (!h) return;
                // Загружаем полный текст из localStorage
                const all = [];
                try {
                    const saved = JSON.parse(localStorage.getItem(COMPILE_KEY));
                    // Если это последняя — берём из last
                    if (idx === 0 && saved) { this._openModal(saved.text, this._fmtTs(h.ts), saved.prevText || ''); return; }
                } catch {}
                this._openModal(h.preview, this._fmtTs(h.ts));
            });
        });
    },

    _openModal(text, title, prevText) {
        // Удаляем старую модалку
        document.getElementById('compile-modal')?.remove();

        const modal = document.createElement('div');
        modal.id = 'compile-modal';
        modal.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px)';
        modal.innerHTML = `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);width:100%;max-width:1100px;max-height:92vh;display:flex;flex-direction:column;overflow:hidden">
            <div style="display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--border);flex-shrink:0">
                <span style="font-size:13px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.06em">Результат компиляции</span>
                <span style="font-size:12px;color:var(--text-3)">${title || ''}</span>
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
            // Клик по ссылке файл(строка) → переход в редактор
            const link = e.target.closest('.compile-file-link');
            if (link) {
                const fileName = link.dataset.file;
                const line     = parseInt(link.dataset.line);
                modal.remove();
                this._navigateToFileLine(fileName, line);
            }
        });
        document.getElementById('compile-modal-close').addEventListener('click', () => modal.remove());
    },

    _navigateToFileLine(fileName, line) {
        // Ищем файл по имени в списке доступных файлов
        const filesPage = app._pages['files'];
        if (!filesPage) { app.navigate('files'); return; }

        app.navigate('files');
        // Ждём рендера страницы файлов
        setTimeout(() => {
            const files = filesPage._files || {};
            const fileId = Object.keys(files).find(id =>
                (files[id].fullPath || '').endsWith(fileName) ||
                files[id].fullPath === fileName
            );
            if (!fileId) { app.toast(`Файл ${fileName} не найден в доступных`, 'error'); return; }
            filesPage._openFile(fileId).then(() => {
                // После загрузки файла ищем нужную часть и прыгаем на строку
                setTimeout(() => {
                    const parts = filesPage._parts || [];
                    // Находим часть которая содержит нужную строку
                    let bestIdx = 0;
                    for (let i = 0; i < parts.length; i++) {
                        const pLine = parts[i].line || 1;
                        if (pLine <= line) bestIdx = i;
                    }
                    if (bestIdx !== filesPage._activePartIdx) {
                        filesPage._activePartIdx = bestIdx;
                        filesPage._renderPartTabs();
                        filesPage._loadPartIntoEditor(bestIdx);
                    }
                    // Прыгаем на строку в Monaco
                    setTimeout(() => {
                        const editor = filesPage._editor;
                        if (!editor) return;
                        const part = parts[bestIdx];
                        const editorLine = line - (part?.line || 1) + 1;
                        editor.revealLineInCenter(editorLine);
                        editor.setPosition({ lineNumber: editorLine, column: 1 });
                        editor.focus();
                    }, 300);
                }, 500);
            });
        }, 200);
    },

    _colorizeText(text, prevText) {
        const prevLines    = new Set((prevText || '').split('\n').map(l => l.trim()).filter(Boolean));
        const filesPage    = app._pages['files'];
        const accessFiles  = filesPage ? Object.values(filesPage._files || {}).map(f => f.fullPath) : [];

        // Проверяем есть ли доступ к файлу (точное совпадение или suffix)
        const hasAccess = (fileName) => accessFiles.some(fp => fp === fileName || fp.endsWith('/' + fileName) || fp.endsWith(fileName));

        return text.split('\n').map(raw => {
            const safe    = this._esc(raw);
            const trimmed = raw.trim();
            const isErr   = /error/i.test(raw);
            const isWarn  = /warning/i.test(raw);
            const isOk    = /done|success|\(0 error/i.test(raw);

            // Обычные строки — стандартный цвет без жёлтого
            if (!isErr && !isWarn) {
                if (isOk) return `<span class="line-ok">${safe}</span>`;
                return `<span style="color:#C8D3F5">${safe}</span>`;
            }

            // Новая строка — бейдж
            const isNew = trimmed && !prevLines.has(trimmed);
            const cls   = isErr ? 'line-err' : 'line-warn';
            const badge = isNew
                ? `<span style="display:inline-block;background:${isErr ? '#7F1D1D' : '#1C1917'};color:${isErr ? '#FCA5A5' : '#FDE68A'};font-size:10px;padding:1px 6px;border-radius:3px;margin-right:6px;vertical-align:middle;font-weight:600;border:1px solid ${isErr ? '#7F1D1D' : '#92400E'}">NEW</span>`
                : '';

            // Ссылки только для файлов с доступом
            const linked = safe.replace(
                /(\.\.\/)?([\w\/\-\.]+\.(pwn|inc))\((\d+)\)/g,
                (match, _dd, file, _ext, line) => {
                    if (!hasAccess(file)) return match; // нет доступа — просто текст
                    return `<a class="compile-file-link" data-file="${file}" data-line="${line}" style="color:inherit;text-decoration:underline;text-underline-offset:2px;cursor:pointer" title="Открыть ${file}:${line}">${match}</a>`;
                }
            );

            return `<span class="${cls}">${badge}${linked}</span>`;
        }).join('\n');
    },

    // ── Консоль ───────────────────────────────────────────────────────
    onLog(data) {
        this._lines.push(data);
        this._saveLines();
        if (this._paused || !this._el) return;
        this._el.textContent += data;
        this._el.scrollTop = this._el.scrollHeight;
        this._updateCount();
    },

    _msg(t)  { const e = document.getElementById('srv-msg'); if (e) e.textContent = t; },
    _esc(s)  { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); },
    _setDisabled(v) {
        ['btn-start','btn-stop'].forEach(id => { const e = document.getElementById(id); if (e) e.disabled = v; });
    },
});
