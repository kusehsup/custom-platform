app.register('queries', {
    _queries: {},

    async render(root) {
        root.innerHTML = `
        <div class="card">
            <div class="card-header">
                <span class="card-title">Запросы кода</span>
                <button class="btn btn-ghost btn-sm" id="btn-queries-refresh">↻ Обновить</button>
            </div>
            <div id="queries-list"><div style="color:var(--text-2);font-size:13px">Загрузка...</div></div>
        </div>`;

        document.getElementById('btn-queries-refresh')?.addEventListener('click', () => this._load());
        await this._load();
    },

    async _load() {
        try {
            const data = await API.get('/api/queries');
            this._queries = data.queries || {};
            this._renderList();
        } catch (e) {
            const el = document.getElementById('queries-list');
            if (el) el.innerHTML = `<div style="color:var(--red);font-size:13px">${e.message}</div>`;
        }
    },

    onUpdate(queries) {
        this._queries = queries || {};
        this._renderList();
    },

    _renderList() {
        const el = document.getElementById('queries-list');
        if (!el) return;
        const entries = Object.entries(this._queries).sort((a, b) => +b[0] - +a[0]);
        if (!entries.length) {
            el.innerHTML = '<div style="color:var(--text-2);font-size:13px;padding:8px 0">Нет запросов</div>';
            return;
        }
        el.innerHTML = entries.map(([id, q]) => {
            const statusHtml = q.status === 'accept'
                ? '<span class="badge badge-on">Доступ разрешён</span>'
                : q.status === 'reject'
                ? '<span class="badge badge-off">Доступ запрещён</span>'
                : '<span class="badge badge-busy">На рассмотрении</span>';

            const btns = (q.responseAccess && q.status === 'wait') ? `
                <button class="btn btn-success btn-sm" data-qid="${id}" data-qtype="accept">✓ Разрешить</button>
                <button class="btn btn-danger  btn-sm" data-qid="${id}" data-qtype="reject">✕ Запретить</button>` : '';

            const code = q.responseAccess ? (q.code || '') : (q.name || '');

            return `<div class="query-block" data-id="${id}">
                <div class="query-info">${this._esc(q.login || '')} запрашивает доступ к коду из файла <strong>${this._esc(q.fileName || '')}</strong></div>
                <div class="query-meta">${statusHtml}</div>
                <pre class="query-code">${this._esc(code)}</pre>
                ${btns ? `<div class="btn-row" style="margin-top:8px">${btns}</div>` : ''}
            </div>`;
        }).join('');

        el.querySelectorAll('[data-qtype]').forEach(btn =>
            btn.addEventListener('click', () => this._respond(btn.dataset.qid, btn.dataset.qtype))
        );
    },

    async _respond(queryId, type) {
        try {
            await API.post('/api/code_query_response', { type, query_id: queryId });
            if (this._queries[queryId]) this._queries[queryId].status = type;
            this._renderList();
            app.toast(type === 'accept' ? '✅ Доступ разрешён' : '❌ Доступ запрещён', type === 'accept' ? 'success' : 'info');
        } catch (e) {
            app.toast('Ошибка: ' + e.message, 'error');
        }
    },

    _esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); },
});
