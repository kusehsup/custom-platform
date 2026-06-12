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
    _expandedSql: new Set(),    // id записей, у которых SQL раскрыт
    _templates: null,           // массив шаблонов из localStorage
    _prefill: null,             // {fields: {key: value}, rewards: [...]} — заполнить форму при следующем _renderForm
    _recentItems: [],           // последние items из /recent (для «Повторить»)

    abort() {
        this._pollTimers.forEach((tid) => clearTimeout(tid));
        this._pollTimers.clear();
        this._pendingIds.clear();
    },

    // ── Шаблоны (хранятся в localStorage) ───────────────────────
    _TPL_KEY: 'extcmd_templates_v1',

    _loadTemplates() {
        try {
            this._templates = JSON.parse(localStorage.getItem(this._TPL_KEY) || '[]');
        } catch {
            this._templates = [];
        }
        if (!Array.isArray(this._templates)) this._templates = [];
    },

    _saveTemplates() {
        try {
            localStorage.setItem(this._TPL_KEY, JSON.stringify(this._templates || []));
        } catch (e) {
            app.toast('Не удалось сохранить шаблон: ' + e.message, 'error');
        }
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

        this._loadTemplates();

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

        let html = '';

        // ── Шаблоны (избранное) ──
        const filterMatches = (s) => !this._filter || (s || '').toLowerCase().includes(this._filter);
        const tpls = (this._templates || []).filter((t) => {
            const cmd = this._catalog.commands.find((c) => c.id === t.command);
            return filterMatches(t.name) || filterMatches(cmd?.name);
        });
        if (tpls.length) {
            html += `<div class="extcmd-group-title">Шаблоны</div>`;
            for (const t of tpls) {
                const cmd = this._catalog.commands.find((c) => c.id === t.command);
                const cmdName = cmd ? cmd.name : `#${t.command}`;
                html += `
                <div class="extcmd-item extcmd-item-tpl" data-tpl-id="${this._esc(t.id)}">
                    <div class="extcmd-item-name">${this._esc(t.name)}</div>
                    <div class="extcmd-item-meta">
                        <span class="extcmd-item-fields">${this._esc(cmdName)}</span>
                        <button class="extcmd-tpl-del" data-tpl-del="${this._esc(t.id)}" title="Удалить шаблон">✕</button>
                    </div>
                </div>`;
            }
        }

        // ── Команды ──
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

        if (groups.size === 0 && tpls.length === 0) {
            list.innerHTML = `<div class="extcmd-empty-small">Ничего не найдено</div>`;
            return;
        }

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

        list.querySelectorAll('.extcmd-item[data-id]').forEach((node) =>
            node.addEventListener('click', () => this._selectCommand(parseInt(node.dataset.id, 10))),
        );
        list.querySelectorAll('.extcmd-item-tpl').forEach((node) =>
            node.addEventListener('click', (e) => {
                if (e.target.closest('.extcmd-tpl-del')) return;
                this._applyTemplate(node.dataset.tplId);
            }),
        );
        list.querySelectorAll('.extcmd-tpl-del').forEach((btn) =>
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._deleteTemplate(btn.dataset.tplDel);
            }),
        );
    },

    _applyTemplate(tplId) {
        const tpl = (this._templates || []).find((t) => t.id === tplId);
        if (!tpl) return;
        this._prefill = {
            command_type: tpl.command_type,
            fields: tpl.fields || {},
            rewards: tpl.rewards || null,
        };
        this._selectCommand(tpl.command);
    },

    _deleteTemplate(tplId) {
        const idx = (this._templates || []).findIndex((t) => t.id === tplId);
        if (idx < 0) return;
        if (!confirm(`Удалить шаблон «${this._templates[idx].name}»?`)) return;
        this._templates.splice(idx, 1);
        this._saveTemplates();
        this._renderList();
    },

    _saveAsTemplate() {
        if (!this._selected) return;
        let payload;
        try {
            payload = this._collectPayload();
        } catch (e) {
            app.toast('Заполни форму корректно: ' + e.message, 'error');
            return;
        }
        const defaultName = `${this._selected.name}`;
        const name = prompt('Название шаблона:', defaultName);
        if (!name) return;
        const fields = {};
        for (const k of Object.keys(payload)) {
            if (k === 'command' || k === 'command_type') continue;
            fields[k] = payload[k];
        }
        const tpl = {
            id: 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
            name: name.trim(),
            command: payload.command,
            command_type: payload.command_type,
            fields,
            // для reward_builder сохраняем и исходный массив, чтобы карточки восстановились
            rewards: this._rewards && this._rewards.length ? JSON.parse(JSON.stringify(this._rewards)) : null,
        };
        (this._templates ||= []).push(tpl);
        this._saveTemplates();
        this._renderList();
        app.toast(`Шаблон «${tpl.name}» сохранён`, 'success');
    },

    _selectCommand(id) {
        this._selectedId = id;
        this._selected = this._catalog.commands.find((c) => c.id === id) || null;
        // Если у нас есть префилл с rewards — он применится в _renderForm.
        // Иначе сбрасываем.
        if (!this._prefill || !this._prefill.rewards) {
            this._rewards = [];
        } else {
            this._rewards = JSON.parse(JSON.stringify(this._prefill.rewards));
        }
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
            <button class="btn btn-ghost btn-sm" id="extcmd-save-tpl" title="Сохранить как шаблон">☆ Шаблон</button>
            <span id="extcmd-status" class="extcmd-form-status"></span>
        </div>`;

        document.getElementById('extcmd-send').addEventListener('click', () => this._submit());
        document.getElementById('extcmd-save-tpl').addEventListener('click', () => this._saveAsTemplate());

        // Применяем prefill для command_type
        if (this._prefill && this._prefill.command_type != null) {
            const sel = document.getElementById('extcmd-type');
            if (sel) sel.value = String(this._prefill.command_type);
        }

        // Применяем prefill для скалярных полей и монтируем reward_builder
        for (const f of fields) {
            const node = document.getElementById(`extcmd-f-${f.key}`);
            if (!node) continue;
            if (f.type === 'reward_builder') {
                this._mountRewardBuilder(node, f.key);
                continue;
            }
            if (!this._prefill || !(f.key in (this._prefill.fields || {}))) continue;
            const v = this._prefill.fields[f.key];
            if (v == null) continue;
            if (f.type === 'bool') node.checked = !!v;
            else if (f.type === 'enum') node.value = String(v);
            else node.value = String(v);
        }

        // prefill одноразовый
        this._prefill = null;
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

    // Возвращает массив [{value, label}] для имени справочника или null.
    // Также собирает label из "value — name" формата для удобного UX.
    _lookupOptions(lookupName) {
        if (!lookupName) return null;
        const src = this._catalog && this._catalog[lookupName];
        if (!Array.isArray(src) || src.length === 0) return null;
        return src.map((o) => ({value: o.value, label: `${o.value} — ${o.label}`}));
    },

    // Преобразует ввод пользователя для lookup-поля в число.
    // Поддерживает: "12", "Glock 19", "12 — Glock 19".
    _resolveLookup(raw, lookupName) {
        const s = String(raw || '').trim();
        if (s === '') return undefined;
        // "12 — Glock 19" → "12"
        const headNum = s.match(/^(-?\d+)\b/);
        if (headNum) return Number(headNum[1]);
        // Чистое число
        if (/^-?\d+$/.test(s)) return Number(s);
        // Поиск по имени (case-insensitive)
        const opts = this._catalog && this._catalog[lookupName];
        if (Array.isArray(opts)) {
            const low = s.toLowerCase();
            const exact = opts.find((o) => o.label.toLowerCase() === low);
            if (exact) return exact.value;
            const starts = opts.find((o) => o.label.toLowerCase().startsWith(low));
            if (starts) return starts.value;
        }
        return NaN;
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
                    .map((f) => {
                        const lookup = this._lookupOptions(f.s.lookup);
                        let inputHtml;
                        if (lookup) {
                            const listId = `extcmd-lookup-${i}-${f.k}`;
                            const curVal = rw[f.k] != null ? rw[f.k] : '';
                            // Подпись выбранного значения (если совпадает с известным id)
                            const known = lookup.find((o) => o.value === rw[f.k]);
                            const knownLabelHtml = known
                                ? `<div class="extcmd-reward-known">${this._esc(known.label)}</div>`
                                : '';
                            const opts = lookup
                                .map((o) => `<option value="${o.value}">${this._esc(o.label)}</option>`)
                                .join('');
                            inputHtml = `
                                <input type="text" class="extcmd-input" list="${listId}"
                                       data-rw-idx="${i}" data-rw-key="${f.k}" data-rw-lookup="1"
                                       value="${curVal}"
                                       placeholder="${this._esc(f.s.hint || 'id или название')}" />
                                <datalist id="${listId}">${opts}</datalist>
                                ${knownLabelHtml}
                            `;
                        } else {
                            inputHtml = `
                                <input type="number" class="extcmd-input" data-rw-idx="${i}" data-rw-key="${f.k}"
                                       value="${rw[f.k] != null ? rw[f.k] : ''}"
                                       placeholder="${this._esc(f.s.hint || '')}" />
                            `;
                        }
                        return `
                        <div class="extcmd-reward-sub">
                            <label>${this._esc(f.s.label)}</label>
                            ${inputHtml}
                        </div>`;
                    })
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
            container.querySelectorAll('input[data-rw-idx]').forEach((inp) => {
                const isLookup = inp.dataset.rwLookup === '1';
                const handler = (e) => {
                    const i = parseInt(e.target.dataset.rwIdx, 10);
                    const k = e.target.dataset.rwKey;
                    const raw = e.target.value;
                    if (isLookup) {
                        // Берём lookup-имя из спецификации
                        const spec = this._rewardSpec(this._rewards[i].type) || types[0];
                        const sub = {index: spec.index, amount: spec.amount, extra: spec.extra,
                                     extra_str: spec.extra_str, extra_two: spec.extra_two}[k];
                        const lookupName = sub && sub.lookup;
                        const v = this._resolveLookup(raw, lookupName);
                        this._rewards[i][k] = (v === undefined || Number.isNaN(v)) ? undefined : v;
                    } else {
                        const v = raw.trim();
                        this._rewards[i][k] = v === '' ? undefined : Number(v);
                    }
                };
                inp.addEventListener('input', handler);
                if (isLookup) inp.addEventListener('change', (e) => { handler(e); render(); });
            });
            container.querySelector('.extcmd-reward-add')?.addEventListener('click', () => {
                this._rewards.push({type: types[0].value});
                render();
            });
        };
        render();
    },

    _buildRewardString(accountId) {
        // Формат для Rewards:OnExternalGiveReward — JSON-массив вида
        //   ["<account_id>", ["t","i","a","e","tt","ei2"], ["t","i","a",...]]
        // ВСЕ значения строками (pawn потом сам делает strval).
        const items = (this._rewards || []).map((rw) => {
            const get = (k) => (rw[k] != null && Number.isFinite(rw[k]) ? rw[k] : 0);
            return [get('type'), get('index'), get('amount'), get('extra'), get('extra_str'), get('extra_two')]
                .map((n) => String(n));
        });
        return JSON.stringify([String(accountId), ...items]);
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
        this._recentItems = items || [];
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
            const sqlOpen = this._expandedSql.has(it.id);
            return `
            <div class="extcmd-rec" data-id="${it.id}">
                <div class="extcmd-rec-row">
                    <span class="extcmd-rec-id">#${it.id}</span>
                    <span class="extcmd-rec-name">${this._esc(name)}</span>
                    <span class="extcmd-rec-type">${isWait ? 'WAIT' : 'EXEC'}</span>
                    <span class="extcmd-rec-state ${stateCls}">${this._esc(it.state_name || String(it.state))}</span>
                    <button class="btn btn-ghost btn-sm extcmd-rec-repeat" data-id="${it.id}" title="Повторить эту команду">↻</button>
                    <button class="btn btn-ghost btn-sm extcmd-rec-sql-toggle" data-id="${it.id}" title="Показать SQL">SQL</button>
                    <button class="btn btn-ghost btn-sm extcmd-rec-sql-copy" data-id="${it.id}" title="Скопировать INSERT">⧉</button>
                    <button class="btn btn-ghost btn-sm extcmd-rec-del" data-id="${it.id}" title="Удалить запись">✕</button>
                </div>
                ${responseHtml}
                <pre class="extcmd-rec-sql${sqlOpen ? '' : ' hidden'}" data-sql-for="${it.id}">${this._esc(sql)}</pre>
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
                const id = parseInt(b.dataset.id, 10);
                const pre = wrap.querySelector(`pre[data-sql-for="${id}"]`);
                if (!pre) return;
                if (this._expandedSql.has(id)) {
                    this._expandedSql.delete(id);
                    pre.classList.add('hidden');
                } else {
                    this._expandedSql.add(id);
                    pre.classList.remove('hidden');
                }
            }),
        );

        wrap.querySelectorAll('.extcmd-rec-repeat').forEach((b) =>
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = parseInt(b.dataset.id, 10);
                const it = this._recentItems.find((x) => x.id === id);
                if (!it) return;
                this._repeatFromRecord(it);
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

    // ── Повторить из журнала ────────────────────────────────────
    _repeatFromRecord(it) {
        const spec = (this._catalog?.commands || []).find((c) => c.id === it.command);
        if (!spec) {
            app.toast('Команда не найдена в каталоге', 'error');
            return;
        }
        const fields = {};
        if (it.data_1 != null) fields.data_1 = it.data_1;
        if (it.data_2 != null) fields.data_2 = it.data_2;
        if (it.data_3 != null) fields.data_3 = it.data_3;
        if (it.data_4 != null) fields.data_4 = it.data_4;
        if (it.data_string_1) fields.data_string_1 = it.data_string_1;

        // Если в спецификации есть reward_builder и data_string_1 — пытаемся распарсить обратно
        let rewards = null;
        const rewardField = (spec.fields || []).find((f) => f.type === 'reward_builder');
        if (rewardField && it.data_string_1) {
            rewards = this._parseRewardString(it.data_string_1);
            // data_string_1 не нужно подставлять как строку — её перестроит reward_builder
            delete fields.data_string_1;
        }

        this._prefill = {
            command_type: it.command_type,
            fields,
            rewards,
        };
        this._selectCommand(it.command);
    },

    _parseRewardString(s) {
        // Формат: ["<sql_id>", ["t","i","a","e","tt","ei2"], ...]
        try {
            const arr = JSON.parse(s);
            if (!Array.isArray(arr) || arr.length < 2) return null;
            const out = [];
            for (let i = 1; i < arr.length; i++) {
                const r = arr[i];
                if (!Array.isArray(r)) continue;
                const num = (x) => {
                    const n = Number(x);
                    return Number.isFinite(n) ? n : 0;
                };
                out.push({
                    type:      num(r[0]),
                    index:     num(r[1]),
                    amount:    num(r[2]),
                    extra:     num(r[3]),
                    extra_str: num(r[4]),
                    extra_two: num(r[5]),
                });
            }
            return out.length ? out : null;
        } catch {
            return null;
        }
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
