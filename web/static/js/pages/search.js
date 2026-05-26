app.register('search', {
    _files: {},

    async render(root) {
        root.innerHTML = `
        <div class="card">
            <div class="card-header"><span class="card-title">Поиск по коду</span></div>
            <div style="display:flex;flex-direction:column;gap:10px">
                <div style="display:flex;gap:8px">
                    <input type="text" id="search-text" placeholder="Поисковый запрос..." style="flex:1" />
                    <button class="btn btn-primary" id="btn-search">Найти</button>
                </div>
                <label style="display:flex;align-items:center;gap:6px;color:var(--text-2);font-size:13px;cursor:pointer">
                    <input type="checkbox" id="search-regexp" />
                    Регулярное выражение
                </label>
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;color:var(--text-2)">
                    <span>Диапазон строк:</span>
                    <input type="text" id="search-from" placeholder="от" style="width:70px;padding:5px 10px" />
                    <span>—</span>
                    <input type="text" id="search-to" placeholder="до" style="width:70px;padding:5px 10px" />
                    <span>в файле</span>
                    <select id="search-file" style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);padding:6px 10px;font-size:13px;outline:none;max-width:260px">
                        <option value="-1">Все файлы</option>
                    </select>
                </div>
                <div style="border-top:1px solid var(--border);padding-top:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;color:var(--text-2)">
                    <span>Получить строку напрямую:</span>
                    <select id="line-file" style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);padding:6px 10px;font-size:13px;outline:none;max-width:260px">
                    </select>
                    <input type="text" id="line-number" placeholder="Номер строки" style="width:120px;padding:5px 10px" />
                    <button class="btn btn-ghost btn-sm" id="btn-get-line">Получить код</button>
                </div>
            </div>
        </div>

        <div id="results-wrap" class="card hidden" style="padding:0;overflow:hidden">
            <div style="display:flex;align-items:center;gap:10px;padding:14px 20px;border-bottom:1px solid var(--border)">
                <span class="card-title" style="margin:0">Результаты</span>
                <span id="search-count" style="color:var(--text-2);font-size:13px"></span>
            </div>
            <div id="search-results" style="padding:8px 0"></div>
        </div>

        <div id="preview-card" class="card hidden">
            <div class="card-header">
                <span class="card-title" id="preview-title">Просмотр строки</span>
                <button class="btn btn-ghost btn-sm" id="btn-preview-close">✕</button>
            </div>
            <pre id="preview-code" style="font-family:var(--mono);font-size:13px;line-height:1.7;color:#C8D3F5;white-space:pre-wrap;word-break:break-all;max-height:400px;overflow-y:auto;background:#0D0D0F;padding:14px;border-radius:var(--radius-sm)"></pre>
        </div>`;

        try {
            const data = await API.get('/api/files');
            this._files = data.files;
            const sel  = document.getElementById('search-file');
            const sel2 = document.getElementById('line-file');
            Object.entries(data.files).forEach(([id, f]) => {
                const mk = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; return o; };
                sel.appendChild(mk(id, f.fullPath));
                sel2.appendChild(mk(id, f.fullPath));
            });
        } catch {}

        document.getElementById('btn-search').addEventListener('click', () => this._search());
        document.getElementById('search-text').addEventListener('keydown', e => { if (e.key === 'Enter') this._search(); });
        document.getElementById('btn-get-line').addEventListener('click', () => this._getLine());
        document.getElementById('btn-preview-close').addEventListener('click', () => {
            document.getElementById('preview-card').classList.add('hidden');
        });
    },

    // ── Поиск ────────────────────────────────────────────────────────
    async _search() {
        const text = document.getElementById('search-text').value.trim();
        if (!text) return;

        const btn = document.getElementById('btn-search');
        btn.disabled = true; btn.textContent = '⏳ Поиск...';

        const wrap = document.getElementById('results-wrap');
        const el   = document.getElementById('search-results');
        wrap.classList.remove('hidden');
        el.innerHTML = '<div style="padding:20px;color:var(--text-2);font-size:13px;text-align:center">Выполняется поиск...</div>';
        document.getElementById('search-count').textContent = '';

        try {
            const res = await API.post('/api/search', {
                text,
                file: document.getElementById('search-file').value,
                regexp: document.getElementById('search-regexp').checked,
                start_line: document.getElementById('search-from').value.trim(),
                end_line:   document.getElementById('search-to').value.trim(),
            });
            this._renderResults(res.result, el);
        } catch (e) {
            el.innerHTML = `<div style="padding:20px;color:var(--red);font-size:13px">${e.message}</div>`;
        } finally {
            btn.disabled = false; btn.textContent = 'Найти';
        }
    },

    _renderResults(result, el) {
        if (!result || result === 'too_much') {
            el.innerHTML = '<div style="padding:20px;color:var(--yellow);font-size:13px;text-align:center">Слишком много результатов — уточните запрос</div>';
            return;
        }
        if (result === 'regex_incorrect') {
            el.innerHTML = '<div style="padding:20px;color:var(--red);font-size:13px;text-align:center">Некорректное регулярное выражение</div>';
            return;
        }

        let totalFiles = 0;
        let html = '';
        for (const [fileId, fileData] of Object.entries(result)) {
            if (!fileData || !Object.keys(fileData).length) continue;
            totalFiles++;
            const fileName = this._files[fileId]?.fullPath || `#${fileId}`;
            html += `<div class="sr-file">
                <div class="sr-file-name">${this._esc(fileName)}</div>
                <div class="sr-blocks">${this._renderBlocks(fileId, fileData, [])}</div>
            </div>`;
        }

        if (!html) {
            el.innerHTML = '<div style="padding:20px;color:var(--text-3);font-size:13px;text-align:center">Ничего не найдено</div>';
            return;
        }

        document.getElementById('search-count').textContent = `${totalFiles} файл(ов)`;
        el.innerHTML = html;

        // Клик по заголовку блока — раскрыть/свернуть
        el.querySelectorAll('.sr-block-toggle').forEach(el => {
            el.addEventListener('click', () => {
                const children = el.closest('.sr-block').querySelector('.sr-block-children');
                if (children) children.classList.toggle('hidden');
            });
        });

        el.querySelectorAll('[data-action="preview"]').forEach(b =>
            b.addEventListener('click', () => this._getCode('preview', b.dataset))
        );
        el.querySelectorAll('[data-action="edit"]').forEach(b =>
            b.addEventListener('click', () => this._getCode('edit', b.dataset))
        );
    },

    _renderBlocks(fileId, blocks, parentPath) {
        const sorted = Object.keys(blocks).sort((a, b) => parseInt(a) - parseInt(b));
        let html = '';

        for (let i = 0; i < sorted.length; i++) {
            const id    = sorted[i];
            const block = blocks[id];
            const path  = [...parentPath, parseInt(id)];
            const pathStr = JSON.stringify(path);

            if (block.children) {
                // Раскрываемый блок кода
                html += `<div class="sr-block">
                    <div class="sr-block-row">
                        <span class="sr-block-toggle sr-expandable">
                            <span class="sr-id">[${id}]</span>
                            <span class="sr-type">[Блок кода]</span>
                            ${block.name ? `<span class="sr-name">${this._esc(block.name)}</span>` : ''}
                            <span class="sr-lines">[Строк: ${block.lines}]</span>
                        </span>
                        <button class="btn btn-ghost btn-sm" data-action="edit"
                            data-file="${fileId}" data-path='${pathStr}' data-name="${this._esc(block.name||'')}">
                            Получить код
                        </button>
                    </div>
                    <div class="sr-block-children hidden">
                        <div class="sr-brace">{</div>
                        ${this._renderBlocks(fileId, block.children, path)}
                        <div class="sr-brace">}</div>
                    </div>
                </div>`;
            } else {
                // Листовой элемент
                let label = '';
                if (block.type === 'function_call') label = `[Вызов функции] ${this._esc(block.name||'')}`;
                else if (block.type === 'text')     label = `[Текст] ${this._esc(block.name||'')}`;
                else if (block.type === 'other')    label = `[Прочее] ${this._esc(block.name||'')}`;
                else                                label = this._esc(block.name||'');

                const hasPreview = block.type !== 'condition';

                html += `<div class="sr-block">
                    <div class="sr-block-row">
                        <span class="sr-leaf" id="sr-leaf-${fileId}-${id}">
                            <span class="sr-id">[${id}]</span>
                            ${label}
                        </span>
                        ${hasPreview ? `<button class="btn btn-ghost btn-sm" data-action="preview"
                            data-file="${fileId}" data-path='${pathStr}' data-name="${this._esc(block.name||'')}"
                            data-leaf-id="sr-leaf-${fileId}-${id}">
                            Посмотреть
                        </button>` : ''}
                        <button class="btn btn-ghost btn-sm" data-action="edit"
                            data-file="${fileId}" data-path='${pathStr}' data-name="${this._esc(block.name||'')}">
                            Получить код
                        </button>
                    </div>
                </div>`;
            }

            // Разрыв нумерации
            if (i < sorted.length - 1 && parseInt(sorted[i+1]) - parseInt(id) > 1) {
                html += `<div class="sr-gap">...</div>`;
            }
        }
        return html;
    },

    // ── Получить строку по номеру ─────────────────────────────────────
    async _getLine() {
        const fileId = document.getElementById('line-file').value;
        const line   = document.getElementById('line-number').value.trim();
        if (!line) return;
        const btn = document.getElementById('btn-get-line');
        btn.disabled = true; btn.textContent = 'Запрос...';
        try {
            await API.post('/api/get_line', { file_id: fileId, line });
            btn.textContent = 'Отправлено';
            setTimeout(() => { btn.disabled = false; btn.textContent = 'Получить код'; }, 3000);
        } catch (e) {
            alert('Ошибка: ' + e.message);
            btn.disabled = false; btn.textContent = 'Получить код';
        }
    },

    // ── get_code ──────────────────────────────────────────────────────
    async _getCode(type, dataset) {
        const fileId  = dataset.file;
        const path    = JSON.parse(dataset.path);
        const name    = dataset.name || '';
        const leafId  = dataset.leafId;
        const btn     = document.querySelector(`[data-action="${type}"][data-file="${fileId}"][data-path='${JSON.stringify(path)}']`);

        if (btn) { btn.disabled = true; btn.textContent = '⏳'; }

        try {
            const res    = await API.post('/api/code/get', { type, file_id: fileId, code_path: path, query_name: name });
            const result = res.result;

            if (type === 'preview') {
                if (result === 'overlimit') { alert('Превышен лимит просмотра. Попробуйте позже.'); return; }
                // Обновляем текст листа inline
                if (leafId && result?.code !== undefined) {
                    const leafEl = document.getElementById(leafId);
                    if (leafEl) leafEl.innerHTML = `<span class="sr-id">[${result.line ?? ''}]</span> ${this._esc(result.code ?? result)}`;
                }
                // Показываем в карточке
                const card = document.getElementById('preview-card');
                document.getElementById('preview-title').textContent = name || 'Просмотр';
                document.getElementById('preview-code').textContent =
                    typeof result === 'string' ? result : (result?.code ?? JSON.stringify(result));
                card.classList.remove('hidden');
                card.scrollIntoView({ behavior: 'smooth' });
            } else {
                if (result === 'access') alert('✅ Доступ разрешён. Откройте файл во вкладке "Файлы".');
                else alert('⏳ Запрос направлен модераторам. Ожидайте рассмотрения.');
            }
        } catch (e) {
            alert('Ошибка: ' + e.message);
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = type === 'preview' ? 'Посмотреть' : 'Получить код'; }
        }
    },

    _esc(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    },
});
