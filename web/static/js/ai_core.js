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
            const msgs = Array.isArray(data.messages) ? data.messages : [];
            // Миграция старых записей: гарантируем поля tools/edits
            for (const m of msgs) {
                if (m.role === 'assistant') {
                    if (!Array.isArray(m.tools)) m.tools = [];
                    if (!Array.isArray(m.edits)) m.edits = [];
                }
            }
            this.state.messages       = msgs;
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
        s.messages.push({
            role: 'assistant',
            content: '',
            tools: [],   // [{tool, path}] — что Claude делал по дороге
            edits: [],   // [{file_id, path, old_content, new_content, status: 'pending'|'applied'|'rejected'}]
        });
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
        const m = s.messages[idx];
        if (!m) return;

        if (event === 'error') {
            m.content += `\n\n*[ошибка: ${data.error || 'unknown'}]*`;
            this._emitAll();
        } else if (event === 'delta' && typeof data.text === 'string') {
            m.content += data.text;
            this._emitDelta(idx);
        } else if (event === 'tool') {
            m.tools = m.tools || [];
            m.tools.push({ tool: data.tool, path: data.path });
            this._emitAll();
        } else if (event === 'edits') {
            m.edits = (data.edits || []).map(e => ({ ...e, status: 'pending' }));
            this._save();
            this._emitAll();
        } else if (event === 'done') {
            this._save();
            this._emitAll();
        }
    },

    async applyEdit(msgIdx, editIdx) {
        const m = this.state.messages[msgIdx];
        if (!m?.edits?.[editIdx]) return;
        const e = m.edits[editIdx];
        if (e.status !== 'pending') return;
        try {
            const res = await API.post('/api/claude/apply_edits', {
                edits: [{ file_id: e.file_id, new_content: e.new_content }],
            });
            if (res.applied?.length) {
                e.status = 'applied';
                app.toast(`Применено: ${e.path}`, 'success');
            } else if (res.errors?.length) {
                e.status = 'failed';
                e.error = res.errors[0].error;
                app.toast(`Ошибка: ${res.errors[0].error}`, 'error');
            }
        } catch (err) {
            e.status = 'failed';
            e.error = err.message;
            app.toast(err.message, 'error');
        }
        this._save();
        this._emitAll();
    },

    async applyAllEdits(msgIdx) {
        const m = this.state.messages[msgIdx];
        if (!m?.edits?.length) return;
        const pending = m.edits.filter(e => e.status === 'pending');
        if (!pending.length) return;
        try {
            const res = await API.post('/api/claude/apply_edits', {
                edits: pending.map(e => ({ file_id: e.file_id, new_content: e.new_content })),
            });
            const appliedSet = new Set((res.applied || []).map(a => a.file_id));
            const errorMap = new Map();
            for (const er of (res.errors || [])) errorMap.set(er.file_id, er.error);
            for (const e of m.edits) {
                if (e.status !== 'pending') continue;
                if (appliedSet.has(e.file_id)) e.status = 'applied';
                else if (errorMap.has(e.file_id)) { e.status = 'failed'; e.error = errorMap.get(e.file_id); }
            }
            if (res.applied?.length) app.toast(`Применено: ${res.applied.length}`, 'success');
            if (res.errors?.length) app.toast(`Ошибок: ${res.errors.length}`, 'error');
        } catch (err) {
            app.toast(err.message, 'error');
        }
        this._save();
        this._emitAll();
    },

    rejectEdit(msgIdx, editIdx) {
        const m = this.state.messages[msgIdx];
        if (!m?.edits?.[editIdx]) return;
        if (m.edits[editIdx].status !== 'pending') return;
        m.edits[editIdx].status = 'rejected';
        this._save();
        this._emitAll();
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

    /** HTML для блока tool-use'ов (что Claude делал по дороге). */
    renderTools(tools) {
        if (!tools?.length) return '';
        // Дедуплицируем подряд идущие одинаковые
        const seen = [];
        for (const t of tools) {
            const key = `${t.tool}:${t.path}`;
            if (seen.length && seen[seen.length - 1].key === key) continue;
            seen.push({ ...t, key });
        }
        const iconFor = name => ({
            'Read':  '👁',
            'Glob':  '🔍',
            'Grep':  '🔎',
            'Edit':  '✎',
            'Write': '✎',
            'MultiEdit': '✎',
        }[name] || '·');
        return `<div class="ai-tools">${seen.map(t =>
            `<span class="ai-tool"><span class="ai-tool-icon">${iconFor(t.tool)}</span>${t.tool}${t.path ? ` <code class="ai-tool-path">${this.esc(t.path)}</code>` : ''}</span>`
        ).join('')}</div>`;
    },

    /** Косметическая нормализация — должна совпадать с _normalize() на бэке. */
    _normalizeText(s) {
        if (!s) return '';
        return s
            .replace(/^﻿/, '')
            .replace(/\r\n?/g, '\n')
            .split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n')
            .replace(/\n+$/, '');
    },

    /** HTML для блока правок с кнопками. msgIdx нужен для callbacks. */
    renderEdits(msg, msgIdx) {
        if (!msg?.edits?.length) return '';
        // Фильтруем «пустые» правки (косметика line endings и пр.)
        const edits = msg.edits.filter(e =>
            this._normalizeText(e.old_content) !== this._normalizeText(e.new_content)
        );
        if (!edits.length) return '';
        const pendingCount = edits.filter(e => e.status === 'pending').length;
        const applyAll = pendingCount > 1
            ? `<button class="btn btn-primary btn-sm" data-action="apply-all" data-msg="${msgIdx}">Применить все (${pendingCount})</button>`
            : '';
        return `
        <div class="ai-edits">
            <div class="ai-edits-header">
                <span>✦ Предлагаемые правки: ${edits.length}</span>
                ${applyAll}
            </div>
            <div class="ai-edits-list">
                ${edits.map((e, i) => this._renderEditRow(e, i, msgIdx)).join('')}
            </div>
        </div>`;
    },

    _renderEditRow(e, i, msgIdx) {
        const stats = this._diffStats(e.old_content || '', e.new_content || '');
        let actions, badge;
        if (e.status === 'applied') {
            actions = `<span class="ai-edit-badge ai-edit-badge-ok">применено</span>`;
            badge = '✓';
        } else if (e.status === 'rejected') {
            actions = `<span class="ai-edit-badge ai-edit-badge-muted">отброшено</span>`;
            badge = '×';
        } else if (e.status === 'failed') {
            actions = `<span class="ai-edit-badge ai-edit-badge-err" title="${this.esc(e.error || '')}">ошибка</span>`;
            badge = '!';
        } else {
            actions = `
                <button class="btn btn-ghost btn-sm" data-action="diff" data-msg="${msgIdx}" data-idx="${i}">Diff</button>
                <button class="btn btn-primary btn-sm" data-action="apply" data-msg="${msgIdx}" data-idx="${i}">Применить</button>
                <button class="btn btn-ghost btn-sm" data-action="reject" data-msg="${msgIdx}" data-idx="${i}">Отбросить</button>`;
            badge = '✎';
        }
        return `
        <div class="ai-edit ${e.status !== 'pending' ? 'ai-edit-done' : ''}">
            <div class="ai-edit-info">
                <span class="ai-edit-icon">${badge}</span>
                <code class="ai-edit-path">${this.esc(e.path)}</code>
                <span class="ai-edit-stats">
                    <span class="ai-edit-plus">+${stats.added}</span>
                    <span class="ai-edit-minus">-${stats.removed}</span>
                </span>
            </div>
            <div class="ai-edit-actions">${actions}</div>
        </div>`;
    },

    _diffStats(oldText, newText) {
        // Простой line-level подсчёт через LCS-приближение (для UI это норм)
        const a = (oldText || '').split('\n');
        const b = (newText || '').split('\n');
        const aSet = new Set(a);
        const bSet = new Set(b);
        let added = 0, removed = 0;
        for (const line of b) if (!aSet.has(line)) added++;
        for (const line of a) if (!bSet.has(line)) removed++;
        return { added, removed };
    },

    /** Открывает Monaco diff модал для конкретной правки. */
    showDiff(msgIdx, editIdx) {
        const m = this.state.messages[msgIdx];
        if (!m?.edits?.[editIdx]) return;
        const e = m.edits[editIdx];
        AiDiffModal.show(e);
    },

    /** Привязывает обработчики к контейнеру с edit'ами. */
    bindEditActions(root) {
        root.querySelectorAll('[data-action]').forEach(btn => {
            const action = btn.dataset.action;
            const msgIdx = parseInt(btn.dataset.msg, 10);
            const idx = parseInt(btn.dataset.idx, 10);
            btn.addEventListener('click', () => {
                if (action === 'apply')      this.applyEdit(msgIdx, idx);
                else if (action === 'reject') this.rejectEdit(msgIdx, idx);
                else if (action === 'apply-all') this.applyAllEdits(msgIdx);
                else if (action === 'diff') this.showDiff(msgIdx, idx);
            });
        });
    },
};


// ── Modal для просмотра diff ────────────────────────────────────────

const AiDiffModal = {
    _editor: null,
    show(edit) {
        this.close();
        const modal = document.createElement('div');
        modal.id = 'ai-diff-modal';
        modal.style.cssText = 'position:fixed;inset:0;z-index:9100;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;padding:20px';
        modal.innerHTML = `
        <div class="ai-diff-window">
            <div class="ai-diff-header">
                <span class="ai-diff-title">Diff</span>
                <code class="ai-diff-path">${AiChat.esc(edit.path)}</code>
                <button class="ai-diff-close">✕</button>
            </div>
            <div class="ai-diff-body" id="ai-diff-body"></div>
        </div>`;
        document.body.appendChild(modal);
        modal.addEventListener('click', e => { if (e.target === modal) this.close(); });
        modal.querySelector('.ai-diff-close').addEventListener('click', () => this.close());

        // Создаём Monaco diff editor
        const wrap = document.getElementById('ai-diff-body');
        const theme = localStorage.getItem('theme') === 'light' ? 'vs' : 'custom-dark';
        const lang = edit.path.endsWith('.inc') || edit.path.endsWith('.pwn') ? 'pawn' : 'plaintext';
        this._editor = monaco.editor.createDiffEditor(wrap, {
            theme,
            readOnly: true,
            renderSideBySide: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: 13,
            lineNumbers: 'on',
            ignoreTrimWhitespace: false,
        });
        this._editor.setModel({
            original: monaco.editor.createModel(edit.old_content || '', lang),
            modified: monaco.editor.createModel(edit.new_content || '', lang),
        });
        setTimeout(() => this._editor?.layout(), 50);
    },
    close() {
        if (this._editor) { try { this._editor.dispose(); } catch {} this._editor = null; }
        const m = document.getElementById('ai-diff-modal');
        if (m) m.remove();
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
