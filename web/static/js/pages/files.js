const FAV_KEY      = 'fav_files';
const HIST_PREFIX  = 'file_hist_';
const HIST_MAX     = 20;

app.register('files', {
    _files: {},
    _projectFiles: [],
    _activeFileId: null,
    _activeTab: 'files',   // 'files' | 'search'
    _editor: null,
    _partIndex: 0,
    _hash: null,
    _modified: false,
    _settingContent: false,
    _pendingContent: undefined,

    // ── Избранное ─────────────────────────────────────────────────────
    _loadFavs()       { try { return JSON.parse(localStorage.getItem(FAV_KEY) || '[]'); } catch { return []; } },
    _saveFavs(favs)   { try { localStorage.setItem(FAV_KEY, JSON.stringify(favs)); } catch {} },
    _isFav(id)        { return this._loadFavs().includes(String(id)); },
    _toggleFav(id) {
        let favs = this._loadFavs();
        const sid = String(id);
        favs = favs.includes(sid) ? favs.filter(f => f !== sid) : [...favs, sid];
        this._saveFavs(favs);
        this._renderFileList(document.getElementById('file-search')?.value?.toLowerCase() || '');
    },

    // ── Рендер страницы ───────────────────────────────────────────────
    async render(root) {
        // Сбрасываем состояние при каждом рендере
        this._modified      = false;
        this._activeFileId  = null;
        this._activeTab     = 'files';
        this._searchInited  = false;   // сброс флага поиска
        this._editor        = null;    // Monaco пересоздаётся при каждом рендере

        root.innerHTML = `
        <div class="files-layout">
            <div class="file-tree">
                <div class="file-tree-search">
                    <input type="search" id="file-search" placeholder="Поиск файла..." />
                </div>
                <div id="file-list"></div>
            </div>
            <div class="file-editor">
                <div class="editor-tabs">
                    <button class="etab active" data-tab="files">📄 Редактор</button>
                    <button class="etab" data-tab="search">🔍 Поиск</button>
                </div>
                <div id="tab-editor" class="editor-tab-content">
                    <div class="editor-topbar">
                        <span class="editor-filename" id="editor-filename">Выберите файл</span>
                        <button class="btn btn-ghost btn-sm hidden" id="btn-save">💾 Сохранить</button>
                        <button class="btn btn-ghost btn-sm hidden" id="btn-discard">✕ Сбросить</button>
                        <button class="btn btn-ghost btn-sm hidden" id="btn-history" title="История изменений">🕐 История</button>
                        <button class="btn btn-ghost btn-sm hidden" id="btn-del-toggle" title="Удалить доступ к строкам">🗑</button>
                    </div>
                    <div id="delete-access-bar" class="hidden">
                        <span class="del-bar-label">Удалить строки:</span>
                        <input type="number" id="del-from" placeholder="от" class="del-bar-input" />
                        <span class="del-bar-sep">—</span>
                        <input type="number" id="del-to" placeholder="до" class="del-bar-input" />
                        <button class="btn btn-danger btn-sm" id="btn-del-access">Удалить</button>
                        <span class="del-bar-sep">·</span>
                        <button class="btn btn-ghost btn-sm" id="btn-del-block">Весь блок</button>
                    </div>
                    <div class="editor-area">
                        <div id="monaco-editor"></div>
                        <div class="editor-empty" id="editor-empty">
                            <span class="big">📄</span>
                            <span>Выберите файл из списка</span>
                        </div>
                    </div>
                </div>
                <div id="tab-search" class="editor-tab-content hidden">
                    <div id="search-root"></div>
                </div>
            </div>
        </div>`;

        await this._loadFiles();
        this._ensureMonaco();
        this._initSearch();

        document.getElementById('file-search').addEventListener('input', e =>
            this._renderFileList(e.target.value.toLowerCase())
        );
        document.getElementById('btn-save').addEventListener('click',    () => this._save());
        document.getElementById('btn-discard').addEventListener('click', () => this._discard());
        document.querySelectorAll('.etab').forEach(btn =>
            btn.addEventListener('click', () => this._switchTab(btn.dataset.tab))
        );

        document.getElementById('btn-history').addEventListener('click', () => this._showHistory());
        document.getElementById('btn-del-toggle').addEventListener('click', () => {
            const bar = document.getElementById('delete-access-bar');
            bar.classList.toggle('hidden');
        });
        document.getElementById('btn-del-access').addEventListener('click', () => this._deleteAccess());
        document.getElementById('btn-del-block').addEventListener('click',  () => this._deleteCurrentBlock());
    },

    _switchTab(tab) {
        this._activeTab = tab;
        document.querySelectorAll('.etab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
        document.getElementById('tab-editor').classList.toggle('hidden', tab !== 'files');
        const searchEl = document.getElementById('tab-search');
        searchEl.classList.toggle('hidden', tab !== 'search');
        if (tab === 'search') {
            this._initSearch();
            // Явно задаём высоту по родителю чтобы overflow-y работал
            requestAnimationFrame(() => {
                const parent = searchEl.parentElement;
                if (parent) {
                    const tabsH = document.querySelector('.editor-tabs')?.offsetHeight || 0;
                    searchEl.style.height = (parent.offsetHeight - tabsH) + 'px';
                }
            });
        }
        if (tab === 'files' && this._editor) {
            requestAnimationFrame(() => this._editor.layout());
        }
    },

    // ── Файлы ─────────────────────────────────────────────────────────
    async _loadFiles() {
        try {
            const data = await API.get('/api/files');
            this._files        = data.files;
            this._projectFiles = data.project_files.map(String);
            this._renderFileList('');
        } catch (e) {
            const list = document.getElementById('file-list');
            if (list) list.innerHTML = `<div style="padding:16px;color:var(--red);font-size:13px">${e.message}</div>`;
        }
    },

    _renderFileList(query) {
        const list = document.getElementById('file-list');
        if (!list) return;
        const favs = this._loadFavs();

        const mkItem = (id, inFav) => {
            const f    = this._files[id];
            if (!f) return '';
            const ext  = f.fullPath.split('.').pop();
            const icon = ext === 'pwn' ? '📝' : ext === 'inc' ? '📎' : '📄';
            const name = f.fullPath.split('/').pop();
            const active = id === this._activeFileId ? ' active' : '';
            const isFav  = favs.includes(String(id));
            return `<div class="file-item${active}" data-id="${id}" title="${f.fullPath}">
                <span class="file-icon">${icon}</span>
                <span class="file-name">${name}</span>
                <span class="fav-btn" data-id="${id}" title="Избранное">${isFav ? '★' : '☆'}</span>
            </div>`;
        };

        let html = '';

        // Секция избранного
        const favMatched = favs.filter(id => {
            const f = this._files[id];
            return f && (!query || f.fullPath.toLowerCase().includes(query));
        });
        if (favMatched.length) {
            html += `<div class="file-tree-section">⭐ Избранное</div>`;
            html += favMatched.map(id => mkItem(id, true)).join('');
            html += `<div class="file-tree-sep"></div>`;
        }

        // Все файлы
        const all = this._projectFiles.filter(id => {
            const f = this._files[id];
            return f && (!query || f.fullPath.toLowerCase().includes(query));
        });
        html += all.map(id => mkItem(id, false)).join('');

        list.innerHTML = html || '<div style="padding:16px;color:var(--text-3);font-size:13px">Ничего не найдено</div>';

        list.querySelectorAll('.file-item').forEach(el =>
            el.addEventListener('click', e => {
                if (e.target.classList.contains('fav-btn')) return;
                this._openFile(el.dataset.id);
            })
        );
        list.querySelectorAll('.fav-btn').forEach(el =>
            el.addEventListener('click', e => { e.stopPropagation(); this._toggleFav(el.dataset.id); })
        );
    },

    async _openFile(fileId) {
        if (this._modified) {
            if (!confirm('Есть несохранённые изменения. Закрыть файл?')) return;
        }
        this._activeFileId  = fileId;
        this._modified      = false;
        this._parts         = [];
        this._activePartIdx = 0;

        if (this._activeTab !== 'files') this._switchTab('files');

        document.querySelectorAll('.file-item').forEach(el =>
            el.classList.toggle('active', el.dataset.id === fileId)
        );

        const f    = this._files[fileId];
        const fnEl = document.getElementById('editor-filename');
        if (fnEl) { fnEl.textContent = f.fullPath + '  (загрузка...)'; fnEl.className = 'editor-filename'; }
        document.getElementById('editor-empty')?.style.setProperty('display', 'none');
        document.getElementById('btn-save')?.classList.add('hidden');
        document.getElementById('btn-discard')?.classList.add('hidden');
        // Показываем кнопку удаления доступа, панель скрыта по умолчанию
        document.getElementById('btn-history')?.classList.remove('hidden');
        document.getElementById('btn-del-toggle')?.classList.remove('hidden');
        document.getElementById('delete-access-bar')?.classList.add('hidden');

        try {
            const data = await API.get(`/api/file/${fileId}/code`);
            if (this._activeFileId !== fileId) return;
            const parts = data.code;
            if (!parts || !parts.length) {
                this._setParts([{ content: '// Файл пустой', line: 1, hash: null }], fileId);
                return;
            }
            if (fnEl) fnEl.textContent = f.fullPath;
            this._setParts(parts, fileId);
        } catch (e) {
            if (this._activeFileId !== fileId) return;
            this._setParts([{ content: `// Ошибка загрузки: ${e.message}`, line: 1, hash: null }], fileId);
        }
    },

    // Устанавливает части файла и рендерит вкладки частей
    _setParts(parts, fileId) {
        this._parts         = parts;
        this._activePartIdx = 0;
        this._modified      = false;
        this._fileId        = fileId;

        // Рендерим вкладки частей под топбаром редактора
        this._renderPartTabs();
        // Загружаем первую часть
        this._loadPartIntoEditor(0);
    },

    _renderPartTabs() {
        // Удаляем старые вкладки частей если есть
        document.getElementById('part-tabs')?.remove();
        if (this._parts.length <= 1) return;

        const tabBar = document.createElement('div');
        tabBar.id = 'part-tabs';
        tabBar.style.cssText = 'display:flex;gap:2px;padding:4px 12px;background:var(--surface);border-bottom:1px solid var(--border);overflow-x:auto;flex-shrink:0';

        this._parts.forEach((part, i) => {
            const btn = document.createElement('button');
            btn.className = 'btn btn-ghost btn-sm' + (i === this._activePartIdx ? ' part-tab-active' : '');
            btn.style.cssText = 'font-family:var(--mono);font-size:12px;padding:4px 10px';
            btn.textContent = `[${part.line}]`;
            btn.title = `Строка ${part.line}`;
            btn.addEventListener('click', () => {
                if (this._modified) {
                    if (!confirm('Есть несохранённые изменения в этой части. Переключиться?')) return;
                    this._modified = false;
                }
                this._activePartIdx = i;
                this._renderPartTabs();
                this._loadPartIntoEditor(i);
            });
            tabBar.appendChild(btn);
        });

        // Вставляем после editor-topbar
        const topbar = document.querySelector('.editor-topbar');
        topbar?.after(tabBar);
    },

    _loadPartIntoEditor(partIdx) {
        const part = this._parts[partIdx];
        if (!part) return;
        this._activePartIdx = partIdx;
        this._modified      = false;

        const lang    = this._getLang(this._files[this._fileId]?.fullPath || '');
        const startLine = part.line || 1;

        const apply = () => {
            this._settingContent = true;
            monaco.editor.setModelLanguage(this._editor.getModel(), lang);
            this._editor.setValue(part.content);
            // Нумерация строк начинается с реального номера строки в файле
            this._editor.updateOptions({
                lineNumbers: n => String(startLine + n - 1),
            });
            this._editor.setScrollPosition({ scrollTop: 0 });
            this._settingContent = false;

            // Сбрасываем индикатор изменений
            const fn = document.getElementById('editor-filename');
            if (fn) fn.className = 'editor-filename';
            document.getElementById('btn-save')?.classList.add('hidden');
            document.getElementById('btn-discard')?.classList.add('hidden');
        };

        if (this._editor) apply();
        else this._pendingContent = { partIdx, apply };
    },

    _getLang(path) {
        if (path.endsWith('.pwn') || path.endsWith('.inc')) return 'cpp';
        if (path.endsWith('.js'))   return 'javascript';
        if (path.endsWith('.json')) return 'json';
        return 'plaintext';
    },

    // ── Monaco ────────────────────────────────────────────────────────
    _ensureMonaco() {
        if (this._editor) return;
        if (window.monaco) { this._initEditor(); return; }
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs/loader.js';
        s.onload = () => {
            require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' } });
            require(['vs/editor/editor.main'], () => this._initEditor());
        };
        document.head.appendChild(s);
    },

    _initEditor() {
        const container = document.getElementById('monaco-editor');
        if (!container || this._editor) return;

        monaco.editor.defineTheme('custom-dark', {
            base: 'vs-dark', inherit: true, rules: [],
            colors: {
                'editor.background':                       '#0D0D0F',
                'editor.lineHighlightBackground':          '#1C1C1F',
                'editorLineNumber.foreground':             '#48484A',
                'editorLineNumber.activeForeground':       '#8E8E93',
                'editor.selectionBackground':              '#3B82F630',
                // Автодополнение
                'editorSuggestWidget.background':          '#1C1C1F',
                'editorSuggestWidget.border':              '#2A2A30',
                'editorSuggestWidget.foreground':          '#E5E5E7',
                'editorSuggestWidget.selectedBackground':  '#3B82F620',
                'editorSuggestWidget.selectedForeground':  '#E5E5E7',
                'editorSuggestWidget.highlightForeground': '#3B82F6',
                'editorSuggestWidget.focusHighlightForeground': '#3B82F6',
                // Hover / parameter hints
                'editorHoverWidget.background':            '#1C1C1F',
                'editorHoverWidget.border':                '#2A2A30',
                'editorHoverWidget.foreground':            '#E5E5E7',
                // Инлайн подсказки
                'editorInlayHint.foreground':              '#8E8E93',
                'editorInlayHint.background':              '#1C1C1F',
            },
        });

        this._editor = monaco.editor.create(container, {
            value: '', language: 'cpp', theme: 'custom-dark',
            fontSize: 13, fontFamily: "'Cascadia Code','Consolas',monospace",
            fontLigatures: true, minimap: { enabled: true },
            scrollBeyondLastLine: false, automaticLayout: true,
            tabSize: 4, wordWrap: 'off', smoothScrolling: true, cursorBlinking: 'smooth',
            wordBasedSuggestions: 'allDocuments',
            suggestOnTriggerCharacters: true,
            quickSuggestions: { other: true, comments: false, strings: false },
        });

        this._editor.onDidChangeModelContent(() => {
            if (this._settingContent || !this._activeFileId) return;
            if (!this._modified) {
                this._modified = true;
                const fn = document.getElementById('editor-filename');
                if (fn) fn.className = 'editor-filename modified';
                document.getElementById('btn-save')?.classList.remove('hidden');
                document.getElementById('btn-discard')?.classList.remove('hidden');
            }
        });

        this._editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => this._save());

        const ro = new ResizeObserver(() => this._editor?.layout());
        ro.observe(container);

        if (this._pendingContent !== undefined) {
            const { apply } = this._pendingContent;
            this._pendingContent = undefined;
            apply();
        }
    },

    async _save() {
        if (!this._activeFileId || !this._parts?.length) return;
        const part = this._parts[this._activePartIdx];
        if (!part) return;

        const btn = document.getElementById('btn-save');
        if (btn) { btn.disabled = true; btn.textContent = 'Сохраняем...'; }

        const code = this._editor.getValue();
        try {
            const res = await API.post('/api/code/save', {
                file_id:    this._activeFileId,
                code,
                part_index: this._activePartIdx,
                hash:       part.hash,
            });
            this._parts[this._activePartIdx].hash = res.hash;
            this._modified = false;
            document.getElementById('editor-filename').className = 'editor-filename';
            document.getElementById('btn-save')?.classList.add('hidden');
            document.getElementById('btn-discard')?.classList.add('hidden');
            // Сохраняем снапшот в историю
            this._pushHistory(this._activeFileId, this._activePartIdx, part.line || 1, code);
            app.toast('💾 Файл сохранён', 'success');
        } catch (e) {
            app.toast('Ошибка сохранения: ' + e.message, 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '💾 Сохранить'; }
        }
    },

    // ── История изменений ─────────────────────────────────────────────
    _histKey(fileId, partIdx) { return `${HIST_PREFIX}${fileId}_${partIdx}`; },

    _pushHistory(fileId, partIdx, startLine, content) {
        const key = this._histKey(fileId, partIdx);
        let hist = [];
        try { hist = JSON.parse(localStorage.getItem(key) || '[]'); } catch {}
        hist.unshift({ ts: Date.now(), startLine, content });
        if (hist.length > HIST_MAX) hist = hist.slice(0, HIST_MAX);
        try { localStorage.setItem(key, JSON.stringify(hist)); } catch {}
    },

    _loadHistory(fileId, partIdx) {
        const key = this._histKey(fileId, partIdx);
        try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; }
    },

    _showHistory() {
        if (!this._activeFileId) return;
        const fileId  = this._activeFileId;
        const partIdx = this._activePartIdx;
        const hist    = this._loadHistory(fileId, partIdx);
        const file    = this._files[fileId];
        const part    = this._parts?.[partIdx];

        const modal = document.createElement('div');
        modal.id = 'history-modal';
        modal.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px)';

        const fmt = ts => new Date(ts).toLocaleString('ru-RU', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        });

        modal.innerHTML = `
        <div style="display:flex;flex-direction:column;width:100%;max-width:900px;margin:auto;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;max-height:90vh">
            <div style="display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--border);flex-shrink:0">
                <span style="font-size:13px;font-weight:600;color:var(--text)">История: ${this._esc(file?.fullPath || '')}${part ? ` [${part.line}]` : ''}</span>
                <span style="flex:1"></span>
                <span style="font-size:12px;color:var(--text-2)">${hist.length} версий</span>
                <button id="hist-close" style="background:none;border:none;color:var(--text-2);cursor:pointer;font-size:18px;padding:4px">✕</button>
            </div>
            <div style="display:grid;grid-template-columns:220px 1fr;flex:1;overflow:hidden;min-height:0">
                <div id="hist-list" style="border-right:1px solid var(--border);overflow-y:auto;padding:8px 0">
                    ${hist.length === 0
                        ? '<div style="padding:16px;color:var(--text-3);font-size:13px">Нет сохранённых версий</div>'
                        : hist.map((h, i) => `
                        <div class="hist-item" data-idx="${i}" style="padding:10px 16px;cursor:pointer;border-bottom:1px solid var(--border);transition:background .1s">
                            <div style="font-size:12.5px;font-weight:500;color:var(--text)">${fmt(h.ts)}</div>
                            <div style="font-size:11px;color:var(--text-3);margin-top:2px;font-family:var(--mono)">строка ${h.startLine}</div>
                        </div>`).join('')
                    }
                </div>
                <div style="display:flex;flex-direction:column;overflow:hidden;min-height:0">
                    <div id="hist-toolbar" style="display:flex;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border);flex-shrink:0" class="hidden">
                        <button class="btn btn-ghost btn-sm" id="hist-restore">↩ Восстановить эту версию</button>
                        <span id="hist-meta" style="font-size:12px;color:var(--text-2);align-self:center"></span>
                    </div>
                    <pre id="hist-preview" style="flex:1;overflow:auto;padding:14px 16px;font-family:var(--mono);font-size:12.5px;line-height:1.7;color:#C8D3F5;background:#0D0D0F;margin:0;white-space:pre-wrap;word-break:break-all">
                        <span style="color:var(--text-3)">← Выберите версию</span>
                    </pre>
                </div>
            </div>
        </div>`;

        document.body.appendChild(modal);

        let selectedHist = null;

        modal.querySelectorAll('.hist-item').forEach(item => {
            item.addEventListener('mouseenter', () => { item.style.background = 'rgba(255,255,255,0.04)'; });
            item.addEventListener('mouseleave', () => { item.style.background = selectedHist === item ? 'rgba(59,130,246,0.1)' : ''; });
            item.addEventListener('click', () => {
                modal.querySelectorAll('.hist-item').forEach(i => i.style.background = '');
                item.style.background = 'rgba(59,130,246,0.1)';
                selectedHist = item;
                const h = hist[parseInt(item.dataset.idx)];
                document.getElementById('hist-preview').textContent = h.content;
                document.getElementById('hist-toolbar').classList.remove('hidden');
                document.getElementById('hist-meta').textContent = fmt(h.ts);
                document.getElementById('hist-restore').onclick = () => {
                    if (!confirm('Восстановить эту версию? Текущие несохранённые изменения будут потеряны.')) return;
                    this._settingContent = true;
                    this._editor.setValue(h.content);
                    this._settingContent = false;
                    this._modified = true;
                    document.getElementById('editor-filename').className = 'editor-filename modified';
                    document.getElementById('btn-save')?.classList.remove('hidden');
                    document.getElementById('btn-discard')?.classList.remove('hidden');
                    modal.remove();
                    app.toast('↩ Версия восстановлена — не забудь сохранить', 'info');
                };
            });
        });

        modal.querySelector('#hist-close').addEventListener('click', () => modal.remove());
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    },

    _discard() {
        if (!this._activeFileId) return;
        this._modified = false;
        this._loadPartIntoEditor(this._activePartIdx);
    },

    async _deleteAccess() {
        if (!this._activeFileId) return;
        const from = parseInt(document.getElementById('del-from').value);
        const to   = parseInt(document.getElementById('del-to').value);
        if (!from || isNaN(from)) { app.toast('Укажите начальную строку', 'error'); return; }
        const endLine = (!to || isNaN(to)) ? from : to;
        if (endLine < from) { app.toast('Конечная строка не может быть меньше начальной', 'error'); return; }
        if (!await this._confirmDelete(from, endLine)) return;
        try {
            await API.post('/api/delete_access', { file_id: this._activeFileId, start_line: from, end_line: endLine });
            app.toast(`🗑 Доступ к строкам ${from}–${endLine} удалён`, 'success');
            document.getElementById('del-from').value = '';
            document.getElementById('del-to').value   = '';
            this._modified = false;
            this._openFile(this._activeFileId);
        } catch (e) { app.toast('Ошибка: ' + e.message, 'error'); }
    },

    async _deleteCurrentBlock() {
        if (!this._activeFileId || !this._parts?.length) return;
        const part = this._parts[this._activePartIdx];
        if (!part) return;
        const startLine = part.line || 1;
        const endLine   = startLine + part.content.split('\n').length - 1;
        if (!await this._confirmDelete(startLine, endLine)) return;
        try {
            await API.post('/api/delete_access', { file_id: this._activeFileId, start_line: startLine, end_line: endLine });
            app.toast(`🗑 Блок [${startLine}–${endLine}] удалён из доступов`, 'success');
            this._modified = false;
            this._openFile(this._activeFileId);
        } catch (e) { app.toast('Ошибка: ' + e.message, 'error'); }
    },

    _confirmDelete(from, to) {
        return new Promise(resolve => {
            const modal = document.createElement('div');
            modal.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px)';
            modal.innerHTML = `
            <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);width:100%;max-width:380px;padding:28px;display:flex;flex-direction:column;gap:16px">
                <div style="font-size:15px;font-weight:600;color:var(--text)">Удалить доступ</div>
                <div style="font-size:13px;color:var(--text-2);line-height:1.6">
                    Удалить доступ к строкам <strong style="color:var(--text)">${from}–${to}</strong>?<br>
                    <span style="color:var(--text-3);font-size:12px">Это удалит эти строки из ваших доступов, но не изменит сам файл.</span>
                </div>
                <div style="display:flex;gap:8px;justify-content:flex-end">
                    <button id="del-cancel" class="btn btn-ghost">Отмена</button>
                    <button id="del-ok" class="btn btn-danger">Удалить</button>
                </div>
            </div>`;
            document.body.appendChild(modal);
            modal.querySelector('#del-ok').addEventListener('click',     () => { modal.remove(); resolve(true); });
            modal.querySelector('#del-cancel').addEventListener('click', () => { modal.remove(); resolve(false); });
            modal.addEventListener('click', e => { if (e.target === modal) { modal.remove(); resolve(false); } });
        });
    },

    // ── Встроенный поиск ─────────────────────────────────────────────
    _searchInited: false,

    _initSearch() {
        const root = document.getElementById('search-root');
        if (!root || this._searchInited) return;
        this._searchInited = true;
        root.innerHTML = `<div class="card">
            <div class="card-header"><span class="card-title">Поиск по коду</span></div>
            <div style="display:flex;flex-direction:column;gap:10px">
                <div style="display:flex;gap:8px">
                    <input type="text" id="sq-text" placeholder="Поисковый запрос..." style="flex:1" />
                    <button class="btn btn-primary" id="sq-btn">Найти</button>
                </div>
                <label style="display:flex;align-items:center;gap:6px;color:var(--text-2);font-size:13px;cursor:pointer">
                    <input type="checkbox" id="sq-regexp" /> Регулярное выражение
                </label>
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;color:var(--text-2)">
                    <span>Диапазон строк:</span>
                    <input type="text" id="sq-from" placeholder="от" style="width:70px;padding:5px 10px" />
                    <span>—</span>
                    <input type="text" id="sq-to"   placeholder="до" style="width:70px;padding:5px 10px" />
                    <span>в файле</span>
                    <select id="sq-file" style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);padding:6px 10px;font-size:13px;outline:none;max-width:240px">
                        <option value="-1">Все файлы</option>
                    </select>
                </div>
                <div style="border-top:1px solid var(--border);padding-top:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;color:var(--text-2)">
                    <span>Получить строку:</span>
                    <select id="sq-line-file" style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);padding:6px 10px;font-size:13px;outline:none;max-width:240px"></select>
                    <input type="text" id="sq-line-num" placeholder="Номер строки" style="width:120px;padding:5px 10px" />
                    <button class="btn btn-ghost btn-sm" id="sq-get-line">Получить</button>
                </div>
            </div>
        </div>
        <div id="sq-results-wrap" class="card hidden" style="padding:0;overflow:hidden">
            <div style="display:flex;align-items:center;gap:10px;padding:14px 20px;border-bottom:1px solid var(--border)">
                <span class="card-title" style="margin:0">Результаты</span>
                <span id="sq-count" style="color:var(--text-2);font-size:13px"></span>
            </div>
            <div id="sq-results" style="padding:8px 0"></div>
        </div>
        `;

        // Заполняем селекты файлов
        Object.entries(this._files).forEach(([id, f]) => {
            const mk = () => { const o = document.createElement('option'); o.value = id; o.textContent = f.fullPath; return o; };
            document.getElementById('sq-file').appendChild(mk());
            document.getElementById('sq-line-file').appendChild(mk());
        });

        document.getElementById('sq-btn').addEventListener('click', () => this._sqSearch());
        document.getElementById('sq-text').addEventListener('keydown', e => { if (e.key === 'Enter') this._sqSearch(); });
        document.getElementById('sq-get-line').addEventListener('click', () => this._sqGetLine());
    },

    async _sqSearch() {
        const text = document.getElementById('sq-text').value.trim();
        if (!text) return;
        const btn = document.getElementById('sq-btn');
        btn.disabled = true; btn.textContent = '⏳';
        const wrap = document.getElementById('sq-results-wrap');
        const el   = document.getElementById('sq-results');
        wrap.classList.remove('hidden');
        el.innerHTML = '<div style="padding:20px;color:var(--text-2);font-size:13px;text-align:center">Поиск...</div>';
        try {
            const res = await API.post('/api/search', {
                text,
                file:       document.getElementById('sq-file').value,
                regexp:     document.getElementById('sq-regexp').checked,
                start_line: document.getElementById('sq-from').value.trim(),
                end_line:   document.getElementById('sq-to').value.trim(),
            });
            this._sqRender(res.result, el);
        } catch (e) {
            el.innerHTML = `<div style="padding:20px;color:var(--red);font-size:13px">${e.message}</div>`;
        } finally {
            btn.disabled = false; btn.textContent = 'Найти';
        }
    },

    _sqRender(result, el) {
        if (!result || result === 'too_much') { el.innerHTML = '<div style="padding:20px;color:var(--yellow);font-size:13px;text-align:center">Слишком много результатов</div>'; return; }
        if (result === 'regex_incorrect')     { el.innerHTML = '<div style="padding:20px;color:var(--red);font-size:13px;text-align:center">Некорректное регулярное выражение</div>'; return; }
        let html = ''; let total = 0;
        for (const [fileId, fileData] of Object.entries(result)) {
            if (!fileData || !Object.keys(fileData).length) continue;
            total++;
            html += `<div class="sr-file">
                <div class="sr-file-name">${this._esc(this._files[fileId]?.fullPath || '#'+fileId)}</div>
                <div class="sr-blocks">${this._sqBlocks(fileId, fileData, [])}</div>
            </div>`;
        }
        if (!html) { el.innerHTML = '<div style="padding:20px;color:var(--text-3);font-size:13px;text-align:center">Ничего не найдено</div>'; return; }
        document.getElementById('sq-count').textContent = `${total} файл(ов)`;
        el.innerHTML = html;
        el.querySelectorAll('.sr-block-toggle').forEach(t =>
            t.addEventListener('click', () => t.closest('.sr-block').querySelector('.sr-block-children')?.classList.toggle('hidden'))
        );
        el.querySelectorAll('[data-sqaction="preview"]').forEach(b => b.addEventListener('click', () => this._sqGetCode('preview', b.dataset)));
        el.querySelectorAll('[data-sqaction="edit"]').forEach(b =>   b.addEventListener('click', () => this._sqGetCode('edit',    b.dataset)));
    },

    _sqBlocks(fileId, blocks, parentPath) {
        const sorted = Object.keys(blocks).sort((a, b) => +a - +b);
        let html = '';
        for (let i = 0; i < sorted.length; i++) {
            const id = sorted[i]; const block = blocks[id];
            const path = JSON.stringify([...parentPath, +id]);
            if (block.children) {
                html += `<div class="sr-block">
                    <div class="sr-block-row">
                        <span class="sr-block-toggle sr-expandable">
                            <span class="sr-id">[${id}]</span><span class="sr-type">[Блок кода]</span>
                            ${block.name ? `<span class="sr-name">${this._esc(block.name)}</span>` : ''}
                            <span class="sr-lines${block.lines > 100 ? '" style="color:var(--yellow)' : ''}">[Строк: ${block.lines}]</span>
                        </span>
                        <button class="btn btn-ghost btn-sm" data-sqaction="edit" data-file="${fileId}" data-path='${path}' data-name="${this._esc(block.name||'')}" data-lines="${block.lines||0}">Получить код</button>
                    </div>
                    <div class="sr-block-children hidden">
                        <div class="sr-brace">{</div>${this._sqBlocks(fileId, block.children, [...parentPath, +id])}<div class="sr-brace">}</div>
                    </div>
                </div>`;
            } else {
                let label = block.type === 'function_call' ? `[Вызов функции] ${this._esc(block.name||'')}` :
                            block.type === 'text'          ? `[Текст] ${this._esc(block.name||'')}` :
                            block.type === 'other'         ? `[Прочее] ${this._esc(block.name||'')}` :
                            this._esc(block.name||'');
                html += `<div class="sr-block"><div class="sr-block-row">
                    <span class="sr-leaf" id="sr-${fileId}-${id}"><span class="sr-id">[${id}]</span> ${label}</span>
                    ${block.type !== 'condition' ? `<button class="btn btn-ghost btn-sm" data-sqaction="preview" data-file="${fileId}" data-path='${path}' data-name="${this._esc(block.name||'')}" data-leaf="sr-${fileId}-${id}">Посмотреть</button>` : ''}
                    <button class="btn btn-ghost btn-sm" data-sqaction="edit" data-file="${fileId}" data-path='${path}' data-name="${this._esc(block.name||'')}">Получить код</button>
                </div></div>`;
            }
            if (i < sorted.length - 1 && +sorted[i+1] - +id > 1) html += `<div class="sr-gap">...</div>`;
        }
        return html;
    },

    async _sqGetCode(type, dataset) {
        const fileId = dataset.file;
        const path   = JSON.parse(dataset.path);
        const name   = dataset.name || '';
        const leaf   = dataset.leaf;
        const lines  = parseInt(dataset.lines || '0');

        // Подтверждение для больших блоков при запросе кода
        if (type === 'edit' && lines > 100) {
            const confirmed = await this._confirmLargeBlock(lines, name);
            if (!confirmed) return;
        }

        // Находим кнопку и показываем загрузку
        const btnSelector = `[data-sqaction="${type}"][data-file="${fileId}"][data-path='${JSON.stringify(path)}']`;
        const btn = document.querySelector(btnSelector);
        const origText = btn?.textContent;
        if (btn) { btn.disabled = true; btn.textContent = '⏳'; }

        try {
            const res    = await API.post('/api/code/get', { type, file_id: fileId, code_path: path, query_name: name });
            const result = res.result;

            if (type === 'preview') {
                if (result === 'overlimit') { app.toast('Превышен лимит просмотра', 'error'); return; }
                // Показываем код прямо в строке результата
                const code = typeof result === 'string' ? result : (result?.code ?? '');
                const line = result?.line ?? '';
                if (leaf) {
                    const el = document.getElementById(leaf);
                    if (el) el.innerHTML = `<span class="sr-id">[${line}]</span> <span style="color:var(--text);white-space:pre-wrap">${this._esc(code)}</span>`;
                }
                btn?.remove();  // просмотрели — кнопка больше не нужна
            } else {
                if (result === 'access') {
                    app.toast('✅ Доступ разрешён', 'success');
                } else {
                    app.toast('⏳ Запрос направлен модераторам', 'info');
                }
                // В обоих случаях запрос уже сделан — убираем обе кнопки блока
                const row = btn?.closest('.sr-block-row');
                if (row) row.querySelectorAll('[data-sqaction]').forEach(b => b.remove());
            }
        } catch (e) {
            app.toast('Ошибка: ' + e.message, 'error');
            if (btn) btn.textContent = origText;
        } finally {
            if (btn) btn.disabled = false;
        }
    },

    _confirmLargeBlock(lines, name) {
        return new Promise(resolve => {
            const modal = document.createElement('div');
            modal.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px)';
            modal.innerHTML = `
            <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);width:100%;max-width:400px;padding:28px;display:flex;flex-direction:column;gap:16px">
                <div style="font-size:15px;font-weight:600;color:var(--text)">Большой блок кода</div>
                <div style="font-size:13px;color:var(--text-2);line-height:1.6">
                    Блок <strong style="color:var(--text)">${this._esc(name)}</strong> содержит
                    <strong style="color:var(--yellow)">${lines} строк</strong>.<br>
                    Запрос такого объёма может занять время. Продолжить?
                </div>
                <div style="display:flex;gap:8px;justify-content:flex-end">
                    <button id="confirm-cancel" class="btn btn-ghost">Отмена</button>
                    <button id="confirm-ok" class="btn btn-primary">Запросить</button>
                </div>
            </div>`;
            document.body.appendChild(modal);
            modal.querySelector('#confirm-ok').addEventListener('click', () => { modal.remove(); resolve(true); });
            modal.querySelector('#confirm-cancel').addEventListener('click', () => { modal.remove(); resolve(false); });
            modal.addEventListener('click', e => { if (e.target === modal) { modal.remove(); resolve(false); } });
        });
    },

    async _sqGetLine() {
        const fileId = document.getElementById('sq-line-file').value;
        const line   = document.getElementById('sq-line-num').value.trim();
        if (!line) return;
        try {
            await API.post('/api/get_line', { file_id: fileId, line });
            app.toast('Запрос строки отправлен', 'info');
        } catch (e) { app.toast('Ошибка: ' + e.message, 'error'); }
    },

    // Вызывается из app._onWS при получении обновлённых данных с платформы
    onFilesUpdate() {
        API.get('/api/files').then(data => {
            const oldIds  = new Set(this._projectFiles);
            this._files        = data.files;
            this._projectFiles = data.project_files.map(String);
            const newIds  = new Set(this._projectFiles);
            // Если появились новые файлы — обновляем список и показываем toast
            const added = [...newIds].filter(id => !oldIds.has(id));
            if (added.length) {
                app.toast(`📄 Доступ открыт к ${added.length} файл(ам)`, 'success');
                this._renderFileList(document.getElementById('file-search')?.value?.toLowerCase() || '');
            }
        }).catch(() => {});
    },

    _esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); },
});
