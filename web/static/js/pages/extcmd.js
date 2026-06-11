// ── External Commands ───────────────────────────────────────────
//
// Страница «Внешние команды» — отправка записей в таблицу
// external_commands Pawn-сервера и просмотр их статусов.

const ExtCmdPage = {
    _catalog: null,             // {commands, state_names, command_types, reward_types}
    _filter: '',
    _selectedId: null,          // id команды из каталога
    _selected: null,            // объект команды из каталога
    _pendingIds: new Set(),     // id записей, для которых идёт WAIT-опрос
    _pollTimers: new Map(),     // recordId -> timeoutId
    _rewards: [],               // состояние reward_builder для текущей команды

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
        this._rewards = [];
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

        // Монтаж reward_builder (после установки innerHTML)
        for (const f of fields) {
            if (f.type !== 'reward_builder') continue;
            const node = document.getElementById(`extcmd-f-${f.key}`);
            if (node) this._mountRewardBuilder(node, f.key);
        }
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
        } else if (field.type === 'reward_builder') {
            inputHtml = `<div class="extcmd-rewards" ${idAttr} ${dataAttr}></div>`;
        } else {
            // int
            const min = field.min != null ? ` min="${field.min}"` : '';
            const max = field.max != null ? ` max="${field.max}"` : '';
            const def = field.default != null ? ` value="${field.default}"` : '';
            inputHtml = `<input type="number" class="extcmd-input" ${idAttr} ${dataAttr}${min}${max}${def} />`;
        }

        return `<div class="extcmd-field-row">${labelHtml}${inputHtml}${hintHtml}</div>`;
    },

    // ── reward_builder ───────────────────────────────────────────
    // Динамический список наград. Каждая запись: {type, index, amount, extra, extra_str, extra_two}.
    // Поля кроме `type` рендерятся по спеке reward_types[type].

    _rewardSpec(typeValue) {
        return (this._catalog?.reward_types || []).find((t) => t.value === typeValue) || null;
    },

    _mountRewardBuilder(container, fieldKey) {
        const types = this._catalog?.reward_types || [];
        if (!types.length) {
            container.innerHTML = '<div class="extcmd-error">reward_types отсутствуют в каталоге</div>';
            return;
        }
        if (this._rewards.length === 0) {
            this._rewards.push({type: types[0].value});
        }
        const render = () => {
            const rows = this._rewards.map((rw, i) => {
                const spec = this._rewardSpec(rw.type) || types[0];
                const typeOpts = types
                    .map((t) => `<option value="${t.value}"${t.value === rw.type ? ' selected' : ''}>${this._esc(t.label)}</option>`)
                    .join('');
                const subFields = [
                    {k: 'index',     s: spec.index},
                    {k: 'amount',    s: spec.amount},
                    {k: 'extra',     s: spec.extra},
                    {k: 'extra_str', s: spec.extra_str},
                    {k: 'extra_two', s: spec.extra_two},
                ];
                const subHtml = subFields
                    .filter((f) => f.s)
                    .map((f) => `
                        <div class="extcmd-reward-sub">
                            <label>${this._esc(f.s.label)}</label>
                            <input type="number" class="extcmd-input" data-rw-idx="${i}" data-rw-key="${f.k}"
                                   value="${rw[f.k] != null ? rw[f.k] : ''}"
                                   placeholder="${this._esc(f.s.hint || '')}" />
                        </div>`)
                    .join('');
                return `
                <div class="extcmd-reward" data-rw-row="${i}">
                    <div class="extcmd-reward-head">
                        <span class="extcmd-reward-num">#${i + 1}</span>
                        <select class="extcmd-input extcmd-reward-type" data-rw-idx="${i}">${typeOpts}</select>
                        <button class="btn btn-ghost btn-sm extcmd-reward-del" data-rw-idx="${i}" title="Убрать">✕</button>
                    </div>
                    ${subHtml ? `<div class="extcmd-reward-subs">${subHtml}</div>` : '<div class="extcmd-reward-subs extcmd-reward-empty">Нет дополнительных полей.</div>'}
                </div>`;
            }).join('');
            container.innerHTML = `
                ${rows}
                <button class="btn btn-ghost btn-sm extcmd-reward-add">+ добавить награду</button>
            `;
            container.querySelectorAll('.extcmd-reward-type').forEach((sel) =>
                sel.addEventListener('change', (e) => {
                    const i = parseInt(e.target.dataset.rwIdx, 10);
                    this._rewards[i] = {type: parseInt(e.target.value, 10)};
                    render();
                }),
            );
            container.querySelectorAll('.extcmd-reward-del').forEach((btn) =>
                btn.addEventListener('click', () => {
                    const i = parseInt(btn.dataset.rwIdx, 10);
                    this._rewards.splice(i, 1);
                    if (this._rewards.length === 0) this._rewards.push({type: types[0].value});
                    render();
                }),
            );
            container.querySelectorAll('input[data-rw-idx]').forEach((inp) =>
                inp.addEventListener('input', (e) => {
                    const i = parseInt(e.target.dataset.rwIdx, 10);
                    const k = e.target.dataset.rwKey;
                    const v = e.target.value.trim();
                    this._rewards[i][k] = v === '' ? undefined : Number(v);
                }),
            );
            container.querySelector('.extcmd-reward-add')?.addEventListener('click', () => {
                this._rewards.push({type: types[0].value});
                render();
            });
        };
        render();
    },

    _buildRewardString(accountId) {
        // Формат, который понимает Rewards:OnExternalGiveReward:
        //   "<account_id>[type,index,amount,extra,extra_str,extra_two]..."
        // Пустые числа в начале можно опустить — но pawn делает strval(""),
        // что = 0, поэтому пишем 0 для пропущенных.
        const parts = (this._rewards || []).map((rw) => {
            const get = (k) => (rw[k] != null && Number.isFinite(rw[k]) ? rw[k] : 0);
            const arr = [get('type'), get('index'), get('amount'), get('extra'), get('extra_str'), get('extra_two')];
            return `[${arr.join(',')}]`;
        });
        return `"${accountId}"${parts.join('')}`;
    },

    _collectPayload() {
        const cmd = this._selected;
        if (!cmd) return null;
        const out = {
            command: cmd.id,
            command_type: parseInt(document.getElementById('extcmd-type').value, 10),
        };
        const fields = cmd.fields || [];
        // Первый проход: собрать обычные поля
        const reservedRewardKeys = [];
        for (const f of fields) {
            if (f.type === 'reward_builder') {
                reservedRewardKeys.push(f);
                continue;
            }
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
        // Второй проход: reward_builder. Требует data_1 (account_id).
        for (const f of reservedRewardKeys) {
            const accountId = out['data_1'];
            if (accountId == null || !Number.isFinite(accountId)) {
                throw new Error('Нужно заполнить SQL ID аккаунта');
            }
            if (!this._rewards || this._rewards.length === 0) {
                throw new Error('Добавьте хотя бы одну награду');
            }
            out[f.key] = this._buildRewardString(accountId);
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
            const sql = this._buildInsertSql(it);
            return `
            <div class="extcmd-rec" data-id="${it.id}">
                <div class="extcmd-rec-row">
                    <span class="extcmd-rec-id">#${it.id}</span>
                    <span class="extcmd-rec-name">${this._esc(name)}</span>
                    <span class="extcmd-rec-type">${isWait ? 'WAIT' : 'EXEC'}</span>
                    <span class="extcmd-rec-state ${stateCls}">${this._esc(it.state_name || String(it.state))}</span>
                    <button class="btn btn-ghost btn-sm extcmd-rec-sql-toggle" data-id="${it.id}" title="Показать SQL">SQL</button>
                    <button class="btn btn-ghost btn-sm extcmd-rec-sql-copy" data-id="${it.id}" title="Скопировать INSERT">⧉</button>
                    <button class="btn btn-ghost btn-sm extcmd-rec-del" data-id="${it.id}" title="Удалить запись">✕</button>
                </div>
                ${responseHtml}
                <pre class="extcmd-rec-sql hidden" data-sql-for="${it.id}">${this._esc(sql)}</pre>
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

        wrap.querySelectorAll('.extcmd-rec-sql-toggle').forEach((b) =>
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = b.dataset.id;
                const pre = wrap.querySelector(`pre[data-sql-for="${id}"]`);
                if (pre) pre.classList.toggle('hidden');
            }),
        );

        wrap.querySelectorAll('.extcmd-rec-sql-copy').forEach((b) =>
            b.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = b.dataset.id;
                const pre = wrap.querySelector(`pre[data-sql-for="${id}"]`);
                if (!pre) return;
                try {
                    await navigator.clipboard.writeText(pre.textContent);
                    app.toast('SQL скопирован', 'success');
                } catch {
                    app.toast('Не удалось скопировать', 'error');
                }
            }),
        );
    },

    // Построить INSERT для записи журнала — чтобы можно было скопировать
    // и выполнить на проде через любой MySQL-клиент.
    _buildInsertSql(it) {
        const cmdType = it.command_type === 2 ? 'WAIT_RESPONSE' : (it.command_type === 1 ? 'EXECUTE' : (it.command_type === 3 ? 'PROCESS' : 'EXECUTE'));
        const cols = ['command', 'command_type'];
        const vals = [String(it.command), this._sqlStr(cmdType)];
        // initial state для WAIT_RESPONSE — иначе сервер не подхватит
        if (it.command_type === 2) {
            cols.push('state');
            vals.push(this._sqlStr('WAIT_RESPONSE'));
        }
        for (const k of ['data_1', 'data_2', 'data_3', 'data_4']) {
            if (it[k] != null) {
                cols.push(k);
                vals.push(String(it[k]));
            }
        }
        if (it.data_string_1) {
            cols.push('data_string_1');
            vals.push(this._sqlStr(it.data_string_1));
        }
        return `INSERT INTO \`external_commands\` (\`${cols.join('`, `')}\`)\nVALUES (${vals.join(', ')});`;
    },

    _sqlStr(s) {
        return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
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
