// ── AiChat: общая модель + рендер для виджета и страницы ────────────

const AiChat = {
    state: {
        messages: [],           // [{role, content}]
        model: null,
        includeConsole: false,
        consoleLines: 200,
        attachedFiles: [],      // [file_id]
        status: null,
        streaming: false,
        abortCtrl: null,
    },
    // Все известные файлы проекта: {file_id: meta}
    _files: {},
    _projectOrder: [],
    _filesLoaded: false,
    // Views: каждая регистрирует свои render-функции
    _views: [],

    _restore() {
        try {
            const raw = localStorage.getItem('ai_chat');
            if (!raw) return;
            const data = JSON.parse(raw);
            this.state.messages       = Array.isArray(data.messages) ? data.messages : [];
            this.state.model          = data.model || null;
            this.state.includeConsole = !!data.includeConsole;
            this.state.consoleLines   = data.consoleLines || 200;
            this.state.attachedFiles  = Array.isArray(data.attachedFiles) ? data.attachedFiles : [];
        } catch {}
    },

    _save() {
        try {
            localStorage.setItem('ai_chat', JSON.stringify({
                messages:       this.state.messages.slice(-100),
                model:          this.state.model,
                includeConsole: this.state.includeConsole,
                consoleLines:   this.state.consoleLines,
                attachedFiles:  this.state.attachedFiles,
            }));
        } catch {}
    },

    init() {
        if (this._inited) return;
        this._inited = true;
        this._restore();
    },

    registerView(view) {
        this._views.push(view);
    },

    _emitAll() {
        for (const v of this._views) {
            try { v.onChange?.(); } catch {}
        }
    },

    _emitDelta(idx) {
        for (const v of this._views) {
            try { v.onDelta?.(idx); } catch {}
        }
    },

    async loadStatus() {
        try {
            const res = await API.get('/api/claude/status');
            this.state.status = res;
            if (res.models && !this.state.model) {
                this.state.model = res.default_model || res.models[0]?.id;
            }
            this._emitAll();
            return res;
        } catch (e) {
            this.state.status = { error: e.message };
            this._emitAll();
            return null;
        }
    },

    async loadFiles() {
        if (this._filesLoaded) return;
        try {
            const data = await API.get('/api/files');
            this._files = data.files || {};
            this._projectOrder = data.project_files || Object.keys(this._files);
            this._filesLoaded = true;
            this._emitAll();
        } catch {}
    },

    getFile(fid) {
        return this._files[fid];
    },

    /** Список файлов для @-автокомплита и пикера. */
    listFiles() {
        const out = [];
        const seen = new Set();
        for (const fid of this._projectOrder) {
            if (this._files[fid]) {
                out.push({ id: fid, ...this._files[fid] });
                seen.add(String(fid));
            }
        }
        for (const fid of Object.keys(this._files)) {
            if (!seen.has(String(fid))) {
                out.push({ id: fid, ...this._files[fid] });
            }
        }
        return out;
    },

    searchFiles(q) {
        const query = (q || '').toLowerCase().trim();
        const list = this.listFiles();
        if (!query) return list.slice(0, 20);
        const scored = [];
        for (const f of list) {
            const path = (f.fullPath || f.name || '').toLowerCase();
            const name = (f.name || '').toLowerCase();
            if (name.startsWith(query)) scored.push([0, f]);
            else if (name.includes(query)) scored.push([1, f]);
            else if (path.includes(query)) scored.push([2, f]);
        }
        scored.sort((a, b) => a[0] - b[0]);
        return scored.slice(0, 30).map(x => x[1]);
    },

    attachFile(fid) {
        if (!fid) return;
        const sid = String(fid);
        if (this.state.attachedFiles.includes(sid)) return;
        this.state.attachedFiles.push(sid);
        this._save();
        this._emitAll();
    },

    detachFile(fid) {
        const sid = String(fid);
        this.state.attachedFiles = this.state.attachedFiles.filter(x => x !== sid);
        this._save();
        this._emitAll();
    },

    setIncludeConsole(v) { this.state.includeConsole = !!v; this._save(); this._emitAll(); },
    setConsoleLines(n)   { this.state.consoleLines = parseInt(n, 10) || 200; this._save(); this._emitAll(); },
    setModel(m)          { this.state.model = m; this._save(); this._emitAll(); },

    clear() {
        if (this.state.streaming) this.stop();
        this.state.messages = [];
        this._save();
        this._emitAll();
    },

    async send(text) {
        const s = this.state;
        if (s.streaming) return;
        text = (text || '').trim();
        if (!text) return;

        s.messages.push({ role: 'user', content: text });
        s.messages.push({ role: 'assistant', content: '' });
        this._save();
        this._emitAll();

        const idx = s.messages.length - 1;
        await this._stream(idx);
    },

    async _stream(idx) {
        const s = this.state;
        s.streaming = true;
        this._emitAll();

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
                    attached_files: s.attachedFiles,
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
                this._emitAll();
            }
        } finally {
            s.streaming = false;
            s.abortCtrl = null;
            this._save();
            this._emitAll();
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

        const s = this.state;
        if (event === 'error') {
            s.messages[idx].content += `\n\n*[ошибка: ${data.error || 'unknown'}]*`;
            this._emitAll();
        } else if (event === 'delta' && typeof data.text === 'string') {
            s.messages[idx].content += data.text;
            this._emitDelta(idx);
        } else if (event === 'done') {
            this._save();
            this._emitAll();
        }
    },

    stop() {
        if (this.state.abortCtrl) this.state.abortCtrl.abort();
    },

    // ── Helpers для рендера ─────────────────────────────────────────

    esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },

    renderMarkdown(text) {
        const parts = [];
        const re = /```(\w+)?\n?([\s\S]*?)```/g;
        let m;
        let last = 0;
        while ((m = re.exec(text)) !== null) {
            parts.push(this._renderInline(text.slice(last, m.index)));
            const code = m[2] || '';
            parts.push(`<pre class="ai-code"><code>${this.esc(code)}</code></pre>`);
            last = re.lastIndex;
        }
        parts.push(this._renderInline(text.slice(last)));
        return parts.join('');
    },

    _renderInline(text) {
        return this.esc(text)
            .replace(/`([^`\n]+)`/g, '<code class="ai-inline-code">$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/\n/g, '<br>');
    },
};


// ── @-автокомплит для composer'а (общий для виджета и страницы) ────

const AiMentions = {
    /**
     * Прикрепляет автокомплит к textarea.
     * Контейнер `mount` — куда позиционировать выпадашку (relative).
     */
    attach(textarea, mount) {
        let popup = null;
        let items = [];
        let active = 0;
        let trigger = null;     // { start } позиция @ в тексте

        const close = () => {
            if (popup) popup.remove();
            popup = null;
            items = [];
            trigger = null;
        };

        const render = () => {
            if (!popup) {
                popup = document.createElement('div');
                popup.className = 'ai-mentions';
                mount.appendChild(popup);
            }
            popup.innerHTML = items.map((f, i) => `
                <div class="ai-mention-item ${i === active ? 'active' : ''}" data-idx="${i}">
                    <span class="ai-mention-name">${AiChat.esc(f.name || f.fullPath || f.id)}</span>
                    <span class="ai-mention-path">${AiChat.esc(f.fullPath || '')}</span>
                </div>`).join('');
            popup.querySelectorAll('.ai-mention-item').forEach(el => {
                el.addEventListener('mousedown', e => {
                    e.preventDefault();
                    active = parseInt(el.dataset.idx, 10);
                    pick();
                });
            });
        };

        const pick = () => {
            const f = items[active];
            if (!f) return;
            AiChat.attachFile(f.id);
            // Удаляем @фрагмент из textarea
            const v = textarea.value;
            const before = v.slice(0, trigger.start);
            const cursor = textarea.selectionStart;
            const after = v.slice(cursor);
            textarea.value = before + after;
            textarea.selectionStart = textarea.selectionEnd = before.length;
            close();
            textarea.focus();
        };

        const update = () => {
            const v = textarea.value;
            const cursor = textarea.selectionStart;
            // Ищем @ слева от курсора, без пробелов/переносов между @ и cursor
            let i = cursor - 1;
            while (i >= 0) {
                const ch = v[i];
                if (ch === '@') break;
                if (/\s/.test(ch)) { i = -1; break; }
                i--;
            }
            if (i < 0) { close(); return; }
            // @ должна быть в начале или после пробела
            if (i > 0 && !/\s/.test(v[i - 1])) { close(); return; }
            const query = v.slice(i + 1, cursor);
            trigger = { start: i };
            items = AiChat.searchFiles(query);
            active = 0;
            if (!items.length) { close(); return; }
            render();
        };

        textarea.addEventListener('input', update);
        textarea.addEventListener('click', update);
        textarea.addEventListener('keydown', e => {
            if (!popup) return;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                active = (active + 1) % items.length;
                render();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                active = (active - 1 + items.length) % items.length;
                render();
            } else if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                pick();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                close();
            }
        });
        textarea.addEventListener('blur', () => {
            // Даём время mousedown сработать
            setTimeout(close, 100);
        });

        return { close };
    },
};
