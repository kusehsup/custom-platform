const QUERIES_PAGE_SIZE = 30;

app.register('queries', {
    _queries: {},
    _shown: 0,
    _prevStatuses: {},   // id → status для отслеживания изменений

    async render(root) {
        root.innerHTML = `
        <div class="card">
            <div class="card-header">
                <span class="card-title">Запросы кода</span>
                <div style="display:flex;gap:8px;align-items:center">
                    <input type="search" id="q-search" placeholder="Поиск по файлу..." style="width:220px;padding:6px 12px;font-size:13px" />
                    <button class="btn btn-ghost btn-sm" id="btn-q-refresh">↻ Обновить</button>
                </div>
            </div>
            <div id="q-list"></div>
            <div id="q-more" class="hidden" style="padding:12px;text-align:center">
                <button class="btn btn-ghost btn-sm" id="btn-q-more">Загрузить ещё</button>
            </div>
        </div>`;

        document.getElementById('btn-q-refresh').addEventListener('click', () => this._load(true));
        document.getElementById('btn-q-more').addEventListener('click', () => this._renderMore());
        document.getElementById('q-search').addEventListener('input', e => {
            this._shown = 0;
            this._renderList(e.target.value.toLowerCase());
        });

        await this._load();
    },

    async _load(refresh = false) {
        const list = document.getElementById('q-list');
        if (list) list.innerHTML = '<div style="padding:16px;color:var(--text-2);font-size:13px">Загрузка...</div>';
        try {
            const data = await API.get('/api/queries' + (refresh ? '?refresh=true' : ''));
            const prev = this._prevStatuses;
            this._queries = data.queries || {};
            this._shown   = 0;

            // Проверяем новые одобрения
            const s = app._getSettings();
            Object.entries(this._queries).forEach(([id, q]) => {
                if (prev[id] && prev[id] !== q.status && q.status === 'accept') {
                    if (s.notify_code_access !== false) {
                        app.toast(`✅ Доступ разрешён: ${q.fileName || ''}`, 'success');
                        app.notify('CustomPlatform', `Доступ разрешён: ${q.fileName || ''}`);
                        this._notifyTelegram(q);
                    }
                }
                prev[id] = q.status;
            });
            this._prevStatuses = prev;

            this._renderList(document.getElementById('q-search')?.value?.toLowerCase() || '');
        } catch (e) {
            const list = document.getElementById('q-list');
            if (list) list.innerHTML = `<div style="padding:16px;color:var(--red);font-size:13px">${e.message}</div>`;
        }
    },

    async _notifyTelegram(query) {
        try {
            await API.post('/api/notify/query_accepted', {
                file_name: query.fileName || '',
                query_name: query.name || '',
            });
        } catch {}
    },

    onUpdate(queries) {
        const prev = this._prevStatuses;
        const s = app._getSettings();

        Object.entries(queries || {}).forEach(([id, q]) => {
            if (prev[id] !== undefined && prev[id] !== q.status && q.status === 'accept') {
                if (s.notify_code_access !== false) {
                    app.toast(`✅ Доступ разрешён: ${q.fileName || ''}`, 'success');
                    app.notify('CustomPlatform', `Доступ разрешён: ${q.fileName || ''}`);
                    this._notifyTelegram(q);
                }
            }
            prev[id] = q.status;
        });

        this._queries = queries || {};
        this._prevStatuses = prev;
        this._shown = 0;
        this._renderList(document.getElementById('q-search')?.value?.toLowerCase() || '');
    },

    _sorted(query) {
        return Object.entries(this._queries)
            .sort((a, b) => +b[0] - +a[0])
            .filter(([, q]) => !query || (q.fileName || '').toLowerCase().includes(query) || (q.name || '').toLowerCase().includes(query));
    },

    _renderList(query) {
        const list = document.getElementById('q-list');
        if (!list) return;
        this._shown = 0;
        list.innerHTML = '';
        this._renderMore(query);
    },

    _renderMore(query) {
        query = query ?? document.getElementById('q-search')?.value?.toLowerCase() ?? '';
        const list = document.getElementById('q-list');
        if (!list) return;

        const all   = this._sorted(query);
        const chunk = all.slice(this._shown, this._shown + QUERIES_PAGE_SIZE);
        this._shown += chunk.length;

        chunk.forEach(([id, q]) => {
            list.insertAdjacentHTML('beforeend', this._itemHtml(id, q));
        });

        // Кнопка "загрузить ещё"
        const moreWrap = document.getElementById('q-more');
        if (moreWrap) {
            moreWrap.classList.toggle('hidden', this._shown >= all.length);
            const btn = document.getElementById('btn-q-more');
            if (btn) btn.textContent = `Загрузить ещё (${all.length - this._shown})`;
        }

        if (all.length === 0) {
            list.innerHTML = '<div style="padding:16px;color:var(--text-3);font-size:13px">Нет запросов</div>';
        }

        // Кнопки ответа
        list.querySelectorAll('[data-qtype]:not([data-bound])').forEach(btn => {
            btn.dataset.bound = '1';
            btn.addEventListener('click', () => this._respond(btn.dataset.qid, btn.dataset.qtype));
        });
    },

    _itemHtml(id, q) {
        const statusBadge = q.status === 'accept'
            ? '<span class="badge badge-on" style="font-size:11px">Разрешён</span>'
            : q.status === 'reject'
            ? '<span class="badge badge-off" style="font-size:11px">Запрещён</span>'
            : '<span class="badge badge-busy" style="font-size:11px">На рассмотрении</span>';

        const code = q.responseAccess ? (q.code || '') : (q.name || '');
        const btns = (q.responseAccess && q.status === 'wait') ? `
            <button class="btn btn-success btn-sm" data-qid="${id}" data-qtype="accept">✓</button>
            <button class="btn btn-danger  btn-sm" data-qid="${id}" data-qtype="reject">✕</button>` : '';

        return `<div class="q-item">
            <div class="q-item-header">
                <span class="q-item-user">${this._esc(q.login || '')}</span>
                <span class="q-item-file">${this._esc(q.fileName || '')}</span>
                <span style="flex:1"></span>
                ${statusBadge}
                ${btns}
            </div>
            ${code ? `<div class="q-item-code">${this._esc(code)}</div>` : ''}
        </div>`;
    },

    async _respond(queryId, type) {
        try {
            await API.post('/api/code_query_response', { type, query_id: queryId });
            if (this._queries[queryId]) {
                this._queries[queryId].status = type;
                this._prevStatuses[queryId] = type;
            }
            // Обновляем только этот элемент в DOM
            const item = document.querySelector(`[data-qid="${queryId}"]`)?.closest('.q-item');
            if (item) {
                const [, q] = [queryId, this._queries[queryId]];
                item.outerHTML = this._itemHtml(queryId, this._queries[queryId]);
            }
            app.toast(type === 'accept' ? '✅ Доступ разрешён' : '❌ Доступ запрещён', type === 'accept' ? 'success' : 'info');
        } catch (e) {
            app.toast('Ошибка: ' + e.message, 'error');
        }
    },

    _esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); },
});
