// ── AiChat: общая модель + рендер для виджета и страницы ────────────

const AiChat = {
    state: {
        messages: [],           // [{role, content, tools?, edits?}]
        model: null,
        includeConsole: false,
        consoleLines: 200,
        attachedFiles: [],      // [file_id]
        status: null,
        streaming: false,
        abortCtrl: null,
        usage: null,
        // Треды
        threads: [],            // [{id, title, task_id, message_count, updated_at}]
        currentThread: 'main',
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
            this.state.model          = data.model || null;
            this.state.includeConsole = !!data.includeConsole;
            this.state.consoleLines   = data.consoleLines || 200;
            this.state.attachedFiles  = Array.isArray(data.attachedFiles) ? data.attachedFiles : [];
            this.state.currentThread  = data.currentThread || 'main';
        } catch {}
    },

    _save() {
        // История сообщений теперь на сервере. В localStorage — только настройки.
        try {
            localStorage.setItem('ai_chat', JSON.stringify({
                model:          this.state.model,
                includeConsole: this.state.includeConsole,
                consoleLines:   this.state.consoleLines,
                attachedFiles:  this.state.attachedFiles,
                currentThread:  this.state.currentThread,
            }));
        } catch {}
    },

    init() {
        if (this._inited) return;
        this._inited = true;
        this._restore();
        // Подписываемся на изменения задач, чтобы шапка с активной задачей обновлялась
        if (typeof TasksStore !== 'undefined') {
            TasksStore.subscribe(() => this._emitAll());
            TasksStore.load();
        }
    },

    /** Вызывается виджетом/страницей при открытии — гарантированно подтягивает треды. */
    async ensureThreadsLoaded() {
        await this.loadThreads();
        await this.loadThreadMessages();
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

    async loadThreads() {
        try {
            const res = await API.get('/api/claude/threads');
            this.state.threads = res.threads || [];
            // Если currentThread не существует среди тредов — переключаемся на main
            if (!this.state.threads.some(t => t.id === this.state.currentThread)) {
                this.state.currentThread = res.current_thread || 'main';
            }
            this._save();
            this._emitAll();
        } catch {}
    },

    async loadThreadMessages(threadId = null) {
        const tid = threadId || this.state.currentThread || 'main';
        try {
            const res = await API.get(`/api/claude/threads/${encodeURIComponent(tid)}`);
            const thread = res.thread || {};
            const msgs = Array.isArray(thread.messages) ? thread.messages : [];
            // Гарантируем поля tools/edits в assistant-сообщениях
            for (const m of msgs) {
                if (m.role === 'assistant') {
                    if (!Array.isArray(m.tools)) m.tools = [];
                    if (!Array.isArray(m.edits)) m.edits = [];
                }
            }
            this.state.messages = msgs;
            this._emitAll();
        } catch {}
    },

    async switchThread(threadId) {
        if (this.state.streaming) {
            app.toast('Сначала останови текущий ответ', 'info');
            return;
        }
        this.state.currentThread = threadId;
        this._save();
        try {
            await API.post('/api/claude/threads/current', { thread_id: threadId });
        } catch (e) {
            app.toast(e.message, 'error');
        }
        await this.loadThreadMessages(threadId);
        await this.loadThreads();
    },

    async openTaskThread(taskId) {
        await this.switchThread(`task:${taskId}`);
    },

    async renameThread(threadId, title) {
        try {
            await API.post(`/api/claude/threads/${encodeURIComponent(threadId)}/rename`, { title });
            await this.loadThreads();
        } catch (e) {
            app.toast(e.message, 'error');
        }
    },

    async deleteThread(threadId) {
        try {
            await API.delete(`/api/claude/threads/${encodeURIComponent(threadId)}`);
            if (this.state.currentThread === threadId) {
                this.state.currentThread = 'main';
                await this.loadThreadMessages('main');
            }
            await this.loadThreads();
        } catch (e) {
            app.toast(e.message, 'error');
        }
    },

    async clearCurrentThread() {
        if (this.state.streaming) this.stop();
        try {
            await API.post(`/api/claude/threads/${encodeURIComponent(this.state.currentThread)}/clear`);
            this.state.messages = [];
            this._emitAll();
        } catch (e) {
            app.toast(e.message, 'error');
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

    async loadUsage() {
        if (!this.state.status?.allowed) return;
        try {
            const res = await API.get('/api/claude/usage');
            this.state.usage = res;
            this._emitAll();
        } catch {}
    },

    async loadUsageHistory(days = 30) {
        try {
            return await API.get('/api/claude/usage/history?days=' + days);
        } catch {
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
        // Сейчас clear ходит на сервер чтобы стереть и серверную копию
        this.clearCurrentThread();
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
            tools: [],
            edits: [],
            actions: [],  // [{id, kind, summary, status}]
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
                    thread_id: s.currentThread || 'main',
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
            // Подтягиваем список тредов чтобы обновить message_count/updated_at
            this.loadThreads();
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
        } else if (event === 'actions') {
            m.actions = data.actions || [];
            this._save();
            this._emitAll();
        } else if (event === 'usage') {
            this.state.usage = data;
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

    async approveAction(msgIdx, actIdx) {
        const m = this.state.messages[msgIdx];
        const action = m?.actions?.[actIdx];
        if (!action || action.status !== 'pending') return;
        try {
            const res = await API.post(`/api/claude/pending_actions/${action.id}/approve`);
            action.status = res.action?.status || (res.ok ? 'approved' : 'failed');
            action.result = res.action?.result;
            this._save(); this._emitAll();
            app.toast(res.ok ? `${action.summary}: ${action.result || 'OK'}` : `Ошибка: ${action.result}`,
                      res.ok ? 'success' : 'error');
        } catch (e) {
            action.status = 'failed';
            action.result = e.message;
            this._save(); this._emitAll();
            app.toast(e.message, 'error');
        }
    },

    async rejectAction(msgIdx, actIdx) {
        const m = this.state.messages[msgIdx];
        const action = m?.actions?.[actIdx];
        if (!action || action.status !== 'pending') return;
        try {
            await API.post(`/api/claude/pending_actions/${action.id}/reject`);
            action.status = 'rejected';
            this._save(); this._emitAll();
        } catch (e) {
            app.toast(e.message, 'error');
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
            parts.push(this._renderBlocks(text.slice(last, m.index)));
            const code = m[2] || '';
            parts.push(`<pre class="ai-code"><code>${this.esc(code)}</code></pre>`);
            last = re.lastIndex;
        }
        parts.push(this._renderBlocks(text.slice(last)));
        return parts.join('');
    },

    /** Между code-fence: ищем таблицы (GFM), остальное — inline. */
    _renderBlocks(text) {
        if (!text) return '';
        const lines = text.split('\n');
        const out = [];
        let i = 0;
        while (i < lines.length) {
            // Detect table: header line with |, then separator line ---|---
            const line = lines[i];
            const next = lines[i + 1] || '';
            if (this._looksLikeTableHeader(line) && this._looksLikeTableSep(next)) {
                // Сбор таблицы
                const headers = this._splitRow(line);
                const tbodyRows = [];
                let j = i + 2;
                while (j < lines.length && lines[j].includes('|') && lines[j].trim()) {
                    tbodyRows.push(this._splitRow(lines[j]));
                    j++;
                }
                out.push(this._tableHtml(headers, tbodyRows));
                i = j;
                continue;
            }
            // Обычная строка — копим до следующей таблицы / конца
            const buf = [];
            while (i < lines.length) {
                const cur = lines[i];
                const nxt = lines[i + 1] || '';
                if (this._looksLikeTableHeader(cur) && this._looksLikeTableSep(nxt)) break;
                buf.push(cur);
                i++;
            }
            out.push(this._renderInline(buf.join('\n')));
        }
        return out.join('');
    },

    _looksLikeTableHeader(line) {
        if (!line) return false;
        const t = line.trim();
        if (!t.includes('|')) return false;
        // Хотя бы 2 столбца
        const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|');
        return cells.length >= 2;
    },

    _looksLikeTableSep(line) {
        if (!line) return false;
        const t = line.trim();
        if (!t.includes('|') || !t.includes('-')) return false;
        // Каждая ячейка должна состоять из -, :, пробелов
        const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|');
        return cells.every(c => /^\s*:?-{2,}:?\s*$/.test(c));
    },

    _splitRow(line) {
        return line.trim()
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map(c => c.trim());
    },

    _tableHtml(headers, rows) {
        const head = headers.map(h => `<th>${this._renderInline(h)}</th>`).join('');
        const body = rows.map(r => {
            // Защита: padding до длины headers
            while (r.length < headers.length) r.push('');
            return '<tr>' + r.map(c => `<td>${this._renderInline(c)}</td>`).join('') + '</tr>';
        }).join('');
        return `<div class="ai-table-wrap"><table class="ai-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
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

    /** HTML-индикатор текущего треда + кнопка для смены. */
    renderThreadPicker() {
        const current = this.getCurrentThread();
        const label = current ? this.esc(current.title) : 'Основной чат';
        const isTask = current?.task_id;
        const cls = `ai-thread-pill${isTask ? ' ai-thread-pill-task' : ''}`;
        return `<button class="${cls}" data-action="pick-thread" title="Сменить тред (Ctrl+/)">
            <span class="ai-thread-icon">${isTask ? '⎘' : '✦'}</span>
            <span class="ai-thread-label">${label}</span>
        </button>`;
    },

    getCurrentThread() {
        return this.state.threads.find(t => t.id === this.state.currentThread)
            || this.state.threads.find(t => t.id === 'main');
    },

    showThreadPicker() {
        const existing = document.getElementById('ai-thread-picker');
        if (existing) existing.remove();
        const modal = document.createElement('div');
        modal.id = 'ai-thread-picker';
        modal.style.cssText = 'position:fixed;inset:0;z-index:9020;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:24px';

        const threads = this.state.threads || [];
        const current = this.state.currentThread;
        const openTasks = (typeof TasksStore !== 'undefined'
            ? TasksStore.list().filter(t => t.status !== 'done')
            : []);

        // Открытые задачи без созданного треда — отдельный блок "Создать тред"
        const threadTaskIds = new Set(threads.filter(t => t.task_id).map(t => t.task_id));
        const taskOptions = openTasks.filter(t => !threadTaskIds.has(t.id));

        modal.innerHTML = `
        <div class="ai-picker ai-thread-picker">
            <div class="ai-picker-header">
                <span style="flex:1;font-size:13px;color:var(--text);font-weight:600">Чат / тред</span>
                <button class="ai-picker-close">✕</button>
            </div>
            <div class="ai-picker-list">
                <div class="ai-thread-section">Существующие</div>
                ${threads.map(t => {
                    const isCurrent = t.id === current;
                    const isMain = t.id === 'main';
                    const sub = isMain ? 'без привязки' : (t.task_id ? `задача · ${t.message_count} сообщ.` : `${t.message_count} сообщ.`);
                    return `
                    <div class="ai-picker-item ai-thread-row ${isCurrent ? 'attached' : ''}" data-thread="${this.esc(t.id)}">
                        <div class="ai-thread-row-body">
                            <div class="ai-thread-row-title">${isMain ? '✦ ' : '⎘ '}${this.esc(t.title)}</div>
                            <div class="ai-thread-row-sub">${sub}</div>
                        </div>
                        <div class="ai-thread-row-actions">
                            ${isCurrent ? '<span class="ai-picker-state" style="color:var(--green)">текущий</span>' : ''}
                            ${!isMain ? `<button class="ai-thread-mini" data-act="rename" data-thread="${this.esc(t.id)}" title="Переименовать">✎</button>
                                          <button class="ai-thread-mini" data-act="delete" data-thread="${this.esc(t.id)}" title="Удалить">🗑</button>` : ''}
                        </div>
                    </div>`;
                }).join('')}
                ${taskOptions.length ? `
                    <div class="ai-thread-section">Создать тред для задачи</div>
                    ${taskOptions.map(t => `
                        <div class="ai-picker-item ai-thread-row" data-create-task="${t.id}">
                            <div class="ai-thread-row-body">
                                <div class="ai-thread-row-title">+ ${this.esc(t.title)}</div>
                                <div class="ai-thread-row-sub">${t.status} · ${t.priority || 'medium'}</div>
                            </div>
                        </div>`).join('')}
                ` : ''}
            </div>
        </div>`;

        document.body.appendChild(modal);
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
        modal.querySelector('.ai-picker-close').addEventListener('click', () => modal.remove());

        modal.querySelectorAll('[data-thread]').forEach(row => {
            if (row.classList.contains('ai-thread-mini')) return;
            // Только сам row, не кнопки-действия внутри
            row.addEventListener('click', async (e) => {
                if (e.target.closest('.ai-thread-mini')) return;
                const tid = row.dataset.thread;
                modal.remove();
                await this.switchThread(tid);
            });
        });
        modal.querySelectorAll('[data-create-task]').forEach(row => {
            row.addEventListener('click', async () => {
                const taskId = row.dataset.createTask;
                modal.remove();
                await this.openTaskThread(taskId);
            });
        });
        modal.querySelectorAll('.ai-thread-mini').forEach(btn => {
            btn.addEventListener('click', async e => {
                e.stopPropagation();
                const tid = btn.dataset.thread;
                const act = btn.dataset.act;
                if (act === 'delete') {
                    if (!confirm('Удалить этот тред со всей историей?')) return;
                    await this.deleteThread(tid);
                    modal.remove();
                    this.showThreadPicker();
                } else if (act === 'rename') {
                    const t = (this.state.threads || []).find(x => x.id === tid);
                    const cur = t?.title || '';
                    const next = prompt('Новое название треда:', cur);
                    if (next && next.trim() && next !== cur) {
                        await this.renameThread(tid, next.trim());
                        modal.remove();
                        this.showThreadPicker();
                    }
                }
            });
        });
    },

    /** Форматирует число токенов в k/M. */
    fmtTokens(n) {
        n = Number(n) || 0;
        if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
        if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'k';
        return String(n);
    },

    /** Компактный HTML-индикатор расхода за сегодня (в шапке виджета/страницы). */
    renderUsageBadge() {
        const u = this.state.usage;
        if (!u || !u.total_requests) {
            return `<span class="ai-usage" title="За сегодня запросов ещё не было">сегодня: —</span>`;
        }
        const cost = u.total_cost_usd?.toFixed?.(3) ?? '0.000';
        const budget = u.daily_budget_usd;
        let budgetHtml = '';
        let extraCls = '';
        if (budget) {
            const pct = u.budget_used_pct ?? 0;
            const over = u.over_budget;
            if (over) {
                extraCls = ' ai-usage-over';
                budgetHtml = ` · <b style="color:var(--red)">${pct.toFixed(0)}% бюджета</b>`;
            } else if (pct >= 75) {
                extraCls = ' ai-usage-warn';
                budgetHtml = ` · ${pct.toFixed(0)}% бюджета`;
            } else {
                budgetHtml = ` · из $${budget.toFixed(2)}`;
            }
        }
        return `<span class="ai-usage${extraCls}" title="Запросов: ${u.total_requests} · in ${u.total_input} · out ${u.total_output} · cache_read ${u.total_cache_read}">
            сегодня: <b>${this.fmtTokens(u.total_input + u.total_output)}</b> · ~$${cost}${budgetHtml}
        </span>`;
    },

    /** HTML карточек pending-действий (server/db/compile). */
    renderActions(msg, msgIdx) {
        if (!msg?.actions?.length) return '';
        const ICONS = {
            server_action: '⚡',
            compile: '🔨',
            console_clear: '🧹',
            db_write: '🗄',
            request_code_access: '🔑',
        };
        return `<div class="ai-actions-list">
            ${msg.actions.map((a, i) => {
                const icon = ICONS[a.kind] || '⎘';
                let stateHtml;
                if (a.status === 'approved') {
                    stateHtml = `<span class="ai-action-badge ai-action-badge-ok">выполнено${a.result ? ` · ${this.esc(a.result)}` : ''}</span>`;
                } else if (a.status === 'rejected') {
                    stateHtml = `<span class="ai-action-badge ai-action-badge-muted">отклонено</span>`;
                } else if (a.status === 'failed') {
                    stateHtml = `<span class="ai-action-badge ai-action-badge-err" title="${this.esc(a.result || '')}">ошибка</span>`;
                } else {
                    stateHtml = `
                        <button class="btn btn-primary btn-sm" data-action="act-approve" data-msg="${msgIdx}" data-idx="${i}">Подтвердить</button>
                        <button class="btn btn-ghost btn-sm" data-action="act-reject" data-msg="${msgIdx}" data-idx="${i}">Отклонить</button>`;
                }
                return `
                <div class="ai-action ${a.status !== 'pending' ? 'ai-action-done' : ''}">
                    <span class="ai-action-icon">${icon}</span>
                    <span class="ai-action-summary">${this.esc(a.summary)}</span>
                    <span class="ai-action-state">${stateHtml}</span>
                </div>`;
            }).join('')}
        </div>`;
    },

    /** Привязывает обработчики к контейнеру с edit'ами/действиями. */
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
                else if (action === 'act-approve') this.approveAction(msgIdx, idx);
                else if (action === 'act-reject')  this.rejectAction(msgIdx, idx);
            });
        });
    },
};


// ── Modal для статистики расхода ────────────────────────────────────

// Лениво подгружает Monaco, если он ещё не загружен (другие страницы
// — Files/DB — грузят его при открытии редактора кода; модалки AI тоже
// должны уметь работать без них).
function ensureMonaco() {
    return new Promise((resolve, reject) => {
        if (window.monaco) return resolve(window.monaco);

        const startWait = () => {
            const t0 = Date.now();
            const id = setInterval(() => {
                if (window.monaco) { clearInterval(id); resolve(window.monaco); }
                else if (Date.now() - t0 > 15000) { clearInterval(id); reject(new Error('Monaco не загрузился')); }
            }, 100);
        };

        if (document.querySelector('script[src*="monaco-editor"]')) {
            // Уже грузится другой страницей — просто подождём
            startWait();
            return;
        }

        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs/loader.js';
        s.onload = () => {
            try {
                require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' } });
                require(['vs/editor/editor.main'], () => resolve(window.monaco));
            } catch (e) { reject(e); }
        };
        s.onerror = () => reject(new Error('Не удалось загрузить Monaco'));
        document.head.appendChild(s);
    });
}


const AiUsageModal = {
    async show() {
        const existing = document.getElementById('ai-usage-modal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'ai-usage-modal';
        modal.style.cssText = 'position:fixed;inset:0;z-index:9050;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;padding:24px';
        modal.innerHTML = `
        <div class="ai-usage-window">
            <div class="ai-usage-header">
                <span class="ai-usage-title">Расход Claude</span>
                <button class="ai-usage-close">✕</button>
            </div>
            <div class="ai-usage-body" id="ai-usage-body">
                <div class="ai-empty">Загрузка...</div>
            </div>
        </div>`;
        document.body.appendChild(modal);
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
        modal.querySelector('.ai-usage-close').addEventListener('click', () => modal.remove());

        const body = document.getElementById('ai-usage-body');
        const [today, hist] = await Promise.all([
            API.get('/api/claude/usage').catch(() => null),
            AiChat.loadUsageHistory(30),
        ]);

        const fmt = n => AiChat.fmtTokens(n);
        const ec = AiChat.esc;

        let todayHtml = '<div class="ai-usage-empty">Сегодня запросов ещё не было.</div>';
        if (today && today.total_requests) {
            const byModel = Object.entries(today.by_model || {});
            todayHtml = `
            <div class="ai-usage-section-title">Сегодня — ${ec(today.date)}</div>
            <div class="ai-usage-grid">
                <div class="ai-usage-stat"><span>Запросов</span><b>${today.total_requests}</b></div>
                <div class="ai-usage-stat"><span>Input</span><b>${fmt(today.total_input)}</b></div>
                <div class="ai-usage-stat"><span>Output</span><b>${fmt(today.total_output)}</b></div>
                <div class="ai-usage-stat"><span>Cache read</span><b>${fmt(today.total_cache_read)}</b></div>
                <div class="ai-usage-stat ai-usage-stat-accent"><span>Оценка</span><b>$${today.total_cost_usd.toFixed(3)}</b></div>
            </div>
            <div class="ai-usage-models">
                ${byModel.map(([model, m]) => `
                    <div class="ai-usage-model">
                        <span class="ai-usage-model-name">${ec(model)}</span>
                        <span class="ai-usage-model-stats">
                            ${m.requests} req · in ${fmt(m.input)} · out ${fmt(m.output)} · cache ${fmt(m.cache_read)}
                        </span>
                        <span class="ai-usage-model-cost">$${m.cost_usd.toFixed(3)}</span>
                    </div>`).join('')}
            </div>`;
        }

        let historyHtml = '';
        if (hist?.days?.length) {
            const days = hist.days;
            historyHtml = `
            <div class="ai-usage-section-title">Последние 30 дней</div>
            <div class="ai-usage-history">
                ${days.map(d => `
                    <div class="ai-usage-day">
                        <span class="ai-usage-day-date">${ec(d.date)}</span>
                        <span class="ai-usage-day-req">${d.total_requests} req</span>
                        <span class="ai-usage-day-tok">${fmt(d.total_input + d.total_output)} tok</span>
                        <span class="ai-usage-day-cost">$${d.total_cost_usd.toFixed(3)}</span>
                    </div>`).join('')}
            </div>`;
        }

        const currentBudget = today?.daily_budget_usd ?? '';
        const budgetHtml = `
            <div class="ai-usage-section-title">Дневной бюджет</div>
            <div class="ai-usage-budget">
                <span>Лимит в $/день (0 — без лимита):</span>
                <input id="ai-budget-input" type="number" min="0" step="0.5" value="${currentBudget || 0}" />
                <button class="btn btn-primary btn-sm" id="ai-budget-save">Сохранить</button>
            </div>
            <div class="ai-usage-note" style="margin-top:6px">
                При превышении бейдж становится <span style="color:var(--red)">красным</span>,
                запросы НЕ блокируются — только предупреждение.
            </div>`;

        body.innerHTML = `
            ${todayHtml}
            ${budgetHtml}
            ${historyHtml}
            <div class="ai-usage-note">
                Это локальные подсчёты по нашим запросам. Глобальный лимит Max-подписки
                (5-часовое окно) Anthropic в API не отдаёт — увидишь его только когда
                CLI начнёт возвращать ошибку rate-limit.
            </div>`;

        document.getElementById('ai-budget-save')?.addEventListener('click', async () => {
            const val = parseFloat(document.getElementById('ai-budget-input').value);
            try {
                await API.post('/api/claude/budget', {
                    daily_budget_usd: val > 0 ? val : null,
                });
                app.toast('Бюджет сохранён', 'success');
                AiChat.loadUsage();
            } catch (e) {
                app.toast(e.message, 'error');
            }
        });
    },
};


// ── Modal для памяти AI ─────────────────────────────────────────────

const AiMemoryModal = {
    _editor: null,
    _files: [],
    _currentName: null,
    _dirty: false,

    async show() {
        this._closeWithoutRemove();
        const modal = document.createElement('div');
        modal.id = 'ai-memory-modal';
        modal.style.cssText = 'position:fixed;inset:0;z-index:9080;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;padding:20px';
        modal.innerHTML = `
        <div class="ai-mem-window">
            <div class="ai-mem-header">
                <span class="ai-mem-title">Память AI</span>
                <span class="ai-mem-sub">.md / .txt — общая для всех чатов</span>
                <button class="ai-mem-close">✕</button>
            </div>
            <div class="ai-mem-body">
                <div class="ai-mem-sidebar">
                    <div class="ai-mem-list-actions">
                        <button class="btn btn-primary btn-sm" id="ai-mem-new">+ Новый</button>
                        <button class="btn btn-ghost btn-sm" id="ai-mem-refresh">↻</button>
                    </div>
                    <div id="ai-mem-list" class="ai-mem-list"></div>
                </div>
                <div class="ai-mem-editor-pane">
                    <div class="ai-mem-editor-bar" id="ai-mem-bar">
                        <span class="ai-mem-current" id="ai-mem-current">— выбери файл —</span>
                        <button class="btn btn-primary btn-sm hidden" id="ai-mem-save">Сохранить</button>
                        <button class="btn btn-danger btn-sm hidden" id="ai-mem-delete">Удалить</button>
                    </div>
                    <div id="ai-mem-editor" class="ai-mem-editor"></div>
                </div>
            </div>
        </div>`;
        document.body.appendChild(modal);
        modal.addEventListener('click', e => { if (e.target === modal) this.close(); });
        modal.querySelector('.ai-mem-close').addEventListener('click', () => this.close());

        document.getElementById('ai-mem-new').addEventListener('click', () => this._createNew());
        document.getElementById('ai-mem-refresh').addEventListener('click', () => this._loadList());
        document.getElementById('ai-mem-save').addEventListener('click', () => this._save());
        document.getElementById('ai-mem-delete').addEventListener('click', () => this._delete());

        await this._loadList();
    },

    async _loadList() {
        try {
            const res = await API.get('/api/claude/memory');
            this._files = res.files || [];
            this._renderList();
        } catch (e) {
            app.toast(e.message, 'error');
        }
    },

    _renderList() {
        const wrap = document.getElementById('ai-mem-list');
        if (!wrap) return;
        if (!this._files.length) {
            wrap.innerHTML = `<div class="ai-empty" style="padding:24px 12px">Пусто. AI будет сюда записывать заметки, или ты сам создашь новый файл.</div>`;
            return;
        }
        const fmt = ts => {
            if (!ts) return '';
            const d = new Date(ts * 1000);
            return d.toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
        };
        const fmtSize = n => {
            if (n < 1024) return n + 'B';
            return (n / 1024).toFixed(1) + 'KB';
        };
        wrap.innerHTML = this._files.map(f => `
            <div class="ai-mem-item ${f.name === this._currentName ? 'active' : ''}" data-name="${AiChat.esc(f.name)}">
                <div class="ai-mem-item-name">${AiChat.esc(f.name)}</div>
                <div class="ai-mem-item-meta">${fmt(f.modified)} · ${fmtSize(f.size)}</div>
            </div>`).join('');
        wrap.querySelectorAll('.ai-mem-item').forEach(el => {
            el.addEventListener('click', () => this._loadFile(el.dataset.name));
        });
    },

    async _loadFile(name) {
        if (this._dirty && !confirm('Несохранённые изменения будут потеряны. Продолжить?')) return;
        try {
            const res = await API.get(`/api/claude/memory/file?name=${encodeURIComponent(name)}`);
            this._currentName = name;
            this._dirty = false;
            this._renderList();
            document.getElementById('ai-mem-current').textContent = name;
            document.getElementById('ai-mem-save').classList.add('hidden');
            document.getElementById('ai-mem-delete').classList.remove('hidden');
            this._mountEditor(res.content || '');
        } catch (e) {
            app.toast(e.message, 'error');
        }
    },

    _createNew() {
        const name = prompt('Имя нового файла (например, notes.md):');
        if (!name || !name.trim()) return;
        let n = name.trim();
        if (!/\.(md|txt)$/i.test(n)) n += '.md';
        this._currentName = n;
        this._dirty = true;
        document.getElementById('ai-mem-current').textContent = n + ' *';
        document.getElementById('ai-mem-save').classList.remove('hidden');
        document.getElementById('ai-mem-delete').classList.add('hidden');
        this._mountEditor('# ' + n + '\n\n');
    },

    async _mountEditor(content) {
        const wrap = document.getElementById('ai-mem-editor');
        if (!wrap) return;
        wrap.innerHTML = '<div style="padding:20px;color:var(--text-3);font-size:12px">Загрузка редактора…</div>';
        try {
            await ensureMonaco();
        } catch (e) {
            wrap.innerHTML = `<div style="padding:20px;color:var(--red);font-size:12px">${e.message}</div>`;
            return;
        }
        wrap.innerHTML = '';
        if (this._editor) { try { this._editor.dispose(); } catch {} this._editor = null; }
        const theme = localStorage.getItem('theme') === 'light' ? 'vs' : 'custom-dark';
        this._editor = monaco.editor.create(wrap, {
            value: content,
            language: 'markdown',
            theme,
            minimap: { enabled: false },
            wordWrap: 'on',
            fontSize: 13,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            padding: { top: 8 },
        });
        this._editor.onDidChangeModelContent(() => {
            if (!this._dirty) {
                this._dirty = true;
                const cur = document.getElementById('ai-mem-current');
                if (cur && !cur.textContent.endsWith(' *')) cur.textContent += ' *';
                document.getElementById('ai-mem-save').classList.remove('hidden');
            }
        });
        setTimeout(() => this._editor?.layout(), 50);
    },

    async _save() {
        if (!this._currentName || !this._editor) return;
        const content = this._editor.getValue();
        try {
            await API.post('/api/claude/memory/file', {
                name: this._currentName, content,
            });
            this._dirty = false;
            document.getElementById('ai-mem-current').textContent = this._currentName;
            document.getElementById('ai-mem-save').classList.add('hidden');
            document.getElementById('ai-mem-delete').classList.remove('hidden');
            await this._loadList();
            app.toast('Сохранено', 'success');
        } catch (e) {
            app.toast(e.message, 'error');
        }
    },

    async _delete() {
        if (!this._currentName) return;
        if (!confirm(`Удалить ${this._currentName}?`)) return;
        try {
            await API.delete(`/api/claude/memory/file?name=${encodeURIComponent(this._currentName)}`);
            this._currentName = null;
            this._dirty = false;
            if (this._editor) { try { this._editor.dispose(); } catch {} this._editor = null; }
            document.getElementById('ai-mem-editor').innerHTML = '';
            document.getElementById('ai-mem-current').textContent = '— выбери файл —';
            document.getElementById('ai-mem-save').classList.add('hidden');
            document.getElementById('ai-mem-delete').classList.add('hidden');
            await this._loadList();
            app.toast('Удалено', 'info');
        } catch (e) {
            app.toast(e.message, 'error');
        }
    },

    close() {
        if (this._dirty && !confirm('Несохранённые изменения будут потеряны. Закрыть?')) return;
        this._closeWithoutRemove();
    },

    _closeWithoutRemove() {
        if (this._editor) { try { this._editor.dispose(); } catch {} this._editor = null; }
        this._dirty = false;
        this._currentName = null;
        const m = document.getElementById('ai-memory-modal');
        if (m) m.remove();
    },
};


// ── Modal для просмотра diff ────────────────────────────────────────

const AiDiffModal = {
    _editor: null,
    async show(edit) {
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

        const wrap = document.getElementById('ai-diff-body');
        wrap.innerHTML = '<div style="padding:20px;color:var(--text-3);font-size:12px">Загрузка редактора…</div>';
        try {
            await ensureMonaco();
        } catch (e) {
            wrap.innerHTML = `<div style="padding:20px;color:var(--red);font-size:12px">${e.message}</div>`;
            return;
        }
        wrap.innerHTML = '';
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
