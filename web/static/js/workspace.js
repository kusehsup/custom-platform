// ── Workspace — сохранение и восстановление состояния редактора ────

const Workspace = {
    KEY: 'workspaces',
    ACTIVE_KEY: 'workspace_active',

    _load() { try { return JSON.parse(localStorage.getItem(this.KEY) || '{}'); } catch { return {}; } },
    _save(d) { try { localStorage.setItem(this.KEY, JSON.stringify(d)); } catch {} },

    list() { return Object.keys(this._load()); },
    activeName() { return localStorage.getItem(this.ACTIVE_KEY) || 'default'; },
    setActive(name) { try { localStorage.setItem(this.ACTIVE_KEY, name); } catch {} },

    // Текущее состояние редактора
    captureState() {
        const files = app._pages['files'];
        if (!files) return null;
        const part = files._parts?.[files._activePartIdx];
        const editor = files._editor;
        const pos = editor?.getPosition();
        return {
            fileId: files._activeFileId,
            partIdx: files._activePartIdx,
            cursor: pos ? { line: pos.lineNumber, col: pos.column } : null,
            scroll: editor?.getScrollTop?.() || 0,
            ts: Date.now(),
        };
    },

    saveCurrent(name) {
        const all = this._load();
        const state = this.captureState();
        if (!state) return false;
        all[name] = state;
        this._save(all);
        this.setActive(name);
        return true;
    },

    restore(name) {
        const all = this._load();
        const ws = all[name];
        if (!ws) return false;
        const files = app._pages['files'];
        if (!files || !ws.fileId) return false;
        app.navigate('files');
        setTimeout(() => {
            files._openFile(ws.fileId).then(() => {
                setTimeout(() => {
                    if (ws.partIdx != null && ws.partIdx !== files._activePartIdx) {
                        files._activePartIdx = ws.partIdx;
                        files._renderPartTabs();
                        files._loadPartIntoEditor(ws.partIdx);
                    }
                    setTimeout(() => {
                        const editor = files._editor;
                        if (!editor) return;
                        if (ws.cursor) {
                            editor.setPosition({ lineNumber: ws.cursor.line, column: ws.cursor.col });
                            editor.revealLineInCenter(ws.cursor.line);
                        }
                        if (ws.scroll) editor.setScrollTop(ws.scroll);
                        editor.focus();
                    }, 350);
                }, 500);
            });
        }, 100);
        this.setActive(name);
        return true;
    },

    remove(name) {
        const all = this._load();
        delete all[name];
        this._save(all);
        if (this.activeName() === name) this.setActive('default');
    },

    showManager() {
        const all = this._load();
        const names = Object.keys(all).sort();
        const active = this.activeName();

        const modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px)';
        modal.innerHTML = `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);width:100%;max-width:500px;padding:0;display:flex;flex-direction:column;max-height:80vh;overflow:hidden">
            <div style="display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--border)">
                <span style="font-size:13px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.06em">Workspace</span>
                <span style="flex:1"></span>
                <button id="ws-close" style="background:none;border:none;color:var(--text-2);cursor:pointer;font-size:18px;padding:4px">✕</button>
            </div>
            <div style="padding:14px 20px;border-bottom:1px solid var(--border);display:flex;gap:8px">
                <input id="ws-name" type="text" placeholder="Имя нового workspace..." style="flex:1" />
                <button class="btn btn-primary btn-sm" id="ws-save">Сохранить</button>
            </div>
            <div id="ws-list" style="overflow-y:auto;flex:1">
                ${names.length === 0
                    ? '<div style="padding:20px;color:var(--text-3);font-size:13px;text-align:center">Нет сохранённых workspace</div>'
                    : names.map(n => {
                        const ws = all[n];
                        const fileName = app._pages['files']?._allFiles?.[ws.fileId]?.fullPath || '?';
                        return `<div class="ws-item ${n === active ? 'active' : ''}" data-name="${this._esc(n)}">
                            <div style="flex:1;overflow:hidden">
                                <div class="ws-name">${this._esc(n)} ${n === active ? '<span style="color:var(--accent);font-size:10px">● текущий</span>' : ''}</div>
                                <div class="ws-meta">${this._esc(fileName)} · ${ws.cursor ? `строка ${ws.cursor.line}` : ''}</div>
                            </div>
                            <button class="ws-restore-btn" data-name="${this._esc(n)}" title="Открыть">↗</button>
                            <button class="ws-del-btn" data-name="${this._esc(n)}" title="Удалить">✕</button>
                        </div>`;
                    }).join('')
                }
            </div>
        </div>`;
        document.body.appendChild(modal);

        const close = () => modal.remove();
        modal.querySelector('#ws-close').addEventListener('click', close);
        modal.addEventListener('click', e => { if (e.target === modal) close(); });

        modal.querySelector('#ws-save').addEventListener('click', () => {
            const name = modal.querySelector('#ws-name').value.trim();
            if (!name) { app.toast('Введите имя', 'error'); return; }
            if (this.saveCurrent(name)) {
                app.toast(`💾 Workspace "${name}" сохранён`, 'success');
                close();
            } else {
                app.toast('Нет открытого файла', 'error');
            }
        });
        modal.querySelector('#ws-name').addEventListener('keydown', e => { if (e.key === 'Enter') modal.querySelector('#ws-save').click(); });

        modal.querySelectorAll('.ws-restore-btn').forEach(b => b.addEventListener('click', () => {
            const name = b.dataset.name;
            if (this.restore(name)) { app.toast(`↗ Workspace "${name}"`, 'info'); close(); }
        }));
        modal.querySelectorAll('.ws-del-btn').forEach(b => b.addEventListener('click', () => {
            if (!confirm(`Удалить workspace "${b.dataset.name}"?`)) return;
            this.remove(b.dataset.name);
            close();
            this.showManager();
        }));
        modal.querySelectorAll('.ws-item').forEach(item => item.addEventListener('dblclick', e => {
            if (e.target.tagName === 'BUTTON') return;
            const name = item.dataset.name;
            if (this.restore(name)) close();
        }));
    },

    _esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); },
};

window.Workspace = Workspace;
