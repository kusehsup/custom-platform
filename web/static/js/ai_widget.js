// ── AI Assistant: compact widget ────────────────────────────────────

const AiWidget = {
    _registered: false,

    toggle() {
        AiChat.init();

        const existing = document.getElementById('widget-ai');
        if (existing) { Widgets.toggle('widget-ai'); return; }

        Widgets.create({
            id: 'widget-ai',
            title: '✦ AI ассистент',
            width: 480,
            height: 600,
            defaultPos: { right: 24, bottom: 80 },
            content: this._template(),
        });

        this._bind();
        if (!this._registered) {
            AiChat.registerView({
                onChange: () => this._renderAll(),
                onDelta:  idx => this._updateBubble(idx),
            });
            this._registered = true;
        }

        this._renderAll();
        AiChat.loadStatus().then(() => AiChat.loadUsage());
        AiChat.loadFiles();
    },

    _template() {
        return `
        <div class="ai">
            <div class="ai-statusbar">
                <div class="ai-status" id="ai-w-status">Загрузка…</div>
                <button class="ai-usage-btn" id="ai-w-usage" title="Расход Claude за сегодня"></button>
            </div>
            <div class="ai-active-task-bar" id="ai-w-active-task"></div>

            <div class="ai-ctx">
                <div class="ai-ctx-row">
                    <label class="ai-field" style="flex:1">
                        <span>Модель</span>
                        <select id="ai-w-model" class="ai-select"></select>
                    </label>
                    <div class="ai-toggle-row" title="Прикрепить логи сервера">
                        <label class="toggle">
                            <input type="checkbox" id="ai-w-console" />
                            <span class="toggle-track"></span>
                        </label>
                        <span class="ai-toggle-label" id="ai-w-console-lbl">Консоль</span>
                    </div>
                    <input type="number" id="ai-w-lines" min="10" max="2000" value="200" class="ai-num" title="строк лога" />
                </div>
            </div>

            <div id="ai-w-chips" class="ai-chips"></div>

            <div id="ai-w-messages" class="ai-messages"></div>

            <div class="ai-composer-wrap">
                <div class="ai-composer">
                    <textarea id="ai-w-input" placeholder="Спросить про Pawn-код. @ — прикрепить файл. Enter — отправить, Shift+Enter — новая строка." rows="2"></textarea>
                </div>
                <div class="ai-actions">
                    <button class="btn btn-ghost btn-sm" id="ai-w-clear">Очистить</button>
                    <button class="btn btn-primary btn-sm" id="ai-w-send">Отправить</button>
                    <button class="btn btn-danger btn-sm hidden" id="ai-w-stop">Стоп</button>
                </div>
            </div>
        </div>`;
    },

    _bind() {
        const $ = id => document.getElementById(id);

        $('ai-w-clear').addEventListener('click', () => AiChat.clear());
        $('ai-w-send').addEventListener('click', () => this._sendFromInput());
        $('ai-w-stop').addEventListener('click', () => AiChat.stop());
        $('ai-w-usage').addEventListener('click', () => AiUsageModal.show());

        const input = $('ai-w-input');
        input.addEventListener('keydown', e => {
            // Если открыт popup автокомплита — AiMentions сам перехватит Enter
            if (e.key === 'Enter' && !e.shiftKey) {
                if (input.closest('.ai-composer-wrap')?.querySelector('.ai-mentions')) return;
                e.preventDefault();
                this._sendFromInput();
            }
        });

        $('ai-w-console').addEventListener('change', e => AiChat.setIncludeConsole(e.target.checked));
        $('ai-w-console-lbl')?.addEventListener('click', () => {
            const cb = $('ai-w-console');
            cb.checked = !cb.checked;
            AiChat.setIncludeConsole(cb.checked);
        });
        $('ai-w-lines').addEventListener('change', e => AiChat.setConsoleLines(e.target.value));
        $('ai-w-model').addEventListener('change', e => AiChat.setModel(e.target.value));

        // @-mentions
        const composerWrap = input.closest('.ai-composer-wrap');
        AiMentions.attach(input, composerWrap);
    },

    _sendFromInput() {
        const input = document.getElementById('ai-w-input');
        if (!input) return;
        const v = input.value;
        input.value = '';
        AiChat.send(v);
    },

    _renderAll() {
        if (!document.getElementById('widget-ai')) return;
        this._renderStatus();
        this._renderModel();
        this._renderControls();
        this._renderChips();
        this._renderMessages();
        const usageBtn = document.getElementById('ai-w-usage');
        if (usageBtn) usageBtn.innerHTML = AiChat.renderUsageBadge();
        const activeTaskBar = document.getElementById('ai-w-active-task');
        if (activeTaskBar) {
            activeTaskBar.innerHTML = AiChat.renderActiveTaskPicker();
            activeTaskBar.querySelector('[data-action="pick-task"]')?.addEventListener('click', () => AiChat.showTaskPicker());
        }
    },

    _renderStatus() {
        const el = document.getElementById('ai-w-status');
        const send = document.getElementById('ai-w-send');
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
            el.innerHTML = `<span class="ai-dot ai-dot-warn"></span>CLI не готов — открой <a href="#" id="ai-w-go-settings">Настройки</a>`;
            document.getElementById('ai-w-go-settings')?.addEventListener('click', e => {
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
        const sel = document.getElementById('ai-w-model');
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
        const cb = document.getElementById('ai-w-console');
        const num = document.getElementById('ai-w-lines');
        if (cb) cb.checked = AiChat.state.includeConsole;
        if (num) num.value = AiChat.state.consoleLines;

        const send = document.getElementById('ai-w-send');
        const stop = document.getElementById('ai-w-stop');
        if (AiChat.state.streaming) {
            send?.classList.add('hidden');
            stop?.classList.remove('hidden');
        } else {
            send?.classList.remove('hidden');
            stop?.classList.add('hidden');
        }
    },

    _renderChips() {
        const wrap = document.getElementById('ai-w-chips');
        if (!wrap) return;
        const fids = AiChat.state.attachedFiles;
        if (!fids.length) {
            wrap.innerHTML = '';
            wrap.style.display = 'none';
            return;
        }
        wrap.style.display = 'flex';
        wrap.innerHTML = fids.map(fid => {
            const meta = AiChat.getFile(fid) || {};
            const name = meta.name || meta.fullPath || fid;
            return `<span class="ai-chip" data-fid="${fid}" title="${AiChat.esc(meta.fullPath || name)}">
                <span class="ai-chip-name">${AiChat.esc(name)}</span>
                <button class="ai-chip-x" data-fid="${fid}">✕</button>
            </span>`;
        }).join('');
        wrap.querySelectorAll('.ai-chip-x').forEach(btn => {
            btn.addEventListener('click', () => AiChat.detachFile(btn.dataset.fid));
        });
    },

    _renderMessages() {
        const wrap = document.getElementById('ai-w-messages');
        if (!wrap) return;
        const msgs = AiChat.state.messages;
        if (!msgs.length) {
            wrap.innerHTML = `<div class="ai-empty">
                Задай вопрос. Через <code class="ai-inline-code">@</code> прикрепи файл.<br>
                <span class="ai-hint">Enter — отправить · Shift+Enter — новая строка</span>
            </div>`;
            return;
        }
        wrap.innerHTML = msgs.map((m, i) => this._renderBubble(m, i)).join('');
        wrap.scrollTop = wrap.scrollHeight;
        AiChat.bindEditActions(wrap);
    },

    _renderBubble(m, idx) {
        const isUser = m.role === 'user';
        const cls = isUser ? 'ai-msg ai-msg-user' : 'ai-msg ai-msg-claude';
        const label = isUser ? 'Ты' : 'Claude';
        if (isUser) {
            return `
            <div data-idx="${idx}" class="${cls}">
                <div class="ai-msg-label">${label}</div>
                <div class="ai-msg-body">${AiChat.esc(m.content).replace(/\n/g, '<br>')}</div>
            </div>`;
        }
        const tools = AiChat.renderTools(m.tools);
        const text = AiChat.renderMarkdown(m.content) || (m.tools?.length ? '' : '<span class="ai-typing">…</span>');
        const edits = AiChat.renderEdits(m, idx);
        return `
        <div data-idx="${idx}" class="${cls}">
            <div class="ai-msg-label">${label}</div>
            ${tools}
            ${text ? `<div class="ai-msg-body">${text}</div>` : ''}
            ${edits}
        </div>`;
    },

    _updateBubble(idx) {
        const wrap = document.getElementById('ai-w-messages');
        if (!wrap) return;
        const node = wrap.querySelector(`[data-idx="${idx}"] .ai-msg-body`);
        if (!node) { this._renderMessages(); return; }
        node.innerHTML = AiChat.renderMarkdown(AiChat.state.messages[idx].content);
        wrap.scrollTop = wrap.scrollHeight;
    },
};
