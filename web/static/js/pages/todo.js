// ── TODO Tracker ─────────────────────────────────────────────────

const TodoPage = {
    _activeFilters: new Set(['TODO', 'FIXME', 'HACK', 'NOTE']),
    _items: null,
    _scanning: false,
    _searchQ: '',
    _abortController: null,

    abort() {
        if (this._abortController) {
            this._abortController.abort();
            this._abortController = null;
        }
        this._scanning = false;
    },

    render(el) {
        el.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <h2 style="font-size:18px;font-weight:600;color:var(--text)">TODO трекер</h2>
            <div style="display:flex;align-items:center;gap:8px">
                <span id="todo-progress" style="font-size:12px;color:var(--text-3)"></span>
                <button class="btn btn-ghost btn-sm" id="todo-refresh">↻ Пересканировать</button>
            </div>
        </div>
        <div class="card" style="padding:16px 20px">
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px">
                <span style="font-size:12px;color:var(--text-3)">Фильтр:</span>
                <span class="todo-tag todo-todo active" data-tag="TODO">TODO</span>
                <span class="todo-tag todo-fixme active" data-tag="FIXME">FIXME</span>
                <span class="todo-tag todo-hack active" data-tag="HACK">HACK</span>
                <span class="todo-tag todo-note active" data-tag="NOTE">NOTE</span>
                <span style="flex:1"></span>
                <input id="todo-search" type="text" placeholder="Поиск..." style="width:200px;padding:5px 10px;font-size:12.5px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);outline:none" />
            </div>
            <div id="todo-summary" style="font-size:12px;color:var(--text-3);margin-bottom:10px"></div>
            <div id="todo-list" class="todo-wrap"></div>
        </div>`;

        el.querySelectorAll('.todo-tag').forEach(tag => {
            tag.addEventListener('click', () => {
                const t = tag.dataset.tag;
                if (this._activeFilters.has(t)) this._activeFilters.delete(t);
                else this._activeFilters.add(t);
                this._renderList(el);
            });
        });
        el.querySelector('#todo-refresh').addEventListener('click', () => {
            this._items = null;
            this._scan(el);
        });
        el.querySelector('#todo-search').addEventListener('input', e => {
            this._searchQ = e.target.value.toLowerCase();
            this._renderList(el);
        });

        this._searchQ = '';

        // Если уже есть закэшированные результаты — показываем сразу
        if (this._items !== null) {
            this._renderList(el);
        } else {
            this._scan(el);
        }
    },

    async _scan(el) {
        if (this._scanning) return;
        this._scanning = true;
        this._abortController = new AbortController();
        const signal = this._abortController.signal;

        const list     = el?.querySelector('#todo-list');
        const summary  = el?.querySelector('#todo-summary');
        const progress = el?.querySelector('#todo-progress');

        if (list) list.innerHTML = '<div style="color:var(--text-3);font-size:13px;padding:12px 0">Сканирование файлов...</div>';
        if (summary) summary.textContent = '';
        if (progress) progress.textContent = '';

        const filesPage = app._pages['files'];
        if (!filesPage) {
            if (list) list.innerHTML = '<div style="color:var(--red);font-size:13px;padding:12px 0">Страница файлов не загружена. Откройте раздел Файлы сначала.</div>';
            this._scanning = false;
            return;
        }

        // Ждём пока files загрузит список (до 5с)
        for (let i = 0; i < 10; i++) {
            if (filesPage._files && Object.keys(filesPage._files).length) break;
            await new Promise(r => setTimeout(r, 500));
        }

        const accessible = filesPage._files || {};
        const allFiles   = filesPage._allFiles || {};
        const fileIds    = Object.keys(accessible);

        if (!fileIds.length) {
            if (list) list.innerHTML = '<div style="color:var(--text-3);font-size:13px;padding:12px 0">Нет доступных файлов.</div>';
            this._scanning = false;
            return;
        }

        const items = [];
        let done = 0;

        // Сначала берём уже закэшированные части
        const cached   = filesPage._codeParts || {};
        const toFetch  = [];
        for (const fileId of fileIds) {
            if (cached[fileId]) {
                this._scanParts(fileId, cached[fileId], accessible, allFiles, items);
                done++;
            } else {
                toFetch.push(fileId);
            }
        }

        if (progress) progress.textContent = `${done}/${fileIds.length}`;

        // Остальные грузим асинхронно пачками по 5
        const BATCH = 5;
        for (let i = 0; i < toFetch.length; i += BATCH) {
            if (signal.aborted) { this._scanning = false; return; }
            const batch = toFetch.slice(i, i + BATCH);
            await Promise.all(batch.map(async fileId => {
                if (signal.aborted) return;
                try {
                    const data = await API.get(`/api/file/${fileId}/code`);
                    if (signal.aborted) return;
                    if (data.code?.length) {
                        if (!filesPage._codeParts) filesPage._codeParts = {};
                        filesPage._codeParts[fileId] = data.code;
                        this._scanParts(fileId, data.code, accessible, allFiles, items);
                    }
                } catch {}
                done++;
                const prog = document.getElementById('todo-progress');
                if (prog) prog.textContent = `${done}/${fileIds.length}`;
            }));

            if (i % (BATCH * 2) === 0) {
                this._items = [...items];
                this._renderList(el);
                this._updateBadge();
                await new Promise(r => setTimeout(r, 0));
            }
        }

        if (signal.aborted) { this._scanning = false; return; }
        this._items = items;
        this._scanning = false;
        this._abortController = null;
        if (progress) progress.textContent = '';
        this._renderList(el);
        this._updateBadge();
    },

    _scanParts(fileId, parts, accessible, allFiles, items) {
        const fileInfo = accessible[fileId] || allFiles[fileId] || {};
        for (const part of (parts || [])) {
            const content   = part.content || '';
            const startLine = part.line || 1;
            content.split('\n').forEach((line, i) => {
                const match = line.match(/\/\/\s*(TODO|FIXME|HACK|NOTE)\b[:\s]*(.*)/i);
                if (match) {
                    items.push({
                        type: match[1].toUpperCase(),
                        text: match[2].trim() || line.trim(),
                        file: fileInfo.fullPath || fileId,
                        fileId,
                        line: startLine + i,
                    });
                }
            });
        }
    },

    _updateBadge() {
        const badge = document.getElementById('todo-badge');
        if (!badge) return;
        const count = this._items?.length || 0;
        if (count > 0) {
            badge.textContent = count > 99 ? '99+' : String(count);
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    },

    _renderList(el) {
        if (!el) return;
        const list    = el.querySelector('#todo-list');
        const summary = el.querySelector('#todo-summary');
        if (!list) return;

        el.querySelectorAll('.todo-tag').forEach(tag => {
            const active = this._activeFilters.has(tag.dataset.tag);
            tag.classList.toggle('active', active);
            tag.classList.toggle('inactive', !active);
        });

        if (this._items === null) return;

        const q = this._searchQ || '';
        const filtered = this._items.filter(it =>
            this._activeFilters.has(it.type) &&
            (!q || it.text.toLowerCase().includes(q) || it.file.toLowerCase().includes(q))
        );

        // Счётчики по типам
        const counts = {};
        this._items.forEach(it => { counts[it.type] = (counts[it.type] || 0) + 1; });
        const parts = ['TODO','FIXME','HACK','NOTE'].filter(t => counts[t])
            .map(t => `<span style="color:${this._typeColor(t)}">${t}: ${counts[t]}</span>`);

        if (summary) summary.innerHTML = parts.join(' · ')
            + (filtered.length !== this._items.length ? ` · <span style="color:var(--text-3)">показано ${filtered.length}</span>` : '');

        if (!filtered.length) {
            list.innerHTML = this._scanning
                ? '<div style="color:var(--text-3);font-size:13px;padding:12px 0">Сканирование...</div>'
                : '<div style="color:var(--text-3);font-size:13px;padding:12px 0">Ничего не найдено</div>';
            return;
        }

        list.innerHTML = filtered.map((it, i) => `
        <div class="todo-item" data-idx="${i}" title="${this._esc(it.file)} : строка ${it.line}">
            <span class="todo-badge todo-${it.type.toLowerCase()}">${it.type}</span>
            <div class="todo-body">
                <div class="todo-text">${this._esc(it.text)}</div>
                <div class="todo-loc">${this._esc(it.file)} · строка ${it.line}</div>
            </div>
            <span style="font-size:12px;color:var(--text-3);flex-shrink:0">↗</span>
        </div>`).join('');

        list.querySelectorAll('.todo-item').forEach((row, i) => {
            row.addEventListener('click', () => {
                const it = filtered[i];
                app.navigate('files');
                setTimeout(() => {
                    const filesPage = app._pages['files'];
                    if (!filesPage) return;
                    filesPage._openFile(it.fileId).then(() => {
                        setTimeout(() => {
                            const editor = filesPage._editor;
                            if (!editor) return;
                            editor.setPosition({ lineNumber: it.line, column: 1 });
                            editor.revealLineInCenter(it.line);
                            editor.focus();
                        }, 400);
                    });
                }, 100);
            });
        });
    },

    _typeColor(t) {
        return { TODO: '#60A5FA', FIXME: 'var(--red)', HACK: 'var(--yellow)', NOTE: 'var(--green)' }[t] || 'var(--text-2)';
    },

    _esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); },
};

app.register('todo', TodoPage);
