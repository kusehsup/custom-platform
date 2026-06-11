// ── External Commands ───────────────────────────────────────────
//
// Страница «Внешние команды» — отправка записей в таблицу
// external_commands Pawn-сервера и просмотр их статусов.

const ExtCmdPage = {
    _catalog: null,             // {commands, state_names, command_types}
    _filter: '',
    _selectedId: null,          // id команды из каталога
    _selected: null,            // объект команды из каталога
    _pendingIds: new Set(),     // id записей, для которых идёт WAIT-опрос
    _pollTimers: new Map(),     // recordId -> timeoutId

    abort() {
        this._pollTimers.forEach((tid) => clearTimeout(tid));
        this._pollTimers.clear();
        this._pendingIds.clear();
    },

    async render(el) {
        el.innerHTML = `
        <div class="extcmd">
            <div class="extcmd-head">
                <div>
                    <h2 class="extcmd-title">Внешние команды</h2>
                    <div class="extcmd-sub">Запись в <code>external_commands</code>, сервер заберёт её на следующем тике.</div>
                </div>
                <div class="extcmd-head-actions">
                    <button class="btn btn-ghost btn-sm" id="extcmd-refresh-log">↻ Журнал</button>
                </div>
            </div>

            <div class="extcmd-layout">
                <aside class="extcmd-sidebar">
                    <input id="extcmd-filter" class="extcmd-filter" placeholder="Поиск команды..." />
                    <div id="extcmd-list" class="extcmd-list"></div>
                </aside>

                <main class="extcmd-main">
                    <div id="extcmd-form" class="extcmd-form">
                        <div class="extcmd-empty">← Выбери команду слева</div>
                    </div>

                    <div class="extcmd-recent-wrap">
                        <div class="extcmd-recent-head">
                            <span>Журнал (последние)</span>
                            <span id="extcmd-recent-count" class="extcmd-recent-count"></span>
                        </div>
                        <div id="extcmd-recent" class="extcmd-recent"></div>
                    </div>
                </main>
            </div>
        </div>`;

        document.getElementById('extcmd-filter').addEventListener('input', (e) => {
            this._filter = (e.target.value || '').trim().toLowerCase();
            this._renderList();
        });
        document.getElementById('extcmd-refresh-log').addEventListener('click', () => this._loadRecent());

        try {
            const data = await API.get('/api/external_commands/catalog');
            this._catalog = data;
            this._renderList();
            this._loadRecent();
        } catch (e) {
            document.getElementById('extcmd-list').innerHTML =
                `<div class="extcmd-error">Не удалось загрузить каталог: ${this._esc(e.message)}</div>`;
        }
    },

    // ── Список команд (sidebar) ──────────────────────────────────

    _renderList() {
        const list = document.getElementById('extcmd-list');
        if (!list || !this._catalog) return;

        const groups = new Map();
        for (const cmd of this._catalog.commands) {
            const matches =
                !this._filter ||
                cmd.name.toLowerCase().includes(this._filter) ||
                String(cmd.id).includes(this._filter) ||
                (cmd.description || '').toLowerCase().includes(this._filter) ||
                (cmd.group || '').toLowerCase().includes(this._filter);
            if (!matches) continue;
            const g = cmd.group || 'Прочее';
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push(cmd);
        }

        if (groups.size === 0) {
            list.innerHTML = `<div class="extcmd-empty-small">Ничего не найдено</div>`;
            return;
        }

        let html = '';
        for (const [group, cmds] of groups) {
            html += `<div class="extcmd-group-title">${this._esc(group)}</div>`;
            for (const cmd of cmds) {
                const active = cmd.id === this._selectedId ? ' active' : '';
                html += `
                <div class="extcmd-item${active}" data-id="${cmd.id}">
                    <div class="extcmd-item-name">${this._esc(cmd.name)}</div>
                    <div class="extcmd-item-meta">
                        <span class="extcmd-item-id">#${cmd.id}</span>
                        ${(cmd.fields && cmd.fields.length) ? `<span class="extcmd-item-fields">${cmd.fields.length} поле(й)</span>` : '<span class="extcmd-item-fields extcmd-item-empty">без параметров</span>'}
                    </div>
                </div>`;
            }
        }
        list.innerHTML = html;
        list.querySelectorAll('.extcmd-item').forEach((node) =>
            node.addEventListener('click', () => this._selectCommand(parseInt(node.dataset.id, 10))),
        );
    },

    _selectCommand(id) {
        this._selectedId = id;
        this._selected = this._catalog.commands.find((c) => c.id === id) || null;
        this._renderList();
        this._renderForm();
    },

    // ── Форма выбранной команды ──────────────────────────────────

    _renderForm() {
        const root = document.getElementById('extcmd-form');
        if (!root) return;
        const cmd = this._selected;
        if (!cmd) {
            root.innerHTML = `<div class="extcmd-empty">← Выбери команду слева</div>`;
            return;
        }

        const fields = cmd.fields || [];
        const fieldsHtml = fields.length
            ? fields.map((f) => this._renderField(f)).join('')
            : '<div class="extcmd-no-fields">У команды нет параметров.</div>';

        const typeOptions = this._catalog.command_types
            .map((t) => {
                const supports = cmd.supports_wait_response || t.value === 1;
                const dis = supports ? '' : ' disabled';
                const sel = t.value === 2 && cmd.supports_wait_response ? ' selected' :
                    (t.value === 1 && !cmd.supports_wait_response ? ' selected' : '');
                return `<option value="${t.value}"${dis}${sel}>${this._esc(t.label)}</option>`;
            })
            .join('');

        root.innerHTML = `
        <div class="extcmd-form-head">
            <div>
                <div class="extcmd-form-name">${this._esc(cmd.name)} <span class="extcmd-form-id">#${cmd.id}</span></div>
                <div class="extcmd-form-desc">${this._esc(cmd.description || '')}</div>
            </div>
        </div>

        <div class="extcmd-field-row">
            <label class="extcmd-field-label">Тип</label>
            <select id="extcmd-type" class="extcmd-input">${typeOptions}</select>
            <div class="extcmd-field-hint">EXECUTE — без ответа, запись удалится. WAIT_RESPONSE — ждать ответ от сервера.</div>
        </div>

        <div class="extcmd-fields">${fieldsHtml}</div>

        <div class="extcmd-actions">
            <button class="btn btn-primary" id="extcmd-send">▶ Отправить команду</button>
            <span id="extcmd-status" class="extcmd-form-status"></span>
        </div>`;

        document.getElementById('extcmd-send').addEventListener('click', () => this._submit());
    },

    _renderField(field) {
        const key = field.key;
        const labelHtml = `<label class="extcmd-field-label" for="extcmd-f-${key}">${this._esc(field.label)}${field.required === false ? ' <span class="extcmd-field-opt">(необяз.)</span>' : ''}</label>`;
        const hintHtml = field.hint ? `<div class="extcmd-field-hint">${this._esc(field.hint)}</div>` : '';

        let inputHtml = '';
        const idAttr = `id="extcmd-f-${key}"`;
        const dataAttr = `data-key="${key}" data-type="${field.type}"`;

        if (field.type === 'enum') {
            const opts = (field.options || [])
                .map((o, i) => {
                    const sel = field.default != null
                        ? (o.value === field.default ? ' selected' : '')
                        : (i === 0 ? ' selected' : '');
                    return `<option value="${this._esc(String(o.value))}"${sel}>${this._esc(o.label)}</option>`;
                })
                .join('');
            inputHtml = `<select class="extcmd-input" ${idAttr} ${dataAttr}>${opts}</select>`;
        } else if (field.type === 'bool') {
            const checked = field.default ? ' checked' : '';
            inputHtml = `
            <label class="extcmd-checkbox">
                <input type="checkbox" ${idAttr} ${dataAttr}${checked} />
                <span>да / нет</span>
            </label>`;
        } else if (field.type === 'string') {
            const maxlen = field.maxlen ? ` maxlength="${field.maxlen}"` : '';
            inputHtml = `<input type="text" class="extcmd-input" ${idAttr} ${dataAttr}${maxlen} />`;
        } else {
            // int
            const min = field.min != null ? ` min="${field.min}"` : '';
            const max = field.max != null ? ` max="${field.max}"` : '';
            const def = field.default != null ? ` value="${field.default}"` : '';
            inputHtml = `<input type="number" class="extcmd-input" ${idAttr} ${dataAttr}${min}${max}${def} />`;
        }

        return `<div class="extcmd-field-row">${labelHtml}${inputHtml}${hintHtml}</div>`;
    },

    _collectPayload() {
        const cmd = this._selected;
        if (!cmd) return null;
        const out = {
            command: cmd.id,
            command_type: parseInt(document.getElementById('extcmd-type').value, 10),
        };
        const fields = cmd.fields || [];
        for (const f of fields) {
            const node = document.getElementById(`extcmd-f-${f.key}`);
            if (!node) continue;
            let value;
            if (f.type === 'bool') {
                value = node.checked ? 1 : 0;
            } else if (f.type === 'string') {
                value = node.value;
                if (!value && f.required === false) continue;
            } else if (f.type === 'enum') {
                const raw = node.value;
                value = raw === '' ? null : Number(raw);
            } else {
                const raw = node.value.trim();
                if (raw === '') {
                    if (f.required === false) continue;
                    value = null;
                } else {
                    value = Number(raw);
                    if (!Number.isFinite(value)) {
                        throw new Error(`«${f.label}» — нужно число`);
                    }
                }
            }
            out[f.key] = value;
        }
        return out;
    },

    async _submit() {
        const statusEl = document.getElementById('extcmd-status');
        statusEl.textContent = '';
        statusEl.className = 'extcmd-form-status';

        let payload;
        try {
            payload = this._collectPayload();
        } catch (e) {
            statusEl.classList.add('err');
            statusEl.textContent = e.message;
            return;
        }
        if (!payload) return;

        const btn = document.getElementById('extcmd-send');
        btn.disabled = true;
        btn.textContent = 'Отправка…';

        try {
            const resp = await API.post('/api/external_commands', payload);
            statusEl.classList.add('ok');
            statusEl.textContent = `Записано id=${resp.id} (state: ${resp.state_name})`;
            app.toast(`Команда отправлена (id=${resp.id})`, 'success');
            await this._loadRecent();
            if (payload.command_type === 2 && resp.id) {
                this._startPolling(resp.id);
            }
        } catch (e) {
            statusEl.classList.add('err');
            statusEl.textContent = e.message || 'Ошибка';
            app.toast(`Ошибка: ${e.message}`, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = '▶ Отправить команду';
        }
    },

    // ── Журнал (recent) ──────────────────────────────────────────

    async _loadRecent() {
        try {
            const data = await API.get('/api/external_commands/recent?limit=50');
            this._renderRecent(data.items || []);
        } catch (e) {
            const wrap = document.getElementById('extcmd-recent');
            if (wrap) wrap.innerHTML = `<div class="extcmd-error">${this._esc(e.message)}</div>`;
        }
    },

    _renderRecent(items) {
        const wrap = document.getElementById('extcmd-recent');
        const countEl = document.getElementById('extcmd-recent-count');
        if (countEl) countEl.textContent = items.length ? `${items.length} записей` : '';
        if (!wrap) return;
        if (!items.length) {
            wrap.innerHTML = `<div class="extcmd-empty-small">Пока пусто.</div>`;
            return;
        }
        const catById = new Map((this._catalog?.commands || []).map((c) => [c.id, c]));
        wrap.innerHTML = items.map((it) => {
            const spec = catById.get(it.command);
            const name = spec ? spec.name : `command #${it.command}`;
            const stateCls = this._stateClass(it.state);
            const isWait = it.command_type === 2;
            const responseHtml = it.response
                ? `<div class="extcmd-rec-response">${this._esc(it.response)}</div>`
                : '';
            return `
            <div class="extcmd-rec" data-id="${it.id}">
                <div class="extcmd-rec-row">
                    <span class="extcmd-rec-id">#${it.id}</span>
                    <span class="extcmd-rec-name">${this._esc(name)}</span>
                    <span class="extcmd-rec-type">${isWait ? 'WAIT' : 'EXEC'}</span>
                    <span class="extcmd-rec-state ${stateCls}">${this._esc(it.state_name || String(it.state))}</span>
                    <button class="btn btn-ghost btn-sm extcmd-rec-del" data-id="${it.id}" title="Удалить запись">✕</button>
                </div>
                ${responseHtml}
            </div>`;
        }).join('');

        wrap.querySelectorAll('.extcmd-rec-del').forEach((b) =>
            b.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = parseInt(b.dataset.id, 10);
                try {
                    await API.delete(`/api/external_commands/${id}`);
                    this._loadRecent();
                } catch (err) {
                    app.toast(err.message, 'error');
                }
            }),
        );
    },

    _stateClass(state) {
        if (state == null) return 'state-removed';
        if (state === 1) return 'state-wait';
        if (state === 2) return 'state-ok';
        return 'state-err';
    },

    // ── Polling для WAIT_RESPONSE ────────────────────────────────

    _startPolling(id) {
        if (this._pendingIds.has(id)) return;
        this._pendingIds.add(id);
        const startedAt = Date.now();
        const tick = async () => {
            try {
                const data = await API.get(`/api/external_commands/${id}`);
                if (data && data.state !== 1) {
                    // Готово — обновим журнал и снимем флаг
                    this._pendingIds.delete(id);
                    this._pollTimers.delete(id);
                    await this._loadRecent();
                    if (data.state === 2) {
                        app.toast(`Команда #${id}: OK${data.response ? ' — ' + data.response.slice(0, 80) : ''}`, 'success');
                    } else if (data.state == null) {
                        app.toast(`Команда #${id} выполнена и удалена сервером`, 'info');
                    } else {
                        app.toast(`Команда #${id}: ${data.state_name}${data.response ? ' — ' + data.response.slice(0, 80) : ''}`, 'error');
                    }
                    return;
                }
            } catch (e) {
                // Сетевой сбой — продолжаем опрашивать
            }
            // Тайм-аут опроса — 60 секунд
            if (Date.now() - startedAt > 60_000) {
                this._pendingIds.delete(id);
                this._pollTimers.delete(id);
                return;
            }
            const t = setTimeout(tick, 1200);
            this._pollTimers.set(id, t);
        };
        const t = setTimeout(tick, 1200);
        this._pollTimers.set(id, t);
    },

    // ── helpers ──────────────────────────────────────────────────

    _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    },
};

app.register('extcmd', ExtCmdPage);
