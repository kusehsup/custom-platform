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
