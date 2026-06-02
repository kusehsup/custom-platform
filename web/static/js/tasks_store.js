// ── Глобальный стор задач (используют страница и AI) ───────────────

const TasksStore = {
    _tasks: [],
    _activeId: null,
    _loaded: false,
    _subs: [],
    _loadingPromise: null,

    subscribe(fn) {
        this._subs.push(fn);
        return () => { this._subs = this._subs.filter(s => s !== fn); };
    },

    _emit() {
        for (const fn of this._subs) {
            try { fn(); } catch {}
        }
        // Обновляем бэйдж в сайдбаре
        try {
            const badge = document.getElementById('tasks-badge');
            if (badge) {
                const inProgress = this._tasks.filter(t => t.status === 'in_progress').length;
                if (inProgress) {
                    badge.textContent = String(inProgress);
                    badge.classList.remove('hidden');
                } else {
                    badge.classList.add('hidden');
                }
            }
        } catch {}
    },

    async load(force = false) {
        if (this._loaded && !force) return;
        if (this._loadingPromise) return this._loadingPromise;
        this._loadingPromise = (async () => {
            try {
                const res = await API.get('/api/tasks');
                this._tasks = res.tasks || [];
                this._activeId = res.active_task_id || null;
                this._loaded = true;
                this._emit();
            } catch {}
            finally {
                this._loadingPromise = null;
            }
        })();
        return this._loadingPromise;
    },

    list(status = null) {
        if (!status) return this._tasks;
        return this._tasks.filter(t => t.status === status);
    },

    get(id) {
        return this._tasks.find(t => t.id === id);
    },

    getActive() {
        return this._activeId ? this.get(this._activeId) : null;
    },

    activeId() { return this._activeId; },

    async setActive(id) {
        try {
            if (id) {
                await API.post(`/api/tasks/${id}/active`);
                this._activeId = id;
            } else {
                await API.post('/api/tasks/active/clear');
                this._activeId = null;
            }
            this._emit();
        } catch (e) {
            app.toast(e.message, 'error');
        }
    },

    async create(data) {
        const res = await API.post('/api/tasks', data);
        if (res.task) {
            this._tasks.unshift(res.task);
            if (res.active_task_id) this._activeId = res.active_task_id;
            this._emit();
        }
        return res.task;
    },

    async update(id, fields) {
        const res = await API._fetch('PATCH', `/api/tasks/${id}`, fields);
        if (res.task) {
            const idx = this._tasks.findIndex(t => t.id === id);
            if (idx !== -1) this._tasks[idx] = res.task;
            this._emit();
        }
        return res.task;
    },

    async delete(id) {
        await API.delete(`/api/tasks/${id}`);
        this._tasks = this._tasks.filter(t => t.id !== id);
        if (this._activeId === id) this._activeId = null;
        this._emit();
    },

    async addNote(id, text) {
        const res = await API.post(`/api/tasks/${id}/notes`, { text });
        if (res.task) {
            const idx = this._tasks.findIndex(t => t.id === id);
            if (idx !== -1) this._tasks[idx] = res.task;
            this._emit();
        }
        return res.task;
    },

    async uploadAttachment(id, file) {
        const form = new FormData();
        form.append('file', file);
        const headers = {};
        if (API._token) headers['Authorization'] = `Bearer ${API._token}`;
        const resp = await fetch(`/api/tasks/${id}/attachments`, {
            method: 'POST',
            headers,
            body: form,
        });
        if (!resp.ok) {
            const j = await resp.json().catch(() => ({}));
            throw new Error(j.detail || `HTTP ${resp.status}`);
        }
        const data = await resp.json();
        if (data.task) {
            const idx = this._tasks.findIndex(t => t.id === id);
            if (idx !== -1) this._tasks[idx] = data.task;
            this._emit();
        }
        return data;
    },

    async deleteAttachment(taskId, attachmentId) {
        await API.delete(`/api/tasks/${taskId}/attachments/${attachmentId}`);
        await this.load(true);
    },
};
