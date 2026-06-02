// ── Tasks page ──────────────────────────────────────────────────────

const TasksPage = {
    _selectedId: null,
    _filter: null,        // null = все, 'open' | 'in_progress' | 'done' | 'blocked'
    _unsub: null,
    _files: {},           // file_id → meta (для прикрепления Pawn-файлов)

    render(root) {
        root.innerHTML = `
        <div class="tasks-page">
            <div class="tasks-page-header">
                <div>
                    <h2 style="font-size:18px;font-weight:600;color:var(--text);margin:0">Задачи</h2>
                    <div class="tasks-page-sub" id="tasks-sub">—</div>
                </div>
                <div style="display:flex;gap:6px">
                    <button class="btn btn-primary btn-sm" id="task-new-btn">+ Новая задача</button>
                </div>
            </div>

            <div class="tasks-layout">
                <div class="tasks-list-pane">
                    <div class="tasks-filters">
                        <button class="task-filter" data-filter="">Все</button>
                        <button class="task-filter" data-filter="in_progress">В работе</button>
                        <button class="task-filter" data-filter="open">Открытые</button>
                        <button class="task-filter" data-filter="blocked">Заблокированы</button>
                        <button class="task-filter" data-filter="done">Завершены</button>
                    </div>
                    <div id="tasks-list" class="tasks-list"></div>
                </div>
                <div id="task-detail" class="task-detail">
                    <div class="ai-empty">Выбери задачу слева или создай новую.</div>
                </div>
            </div>
        </div>`;

        document.getElementById('task-new-btn').addEventListener('click', () => this._openCreateModal());
        root.querySelectorAll('.task-filter').forEach(btn => {
            btn.addEventListener('click', () => {
                this._filter = btn.dataset.filter || null;
                this._renderList();
            });
        });

        this._unsub = TasksStore.subscribe(() => {
            this._renderList();
            this._renderDetail();
            this._renderSub();
        });

        // Тянем файлы для прикрепления (используем тот же endpoint что и для AI)
        API.get('/api/files').then(data => {
            this._files = data.files || {};
        }).catch(() => {});

        TasksStore.load().then(() => {
            this._renderList();
            this._renderDetail();
            this._renderSub();
        });
    },

    cleanup() {
        if (this._unsub) { this._unsub(); this._unsub = null; }
    },

    _renderSub() {
        const el = document.getElementById('tasks-sub');
        if (!el) return;
        const all = TasksStore.list();
        const inProgress = all.filter(t => t.status === 'in_progress').length;
        const open = all.filter(t => t.status === 'open').length;
        const done = all.filter(t => t.status === 'done').length;
        const active = TasksStore.getActive();
        el.innerHTML = `
            ${inProgress} в работе · ${open} открытых · ${done} завершено
            ${active ? `· активная: <b>${this._esc(active.title)}</b>` : ''}
        `;
    },

    _renderList() {
        const list = document.getElementById('tasks-list');
        if (!list) return;
        document.querySelectorAll('.task-filter').forEach(b => {
            b.classList.toggle('active', (b.dataset.filter || null) === this._filter);
        });
        const tasks = TasksStore.list(this._filter);
        if (!tasks.length) {
            list.innerHTML = `<div class="ai-empty" style="padding:24px">Задач нет</div>`;
            return;
        }
        const activeId = TasksStore.activeId();
        list.innerHTML = tasks.map(t => this._taskRowHtml(t, activeId)).join('');
        list.querySelectorAll('.task-row').forEach(el => {
            el.addEventListener('click', () => {
                this._selectedId = el.dataset.id;
                this._renderList();
                this._renderDetail();
            });
        });
    },

    _taskRowHtml(t, activeId) {
        const isSelected = t.id === this._selectedId;
        const isActive = t.id === activeId;
        const dot = `task-dot task-dot-${t.status}`;
        const prio = `task-prio task-prio-${t.priority || 'medium'}`;
        return `
        <div class="task-row ${isSelected ? 'selected' : ''}" data-id="${t.id}">
            <span class="${dot}"></span>
            <div class="task-row-body">
                <div class="task-row-title">${this._esc(t.title)}${isActive ? ' <span class="task-active-badge">активная</span>' : ''}</div>
                <div class="task-row-meta">
                    <span class="task-status task-status-${t.status}">${this._statusLabel(t.status)}</span>
                    <span class="${prio}">${this._prioLabel(t.priority || 'medium')}</span>
                    ${(t.attached_files?.length || 0) ? `<span class="task-row-files">📎 ${t.attached_files.length}</span>` : ''}
                    ${(t.attachments?.length || 0) ? `<span class="task-row-files">🖼 ${t.attachments.length}</span>` : ''}
                </div>
            </div>
        </div>`;
    },

    _statusLabel(s) {
        return {open: 'open', in_progress: 'в работе', done: 'done', blocked: 'blocked'}[s] || s;
    },

    _prioLabel(p) {
        return {low: 'low', medium: 'med', high: 'HIGH'}[p] || p;
    },

    _renderDetail() {
        const wrap = document.getElementById('task-detail');
        if (!wrap) return;
        const t = this._selectedId ? TasksStore.get(this._selectedId) : null;
        if (!t) {
            wrap.innerHTML = `<div class="ai-empty">Выбери задачу слева или создай новую.</div>`;
            return;
        }
        const activeId = TasksStore.activeId();
        const isActive = t.id === activeId;
        const filesHtml = (t.attached_files || []).map(fid => {
            const meta = this._files[fid] || {};
            const name = meta.fullPath || meta.name || fid;
            return `<span class="ai-chip" title="${this._esc(name)}">
                <span class="ai-chip-name">${this._esc(meta.name || name)}</span>
                <button class="ai-chip-x" data-action="detach-file" data-fid="${fid}">✕</button>
            </span>`;
        }).join('');

        const attachmentsHtml = (t.attachments || []).map(a => {
            if (a.kind === 'image') {
                return `<div class="task-att" data-id="${a.id}">
                    <a href="${a.url}" target="_blank"><img src="${a.url}" alt="${this._esc(a.name)}" /></a>
                    <div class="task-att-bar">
                        <span class="task-att-name">${this._esc(a.name)}</span>
                        <button class="task-att-x" data-action="rm-attach" data-aid="${a.id}">✕</button>
                    </div>
                </div>`;
            }
            return `<div class="task-att task-att-file" data-id="${a.id}">
                <a href="${a.url}" target="_blank">${this._esc(a.name)}</a>
                <button class="task-att-x" data-action="rm-attach" data-aid="${a.id}">✕</button>
            </div>`;
        }).join('');

        const notesHtml = (t.notes || []).slice().reverse().map(n => `
            <div class="task-note">
                <div class="task-note-meta">${this._fmtDate(n.at)}</div>
                <div class="task-note-text">${this._esc(n.text).replace(/\n/g, '<br>')}</div>
            </div>`).join('');

        const aiLogHtml = (t.ai_log || []).slice().reverse().slice(0, 20).map(l => {
            const files = (l.files || []).map(f => `<code class="ai-inline-code">${this._esc(f)}</code>`).join(' ');
            return `<div class="task-ai-log-item">
                <span class="task-ai-log-time">${this._fmtDate(l.at)}</span>
                <span class="task-ai-log-kind">${l.kind}</span>
                <span class="task-ai-log-summary">${this._esc(l.summary || '')}</span>
                ${files ? `<div class="task-ai-log-files">${files}</div>` : ''}
            </div>`;
        }).join('');

        wrap.innerHTML = `
        <div class="task-detail-header">
            <input id="task-title" type="text" value="${this._esc(t.title)}" />
            <div class="task-detail-actions">
                ${isActive
                    ? `<button class="btn btn-ghost btn-sm" id="task-deactivate">Снять активность</button>`
                    : `<button class="btn btn-primary btn-sm" id="task-activate">Сделать активной</button>`}
                <button class="btn btn-danger btn-sm" id="task-delete">Удалить</button>
            </div>
        </div>

        <div class="task-meta-row">
            <label class="ai-field" style="min-width:140px">
                <span>Статус</span>
                <select id="task-status" class="ai-select">
                    <option value="open"        ${t.status==='open'?'selected':''}>Открыта</option>
                    <option value="in_progress" ${t.status==='in_progress'?'selected':''}>В работе</option>
                    <option value="blocked"     ${t.status==='blocked'?'selected':''}>Заблокирована</option>
                    <option value="done"        ${t.status==='done'?'selected':''}>Завершена</option>
                </select>
            </label>
            <label class="ai-field" style="min-width:140px">
                <span>Приоритет</span>
                <select id="task-priority" class="ai-select">
                    <option value="low"    ${t.priority==='low'?'selected':''}>Низкий</option>
                    <option value="medium" ${t.priority==='medium' || !t.priority?'selected':''}>Средний</option>
                    <option value="high"   ${t.priority==='high'?'selected':''}>Высокий</option>
                </select>
            </label>
            <div class="task-meta-spacer"></div>
            <div class="task-detail-times">
                <span>создана ${this._fmtDate(t.created_at)}</span>
                <span>обновлена ${this._fmtDate(t.updated_at)}</span>
                ${t.completed_at ? `<span>завершена ${this._fmtDate(t.completed_at)}</span>` : ''}
            </div>
        </div>

        <div class="task-section">
            <div class="task-section-title">Описание</div>
            <textarea id="task-description" rows="8" placeholder="Опиши задачу. Поддерживается markdown.">${this._esc(t.description || '')}</textarea>
            <div class="task-section-actions">
                <button class="btn btn-ghost btn-sm" id="task-save-desc">Сохранить</button>
            </div>
        </div>

        <div class="task-section">
            <div class="task-section-title">Pawn-файлы задачи <span class="task-section-hint">через @</span></div>
            <div class="ai-chips" style="background:transparent;border:none;padding:0;${filesHtml ? '' : 'display:none'}">${filesHtml}</div>
            <div class="task-section-actions">
                <input id="task-file-search" type="text" placeholder="Найти файл по имени или пути..." class="task-search" />
                <div id="task-file-results" class="task-file-results"></div>
            </div>
        </div>

        <div class="task-section">
            <div class="task-section-title">Скриншоты и файлы</div>
            <div class="task-dropzone" id="task-dropzone">
                <div>Перетащи файлы сюда или <button class="task-link" id="task-pick-file">выбери</button></div>
                <input type="file" id="task-file-input" multiple style="display:none" accept=".png,.jpg,.jpeg,.gif,.webp,.svg,.txt,.md,.log,.json,.pwn,.inc,.pdf" />
            </div>
            <div class="task-attachments">${attachmentsHtml}</div>
        </div>

        <div class="task-section">
            <div class="task-section-title">Заметки</div>
            <div class="task-note-composer">
                <textarea id="task-note-input" rows="2" placeholder="Добавить заметку (Ctrl+Enter)"></textarea>
                <button class="btn btn-primary btn-sm" id="task-note-add">Добавить</button>
            </div>
            <div class="task-notes">${notesHtml || '<div class="ai-hint">Пока нет заметок</div>'}</div>
        </div>

        ${aiLogHtml ? `
        <div class="task-section">
            <div class="task-section-title">Журнал AI-активности</div>
            <div class="task-ai-log">${aiLogHtml}</div>
        </div>` : ''}
        `;

        this._bindDetail(t);
    },

    _bindDetail(t) {
        const $ = id => document.getElementById(id);

        $('task-delete').addEventListener('click', async () => {
            if (!confirm(`Удалить задачу "${t.title}"?`)) return;
            await TasksStore.delete(t.id);
            this._selectedId = null;
            this._renderDetail();
            this._renderList();
            app.toast('Задача удалена', 'info');
        });

        if (document.getElementById('task-activate')) {
            $('task-activate').addEventListener('click', async () => {
                await TasksStore.setActive(t.id);
                app.toast('Задача активна — Claude её видит', 'success');
            });
        }
        if (document.getElementById('task-deactivate')) {
            $('task-deactivate').addEventListener('click', async () => {
                await TasksStore.setActive(null);
                app.toast('Снято', 'info');
            });
        }

        const saveField = async (field, value) => {
            try {
                await TasksStore.update(t.id, { [field]: value });
            } catch (e) { app.toast(e.message, 'error'); }
        };

        const titleInput = $('task-title');
        let titleDebounce;
        titleInput.addEventListener('input', () => {
            clearTimeout(titleDebounce);
            titleDebounce = setTimeout(() => saveField('title', titleInput.value), 500);
        });

        $('task-status').addEventListener('change', e => saveField('status', e.target.value));
        $('task-priority').addEventListener('change', e => saveField('priority', e.target.value));

        const descTa = $('task-description');
        $('task-save-desc').addEventListener('click', () => saveField('description', descTa.value).then(() => app.toast('Описание сохранено', 'info')));
        descTa.addEventListener('keydown', e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                saveField('description', descTa.value).then(() => app.toast('Описание сохранено', 'info'));
            }
        });

        // Отвязка Pawn-файла
        document.querySelectorAll('[data-action="detach-file"]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const fid = btn.dataset.fid;
                const newList = (t.attached_files || []).filter(x => String(x) !== String(fid));
                await TasksStore.update(t.id, { attached_files: newList });
            });
        });

        // Поиск файлов для прикрепления
        const searchInput = $('task-file-search');
        const resultsEl = $('task-file-results');
        const fileList = Object.entries(this._files);
        const renderResults = q => {
            const query = (q || '').toLowerCase().trim();
            if (!query) { resultsEl.innerHTML = ''; resultsEl.style.display='none'; return; }
            const matches = [];
            for (const [fid, meta] of fileList) {
                const name = (meta.name || '').toLowerCase();
                const path = (meta.fullPath || '').toLowerCase();
                if (name.includes(query) || path.includes(query)) {
                    matches.push({ fid, meta });
                    if (matches.length >= 20) break;
                }
            }
            if (!matches.length) {
                resultsEl.innerHTML = `<div class="task-file-empty">Ничего не найдено</div>`;
            } else {
                resultsEl.innerHTML = matches.map(({fid, meta}) => `
                    <div class="task-file-result" data-fid="${fid}">
                        <span class="task-file-result-name">${this._esc(meta.name || fid)}</span>
                        <span class="task-file-result-path">${this._esc(meta.fullPath || '')}</span>
                    </div>`).join('');
                resultsEl.querySelectorAll('.task-file-result').forEach(el => {
                    el.addEventListener('click', async () => {
                        const newList = [...(t.attached_files || [])];
                        if (!newList.map(String).includes(String(el.dataset.fid))) {
                            newList.push(el.dataset.fid);
                            await TasksStore.update(t.id, { attached_files: newList });
                            searchInput.value = '';
                            resultsEl.innerHTML = '';
                            resultsEl.style.display='none';
                        }
                    });
                });
            }
            resultsEl.style.display = 'block';
        };
        searchInput.addEventListener('input', e => renderResults(e.target.value));

        // Заметки
        const noteInput = $('task-note-input');
        const addNote = async () => {
            const text = noteInput.value.trim();
            if (!text) return;
            try {
                await TasksStore.addNote(t.id, text);
                noteInput.value = '';
                app.toast('Заметка добавлена', 'info');
            } catch (e) { app.toast(e.message, 'error'); }
        };
        $('task-note-add').addEventListener('click', addNote);
        noteInput.addEventListener('keydown', e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                addNote();
            }
        });

        // Удаление аттача
        document.querySelectorAll('[data-action="rm-attach"]').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Удалить вложение?')) return;
                try {
                    await TasksStore.deleteAttachment(t.id, btn.dataset.aid);
                } catch (e) { app.toast(e.message, 'error'); }
            });
        });

        // Drag&drop / file pick
        const dropzone = $('task-dropzone');
        const fileInput = $('task-file-input');
        $('task-pick-file').addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => this._uploadFiles(t.id, fileInput.files));
        ['dragenter', 'dragover'].forEach(ev => dropzone.addEventListener(ev, e => {
            e.preventDefault(); dropzone.classList.add('over');
        }));
        ['dragleave', 'drop'].forEach(ev => dropzone.addEventListener(ev, e => {
            e.preventDefault(); dropzone.classList.remove('over');
        }));
        dropzone.addEventListener('drop', e => {
            e.preventDefault();
            this._uploadFiles(t.id, e.dataTransfer.files);
        });

        // Paste-screenshot — если фокус в любом поле детали
        const onPaste = e => {
            const items = e.clipboardData?.items || [];
            for (const it of items) {
                if (it.kind === 'file') {
                    const file = it.getAsFile();
                    if (file) this._uploadFiles(t.id, [file]);
                }
            }
        };
        document.querySelector('.task-detail').addEventListener('paste', onPaste);
    },

    async _uploadFiles(taskId, files) {
        for (const file of files) {
            try {
                await TasksStore.uploadAttachment(taskId, file);
                app.toast(`Загружено: ${file.name}`, 'info');
            } catch (e) {
                app.toast(`${file.name}: ${e.message}`, 'error');
            }
        }
    },

    _openCreateModal() {
        const existing = document.getElementById('task-create-modal');
        if (existing) existing.remove();
        const modal = document.createElement('div');
        modal.id = 'task-create-modal';
        modal.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:24px';
        modal.innerHTML = `
        <div class="task-create-window">
            <div class="task-create-header">
                <span>Новая задача</span>
                <button class="task-create-close">✕</button>
            </div>
            <div class="task-create-body">
                <input type="text" id="tc-title" placeholder="Что нужно сделать" autofocus />
                <textarea id="tc-desc" rows="5" placeholder="Описание (markdown, не обязательно)"></textarea>
                <div class="task-create-row">
                    <label class="ai-field">
                        <span>Приоритет</span>
                        <select id="tc-prio" class="ai-select">
                            <option value="low">Низкий</option>
                            <option value="medium" selected>Средний</option>
                            <option value="high">Высокий</option>
                        </select>
                    </label>
                    <label class="ai-toggle-row" style="margin-left:auto">
                        <label class="toggle">
                            <input type="checkbox" id="tc-active" checked />
                            <span class="toggle-track"></span>
                        </label>
                        <span class="ai-toggle-label">Сделать активной</span>
                    </label>
                </div>
            </div>
            <div class="task-create-footer">
                <button class="btn btn-ghost btn-sm" id="tc-cancel">Отмена</button>
                <button class="btn btn-primary btn-sm" id="tc-create">Создать</button>
            </div>
        </div>`;
        document.body.appendChild(modal);
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
        modal.querySelector('.task-create-close').addEventListener('click', () => modal.remove());
        document.getElementById('tc-cancel').addEventListener('click', () => modal.remove());
        const create = async () => {
            const title = document.getElementById('tc-title').value.trim();
            if (!title) { app.toast('Заголовок обязателен', 'error'); return; }
            const desc = document.getElementById('tc-desc').value;
            const priority = document.getElementById('tc-prio').value;
            const makeActive = document.getElementById('tc-active').checked;
            try {
                const task = await TasksStore.create({ title, description: desc, priority, make_active: makeActive });
                modal.remove();
                this._selectedId = task.id;
                this._renderList();
                this._renderDetail();
                this._renderSub();
                app.toast('Задача создана', 'success');
            } catch (e) { app.toast(e.message, 'error'); }
        };
        document.getElementById('tc-create').addEventListener('click', create);
        document.getElementById('tc-title').addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); create(); }
        });
    },

    _esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); },

    _fmtDate(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (isNaN(d.getTime())) return iso;
        return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
    },
};

app.register('tasks', TasksPage);
