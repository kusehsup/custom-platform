// ── Session — автосохранение состояния (auto-workspace) ────────────
//
// Отдельно от именованных Workspace. Эта штука пишет в localStorage
// текущую вкладку и место в редакторе/заметках, чтобы при перезагрузке
// страницы или возврате на сайт открывалось ровно то же.
//
// Что хранится:
//   page:      'server' | 'files' | 'db' | 'notes' | 'extcmd' | ...
//   files:     { fileId, partIdx, cursor: {line, col}, scroll }
//   notes:     { noteId }
//
// Что НЕ хранится: открытые папки дерева, ширина sidebar'а, режимы,
// избранное — у них свои персистентные ключи, восстанавливаются сами.

const Session = {
    KEY: 'last_session',
    _state: null,
    _writeTimer: null,
    _writeDelay: 400,
    _suspendRestore: false,

    _load() {
        try { return JSON.parse(localStorage.getItem(this.KEY) || '{}') || {}; }
        catch { return {}; }
    },

    _persist() {
        try { localStorage.setItem(this.KEY, JSON.stringify(this._state || {})); }
        catch {}
    },

    _scheduleWrite() {
        if (this._writeTimer) clearTimeout(this._writeTimer);
        this._writeTimer = setTimeout(() => {
            this._writeTimer = null;
            this._persist();
        }, this._writeDelay);
    },

    init() {
        if (this._state) return this._state;
        this._state = this._load();
        return this._state;
    },

    // Обновляет поле верхнего уровня (page) или вложенный объект.
    // setPage('files'), setFiles({fileId, partIdx, cursor, scroll}),
    // setNotes({noteId}). Каждое поле мерджится поверх предыдущего.
    setPage(page) {
        if (!page) return;
        this.init();
        this._state.page = page;
        this._scheduleWrite();
    },

    patchFiles(patch) {
        this.init();
        if (!patch) return;
        this._state.files = { ...(this._state.files || {}), ...patch };
        this._scheduleWrite();
    },

    setFiles(obj) {
        this.init();
        this._state.files = obj || null;
        this._scheduleWrite();
    },

    setNotes(obj) {
        this.init();
        this._state.notes = obj || null;
        this._scheduleWrite();
    },

    clearFiles() {
        this.init();
        delete this._state.files;
        this._scheduleWrite();
    },

    get() { return this.init(); },
    getPage() { return this.init().page; },
    getFiles() { return this.init().files; },
    getNotes() { return this.init().notes; },

    // На время восстановления выключаем запись — иначе автохуки засрут state.
    suspend(fn) {
        this._suspendRestore = true;
        try { return fn(); }
        finally {
            // Слегка подождём — Monaco/files асинхронно дотягиваются.
            setTimeout(() => { this._suspendRestore = false; }, 1500);
        }
    },
    isSuspended() { return this._suspendRestore; },

    // Высокоуровневый restore. Вызывается из app.boot после showApp.
    // 1) Переключает вкладку (или server по умолчанию).
    // 2) Если page === 'files' и есть files-state — открывает файл,
    //    переключает part, восстанавливает курсор/скролл.
    // 3) Если page === 'notes' — открывает заметку.
    restore() {
        const st = this.get();
        const page = st.page || 'server';
        this._suspendRestore = true;

        const finishUnsuspend = () => setTimeout(() => { this._suspendRestore = false; }, 1500);

        if (page !== 'server') {
            try { app.navigate(page); } catch {}
        }

        if (page === 'files' && st.files && st.files.fileId) {
            const files = app._pages['files'];
            if (!files) { finishUnsuspend(); return; }
            // app.navigate уже отрендерил страницу; openFile асинхронен.
            const targetId = String(st.files.fileId);
            const partIdx  = st.files.partIdx | 0;
            const cursor   = st.files.cursor;
            const scroll   = st.files.scroll;

            const tryOpen = () => {
                if (!files._files || Object.keys(files._files).length === 0) {
                    setTimeout(tryOpen, 200);
                    return;
                }
                if (!files._files[targetId] && !files._allFiles?.[targetId]) {
                    // Файл больше недоступен — просто оставляем как есть.
                    finishUnsuspend();
                    return;
                }
                Promise.resolve(files._openFile(targetId)).then(() => {
                    setTimeout(() => {
                        if (partIdx > 0 && partIdx !== files._activePartIdx
                            && files._parts && partIdx < files._parts.length) {
                            files._activePartIdx = partIdx;
                            files._renderPartTabs?.();
                            files._loadPartIntoEditor?.(partIdx);
                        }
                        setTimeout(() => {
                            const editor = files._editor;
                            if (editor) {
                                if (cursor && cursor.line) {
                                    editor.setPosition({ lineNumber: cursor.line, column: cursor.col || 1 });
                                    editor.revealLineInCenter(cursor.line);
                                }
                                if (scroll) editor.setScrollTop(scroll);
                            }
                            finishUnsuspend();
                        }, 350);
                    }, 400);
                }).catch(() => finishUnsuspend());
            };
            tryOpen();
            return;
        }

        if (page === 'notes' && st.notes && st.notes.noteId) {
            const notes = app._pages['notes'];
            if (!notes) { finishUnsuspend(); return; }
            const tryOpen = () => {
                if (!notes._items || !notes._items.length) {
                    setTimeout(tryOpen, 200);
                    return;
                }
                if (!notes._items.some(n => n.id === st.notes.noteId)) {
                    finishUnsuspend();
                    return;
                }
                Promise.resolve(notes._open(st.notes.noteId)).finally(finishUnsuspend);
            };
            tryOpen();
            return;
        }

        finishUnsuspend();
    },
};

window.Session = Session;
