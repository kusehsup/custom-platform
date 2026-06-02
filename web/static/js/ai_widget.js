// ── AI Assistant widget (Claude via Max subscription) ───────────────

const AiWidget = {
    _state: null,
    _bound: false,

    _initState() {
        if (this._state) return;
        let restored = {};
        try { restored = JSON.parse(localStorage.getItem('ai_chat') || '{}'); } catch {}
        this._state = {
            messages:   Array.isArray(restored.messages) ? restored.messages : [],
            model:      restored.model || null,
            includeConsole: !!restored.includeConsole,
            consoleLines:   restored.consoleLines || 200,
            includeFile:    restored.includeFile || '',
            status:     null,
            streaming:  false,
            abortCtrl:  null,
        };
    },

    _save() {
        const s = this._state;
        try {
            localStorage.setItem('ai_chat', JSON.stringify({
                messages:       s.messages.slice(-100),
                model:          s.model,
                includeConsole: s.includeConsole,
                consoleLines:   s.consoleLines,
                includeFile:    s.includeFile,
            }));
        } catch {}
    },

    toggle() {
        this._initState();
        const existing = document.getElementById('widget-ai');
        if (existing) { Widgets.toggle('widget-ai'); return; }

        Widgets.create({
            id: 'widget-ai',
            title: '✦ AI ассистент',
            width: 460,
            height: 560,
            defaultPos: { right: 24, bottom: 80 },
            content: this._template(),
        });

        this._bindUi();
        this._renderMessages();
        this._loadStatus();
        this._loadFiles();
    },

    _template() {
        return `
        <div class="ai-w">
            <div class="ai-w-status" id="ai-w-status">Загрузка…</div>

            <div class="ai-w-ctx">
                <div class="ai-w-ctx-row">
                    <label class="ai-w-field">
                        <span>Модель</span>
                        <select id="ai-w-model" class="ai-w-select"></select>
                    </label>
                </div>
                <div class="ai-w-ctx-row">
                    <label class="ai-w-check">
                        <input type="checkbox" id="ai-w-console" />
                        <span>Консоль</span>
                    </label>
                    <input type="number" id="ai-w-lines" min="10" max="2000" value="200" class="ai-w-num" title="строк" />
                    <label class="ai-w-field" style="flex:1;min-width:0">
                        <span>Файл</span>
                        <select id="ai-w-file" class="ai-w-select">
                            <option value="">— не прикреплять —</option>
                        </select>
                    </label>
                </div>
            </div>

            <div id="ai-w-messages" class="ai-w-messages"></div>

            <div class="ai-w-composer">
                <textarea id="ai-w-input" placeholder="Спросить про код, ошибку, как реализовать… (Ctrl+Enter)" rows="2"></textarea>
                <div class="ai-w-actions">
                    <button class="btn btn-ghost btn-sm" id="ai-w-clear" title="Очистить чат">Очистить</button>
                    <button class="btn btn-primary btn-sm" id="ai-w-send">Отправить</button>
                    <button class="btn btn-danger btn-sm hidden" id="ai-w-stop">Стоп</button>
                </div>
            </div>
        </div>`;
    },

    _bindUi() {
        const s = this._state;

        const $ = id => document.getElementById(id);

        $('ai-w-clear').addEventListener('click', () => {
            if (s.streaming) this._stop();
            s.messages = [];
            this._save();
            this._renderMessages();
        });

        $('ai-w-send').addEventListener('click', () => this._send());
        $('ai-w-stop').addEventListener('click', () => this._stop());

        const input = $('ai-w-input');
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                this._send();
            }
        });

        $('ai-w-console').checked = s.includeConsole;
        $('ai-w-console').addEventListener('change', e => {
            s.includeConsole = e.target.checked;
            this._save();
        });

        $('ai-w-lines').value = s.consoleLines;
        $('ai-w-lines').addEventListener('change', e => {
            s.consoleLines = parseInt(e.target.value, 10) || 200;
            this._save();
        });

        $('ai-w-file').addEventListener('change', e => {
            s.includeFile = e.target.value;
            this._save();
        });

        $('ai-w-model').addEventListener('change', e => {
            s.model = e.target.value;
            this._save();
        });
    },

    async _loadStatus() {
        const statusEl = document.getElementById('ai-w-status');
        const sendBtn  = document.getElementById('ai-w-send');
        const modelSel = document.getElementById('ai-w-model');
        try {
            const res = await API.get('/api/claude/status');
            this._state.status = res;

            if (!res.allowed) {
                statusEl.innerHTML = `<span class="ai-w-dot ai-w-dot-warn"></span>${res.reason || 'AI ассистент недоступен'}`;
                sendBtn.disabled = true;
                return;
            }
            if (!res.cli_installed || !res.logged_in) {
                statusEl.innerHTML = `<span class="ai-w-dot ai-w-dot-warn"></span>CLI не готов — открой <a href="#" id="ai-w-go-settings">Настройки</a>`;
                document.getElementById('ai-w-go-settings')?.addEventListener('click', e => {
                    e.preventDefault();
                    app.navigate('settings');
                });
                sendBtn.disabled = true;
                return;
            }

            modelSel.innerHTML = (res.models || []).map(m =>
                `<option value="${m.id}">${m.label}</option>`
            ).join('');
            const chosen = this._state.model || res.default_model || (res.models?.[0]?.id);
            this._state.model = chosen;
            modelSel.value = chosen;

            statusEl.innerHTML = `<span class="ai-w-dot ai-w-dot-ok"></span>Подключено через Max подписку`;
            sendBtn.disabled = false;
        } catch (e) {
            statusEl.textContent = e.message;
        }
    },

    async _loadFiles() {
        try {
            const data = await API.get('/api/files');
            const sel = document.getElementById('ai-w-file');
            if (!sel) return;
            const ordered = data.project_files || Object.keys(data.files || {});
            for (const fid of ordered) {
                const meta = (data.files || {})[fid];
                if (!meta) continue;
                const opt = document.createElement('option');
                opt.value = fid;
                opt.textContent = meta.fullPath || meta.name || fid;
                if (this._state.includeFile === fid) opt.selected = true;
                sel.appendChild(opt);
            }
        } catch {}
    },

    _esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },

    _renderMarkdown(text) {
        const parts = [];
        const re = /```(\w+)?\n?([\s\S]*?)```/g;
        let m;
        let last = 0;
        while ((m = re.exec(text)) !== null) {
            parts.push(this._renderInline(text.slice(last, m.index)));
            const code = m[2] || '';
            parts.push(`<pre class="ai-w-code"><code>${this._esc(code)}</code></pre>`);
            last = re.lastIndex;
        }
        parts.push(this._renderInline(text.slice(last)));
        return parts.join('');
    },

    _renderInline(text) {
        return this._esc(text)
            .replace(/`([^`\n]+)`/g, '<code class="ai-w-inline-code">$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/\n/g, '<br>');
    },

    _renderMessages() {
        const wrap = document.getElementById('ai-w-messages');
        if (!wrap) return;
        const s = this._state;
        if (!s.messages.length) {
            wrap.innerHTML = `<div class="ai-w-empty">
                Задай вопрос — Claude увидит файл и логи, если они отмечены сверху.<br>
                <span class="ai-w-hint">Ctrl+Enter — отправить</span>
            </div>`;
            return;
        }
        wrap.innerHTML = s.messages.map((m, i) => this._renderBubble(m, i)).join('');
        wrap.scrollTop = wrap.scrollHeight;
    },

    _renderBubble(m, idx) {
        const isUser = m.role === 'user';
        const cls = isUser ? 'ai-w-msg ai-w-msg-user' : 'ai-w-msg ai-w-msg-claude';
        const label = isUser ? 'Ты' : 'Claude';
        const body = isUser
            ? this._esc(m.content).replace(/\n/g, '<br>')
            : (this._renderMarkdown(m.content) || '<span class="ai-w-typing">…</span>');
        return `
        <div data-idx="${idx}" class="${cls}">
            <div class="ai-w-msg-label">${label}</div>
            <div class="ai-w-msg-body">${body}</div>
        </div>`;
    },

    async _send() {
        const s = this._state;
        if (s.streaming) return;
        const input = document.getElementById('ai-w-input');
        const text = input.value.trim();
        if (!text) return;
        input.value = '';

        s.messages.push({ role: 'user', content: text });
        s.messages.push({ role: 'assistant', content: '' });
        this._renderMessages();
        this._save();

        const idx = s.messages.length - 1;
        await this._stream(idx);
    },

    async _stream(idx) {
        const s = this._state;
        s.streaming = true;
        document.getElementById('ai-w-send').classList.add('hidden');
        document.getElementById('ai-w-stop').classList.remove('hidden');

        const ctrl = new AbortController();
        s.abortCtrl = ctrl;

        const payloadMessages = s.messages.slice(0, idx).filter(m => m.content);

        try {
            const res = await fetch('/api/claude/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(API._token ? { 'Authorization': `Bearer ${API._token}` } : {}),
                },
                body: JSON.stringify({
                    messages: payloadMessages,
                    model: s.model || null,
                    include_console: s.includeConsole,
                    console_lines: s.consoleLines,
                    include_file: s.includeFile || null,
                }),
                signal: ctrl.signal,
            });

            if (!res.ok) {
                const t = await res.text();
                throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });

                let sep;
                while ((sep = buf.indexOf('\n\n')) !== -1) {
                    const rawEvent = buf.slice(0, sep);
                    buf = buf.slice(sep + 2);
                    this._handleSse(rawEvent, idx);
                }
            }
        } catch (e) {
            if (e.name !== 'AbortError') {
                s.messages[idx].content += `\n\n*[ошибка: ${e.message}]*`;
                this._renderMessages();
            }
        } finally {
            s.streaming = false;
            s.abortCtrl = null;
            document.getElementById('ai-w-send')?.classList.remove('hidden');
            document.getElementById('ai-w-stop')?.classList.add('hidden');
            this._save();
        }
    },

    _handleSse(raw, idx) {
        let event = 'message';
        const dataLines = [];
        for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) return;
        let data;
        try { data = JSON.parse(dataLines.join('\n')); } catch { return; }

        const s = this._state;
        if (event === 'error') {
            s.messages[idx].content += `\n\n*[ошибка: ${data.error || 'unknown'}]*`;
            this._renderMessages();
        } else if (event === 'delta' && typeof data.text === 'string') {
            s.messages[idx].content += data.text;
            this._updateBubble(idx);
        } else if (event === 'done') {
            this._renderMessages();
            this._save();
        }
    },

    _updateBubble(idx) {
        const wrap = document.getElementById('ai-w-messages');
        if (!wrap) return;
        const node = wrap.querySelector(`[data-idx="${idx}"] .ai-w-msg-body`);
        if (!node) { this._renderMessages(); return; }
        node.innerHTML = this._renderMarkdown(this._state.messages[idx].content);
        wrap.scrollTop = wrap.scrollHeight;
    },

    _stop() {
        if (this._state?.abortCtrl) this._state.abortCtrl.abort();
    },
};
