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
    _codeParts: {},  // кэш частей для TODO-сканера

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
        this._searchInited  = false;
        this._editor        = null;
        root.classList.add('main--fullscreen');

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
                        <button class="btn btn-ghost btn-sm hidden" id="btn-goto" title="Перейти к строке (Ctrl+G)" style="font-family:var(--mono);font-size:11px">:N</button>
                        <button class="btn btn-ghost btn-sm hidden" id="btn-save">💾 Сохранить</button>
                        <button class="btn btn-ghost btn-sm hidden" id="btn-discard">✕ Сбросить</button>
                        <button class="btn btn-ghost btn-sm hidden" id="btn-history" title="История изменений">🕐 История</button>
                        <button class="btn btn-ghost btn-sm hidden" id="btn-del-toggle" title="Удалить доступ к строкам">🗑</button>
                    </div>
                    <div id="editor-statusbar" class="editor-statusbar hidden">
                        <span id="sb-pos">Стр 1, Кол 1</span>
                        <span class="sb-sep">·</span>
                        <span id="sb-lines">0 строк</span>
                        <span class="sb-sep">·</span>
                        <span id="sb-context" style="color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:300px"></span>
                    </div>
                    <div id="delete-access-bar" class="hidden del-access-bar">
                        <span class="del-bar-label">Удалить доступ к строкам:</span>
                        <input type="number" id="del-from" placeholder="от" />
                        <span class="del-bar-sep">—</span>
                        <input type="number" id="del-to" placeholder="до" />
                        <button class="btn btn-ghost btn-sm del-bar-danger" id="btn-del-access">Удалить</button>
                        <div class="del-bar-divider"></div>
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
        document.getElementById('btn-goto').addEventListener('click',    () => this._showGotoLine());
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
            this._allFiles     = data.all_files || data.files;
            this._projectFiles = data.project_files.map(String);
            this._renderFileList('');
            // Загружаем части всех доступных файлов для проверки диапазонов в поиске
            this._sqLoadAccessibleRanges();
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
        document.getElementById('btn-goto')?.classList.remove('hidden');
        document.getElementById('btn-history')?.classList.remove('hidden');
        document.getElementById('btn-del-toggle')?.classList.remove('hidden');
        document.getElementById('editor-statusbar')?.classList.remove('hidden');
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
        // Если переоткрываем тот же файл — переносим актуальные hash'и
        if (this._fileId === fileId && this._parts?.length === parts.length) {
            parts = parts.map((p, i) => ({
                ...p,
                hash: this._parts[i]?.hash ?? p.hash,
            }));
        }
        this._parts         = parts;
        // Кэшируем части для TODO-сканера
        if (!this._codeParts) this._codeParts = {};
        this._codeParts[fileId] = parts;
        // Сохраняем локальные правки в памяти (на случай переключения частей)
        this._partDrafts    = {};
        this._activePartIdx = 0;
        this._modified      = false;
        this._fileId        = fileId;

        this._renderPartTabs();
        this._loadPartIntoEditor(0);
    },

    // Извлекаем значимое название из кода части
    _partLabel(part) {
        if (!part.content) return `[${part.line}]`;
        const firstLine = part.content.split('\n').find(l => l.trim()) || '';
        // Берём первые значимые слова (убираем отступы, ограничиваем длину)
        const clean = firstLine.trim().replace(/\s+/g, ' ');
        const label = clean.length > 28 ? clean.slice(0, 28) + '…' : clean;
        return label || `[${part.line}]`;
    },

    _renderPartTabs() {
        document.getElementById('part-tabs')?.remove();
        if (this._parts.length <= 1) return;

        const tabBar = document.createElement('div');
        tabBar.id = 'part-tabs';
        tabBar.className = 'part-tabs-horizontal';

        this._parts.forEach((part, i) => {
            const btn = document.createElement('div');
            btn.className = 'ptab' + (i === this._activePartIdx ? ' active' : '');
            btn.title = `Строка ${part.line}: ${part.content?.split('\n')[0]?.trim() || ''}`;

            const lineNum = document.createElement('span');
            lineNum.className = 'ptab-line';
            lineNum.textContent = part.line;

            const label = document.createElement('span');
            label.className = 'ptab-label';
            label.textContent = this._partLabel(part);

            btn.appendChild(lineNum);
            btn.appendChild(label);
            btn.addEventListener('click', () => {
                // Сохраняем черновик текущей части перед переключением
                if (this._editor && this._modified) {
                    this._partDrafts[this._activePartIdx] = this._editor.getValue();
                }
                this._activePartIdx = i;
                this._renderPartTabs();
                this._loadPartIntoEditor(i);
            });
            tabBar.appendChild(btn);
        });

        // Вставляем между topbar/statusbar и editor-area как горизонтальную полосу сверху
        const area   = document.querySelector('.editor-area');
        const sb     = document.getElementById('editor-statusbar');
        if (area) {
            area.style.display = 'flex';
            area.style.flexDirection = 'column';
            area.insertBefore(tabBar, area.firstChild);
        }
    },


    _loadPartIntoEditor(partIdx) {
        const part = this._parts[partIdx];
        if (!part) return;
        this._activePartIdx = partIdx;
        this._modified      = false;

        const lang    = this._getLang(this._files[this._fileId]?.fullPath || '');
        const startLine = part.line || 1;

        // Берём черновик если есть, иначе оригинальный контент
        const draft   = this._partDrafts?.[partIdx];
        const content = draft ?? part.content;
        const hasDraft = !!draft;

        const apply = () => {
            this._settingContent = true;
            monaco.editor.setModelLanguage(this._editor.getModel(), lang);
            this._editor.setValue(content);
            this._editor.updateOptions({
                lineNumbers: n => String(startLine + n - 1),
            });
            this._editor.setScrollPosition({ scrollTop: 0 });
            this._settingContent = false;

            const fn = document.getElementById('editor-filename');
            if (hasDraft) {
                // Восстанавливаем флаг изменений
                this._modified = true;
                if (fn) fn.className = 'editor-filename modified';
                document.getElementById('btn-save')?.classList.remove('hidden');
                document.getElementById('btn-discard')?.classList.remove('hidden');
            } else {
                this._modified = false;
                if (fn) fn.className = 'editor-filename';
                document.getElementById('btn-save')?.classList.add('hidden');
                document.getElementById('btn-discard')?.classList.add('hidden');
            }
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

        window._monacoThemeDefined = true;
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
        this._editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyG, () => this._showGotoLine());

        // Статусбар — позиция курсора
        this._editor.onDidChangeCursorPosition(e => {
            const pos = e.position;
            const part = this._parts?.[this._activePartIdx];
            const realLine = (part?.line || 1) + pos.lineNumber - 1;
            const sb = document.getElementById('sb-pos');
            if (sb) sb.textContent = `Стр ${realLine}, Кол ${pos.column}`;
        });

        // Статусбар — количество строк
        this._editor.onDidChangeModelContent(() => {
            const model = this._editor.getModel();
            if (!model) return;
            const linesEl = document.getElementById('sb-lines');
            if (linesEl) linesEl.textContent = `${model.getLineCount()} строк`;
        });

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

        // Фиксируем все значения в момент начала сохранения
        const savedFileId  = this._activeFileId;
        const savedPartIdx = this._activePartIdx;
        const part         = this._parts[savedPartIdx];
        if (!part) return;
        const code = this._editor.getValue();

        const btn = document.getElementById('btn-save');
        if (btn) { btn.disabled = true; btn.textContent = 'Сохраняем...'; }

        try {
            const res = await API.post('/api/code/save', {
                file_id:    savedFileId,
                code,
                part_index: savedPartIdx,
                hash:       part.hash,
                html:       this._buildFileHtml(savedFileId, savedPartIdx, code),
            });

            // Применяем результат только если файл не изменился
            if (this._activeFileId === savedFileId) {
                this._parts[savedPartIdx].hash = res.hash;
                if (this._partDrafts) delete this._partDrafts[savedPartIdx];
                // Сбрасываем флаг изменений только если мы всё ещё на той же части
                if (this._activePartIdx === savedPartIdx) {
                    this._modified = false;
                    document.getElementById('editor-filename').className = 'editor-filename';
                    document.getElementById('btn-save')?.classList.add('hidden');
                    document.getElementById('btn-discard')?.classList.add('hidden');
                }
            }
            this._pushHistory(savedFileId, savedPartIdx, part.line || 1, code);
            app.toast('💾 Файл сохранён', 'success');
        } catch (e) {
            app.toast('Ошибка сохранения: ' + e.message, 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '💾 Сохранить'; }
        }
    },

    // Генерируем HTML который платформа ожидает как 5-й аргумент set_code
    _buildFileHtml(fileId, savedPartIdx, savedCode) {
        const file = this._files[fileId];
        const fileName = file?.fullPath || '';
        let partsHtml = '';
        this._parts.forEach((p, i) => {
            const content = (i === savedPartIdx) ? savedCode : (this._partDrafts?.[i] ?? p.content ?? '');
            const parents = (p.parents || []).map(par =>
                `<div class="parent"><div class="line">${par.line}</div><div class="name">${par.name}</div></div>`
            ).join('');
            partsHtml += `<div class="clearfix code-part" data-index="${i}">` +
                `<div class="parents">${parents}</div>` +
                `<div class="code" style="height: 300px" flask="${i}">` +
                `<textarea class="codeflask__textarea">${content.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</textarea>` +
                `</div>` +
                `<div class="button-simple save-code" style="display: none">Сохранить</div>` +
                `</div>`;
        });
        return `\n\t\t\t\t<div class="title action">${fileName}</div>\n\t\t\t\t<div class="content" style="display: block;">\n\t\t\t\t\t<div class="delete-access"><input class="line-start" placeholder="от"> - <input class="line-end" placeholder="до"><div class="button-simple">Удалить</div></div>\n\t\t\t\t\t<div class="spoiler code-block"><div class="title action">Посмотреть содержимое</div><div class="content" style="display: block;">${partsHtml}</div></div>\n\t\t\t\t</div>`;
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
        const currentCode = this._editor?.getValue() || part?.content || '';

        const modal = document.createElement('div');
        modal.id = 'history-modal';
        modal.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px)';

        const fmt = ts => new Date(ts).toLocaleString('ru-RU', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        });

        const lang = this._getLang(file?.fullPath || '');

        modal.innerHTML = `
        <div style="display:flex;flex-direction:column;width:100%;max-width:1400px;height:88vh;margin:auto;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden">
            <div style="display:flex;align-items:center;gap:12px;padding:13px 20px;border-bottom:1px solid var(--border);flex-shrink:0">
                <span style="font-size:13px;font-weight:600;color:var(--text)">История: <span style="font-family:var(--mono);color:var(--text-2)">${this._esc(file?.fullPath || '')}${part ? ` [${part.line}]` : ''}</span></span>
                <span style="flex:1"></span>
                <span id="hist-meta" style="font-size:12px;color:var(--text-2)"></span>
                <button class="btn btn-ghost btn-sm hidden" id="hist-diff-btn" title="Сравнить с текущим">⟺ Diff</button>
                <button class="btn btn-ghost btn-sm hidden" id="hist-restore">↩ Восстановить</button>
                <button id="hist-close" style="background:none;border:none;color:var(--text-2);cursor:pointer;font-size:18px;padding:4px 8px">✕</button>
            </div>
            <div style="display:grid;grid-template-columns:200px 1fr;flex:1;overflow:hidden;min-height:0">
                <div id="hist-list" style="border-right:1px solid var(--border);overflow-y:auto;padding:6px 0;background:var(--bg)">
                    ${hist.length === 0
                        ? '<div style="padding:16px;color:var(--text-3);font-size:13px">Нет версий</div>'
                        : hist.map((h, i) => `
                        <div class="hist-item" data-idx="${i}">
                            <div class="hist-item-ts">${fmt(h.ts)}</div>
                            <div class="hist-item-line">строка ${h.startLine}</div>
                        </div>`).join('')
                    }
                </div>
                <div style="display:flex;flex-direction:column;overflow:hidden;min-height:0;background:#0D0D0F">
                    <div id="hist-editor-empty" style="display:flex;align-items:center;justify-content:center;flex:1;color:var(--text-3);font-size:13px">← Выберите версию</div>
                    <div id="hist-editor-wrap" style="flex:1;display:none;position:relative"></div>
                </div>
            </div>
        </div>`;

        document.body.appendChild(modal);

        let histViewer = null;
        let diffViewer = null;
        let currentEntry = null;
        let isDiff = false;

        const destroyViewers = () => {
            if (histViewer) { histViewer.dispose(); histViewer = null; }
            if (diffViewer) { diffViewer.dispose(); diffViewer = null; }
        };

        const showVersion = (h) => {
            currentEntry = h;
            const { content, ts, startLine } = h;
            document.getElementById('hist-editor-empty').style.display = 'none';
            const wrap = document.getElementById('hist-editor-wrap');
            wrap.style.display = 'block';
            document.getElementById('hist-meta').textContent = fmt(ts);
            document.getElementById('hist-restore').classList.remove('hidden');
            document.getElementById('hist-diff-btn').classList.remove('hidden');

            if (isDiff) {
                showDiff(h);
                return;
            }

            destroyViewers();
            if (window.monaco) {
                histViewer = monaco.editor.create(wrap, {
                    value: content,
                    language: lang,
                    theme: 'custom-dark',
                    readOnly: true,
                    fontSize: 13,
                    fontFamily: "'Cascadia Code','Consolas',monospace",
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    lineNumbers: n => String((startLine || 1) + n - 1),
                    renderLineHighlight: 'line',
                    wordWrap: 'off',
                });
            }
        };

        const showDiff = (h) => {
            if (!window.monaco) return;
            const { content, startLine } = h;
            const wrap = document.getElementById('hist-editor-wrap');
            wrap.style.display = 'block';
            document.getElementById('hist-editor-empty').style.display = 'none';

            destroyViewers();
            const origModel    = monaco.editor.createModel(content, lang);
            const modifiedModel = monaco.editor.createModel(currentCode, lang);
            diffViewer = monaco.editor.createDiffEditor(wrap, {
                theme: 'custom-dark',
                readOnly: true,
                fontSize: 13,
                fontFamily: "'Cascadia Code','Consolas',monospace",
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                automaticLayout: true,
                renderSideBySide: true,
                originalEditable: false,
            });
            diffViewer.setModel({ original: origModel, modified: modifiedModel });
        };

        const diffBtn = modal.querySelector('#hist-diff-btn');
        diffBtn.addEventListener('click', () => {
            isDiff = !isDiff;
            diffBtn.textContent = isDiff ? '📄 Просмотр' : '⟺ Diff';
            diffBtn.title = isDiff ? 'Обычный просмотр' : 'Сравнить с текущим';
            if (currentEntry) {
                if (isDiff) showDiff(currentEntry);
                else showVersion({ ...currentEntry });
            }
        });

        modal.querySelectorAll('.hist-item').forEach(item => {
            item.addEventListener('click', () => {
                modal.querySelectorAll('.hist-item').forEach(i => i.classList.remove('active'));
                item.classList.add('active');
                const h = hist[parseInt(item.dataset.idx)];
                showVersion(h);

                document.getElementById('hist-restore').onclick = () => {
                    if (!confirm('Восстановить эту версию?')) return;
                    this._settingContent = true;
                    this._editor.setValue(h.content);
                    this._settingContent = false;
                    this._modified = true;
                    document.getElementById('editor-filename').className = 'editor-filename modified';
                    document.getElementById('btn-save')?.classList.remove('hidden');
                    document.getElementById('btn-discard')?.classList.remove('hidden');
                    destroyViewers();
                    modal.remove();
                    app.toast('↩ Версия восстановлена — не забудь сохранить', 'info');
                };
            });
        });

        modal.querySelector('#hist-close').addEventListener('click', () => {
            destroyViewers();
            modal.remove();
        });
        modal.addEventListener('click', e => {
            if (e.target === modal) {
                destroyViewers();
                modal.remove();
            }
        });
    },

    _discard() {
        if (!this._activeFileId) return;
        this._modified = false;
        this._loadPartIntoEditor(this._activePartIdx);
    },

    _showGotoLine() {
        if (!this._editor) return;
        const part = this._parts?.[this._activePartIdx];
        const startLine = part?.line || 1;

        const modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:flex-start;justify-content:center;padding-top:120px;background:rgba(0,0,0,0.5)';
        modal.innerHTML = `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-md);padding:16px;width:320px;display:flex;flex-direction:column;gap:10px;box-shadow:0 8px 32px rgba(0,0,0,0.5)">
            <div style="font-size:13px;font-weight:500;color:var(--text)">Перейти к строке</div>
            <input id="goto-input" type="number" placeholder="Номер строки..." style="width:100%;padding:8px 12px;font-size:13px;font-family:var(--mono)" autofocus />
            <div style="font-size:12px;color:var(--text-3)">Диапазон: ${startLine} – ${startLine + (this._editor.getModel()?.getLineCount() || 1) - 1}</div>
            <div style="display:flex;gap:8px;justify-content:flex-end">
                <button class="btn btn-ghost btn-sm" id="goto-cancel">Отмена</button>
                <button class="btn btn-primary btn-sm" id="goto-ok">Перейти</button>
            </div>
        </div>`;
        document.body.appendChild(modal);

        const input = modal.querySelector('#goto-input');
        setTimeout(() => input?.focus(), 50);

        const go = () => {
            const realLine = parseInt(input.value);
            if (!isNaN(realLine)) {
                const editorLine = Math.max(1, realLine - startLine + 1);
                this._editor.revealLineInCenter(editorLine);
                this._editor.setPosition({ lineNumber: editorLine, column: 1 });
                this._editor.focus();
            }
            modal.remove();
        };

        modal.querySelector('#goto-ok').addEventListener('click', go);
        modal.querySelector('#goto-cancel').addEventListener('click', () => modal.remove());
        input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); if (e.key === 'Escape') modal.remove(); });
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
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
    _sqLastResult: null,   // сохранённый результат поиска
    _sqBookmarks: [],      // закладки на блоки

    // ── История поисковых запросов ────────────────────────────────────
    _sqHistKey: 'sq_history',
    _sqHistMax: 20,

    _sqLoadHist() { try { return JSON.parse(localStorage.getItem(this._sqHistKey) || '[]'); } catch { return []; } },
    _sqPushHist(text) {
        let h = this._sqLoadHist().filter(t => t !== text);
        h.unshift(text);
        if (h.length > this._sqHistMax) h = h.slice(0, this._sqHistMax);
        try { localStorage.setItem(this._sqHistKey, JSON.stringify(h)); } catch {}
    },

    // ── Закладки ─────────────────────────────────────────────────────
    _sqBmKey: 'sq_bookmarks',
    _sqLoadBm() { try { return JSON.parse(localStorage.getItem(this._sqBmKey) || '[]'); } catch { return []; } },
    _sqSaveBm(bms) { try { localStorage.setItem(this._sqBmKey, JSON.stringify(bms)); } catch {} },
    _sqAddBm(fileId, path, name, fileName) {
        const bms = this._sqLoadBm();
        const key = `${fileId}:${path}`;
        if (!bms.find(b => b.key === key)) {
            bms.unshift({ key, fileId, path, name, fileName, ts: Date.now() });
            if (bms.length > 30) bms.pop();
            this._sqSaveBm(bms);
            app.toast('🔖 Закладка добавлена', 'success');
        } else {
            app.toast('Уже в закладках', 'info');
        }
        this._sqRenderBookmarks();
    },
    _sqRemoveBm(key) {
        this._sqSaveBm(this._sqLoadBm().filter(b => b.key !== key));
        this._sqRenderBookmarks();
    },
    _sqRenderBookmarks() {
        const el = document.getElementById('sq-bookmarks');
        if (!el) return;
        const bms = this._sqLoadBm();
        if (!bms.length) { el.innerHTML = '<div style="padding:8px 0;color:var(--text-3);font-size:12px">Нет закладок</div>'; return; }
        el.innerHTML = bms.map(b => `
        <div class="sq-bm-item">
            <span class="sq-bm-name" data-key="${b.key}" data-file="${b.fileId}" data-path='${b.path}' data-name="${this._esc(b.name)}">${this._esc(b.name || b.fileName)}</span>
            <span class="sq-bm-file">${this._esc(b.fileName || '')}</span>
            <button class="sq-bm-del" data-key="${b.key}">✕</button>
        </div>`).join('');
        el.querySelectorAll('.sq-bm-name').forEach(n => n.addEventListener('click', () => {
            this._sqGetCode('edit', { file: n.dataset.file, path: n.dataset.path, name: n.dataset.name, lines: '0' });
        }));
        el.querySelectorAll('.sq-bm-del').forEach(b => b.addEventListener('click', e => {
            e.stopPropagation(); this._sqRemoveBm(b.dataset.key);
        }));
    },

    _initSearch() {
        const root = document.getElementById('search-root');
        if (!root || this._searchInited) return;
        this._searchInited = true;

        const favIds = this._loadFavs();
        const favOpts = favIds.map(id => {
            const f = this._files[id];
            return f ? `<option value="${id}">${this._esc(f.fullPath)}</option>` : '';
        }).join('');

        root.innerHTML = `
        <div class="card">
            <div class="card-header"><span class="card-title">Поиск по коду</span></div>
            <div style="display:flex;flex-direction:column;gap:10px">
                <div style="position:relative;display:flex;gap:8px">
                    <div style="flex:1;position:relative">
                        <input type="text" id="sq-text" placeholder="Поисковый запрос..." style="width:100%" autocomplete="off" />
                        <div id="sq-hist-drop" class="sq-hist-drop hidden"></div>
                    </div>
                    <button class="btn btn-primary" id="sq-btn">Найти</button>
                </div>
                <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;font-size:13px;color:var(--text-2)">
                    <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
                        <input type="checkbox" id="sq-regexp" /> Regexp
                    </label>
                    <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
                        <input type="checkbox" id="sq-fav-only" />
                        ⭐ Только избранные
                    </label>
                    <span>Строки:</span>
                    <input type="text" id="sq-from" placeholder="от" style="width:60px;padding:5px 8px" />
                    <span>—</span>
                    <input type="text" id="sq-to" placeholder="до" style="width:60px;padding:5px 8px" />
                    <span>в файле:</span>
                    <select id="sq-file" style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);padding:5px 8px;font-size:13px;outline:none;max-width:220px">
                        <option value="-1">Все файлы</option>
                        ${Object.entries(this._files).map(([id, f]) => `<option value="${id}">${this._esc(f.fullPath)}</option>`).join('')}
                    </select>
                </div>
                <div style="border-top:1px solid var(--border);padding-top:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;color:var(--text-2)">
                    <span>Строка напрямую:</span>
                    <select id="sq-line-file" style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);padding:5px 8px;font-size:13px;outline:none;max-width:200px">
                        ${Object.entries(this._files).map(([id, f]) => `<option value="${id}">${this._esc(f.fullPath)}</option>`).join('')}
                    </select>
                    <input type="text" id="sq-line-num" placeholder="Номер строки" style="width:110px;padding:5px 8px" />
                    <button class="btn btn-ghost btn-sm" id="sq-get-line">Получить</button>
                </div>
            </div>
        </div>

        <div class="card" style="padding:0;overflow:hidden">
            <div style="display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid var(--border)">
                <span class="card-title" style="margin:0">🔖 Закладки</span>
            </div>
            <div id="sq-bookmarks" style="padding:8px 16px;max-height:120px;overflow-y:auto"></div>
        </div>

        <div id="sq-results-wrap" class="card hidden" style="padding:0;overflow:hidden">
            <div style="display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border)">
                <span class="card-title" style="margin:0">Результаты</span>
                <span id="sq-count" style="color:var(--text-2);font-size:13px"></span>
            </div>
            <div id="sq-results" style="padding:8px 0"></div>
        </div>`;

        this._sqRenderBookmarks();

        // История — показываем при фокусе
        const textEl = document.getElementById('sq-text');
        const histDrop = document.getElementById('sq-hist-drop');
        textEl.addEventListener('focus', () => this._sqShowHist());
        textEl.addEventListener('input', () => this._sqShowHist());
        textEl.addEventListener('keydown', e => { if (e.key === 'Enter') { histDrop.classList.add('hidden'); this._sqSearch(); } if (e.key === 'Escape') histDrop.classList.add('hidden'); });
        document.addEventListener('click', e => { if (!e.target.closest('#sq-text') && !e.target.closest('#sq-hist-drop')) histDrop.classList.add('hidden'); }, true);

        // Фильтр "только избранные"
        document.getElementById('sq-fav-only').addEventListener('change', e => {
            const sel = document.getElementById('sq-file');
            if (e.target.checked) {
                // Оставляем только избранные в селекте
                Array.from(sel.options).forEach(o => {
                    o.hidden = o.value !== '-1' && !favIds.includes(o.value);
                });
                sel.value = '-1';
            } else {
                Array.from(sel.options).forEach(o => o.hidden = false);
            }
        });

        document.getElementById('sq-btn').addEventListener('click', () => this._sqSearch());
        document.getElementById('sq-get-line').addEventListener('click', () => this._sqGetLine());

        // Восстанавливаем последний результат
        if (this._sqLastResult) {
            const wrap = document.getElementById('sq-results-wrap');
            const el   = document.getElementById('sq-results');
            wrap.classList.remove('hidden');
            this._sqRender(this._sqLastResult, el);
        }
    },

    _sqShowHist() {
        const drop = document.getElementById('sq-hist-drop');
        if (!drop) return;
        const val  = document.getElementById('sq-text').value.toLowerCase();
        const hist = this._sqLoadHist().filter(t => !val || t.toLowerCase().includes(val));
        if (!hist.length) { drop.classList.add('hidden'); return; }
        drop.classList.remove('hidden');
        drop.innerHTML = hist.slice(0, 8).map(t =>
            `<div class="sq-hist-item" data-val="${this._esc(t)}">${this._esc(t)}</div>`
        ).join('');
        drop.querySelectorAll('.sq-hist-item').forEach(item => {
            item.addEventListener('click', () => {
                document.getElementById('sq-text').value = item.dataset.val;
                drop.classList.add('hidden');
                this._sqSearch();
            });
        });
    },

    async _sqSearch() {
        const text = document.getElementById('sq-text').value.trim();
        if (!text) return;
        this._sqPushHist(text);
        this._sqQuery = text;
        document.getElementById('sq-hist-drop')?.classList.add('hidden');

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
            this._sqLastResult = res.result;  // сохраняем для восстановления
            this._sqRender(res.result, el);
        } catch (e) {
            el.innerHTML = `<div style="padding:20px;color:var(--red);font-size:13px">${e.message}</div>`;
        } finally {
            btn.disabled = false; btn.textContent = 'Найти';
        }
    },

    _sqCompact: false,  // режим отображения
    _sqQuery: '',       // последний поисковый запрос для подсветки

    _sqRender(result, el) {
        if (!result || result === 'too_much') { el.innerHTML = '<div style="padding:20px;color:var(--yellow);font-size:13px;text-align:center">Слишком много результатов — уточните запрос</div>'; return; }
        if (result === 'regex_incorrect')     { el.innerHTML = '<div style="padding:20px;color:var(--red);font-size:13px;text-align:center">Некорректное регулярное выражение</div>'; return; }

        let totalFiles = 0, totalBlocks = 0;
        let html = '';

        for (const [fileId, fileData] of Object.entries(result)) {
            if (!fileData || !Object.keys(fileData).length) continue;
            totalFiles++;
            // Ищем имя сначала в доступных, потом во всех файлах
            const fileName   = this._files[fileId]?.fullPath
                            || this._allFiles?.[fileId]?.fullPath
                            || ('#' + fileId);
            const blockCount = this._sqCountBlocks(fileData);
            totalBlocks += blockCount;

            const shortName  = fileName.split('/').pop();
            const dirPart    = fileName.includes('/') ? fileName.slice(0, fileName.lastIndexOf('/') + 1) : '';
            const accessFid  = Object.keys(this._files).find(fid =>
                this._files[fid].fullPath === fileName || this._files[fid].fullPath.endsWith('/' + fileName)
            ) || null;

            html += `<div class="sq-file-group" data-fileid="${fileId}">
                <div class="sq-file-header">
                    <span class="sq-file-icon">📄</span>
                    <span class="sq-file-dir">${this._esc(dirPart)}</span>
                    <span class="sq-file-name">${this._esc(shortName)}</span>
                    <span class="sq-file-count">${blockCount} ${blockCount === 1 ? 'блок' : 'блоков'}</span>
                    <div class="sq-file-actions">
                        <button class="sq-header-btn sq-expand-all" title="Развернуть все блоки">⊞</button>
                        <button class="sq-header-btn sq-collapse-all" title="Свернуть все блоки">⊟</button>
                    </div>
                </div>
                <div class="sq-file-blocks">
                    ${this._sqBlocks(fileId, fileData, [], fileName, accessFid)}
                </div>
            </div>`;
        }

        if (!html) { el.innerHTML = '<div style="padding:20px;color:var(--text-3);font-size:13px;text-align:center">Ничего не найдено</div>'; return; }

        const countEl = document.getElementById('sq-count');
        if (countEl) countEl.textContent = `${totalFiles} файл(ов) · ${totalBlocks} блоков`;

        el.innerHTML = html;
        this._sqBindEvents(el);
    },

    _sqCountBlocks(blocks) {
        let n = 0;
        for (const b of Object.values(blocks)) {
            n++;
            if (b.children) n += this._sqCountBlocks(b.children);
        }
        return n;
    },

    // Проверяем попадает ли строка line в доступные части файла
    // Использует кэш _sqAccessibleRanges который строится из client.code
    _sqLineAccessible(fileId, line) {
        const ranges = this._sqAccessibleRanges?.[fileId];
        if (!ranges) return false;
        return ranges.some(([start, end]) => line >= start && line <= end);
    },

    // Строим карту доступных диапазонов из данных кода
    async _sqLoadAccessibleRanges() {
        // Загружаем code-данные для всех доступных файлов чтобы знать диапазоны строк
        const filesData = {};
        await Promise.all(
            Object.keys(this._files).map(async fileId => {
                try {
                    const data = await API.get(`/api/file/${fileId}/code`);
                    if (data.code) filesData[fileId] = data.code;
                } catch {}
            })
        );
        this._sqBuildAccessibleRanges(filesData);
    },

    _sqBuildAccessibleRanges(filesData) {
        this._sqAccessibleRanges = {};
        for (const [fileId, parts] of Object.entries(filesData)) {
            if (!Array.isArray(parts) || !parts.length) continue;
            this._sqAccessibleRanges[fileId] = parts.map(part => {
                const start = part.line || 1;
                const end   = start + (part.content || '').split('\n').length - 1;
                return [start, end];
            });
        }
    },

    _sqHighlight(text) {
        if (!this._sqQuery) return this._esc(text);
        const safe  = this._esc(text);
        const safeQ = this._esc(this._sqQuery).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return safe.replace(new RegExp(safeQ, 'gi'), m => `<mark class="sq-hl">${m}</mark>`);
    },

    _sqBlocks(fileId, blocks, parentPath, fileName, accessFid, depth = 0) {
        const sorted = Object.keys(blocks).sort((a, b) => +a - +b);
        let html = '';

        for (let i = 0; i < sorted.length; i++) {
            const id    = sorted[i];
            const block = blocks[id];
            const path  = JSON.stringify([...parentPath, +id]);
            const esc   = this._esc.bind(this);

            if (block.children) {
                const linesColor = block.lines > 100 ? 'var(--yellow)' : 'var(--text-3)';
                html += `<div class="sq-block sq-block-parent" data-depth="${depth}">
                    <div class="sq-block-row" data-toggle="1">
                        <span class="sq-toggle-icon">▶</span>
                        <span class="sq-line-num">${id}</span>
                        <span class="sq-block-label">
                            <span class="sq-type-tag">Блок</span>
                            ${block.name ? `<span class="sq-name">${this._sqHighlight(block.name)}</span>` : ''}
                        </span>
                        <span class="sq-lines-badge" style="color:${linesColor}">${block.lines} стр.</span>
                        <div class="sq-row-actions">
                            <button class="sq-act-btn sq-bm-add" data-file="${fileId}" data-path='${path}' data-name="${esc(block.name||'')}" data-fname="${esc(fileName||'')}" title="Закладка">🔖</button>
                            <button class="sq-act-btn" data-sqaction="edit" data-file="${fileId}" data-path='${path}' data-name="${esc(block.name||'')}" data-lines="${block.lines||0}" title="Получить код">↓ Код</button>
                        </div>
                    </div>
                    <div class="sq-block-children sq-hidden">
                        ${this._sqBlocks(fileId, block.children, [...parentPath, +id], fileName, accessFid, depth + 1)}
                    </div>
                </div>`;
            } else {
                let typeTag = '';
                if (block.type === 'function_call') typeTag = 'Вызов';
                else if (block.type === 'text')     typeTag = 'Текст';
                else if (block.type === 'other')    typeTag = 'Прочее';

                // Кнопка перехода только если строка попадает в доступный диапазон
                const goBtn = accessFid && this._sqLineAccessible(accessFid, +id)
                    ? `<button class="sq-act-btn sq-go-btn" data-fileid="${accessFid}" data-line="${id}" title="Открыть в редакторе">↗</button>`
                    : '';

                const previewBtn = block.type !== 'condition'
                    ? `<button class="sq-act-btn" data-sqaction="preview" data-file="${fileId}" data-path='${path}' data-name="${esc(block.name||'')}" data-leaf="sq-leaf-${fileId}-${id}" title="Посмотреть">👁</button>`
                    : '';

                html += `<div class="sq-block sq-block-leaf" data-depth="${depth}">
                    <div class="sq-block-row">
                        <span class="sq-line-num">${id}</span>
                        <span class="sq-block-label" id="sq-leaf-${fileId}-${id}">
                            ${typeTag ? `<span class="sq-type-tag">${typeTag}</span>` : ''}
                            <span class="sq-name">${this._sqHighlight(block.name || '')}</span>
                        </span>
                        <div class="sq-row-actions">
                            ${goBtn}
                            <button class="sq-act-btn sq-bm-add" data-file="${fileId}" data-path='${path}' data-name="${esc(block.name||'')}" data-fname="${esc(fileName||'')}" title="Закладка">🔖</button>
                            ${previewBtn}
                            <button class="sq-act-btn" data-sqaction="edit" data-file="${fileId}" data-path='${path}' data-name="${esc(block.name||'')}" title="Получить код">↓ Код</button>
                        </div>
                    </div>
                </div>`;
            }

            if (i < sorted.length - 1 && +sorted[i + 1] - +id > 1) {
                html += `<div class="sq-gap">···</div>`;
            }
        }
        return html;
    },

    _sqBindEvents(el) {
        // Toggle блоков
        el.querySelectorAll('[data-toggle="1"]').forEach(row => {
            row.addEventListener('click', e => {
                if (e.target.closest('.sq-row-actions')) return;
                const block    = row.closest('.sq-block-parent');
                const children = block?.querySelector('.sq-block-children');
                const icon     = row.querySelector('.sq-toggle-icon');
                if (!children) return;
                children.classList.toggle('sq-hidden');
                if (icon) icon.textContent = children.classList.contains('sq-hidden') ? '▶' : '▼';
            });
        });

        // Развернуть/свернуть все в группе файла
        el.querySelectorAll('.sq-expand-all').forEach(btn => {
            btn.addEventListener('click', () => {
                btn.closest('.sq-file-group').querySelectorAll('.sq-block-children').forEach(c => {
                    c.classList.remove('sq-hidden');
                    const icon = c.closest('.sq-block-parent')?.querySelector('.sq-toggle-icon');
                    if (icon) icon.textContent = '▼';
                });
            });
        });
        el.querySelectorAll('.sq-collapse-all').forEach(btn => {
            btn.addEventListener('click', () => {
                btn.closest('.sq-file-group').querySelectorAll('.sq-block-children').forEach(c => {
                    c.classList.add('sq-hidden');
                    const icon = c.closest('.sq-block-parent')?.querySelector('.sq-toggle-icon');
                    if (icon) icon.textContent = '▶';
                });
            });
        });

        // Preview
        el.querySelectorAll('[data-sqaction="preview"]').forEach(b => b.addEventListener('click', e => {
            e.stopPropagation();
            this._sqGetCode('preview', b.dataset);
        }));

        // Получить код
        el.querySelectorAll('[data-sqaction="edit"]').forEach(b => b.addEventListener('click', e => {
            e.stopPropagation();
            this._sqGetCode('edit', b.dataset);
        }));

        // Закладки
        el.querySelectorAll('.sq-bm-add').forEach(b => b.addEventListener('click', e => {
            e.stopPropagation();
            this._sqAddBm(b.dataset.file, b.dataset.path, b.dataset.name, b.dataset.fname);
        }));

        // Быстрый переход
        el.querySelectorAll('.sq-go-btn').forEach(b => b.addEventListener('click', e => {
            e.stopPropagation();
            const line = parseInt(b.dataset.line);
            const fid  = b.dataset.fileid;
            this._switchTab('files');
            this._openFile(fid).then(() => {
                setTimeout(() => {
                    const parts = this._parts || [];
                    let bestIdx = 0;
                    parts.forEach((p, i) => { if ((p.line || 1) <= line) bestIdx = i; });
                    if (bestIdx !== this._activePartIdx) {
                        this._activePartIdx = bestIdx;
                        this._renderPartTabs();
                        this._loadPartIntoEditor(bestIdx);
                    }
                    setTimeout(() => {
                        const editor = this._editor;
                        if (!editor) return;
                        const editorLine = Math.max(1, line - ((parts[bestIdx]?.line || 1)) + 1);
                        editor.revealLineInCenter(editorLine);
                        editor.setPosition({ lineNumber: editorLine, column: 1 });
                        editor.focus();
                    }, 400);
                }, 600);
            });
        }));
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
                // null = таймаут но данные могут быть в update_code — просто убираем кнопку
                if (result !== null) {
                    const code = typeof result === 'string' ? result : (result?.code ?? '');
                    const line = result?.line ?? '';
                    if (leaf) {
                        const el = document.getElementById(leaf);
                        if (el) {
                            el.innerHTML = `<span class="sq-line-num">[${line}]</span> <span class="sq-preview-code">${this._esc(code)}</span>`;
                            el.closest('.sq-block-row')?.classList.add('sq-has-preview');
                        }
                    }
                }
                btn?.remove();
            } else {
                if (result === 'access') {
                    app.toast('✅ Доступ разрешён', 'success');
                } else if (result === 'pending' || result === null) {
                    app.toast('⏳ Запрос направлен модераторам', 'info');
                } else {
                    app.toast('⏳ Запрос направлен модераторам', 'info');
                }
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
