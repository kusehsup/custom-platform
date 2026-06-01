// ── TODO Tracker ─────────────────────────────────────────────────

const TodoPage = {
    _activeFilters: new Set(['TODO', 'FIXME', 'HACK', 'NOTE']),

    render(el) {
        el.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <h2 style="font-size:18px;font-weight:600;color:var(--text)">TODO трекер</h2>
            <button class="btn btn-ghost btn-sm" id="todo-refresh" title="Обновить">↻ Обновить</button>
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
        this._scan(el);
    },

    _items: null,

    _scan(el) {
        const list = el.querySelector('#todo-list');
        const summary = el.querySelector('#todo-summary');
        list.innerHTML = '<div style="color:var(--text-3);font-size:13px;padding:12px 0">Сканирование файлов...</div>';
        summary.textContent = '';

        const files = app._pages['files'];
        if (!files) {
            list.innerHTML = '<div style="color:var(--red);font-size:13px;padding:12px 0">Страница файлов не загружена</div>';
            return;
        }

        const allFiles = files._allFiles || {};
        const items = [];

        // Сканируем все закэшированные части кода (заполняется по мере открытия файлов)
        const codeParts = files._codeParts || {};
        const accessible = files._files || {};

        for (const [fileId, parts] of Object.entries(codeParts)) {
            const fileInfo = accessible[fileId] || allFiles[fileId] || {};
            for (const part of (parts || [])) {
                const content = part.content || '';
                const startLine = part.line || 1;
                const lines = content.split('\n');
                lines.forEach((line, i) => {
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
        }

        if (!Object.keys(codeParts).length) {
            list.innerHTML = '<div style="color:var(--text-3);font-size:13px;padding:12px 0">Нет данных. Откройте несколько файлов — они будут просканированы автоматически.</div>';
            this._items = [];
            return;
        }

        this._items = items;
        this._renderList(el);
    },

    _renderList(el) {
        if (!el) return;
        const list = el.querySelector('#todo-list');
        const summary = el.querySelector('#todo-summary');
        if (!list) return;

        // Обновляем кнопки фильтров
        el.querySelectorAll('.todo-tag').forEach(tag => {
            const active = this._activeFilters.has(tag.dataset.tag);
            tag.classList.toggle('active', active);
            tag.classList.toggle('inactive', !active);
        });

        if (!this._items) return;

        const q = this._searchQ || '';
        let filtered = this._items.filter(it =>
            this._activeFilters.has(it.type) &&
            (!q || it.text.toLowerCase().includes(q) || it.file.toLowerCase().includes(q))
        );

        // Счётчики
        const counts = {};
        this._items.forEach(it => { counts[it.type] = (counts[it.type] || 0) + 1; });
        const parts = ['TODO','FIXME','HACK','NOTE'].filter(t => counts[t]).map(t => `${t}: ${counts[t]}`);
        if (summary) summary.textContent = parts.join(' · ') + (filtered.length !== this._items.length ? ` · показано ${filtered.length}` : '');

        if (!filtered.length) {
            list.innerHTML = '<div style="color:var(--text-3);font-size:13px;padding:12px 0">Ничего не найдено</div>';
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

    _esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); },
};

app.register('todo', TodoPage);
