// ── AI Assistant (Claude) ─────────────────────────────────────────

const AiPage = {
    _messages: [],            // [{role, content}]
    _streaming: false,
    _abortCtrl: null,
    _opts: {
        include_console: false,
        console_lines: 200,
        include_file: '',     // file_id
    },
    _files: {},               // {file_id: meta} для селектора

    render(el) {
        el.innerHTML = `
        <div style="display:flex;flex-direction:column;height:calc(100vh - 90px);min-height:0">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-shrink:0">
                <div>
                    <h2 style="font-size:18px;font-weight:600;color:var(--text);margin:0">AI ассистент</h2>
                    <div id="ai-status" style="font-size:11px;color:var(--text-3);margin-top:2px">Загрузка...</div>
                </div>
                <div style="display:flex;gap:6px">
                    <button class="btn btn-ghost btn-sm" id="ai-clear">Очистить чат</button>
                </div>
            </div>

            <div id="ai-context-bar" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:8px 12px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:8px;flex-shrink:0">
                <label style="display:flex;gap:6px;align-items:center;font-size:12px;color:var(--text-2);cursor:pointer">
                    <input type="checkbox" id="ai-include-console" style="margin:0" />
                    Консоль сервера
                </label>
                <input type="number" id="ai-console-lines" min="10" max="2000" value="200" style="width:80px;font-size:12px;padding:3px 6px" title="Сколько последних строк лога" />
                <div style="width:1px;height:18px;background:var(--border)"></div>
                <label style="display:flex;gap:6px;align-items:center;font-size:12px;color:var(--text-2)">
                    Файл
                    <select id="ai-include-file" style="font-size:12px;padding:3px 6px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-xs);max-width:280px">
                        <option value="">— не прикреплять —</option>
                    </select>
                </label>
            </div>

            <div id="ai-messages" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:14px;padding:8px 4px;min-height:0"></div>

            <div style="display:flex;gap:8px;align-items:flex-end;padding-top:10px;border-top:1px solid var(--border);flex-shrink:0">
                <textarea id="ai-input" placeholder="Спросить про код, ошибку из консоли, как реализовать..." rows="2"
                    style="flex:1;resize:none;font-family:var(--mono);font-size:13px;padding:8px 10px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:var(--radius);min-height:44px;max-height:160px"></textarea>
                <button class="btn btn-primary" id="ai-send" style="height:44px">Отправить</button>
                <button class="btn btn-danger btn-sm" id="ai-stop" style="display:none;height:44px">Стоп</button>
            </div>
        </div>`;

        document.getElementById('ai-clear').addEventListener('click', () => this._clearChat());
        document.getElementById('ai-send').addEventListener('click', () => this._sendMessage());
        document.getElementById('ai-stop').addEventListener('click', () => this._stopStream());

        const input = document.getElementById('ai-input');
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                this._sendMessage();
            }
        });

        document.getElementById('ai-include-console').addEventListener('change', e => {
            this._opts.include_console = e.target.checked;
        });
        document.getElementById('ai-console-lines').addEventListener('change', e => {
            this._opts.console_lines = parseInt(e.target.value, 10) || 200;
        });
        document.getElementById('ai-include-file').addEventListener('change', e => {
            this._opts.include_file = e.target.value;
        });

        this._restoreState();
        this._renderMessages();
        this._loadStatus();
        this._loadFiles();
    },

    async _loadStatus() {
        const el = document.getElementById('ai-status');
        try {
            const res = await API.get('/api/claude/status');
            if (!res.connected) {
                el.innerHTML = `<span style="color:var(--orange,#f59e0b)">Claude не подключён. Открой <a href="#" id="ai-go-settings" style="color:var(--text-2);text-decoration:underline">Настройки</a></span>`;
                document.getElementById('ai-go-settings')?.addEventListener('click', e => {
                    e.preventDefault();
                    app.navigate('settings');
                });
                document.getElementById('ai-send').disabled = true;
                return;
            }
            const modelLabel = (res.models || []).find(m => m.id === res.model)?.label || res.model;
            el.innerHTML = `<span style="color:var(--green)">●</span> Модель: ${modelLabel}`;
        } catch (e) {
            el.textContent = e.message;
        }
    },

    async _loadFiles() {
        try {
            const data = await API.get('/api/files');
            this._files = data.files || {};
            const sel = document.getElementById('ai-include-file');
            const ordered = data.project_files || Object.keys(this._files);
            for (const fid of ordered) {
                const meta = this._files[fid];
                if (!meta) continue;
                const opt = document.createElement('option');
                opt.value = fid;
                opt.textContent = meta.fullPath || meta.name || fid;
                if (this._opts.include_file === fid) opt.selected = true;
                sel.appendChild(opt);
            }
        } catch {}
    },

    _saveState() {
        try {
            localStorage.setItem('ai_chat', JSON.stringify({
                messages: this._messages.slice(-100),
                opts: this._opts,
            }));
        } catch {}
    },

    _restoreState() {
        try {
            const raw = localStorage.getItem('ai_chat');
            if (!raw) return;
            const data = JSON.parse(raw);
            this._messages = Array.isArray(data.messages) ? data.messages : [];
            this._opts = { ...this._opts, ...(data.opts || {}) };
            document.getElementById('ai-include-console').checked = !!this._opts.include_console;
            document.getElementById('ai-console-lines').value = this._opts.console_lines;
        } catch {}
    },

    _clearChat() {
        if (this._streaming) this._stopStream();
        this._messages = [];
        this._saveState();
        this._renderMessages();
    },

    _esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },

    _renderMarkdown(text) {
        // Минимальный safe-markdown: code fences + inline code + переносы
        const parts = [];
        let i = 0;
        const re = /```(\w+)?\n?([\s\S]*?)```/g;
        let m;
        let last = 0;
        while ((m = re.exec(text)) !== null) {
            const before = text.slice(last, m.index);
            parts.push(this._renderInline(before));
            const lang = m[1] || '';
            const code = m[2] || '';
            parts.push(`<pre style="background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-xs);padding:10px 12px;overflow-x:auto;font-family:var(--mono);font-size:12px;margin:6px 0;line-height:1.55"><code>${this._esc(code)}</code></pre>`);
            last = re.lastIndex;
        }
        parts.push(this._renderInline(text.slice(last)));
        return parts.join('');
    },

    _renderInline(text) {
        const escaped = this._esc(text);
        return escaped
            .replace(/`([^`\n]+)`/g, '<code style="background:var(--bg);border:1px solid var(--border);border-radius:3px;padding:1px 5px;font-family:var(--mono);font-size:12px">$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/\n/g, '<br>');
    },

    _renderMessages() {
        const wrap = document.getElementById('ai-messages');
        if (!wrap) return;
        if (!this._messages.length) {
            wrap.innerHTML = `<div style="margin:auto;color:var(--text-3);font-size:13px;text-align:center;padding:32px">
                Задай вопрос — Claude увидит выбранный файл и логи сервера, если они отмечены сверху.<br>
                <span style="font-size:11px">Ctrl+Enter — отправить</span>
            </div>`;
            return;
        }
        wrap.innerHTML = this._messages.map((m, idx) => this._renderBubble(m, idx)).join('');
        wrap.scrollTop = wrap.scrollHeight;
    },

    _renderBubble(m, idx) {
        const isUser = m.role === 'user';
        const align = isUser ? 'flex-end' : 'flex-start';
        const bg = isUser ? 'var(--accent, #2563eb)' : 'var(--surface)';
        const color = isUser ? '#fff' : 'var(--text)';
        const border = isUser ? 'none' : '1px solid var(--border)';
        const label = isUser ? 'Ты' : 'Claude';
        const body = isUser ? this._esc(m.content).replace(/\n/g, '<br>') : this._renderMarkdown(m.content);
        return `
        <div data-idx="${idx}" style="display:flex;flex-direction:column;align-items:${align};max-width:100%">
            <div style="font-size:10px;color:var(--text-3);margin-bottom:3px;text-transform:uppercase;letter-spacing:0.5px">${label}</div>
            <div style="background:${bg};color:${color};border:${border};border-radius:var(--radius);padding:10px 14px;max-width:min(820px,92%);font-size:13px;line-height:1.55;white-space:normal;word-wrap:break-word">${body || '<span style="opacity:0.5">…</span>'}</div>
        </div>`;
    },

    async _sendMessage() {
        if (this._streaming) return;
        const input = document.getElementById('ai-input');
        const text = input.value.trim();
        if (!text) return;
        input.value = '';

        this._messages.push({ role: 'user', content: text });
        this._messages.push({ role: 'assistant', content: '' });
        this._renderMessages();
        this._saveState();

        const assistantIdx = this._messages.length - 1;
        await this._streamReply(assistantIdx);
    },

    async _streamReply(assistantIdx) {
        this._streaming = true;
        document.getElementById('ai-send').style.display = 'none';
        document.getElementById('ai-stop').style.display = 'inline-flex';

        const ctrl = new AbortController();
        this._abortCtrl = ctrl;

        const payloadMessages = this._messages
            .slice(0, assistantIdx)  // только user + предыдущие assistant
            .filter(m => m.content);

        try {
            const res = await fetch('/api/claude/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(API._token ? { 'Authorization': `Bearer ${API._token}` } : {}),
                },
                body: JSON.stringify({
                    messages: payloadMessages,
                    include_console: this._opts.include_console,
                    console_lines: this._opts.console_lines,
                    include_file: this._opts.include_file || null,
                    max_tokens: 4096,
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

                // SSE: events separated by \n\n
                let sep;
                while ((sep = buf.indexOf('\n\n')) !== -1) {
                    const rawEvent = buf.slice(0, sep);
                    buf = buf.slice(sep + 2);
                    this._handleSseEvent(rawEvent, assistantIdx);
                }
            }
        } catch (e) {
            if (e.name !== 'AbortError') {
                this._messages[assistantIdx].content += `\n\n*[ошибка: ${e.message}]*`;
                this._renderMessages();
            }
        } finally {
            this._streaming = false;
            this._abortCtrl = null;
            document.getElementById('ai-send').style.display = 'inline-flex';
            document.getElementById('ai-stop').style.display = 'none';
            this._saveState();
        }
    },

    _handleSseEvent(raw, assistantIdx) {
        // Парсим SSE-блок: строки event:/data:
        let event = 'message';
        const dataLines = [];
        for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) return;
        const dataStr = dataLines.join('\n');
        let data;
        try { data = JSON.parse(dataStr); } catch { return; }

        if (event === 'error') {
            this._messages[assistantIdx].content += `\n\n*[ошибка Anthropic: ${data.error || 'unknown'}]*`;
            this._renderMessages();
            return;
        }

        // Anthropic SSE events
        const t = data.type;
        if (t === 'content_block_delta' && data.delta?.type === 'text_delta') {
            this._messages[assistantIdx].content += data.delta.text;
            this._updateAssistantBubble(assistantIdx);
        } else if (t === 'message_stop') {
            this._renderMessages();
            this._saveState();
        }
    },

    _updateAssistantBubble(idx) {
        const wrap = document.getElementById('ai-messages');
        if (!wrap) return;
        const node = wrap.querySelector(`[data-idx="${idx}"]`);
        if (!node) {
            this._renderMessages();
            return;
        }
        const bubble = node.querySelector('div:last-child');
        if (bubble) bubble.innerHTML = this._renderMarkdown(this._messages[idx].content);
        wrap.scrollTop = wrap.scrollHeight;
    },

    _stopStream() {
        if (this._abortCtrl) this._abortCtrl.abort();
    },
};

app.register('ai', AiPage);
