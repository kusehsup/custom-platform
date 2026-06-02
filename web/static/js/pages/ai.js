// ── AI Assistant: full page view ────────────────────────────────────

const AiPage = {
    _registered: false,

    render(el) {
        AiChat.init();
        el.innerHTML = `
        <div class="ai ai-page">
            <div class="ai-page-header">
                <div>
                    <h2 style="font-size:18px;font-weight:600;color:var(--text);margin:0">AI ассистент</h2>
                    <div id="ai-p-status" class="ai-status ai-status-inline">Загрузка…</div>
                </div>
                <div style="display:flex;gap:6px;align-items:center">
                    <button class="btn btn-ghost btn-sm" id="ai-p-clear">Очистить чат</button>
                </div>
            </div>

            <div class="ai-ctx ai-ctx-page">
                <label class="ai-field" style="min-width:240px">
                    <span>Модель</span>
                    <select id="ai-p-model" class="ai-select"></select>
                </label>
                <label class="toggle ai-toggle-inline" title="Прикрепить логи сервера">
                    <input type="checkbox" id="ai-p-console" />
                    <span class="toggle-track"></span>
                    <span class="ai-toggle-label">Консоль сервера</span>
                </label>
                <label class="ai-field" style="width:120px">
                    <span>Строк</span>
                    <input type="number" id="ai-p-lines" min="10" max="2000" value="200" class="ai-num" style="width:100%" />
                </label>
                <button class="btn btn-ghost btn-sm" id="ai-p-attach" style="margin-left:auto">+ Прикрепить файл</button>
            </div>

            <div class="ai-page-attached" id="ai-p-attached"></div>

            <div id="ai-p-messages" class="ai-messages ai-messages-page"></div>

            <div class="ai-composer-wrap ai-composer-wrap-page">
                <div class="ai-composer">
                    <textarea id="ai-p-input" placeholder="Спросить про Pawn-код, ошибку из логов сервера, как реализовать… (@ — прикрепить файл, Ctrl+Enter — отправить)" rows="3"></textarea>
                </div>
                <div class="ai-actions">
                    <button class="btn btn-primary btn-sm" id="ai-p-send">Отправить</button>
                    <button class="btn btn-danger btn-sm hidden" id="ai-p-stop">Стоп</button>
                </div>
            </div>
        </div>`;

        this._bind();
        if (!this._registered) {
            AiChat.registerView({
                onChange: () => this._renderAll(),
                onDelta:  idx => this._updateBubble(idx),
            });
            this._registered = true;
        }

        this._renderAll();
        AiChat.loadStatus();
        AiChat.loadFiles();
    },

    _bind() {
        const $ = id => document.getElementById(id);

        $('ai-p-clear').addEventListener('click', () => AiChat.clear());
        $('ai-p-send').addEventListener('click', () => this._sendFromInput());
        $('ai-p-stop').addEventListener('click', () => AiChat.stop());
        $('ai-p-attach').addEventListener('click', () => this._showFilePicker());

        const input = $('ai-p-input');
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                this._sendFromInput();
            }
        });

        $('ai-p-console').addEventListener('change', e => AiChat.setIncludeConsole(e.target.checked));
        $('ai-p-lines').addEventListener('change', e => AiChat.setConsoleLines(e.target.value));
        $('ai-p-model').addEventListener('change', e => AiChat.setModel(e.target.value));

        const composerWrap = input.closest('.ai-composer-wrap');
        AiMentions.attach(input, composerWrap);
    },

    _sendFromInput() {
        const input = document.getElementById('ai-p-input');
        if (!input) return;
        const v = input.value;
        input.value = '';
        AiChat.send(v);
    },

    _renderAll() {
        if (!document.getElementById('ai-p-messages')) return;
        this._renderStatus();
        this._renderModel();
        this._renderControls();
        this._renderAttached();
        this._renderMessages();
    },

    _renderStatus() {
        const el = document.getElementById('ai-p-status');
        const send = document.getElementById('ai-p-send');
        if (!el) return;
        const st = AiChat.state.status;
        if (!st) { el.textContent = 'Загрузка…'; return; }
        if (st.error) { el.textContent = st.error; send.disabled = true; return; }
        if (!st.allowed) {
            el.innerHTML = `<span class="ai-dot ai-dot-warn"></span>${st.reason || 'AI ассистент недоступен'}`;
            send.disabled = true;
            return;
        }
        if (!st.cli_installed || !st.logged_in) {
            el.innerHTML = `<span class="ai-dot ai-dot-warn"></span>CLI не готов — открой <a href="#" id="ai-p-go-settings">Настройки</a>`;
            document.getElementById('ai-p-go-settings')?.addEventListener('click', e => {
                e.preventDefault();
                app.navigate('settings');
            });
            send.disabled = true;
            return;
        }
        el.innerHTML = `<span class="ai-dot ai-dot-ok"></span>Подключено через Max подписку`;
        send.disabled = AiChat.state.streaming;
    },

    _renderModel() {
        const sel = document.getElementById('ai-p-model');
        if (!sel) return;
        const st = AiChat.state.status;
        if (!st?.models) return;
        const wantValue = AiChat.state.model || st.default_model || st.models[0]?.id;
        if (sel.options.length !== st.models.length) {
            sel.innerHTML = st.models.map(m => `<option value="${m.id}">${m.label}</option>`).join('');
        }
        sel.value = wantValue;
    },

    _renderControls() {
        const cb = document.getElementById('ai-p-console');
        const num = document.getElementById('ai-p-lines');
        if (cb) cb.checked = AiChat.state.includeConsole;
        if (num) num.value = AiChat.state.consoleLines;

        const send = document.getElementById('ai-p-send');
        const stop = document.getElementById('ai-p-stop');
        if (AiChat.state.streaming) {
            send?.classList.add('hidden');
            stop?.classList.remove('hidden');
        } else {
            send?.classList.remove('hidden');
            stop?.classList.add('hidden');
        }
    },

    _renderAttached() {
        const wrap = document.getElementById('ai-p-attached');
        if (!wrap) return;
        const fids = AiChat.state.attachedFiles;
        if (!fids.length) {
            wrap.innerHTML = '';
            wrap.style.display = 'none';
            return;
        }
        wrap.style.display = 'flex';
        wrap.innerHTML = `
            <div class="ai-attached-header">Прикреплено ${fids.length}:</div>
            <div class="ai-chips ai-chips-page">
                ${fids.map(fid => {
                    const meta = AiChat.getFile(fid) || {};
                    const name = meta.name || meta.fullPath || fid;
                    return `<span class="ai-chip" data-fid="${fid}" title="${AiChat.esc(meta.fullPath || name)}">
                        <span class="ai-chip-name">${AiChat.esc(name)}</span>
                        <button class="ai-chip-x" data-fid="${fid}">✕</button>
                    </span>`;
                }).join('')}
            </div>`;
        wrap.querySelectorAll('.ai-chip-x').forEach(btn => {
            btn.addEventListener('click', () => AiChat.detachFile(btn.dataset.fid));
        });
    },

    _renderMessages() {
        const wrap = document.getElementById('ai-p-messages');
        if (!wrap) return;
        const msgs = AiChat.state.messages;
        if (!msgs.length) {
            wrap.innerHTML = `<div class="ai-empty">
                <div style="font-size:14px;color:var(--text-2);margin-bottom:12px">AI ассистент работает с Pawn-кодом сервера</div>
                <div>Прикрепи файлы через <code class="ai-inline-code">@</code> или кнопку справа сверху,<br>включи логи консоли — и спроси что нужно.</div>
                <div class="ai-hint" style="margin-top:14px">Подсказки:</div>
                <div class="ai-suggestions">
                    <button class="ai-suggest" data-text="Покажи список доступных мне файлов и кратко опиши их структуру.">📁 Что есть в проекте</button>
                    <button class="ai-suggest" data-text="Проверь последние логи сервера на наличие ошибок и предложи исправления.">⚠️ Ошибки в логах</button>
                </div>
            </div>`;
            wrap.querySelectorAll('.ai-suggest').forEach(b => {
                b.addEventListener('click', () => AiChat.send(b.dataset.text));
            });
            return;
        }
        wrap.innerHTML = msgs.map((m, i) => this._renderBubble(m, i)).join('');
        wrap.scrollTop = wrap.scrollHeight;
    },

    _renderBubble(m, idx) {
        const isUser = m.role === 'user';
        const cls = isUser ? 'ai-msg ai-msg-user' : 'ai-msg ai-msg-claude';
        const label = isUser ? 'Ты' : 'Claude';
        const body = isUser
            ? AiChat.esc(m.content).replace(/\n/g, '<br>')
            : (AiChat.renderMarkdown(m.content) || '<span class="ai-typing">…</span>');
        return `
        <div data-idx="${idx}" class="${cls}">
            <div class="ai-msg-label">${label}</div>
            <div class="ai-msg-body">${body}</div>
        </div>`;
    },

    _updateBubble(idx) {
        const wrap = document.getElementById('ai-p-messages');
        if (!wrap) return;
        const node = wrap.querySelector(`[data-idx="${idx}"] .ai-msg-body`);
        if (!node) { this._renderMessages(); return; }
        node.innerHTML = AiChat.renderMarkdown(AiChat.state.messages[idx].content);
        wrap.scrollTop = wrap.scrollHeight;
    },

    _showFilePicker() {
        const existing = document.getElementById('ai-file-picker');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'ai-file-picker';
        modal.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:24px';
        modal.innerHTML = `
        <div class="ai-picker">
            <div class="ai-picker-header">
                <input id="ai-picker-q" type="text" placeholder="Найти файл..." autofocus />
                <button class="ai-picker-close">✕</button>
            </div>
            <div id="ai-picker-list" class="ai-picker-list"></div>
        </div>`;
        document.body.appendChild(modal);

        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
        modal.querySelector('.ai-picker-close').addEventListener('click', () => modal.remove());

        const q = document.getElementById('ai-picker-q');
        const list = document.getElementById('ai-picker-list');

        const renderList = () => {
            const items = AiChat.searchFiles(q.value);
            const attached = new Set(AiChat.state.attachedFiles.map(String));
            list.innerHTML = items.map(f => {
                const isAttached = attached.has(String(f.id));
                return `<div class="ai-picker-item ${isAttached ? 'attached' : ''}" data-fid="${f.id}">
                    <span class="ai-picker-name">${AiChat.esc(f.name || f.id)}</span>
                    <span class="ai-picker-path">${AiChat.esc(f.fullPath || '')}</span>
                    <span class="ai-picker-state">${isAttached ? 'прикреплено' : '+'}</span>
                </div>`;
            }).join('') || '<div class="ai-empty" style="padding:32px">Ничего не найдено</div>';
            list.querySelectorAll('.ai-picker-item').forEach(item => {
                item.addEventListener('click', () => {
                    const fid = item.dataset.fid;
                    if (attached.has(String(fid))) AiChat.detachFile(fid);
                    else AiChat.attachFile(fid);
                    renderList();
                });
            });
        };

        q.addEventListener('input', renderList);
        q.addEventListener('keydown', e => {
            if (e.key === 'Escape') modal.remove();
        });
        renderList();
        setTimeout(() => q.focus(), 50);
    },
};

app.register('ai', AiPage);
