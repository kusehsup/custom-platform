// ── Заметки (markdown + публичный шаринг) ────────────────────────
//
// Минималистичная альтернатива outline.com: список заметок слева,
// split editor/preview справа. Каждая заметка — markdown в JSON-store
// на бэке. По кнопке «Поделиться» открывается публичная read-only
// ссылка /n/<token>.

const NotesPage = {
    _items: [],           // [{id, title, share_enabled, share_token, updated_at}]
    _activeId: null,
    _active: null,        // {id, title, body, ...}
    _dirty: false,
    _saveTimer: null,
    _saveDelay: 700,
    _previewMode: 'split',  // 'edit' | 'preview' | 'split'

    async render(el) {
        el.innerHTML = `
        <div class="notes">
            <aside class="notes-sidebar">
                <div class="notes-side-head">
                    <button class="btn btn-primary btn-sm" id="notes-new">+ Новая</button>
                    <input id="notes-search" type="search" placeholder="Поиск…" autocomplete="off" />
                </div>
                <div id="notes-list" class="notes-list">
                    <div class="notes-empty">Загрузка…</div>
                </div>
            </aside>
            <main class="notes-main">
                <div id="notes-editor" class="notes-editor">
                    <div class="notes-blank">← Выбери или создай заметку</div>
                </div>
            </main>
        </div>`;

        document.getElementById('notes-new').addEventListener('click', () => this._create());
        document.getElementById('notes-search').addEventListener('input', (e) => {
            this._filter = (e.target.value || '').toLowerCase().trim();
            this._renderList();
        });

        await this._loadList();
    },

    abort() {
        // При уходе со страницы — принудительно сохранить если есть несохранённое
        if (this._dirty) this._save(true);
        if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    },

    // ── Список ───────────────────────────────────────────────────

    async _loadList() {
        try {
            const data = await API.get('/api/notes');
            this._items = data.items || [];
            this._renderList();
            // Если есть активная — обновим её title в списке, если изменился
        } catch (e) {
            const list = document.getElementById('notes-list');
            if (list) list.innerHTML = `<div class="notes-err">Не удалось: ${this._esc(e.message)}</div>`;
        }
    },

    _renderList() {
        const list = document.getElementById('notes-list');
        if (!list) return;
        const filter = this._filter || '';
        const items = filter
            ? this._items.filter((n) => (n.title || '').toLowerCase().includes(filter))
            : this._items;
        if (!items.length) {
            list.innerHTML = `<div class="notes-empty">${filter ? 'Ничего не найдено' : 'Пока пусто. Нажми «Новая».'}</div>`;
            return;
        }
        list.innerHTML = items.map((n) => {
            const active = n.id === this._activeId ? ' active' : '';
            const shared = n.share_enabled ? '<span class="notes-shared" title="Доступна по ссылке">🔗</span>' : '';
            return `
            <div class="notes-item${active}" data-id="${this._esc(n.id)}">
                <div class="notes-item-title">${this._esc(n.title || 'Без названия')}</div>
                <div class="notes-item-meta">
                    <span>${this._formatDate(n.updated_at)}</span>
                    ${shared}
                </div>
            </div>`;
        }).join('');
        list.querySelectorAll('.notes-item').forEach((node) =>
            node.addEventListener('click', () => this._open(node.dataset.id)),
        );
    },

    // ── CRUD ─────────────────────────────────────────────────────

    async _create() {
        try {
            const note = await API.post('/api/notes', {title: 'Новая заметка', body: ''});
            await this._loadList();
            this._open(note.id);
        } catch (e) { app.toast(e.message, 'error'); }
    },

    async _open(id) {
        if (this._dirty) await this._save(true);
        try {
            this._active = await API.get(`/api/notes/${encodeURIComponent(id)}`);
            this._activeId = id;
            this._dirty = false;
            this._renderList();
            this._renderEditor();
            // Auto-workspace: запоминаем активную заметку.
            if (typeof Session !== 'undefined' && !Session.isSuspended()) {
                Session.setNotes({ noteId: id });
            }
        } catch (e) { app.toast(e.message, 'error'); }
    },

    async _deleteActive() {
        if (!this._active) return;
        if (!confirm(`Удалить заметку «${this._active.title}»?`)) return;
        try {
            await API.delete(`/api/notes/${encodeURIComponent(this._active.id)}`);
            this._activeId = null;
            this._active = null;
            this._dirty = false;
            await this._loadList();
            this._renderEditor();
            app.toast('Заметка удалена', 'success');
        } catch (e) { app.toast(e.message, 'error'); }
    },

    _scheduleSave() {
        this._dirty = true;
        this._updateSaveStatus('Изменения не сохранены…');
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this._save(false), this._saveDelay);
    },

    async _save(force) {
        if (!this._active || !this._dirty) return;
        this._saveTimer = null;
        const title = document.getElementById('notes-title')?.value ?? this._active.title;
        const body = document.getElementById('notes-body')?.value ?? this._active.body;
        const kind = this._active.kind || 'markdown';
        try {
            this._updateSaveStatus('Сохранение…');
            const updated = await API.put(`/api/notes/${encodeURIComponent(this._active.id)}`,
                {title, body, kind});
            this._active = updated;
            this._dirty = false;
            this._updateSaveStatus('✓ Сохранено');
            // Обновим список (там title и updated_at)
            const idx = this._items.findIndex((x) => x.id === updated.id);
            if (idx >= 0) {
                this._items[idx] = {
                    id: updated.id,
                    title: updated.title,
                    share_enabled: updated.share_enabled,
                    share_token: updated.share_token,
                    updated_at: updated.updated_at,
                    created_at: updated.created_at,
                };
                this._renderList();
            }
        } catch (e) {
            this._updateSaveStatus('✗ Ошибка: ' + e.message);
            if (force) throw e;
        }
    },

    _updateSaveStatus(text) {
        const el = document.getElementById('notes-save-status');
        if (el) el.textContent = text;
    },

    // ── Редактор ─────────────────────────────────────────────────

    _renderEditor() {
        const root = document.getElementById('notes-editor');
        if (!root) return;
        if (!this._active) {
            root.innerHTML = `<div class="notes-blank">← Выбери или создай заметку</div>`;
            return;
        }
        const n = this._active;
        const kind = n.kind || 'markdown';
        const modeBtn = (m, label) =>
            `<button class="notes-mode-btn${this._previewMode === m ? ' active' : ''}" data-mode="${m}">${label}</button>`;
        const kindBtn = (k, label) =>
            `<button class="notes-mode-btn${kind === k ? ' active' : ''}" data-kind="${k}">${label}</button>`;
        const placeholder = kind === 'html'
            ? '<!doctype html>&#10;<html>&#10;  <body>…</body>&#10;</html>'
            : '# Заголовок&#10;&#10;Текст заметки в markdown…';

        root.innerHTML = `
        <div class="notes-toolbar">
            <input id="notes-title" class="notes-title-input" value="${this._esc(n.title)}" placeholder="Название" />
            <div class="notes-modes" title="Тип контента">
                ${kindBtn('markdown', 'MD')}
                ${kindBtn('html', 'HTML')}
            </div>
            <div class="notes-modes">
                ${modeBtn('edit', 'Редактор')}
                ${modeBtn('split', 'Split')}
                ${modeBtn('preview', 'Preview')}
            </div>
            ${kind === 'html'
                ? `<button class="btn btn-ghost btn-sm" id="notes-upload-btn" title="Загрузить .html файл">📤 .html</button>
                   <input type="file" id="notes-upload-input" accept=".html,.htm,text/html" style="display:none" />`
                : ''}
            <button class="btn btn-ghost btn-sm" id="notes-share-btn" title="Поделиться">📤 Поделиться</button>
            <button class="btn btn-ghost btn-sm" id="notes-delete-btn" title="Удалить заметку">🗑</button>
        </div>
        <div class="notes-status">
            <span id="notes-save-status" class="notes-save-status">✓ Сохранено</span>
            <span class="notes-meta">обновлено: ${this._formatDate(n.updated_at)}</span>
        </div>
        <div class="notes-panes notes-panes-${this._previewMode}">
            <textarea id="notes-body" class="notes-body" spellcheck="false"
                placeholder="${placeholder}">${this._esc(n.body)}</textarea>
            <div id="notes-preview" class="notes-preview${kind === 'html' ? ' notes-preview-html' : ''}"></div>
        </div>`;

        const titleInp = document.getElementById('notes-title');
        const bodyInp = document.getElementById('notes-body');
        titleInp.addEventListener('input', () => this._scheduleSave());
        bodyInp.addEventListener('input', () => {
            this._scheduleSave();
            this._renderPreview();
        });
        // Tab → две пробельных пары в textarea
        bodyInp.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
                e.preventDefault();
                const start = bodyInp.selectionStart;
                const end = bodyInp.selectionEnd;
                bodyInp.value = bodyInp.value.slice(0, start) + '  ' + bodyInp.value.slice(end);
                bodyInp.selectionStart = bodyInp.selectionEnd = start + 2;
                this._scheduleSave();
                this._renderPreview();
            }
        });

        document.getElementById('notes-share-btn').addEventListener('click', () => this._showShareModal());
        document.getElementById('notes-delete-btn').addEventListener('click', () => this._deleteActive());
        root.querySelectorAll('.notes-mode-btn').forEach((b) =>
            b.addEventListener('click', () => {
                if (b.dataset.kind) {
                    if (this._active && this._active.kind !== b.dataset.kind) {
                        this._active.kind = b.dataset.kind;
                        this._scheduleSave();
                        this._renderEditor();
                    }
                    return;
                }
                if (b.dataset.mode) {
                    this._previewMode = b.dataset.mode;
                    this._renderEditor();
                }
            }),
        );

        // Загрузка .html файла
        const uploadBtn = document.getElementById('notes-upload-btn');
        const uploadInp = document.getElementById('notes-upload-input');
        if (uploadBtn && uploadInp) {
            uploadBtn.addEventListener('click', () => uploadInp.click());
            uploadInp.addEventListener('change', async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (file.size > 1024 * 1024) {
                    app.toast(`Файл слишком большой: ${(file.size/1024).toFixed(1)} КБ > 1024 КБ`, 'error');
                    uploadInp.value = '';
                    return;
                }
                try {
                    const text = await file.text();
                    const ta = document.getElementById('notes-body');
                    if (ta) {
                        ta.value = text;
                        this._scheduleSave();
                        this._renderPreview();
                    }
                    // Если у заметки нет нормального названия — подставим имя файла
                    if (!this._active.title || this._active.title === 'Без названия' || this._active.title === 'Новая заметка') {
                        const titleInp2 = document.getElementById('notes-title');
                        const nameOnly = file.name.replace(/\.html?$/i, '');
                        if (titleInp2) {
                            titleInp2.value = nameOnly;
                            this._scheduleSave();
                        }
                    }
                    app.toast(`Загружен: ${file.name}`, 'success');
                } catch (err) {
                    app.toast(`Не удалось прочитать файл: ${err.message}`, 'error');
                } finally {
                    uploadInp.value = '';
                }
            });
        }

        this._renderPreview();
    },

    _renderPreview() {
        const el = document.getElementById('notes-preview');
        if (!el) return;
        const body = document.getElementById('notes-body')?.value || '';
        const kind = this._active?.kind || 'markdown';

        if (kind === 'html') {
            // Песочница: allow-scripts даёт JS работать (графики, фильтры),
            // НО без allow-same-origin — никакого доступа к нашему cookie /
            // localStorage / DOM родительской страницы. Это и есть защита.
            el.innerHTML = '';
            const iframe = document.createElement('iframe');
            iframe.className = 'notes-preview-iframe';
            iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups');
            iframe.srcdoc = body;
            el.appendChild(iframe);
            return;
        }

        el.innerHTML = NotesMd.render(body);
        // Делаем чекбоксы кликабельными — toggle строки в исходном markdown
        el.querySelectorAll('input[type="checkbox"][data-task-idx]').forEach((cb) =>
            cb.addEventListener('change', (e) => this._toggleTask(parseInt(e.target.dataset.taskIdx, 10), e.target.checked)),
        );
    },

    _toggleTask(idx, checked) {
        const ta = document.getElementById('notes-body');
        if (!ta) return;
        const lines = ta.value.split('\n');
        let n = 0;
        // Тот же regex, что и в renderer'е: [-*+] для ul, либо "1." для ol,
        // следом "[ ]" / "[x]" / "[X]"
        const re = /^(\s*(?:[-*+]|\d+\.)\s+)\[( |x|X)\](\s+.*)$/;
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(re);
            if (!m) continue;
            if (n === idx) {
                lines[i] = `${m[1]}[${checked ? 'x' : ' '}]${m[3]}`;
                ta.value = lines.join('\n');
                this._scheduleSave();
                // Перерисуем превью, чтобы расставленный/снятый чек сохранился
                // визуально и индексы остались синхронны.
                this._renderPreview();
                return;
            }
            n++;
        }
    },

    // ── Share modal ──────────────────────────────────────────────

    async _showShareModal() {
        if (!this._active) return;
        // Перечитаем актуальное состояние шары
        try {
            this._active = await API.get(`/api/notes/${encodeURIComponent(this._active.id)}`);
        } catch {}
        const n = this._active;
        const url = n.share_token
            ? `${location.origin}/n/${n.share_token}`
            : '';
        const enabled = !!n.share_enabled;

        // Простая модалка
        const overlay = document.createElement('div');
        overlay.className = 'notes-modal-overlay';
        overlay.innerHTML = `
        <div class="notes-modal">
            <div class="notes-modal-head">
                <span>Поделиться заметкой</span>
                <button class="notes-modal-close">✕</button>
            </div>
            <div class="notes-modal-body">
                <label class="notes-share-toggle">
                    <input type="checkbox" id="notes-share-on" ${enabled ? 'checked' : ''} />
                    <span>Доступ по публичной ссылке</span>
                </label>
                <div class="notes-share-url-wrap ${enabled ? '' : 'dim'}">
                    <input type="text" id="notes-share-url" class="notes-share-url" readonly value="${this._esc(url)}" />
                    <button class="btn btn-ghost btn-sm" id="notes-share-copy" ${enabled ? '' : 'disabled'}>Копировать</button>
                </div>
                <div class="notes-share-actions">
                    <button class="btn btn-ghost btn-sm" id="notes-share-regen" ${enabled ? '' : 'disabled'}>Пересоздать ссылку</button>
                </div>
                <div class="notes-share-hint">
                    ${enabled
                        ? 'Любой с этой ссылкой видит read-only превью. Пересоздание ссылки сломает старые URL.'
                        : 'Включи доступ, чтобы получить публичную ссылку. Заметка останется read-only.'}
                </div>
            </div>
        </div>`;
        document.body.appendChild(overlay);

        const close = () => overlay.remove();
        overlay.querySelector('.notes-modal-close').addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

        overlay.querySelector('#notes-share-on').addEventListener('change', async (e) => {
            try {
                const updated = await API.post(
                    `/api/notes/${encodeURIComponent(this._active.id)}/share`,
                    {enabled: e.target.checked},
                );
                this._active = updated;
                close();
                this._showShareModal();
                // обновим список (иконка шары)
                this._loadList();
            } catch (err) { app.toast(err.message, 'error'); }
        });

        overlay.querySelector('#notes-share-copy')?.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(url);
                app.toast('Ссылка скопирована', 'success');
            } catch {
                app.toast('Не удалось скопировать', 'error');
            }
        });

        overlay.querySelector('#notes-share-regen')?.addEventListener('click', async () => {
            if (!confirm('Пересоздать публичную ссылку? Старая перестанет работать.')) return;
            try {
                const updated = await API.post(
                    `/api/notes/${encodeURIComponent(this._active.id)}/share/regenerate`, {});
                this._active = updated;
                close();
                this._showShareModal();
                app.toast('Ссылка пересоздана', 'success');
            } catch (err) { app.toast(err.message, 'error'); }
        });
    },

    // ── helpers ──────────────────────────────────────────────────

    _formatDate(iso) {
        if (!iso) return '';
        try {
            const d = new Date(iso);
            return d.toLocaleString('ru-RU', {
                month: 'short', day: 'numeric',
                hour: '2-digit', minute: '2-digit',
            });
        } catch { return iso; }
    },

    _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    },
};

// ── Markdown рендер (тот же что в public_note.html) ──────────────
const NotesMd = {
    _escape(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    },
    _inline(s) {
        const codes = [];
        s = s.replace(/`([^`]+)`/g, (_, c) => {
            codes.push(c);
            return `\x00${codes.length - 1}\x00`;
        });
        s = this._escape(s);
        s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g,
            (_, alt, url) => `<img src="${url}" alt="${alt}" />`);
        s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
            (_, t, u) => `<a href="${u}" target="_blank" rel="noopener nofollow">${t}</a>`);
        s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
        s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
        s = s.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
        s = s.replace(/\x00(\d+)\x00/g, (_, i) =>
            `<code>${this._escape(codes[+i])}</code>`);
        return s;
    },
    render(md) {
        const lines = String(md || '').split('\n');
        const out = [];
        let i = 0;
        let listType = null;
        let taskIdx = 0;   // порядковый номер чекбокса в превью — нужен для toggle
        const flushList = () => {
            if (listType) { out.push(listType === 'ol' ? '</ol>' : '</ul>'); listType = null; }
        };

        while (i < lines.length) {
            let line = lines[i];

            if (/^```/.test(line)) {
                flushList();
                const lang = line.replace(/^```/, '').trim();
                const buf = [];
                i++;
                while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
                i++;
                out.push(`<pre><code class="lang-${this._escape(lang)}">${this._escape(buf.join('\n'))}</code></pre>`);
                continue;
            }
            if (/^(---+|\*\*\*+|___+)\s*$/.test(line)) { flushList(); out.push('<hr />'); i++; continue; }
            const h = line.match(/^(#{1,6})\s+(.*)$/);
            if (h) {
                flushList();
                out.push(`<h${h[1].length}>${this._inline(h[2])}</h${h[1].length}>`);
                i++; continue;
            }
            if (/^>\s?/.test(line)) {
                flushList();
                const buf = [];
                while (i < lines.length && /^>\s?/.test(lines[i])) {
                    buf.push(lines[i].replace(/^>\s?/, ''));
                    i++;
                }
                out.push(`<blockquote>${this._inline(buf.join(' '))}</blockquote>`);
                continue;
            }
            const ul = line.match(/^[-*+]\s+(.*)$/);
            const ol = line.match(/^(\d+)\.\s+(.*)$/);
            if (ul || ol) {
                const t = ol ? 'ol' : 'ul';
                if (listType !== t) { flushList(); out.push(t === 'ol' ? '<ol>' : '<ul>'); listType = t; }
                let text = ul ? ul[1] : ol[2];
                const cb = text.match(/^\[( |x|X)\]\s+(.*)$/);
                if (cb) {
                    const checked = /x/i.test(cb[1]) ? ' checked' : '';
                    text = `<input type="checkbox"${checked} data-task-idx="${taskIdx}" /> ${this._inline(cb[2])}`;
                    taskIdx++;
                } else {
                    text = this._inline(text);
                }
                out.push(`<li>${text}</li>`);
                i++; continue;
            }
            if (/^\|/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|?$/.test(lines[i + 1])) {
                flushList();
                const head = line.split('|').slice(1, -1).map((c) => c.trim());
                i += 2;
                const rows = [];
                while (i < lines.length && /^\|/.test(lines[i])) {
                    rows.push(lines[i].split('|').slice(1, -1).map((c) => c.trim()));
                    i++;
                }
                let html = '<table><thead><tr>' +
                    head.map((c) => `<th>${this._inline(c)}</th>`).join('') +
                    '</tr></thead><tbody>';
                for (const r of rows) {
                    html += '<tr>' + r.map((c) => `<td>${this._inline(c)}</td>`).join('') + '</tr>';
                }
                html += '</tbody></table>';
                out.push(html);
                continue;
            }
            if (line.trim() === '') { flushList(); i++; continue; }
            flushList();
            const buf = [line];
            i++;
            while (i < lines.length && lines[i].trim() !== ''
                   && !/^(#{1,6}\s|>\s|[-*+]\s|\d+\.\s|```|---|\*\*\*|___|\|)/.test(lines[i])) {
                buf.push(lines[i]);
                i++;
            }
            out.push(`<p>${this._inline(buf.join(' '))}</p>`);
        }
        flushList();
        return out.join('\n');
    },
};

app.register('notes', NotesPage);
