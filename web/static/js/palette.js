// ── Command Palette (Ctrl+Shift+P) ──────────────────────────────

const Palette = {
    _commands: [],
    _el: null,
    _selected: 0,
    _filtered: [],

    register(cmd) {
        // cmd: { id, title, icon, hint, group, run, when }
        this._commands.push(cmd);
    },

    open() {
        if (this._el) return;
        const overlay = document.createElement('div');
        overlay.id = 'palette-overlay';
        overlay.innerHTML = `
        <div id="palette" role="dialog" aria-modal="true">
            <div class="palette-input-wrap">
                <span class="palette-icon">⌘</span>
                <input id="palette-input" type="text" placeholder="Введите команду или файл..." autocomplete="off" />
                <span class="palette-hint">Esc · ↑↓ · Enter</span>
            </div>
            <div id="palette-list"></div>
        </div>`;
        document.body.appendChild(overlay);
        this._el = overlay;

        const input = document.getElementById('palette-input');
        this._selected = 0;
        this._renderList('');

        input.addEventListener('input', e => { this._selected = 0; this._renderList(e.target.value); });
        input.addEventListener('keydown', e => this._onKey(e));
        overlay.addEventListener('click', e => { if (e.target === overlay) this.close(); });
        setTimeout(() => input.focus(), 30);
    },

    close() {
        this._el?.remove();
        this._el = null;
    },

    _score(text, query) {
        if (!query) return 1;
        text = text.toLowerCase();
        query = query.toLowerCase();
        if (text === query) return 1000;
        if (text.startsWith(query)) return 500;
        if (text.includes(query)) return 100;
        // Fuzzy: символы по порядку
        let i = 0, j = 0, score = 0;
        while (i < text.length && j < query.length) {
            if (text[i] === query[j]) { score++; j++; }
            i++;
        }
        return j === query.length ? score : 0;
    },

    _gather() {
        const items = [];
        // Команды
        for (const c of this._commands) {
            if (c.when && !c.when()) continue;
            items.push({ ...c, kind: 'command' });
        }
        // Файлы
        const filesPage = app._pages['files'];
        const files = filesPage?._files || {};
        for (const [id, f] of Object.entries(files)) {
            items.push({
                id: 'file:' + id,
                title: f.fullPath,
                icon: '📄',
                group: 'Файлы',
                kind: 'file',
                run: () => {
                    app.navigate('files');
                    setTimeout(() => filesPage._openFile(id), 100);
                },
            });
        }
        return items;
    },

    _renderList(query) {
        const list = document.getElementById('palette-list');
        if (!list) return;
        const items = this._gather();
        const q = query.trim();

        let scored = items.map(it => ({ it, s: this._score(it.title, q) })).filter(x => x.s > 0);
        scored.sort((a, b) => b.s - a.s);
        this._filtered = scored.slice(0, 30).map(x => x.it);

        if (!this._filtered.length) {
            list.innerHTML = '<div class="palette-empty">Ничего не найдено</div>';
            return;
        }

        list.innerHTML = this._filtered.map((it, i) => `
            <div class="palette-item ${i === this._selected ? 'active' : ''}" data-idx="${i}">
                <span class="palette-item-icon">${it.icon || '•'}</span>
                <span class="palette-item-title">${this._highlight(it.title, q)}</span>
                ${it.group ? `<span class="palette-item-group">${it.group}</span>` : ''}
                ${it.hint ? `<span class="palette-item-hint">${it.hint}</span>` : ''}
            </div>`).join('');

        list.querySelectorAll('.palette-item').forEach(el => {
            el.addEventListener('click', () => {
                this._selected = parseInt(el.dataset.idx);
                this._run();
            });
            el.addEventListener('mouseover', () => {
                this._selected = parseInt(el.dataset.idx);
                this._updateActive();
            });
        });
        this._scrollIntoView();
    },

    _highlight(text, q) {
        if (!q) return this._esc(text);
        const safe = this._esc(text);
        const safeQ = this._esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return safe.replace(new RegExp(safeQ, 'gi'), m => `<mark class="palette-hl">${m}</mark>`);
    },

    _esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); },

    _updateActive() {
        const list = document.getElementById('palette-list');
        list?.querySelectorAll('.palette-item').forEach((el, i) => {
            el.classList.toggle('active', i === this._selected);
        });
        this._scrollIntoView();
    },

    _scrollIntoView() {
        const list = document.getElementById('palette-list');
        const active = list?.querySelector('.palette-item.active');
        active?.scrollIntoView({ block: 'nearest' });
    },

    _onKey(e) {
        if (e.key === 'Escape') { this.close(); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); this._selected = Math.min(this._selected + 1, this._filtered.length - 1); this._updateActive(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); this._selected = Math.max(this._selected - 1, 0); this._updateActive(); }
        else if (e.key === 'Enter') { e.preventDefault(); this._run(); }
    },

    _run() {
        const cmd = this._filtered[this._selected];
        if (!cmd) return;
        this.close();
        try { cmd.run(); } catch (e) { app.toast('Ошибка: ' + e.message, 'error'); }
    },
};

window.Palette = Palette;

// Глобальные горячие клавиши:
//   Ctrl+Shift+P — палитра команд + файлов
//   Ctrl+P       — то же самое (привычка по VS Code, quick-open файла)
document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p' && !e.altKey) {
        // Если фокус в input/textarea/contenteditable — пропускаем,
        // не перехватываем системные шорткаты пользователя (печать).
        const tag = (e.target?.tagName || '').toLowerCase();
        const editable = tag === 'input' || tag === 'textarea' || e.target?.isContentEditable;
        if (editable && !e.shiftKey) return;
        e.preventDefault();
        Palette.open();
    }
});
