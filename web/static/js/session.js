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

    // Восстанавливает содержимое одной страницы. Сам не переключает
    // вкладку — навигация снаружи. Используется и при первом boot,
    // и при возврате на ту же вкладку через app.navigate.
    restorePageContents(page) {
        const st = this.get();
        this._suspendRestore = true;
        const finishUnsuspend = () => setTimeout(() => { this._suspendRestore = false; }, 1500);

        if (page === 'files' && st.files && st.files.fileId) {
            const files = app._pages['files'];
            if (!files) { finishUnsuspend(); return; }
            const targetId = String(st.files.fileId);
            const partIdx  = st.files.partIdx | 0;
            const cursor   = st.files.cursor;
            const scroll   = st.files.scroll;

            const tryOpen = (attempt = 0) => {
                if (!files._files || Object.keys(files._files).length === 0) {
                    if (attempt > 40) { finishUnsuspend(); return; }
                    setTimeout(() => tryOpen(attempt + 1), 150);
                    return;
                }
                if (!files._files[targetId] && !files._allFiles?.[targetId]) {
                    finishUnsuspend();
                    return;
                }
                // Если уже открыт нужный файл — не открываем заново, только
                // дотягиваем part/cursor/scroll (типичный случай при возврате
                // на вкладку без перезагрузки страницы).
                const alreadyOpen = String(files._activeFileId) === targetId
                    && files._parts && files._parts.length;
                const ensureOpen = alreadyOpen
                    ? Promise.resolve()
                    : Promise.resolve(files._openFile(targetId));
                ensureOpen.then(() => {
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
                                if (typeof scroll === 'number' && scroll > 0) {
                                    // Несколько попыток — Monaco иногда сбрасывает scrollTop при перерисовке
                                    let tries = 0;
                                    const applyScroll = () => {
                                        editor.setScrollTop(scroll);
                                        if (++tries < 4) setTimeout(applyScroll, 100);
                                    };
                                    applyScroll();
                                }
                            }
                            finishUnsuspend();
                        }, alreadyOpen ? 0 : 350);
                    }, alreadyOpen ? 0 : 400);
                }).catch(() => finishUnsuspend());
            };
            tryOpen();
            return;
        }

        if (page === 'notes' && st.notes && st.notes.noteId) {
            const notes = app._pages['notes'];
            if (!notes) { finishUnsuspend(); return; }
            const tryOpen = (attempt = 0) => {
                if (!notes._items || !notes._items.length) {
                    if (attempt > 40) { finishUnsuspend(); return; }
                    setTimeout(() => tryOpen(attempt + 1), 150);
                    return;
                }
                if (!notes._items.some(n => n.id === st.notes.noteId)) {
                    finishUnsuspend();
                    return;
                }
                if (notes._activeId === st.notes.noteId) {
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

    // Высокоуровневый restore при старте: переключает вкладку и
    // вызывает restorePageContents.
    restore() {
        const st = this.get();
        const page = st.page || 'server';
        if (page !== 'server') {
            this._suspendRestore = true;
            try { app.navigate(page); } catch {}
        }
        this.restorePageContents(page);
    },
};

window.Session = Session;
