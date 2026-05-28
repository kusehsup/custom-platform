// ── Draggable/resizable widget system ────────────────────────────────

const Widgets = {
    _instances: {},

    _loadPos(id) {
        try { return JSON.parse(localStorage.getItem('widget_' + id) || 'null'); } catch { return null; }
    },
    _savePos(id, data) {
        try { localStorage.setItem('widget_' + id, JSON.stringify(data)); } catch {}
    },

    create({ id, title, content, width = 340, height = 300, defaultPos }) {
        const existing = document.getElementById(id);
        if (existing) { existing.style.display = existing.style.display === 'none' ? 'flex' : 'none'; return existing; }

        const saved = this._loadPos(id);
        const pos   = saved || defaultPos || { right: 24, bottom: 80 };
        const opacity = saved?.opacity ?? 0.95;
        const w = saved?.width  || width;
        const h = saved?.height || height;

        const el = document.createElement('div');
        el.id = id;
        el.className = 'widget';
        el.style.cssText = `width:${w}px;height:${h}px;opacity:${opacity};`;
        if (saved?.left !== undefined) { el.style.left = saved.left + 'px'; el.style.top  = saved.top  + 'px'; }
        else { el.style.right = (pos.right ?? 24) + 'px'; el.style.bottom = (pos.bottom ?? 80) + 'px'; }

        el.innerHTML = `
        <div class="widget-header" data-drag="${id}">
            <span class="widget-title">${title}</span>
            <div class="widget-controls">
                <input type="range" class="widget-opacity" min="20" max="100" value="${Math.round(opacity * 100)}" title="Прозрачность" />
                <button class="widget-close">✕</button>
            </div>
        </div>
        <div class="widget-body">${content}</div>
        <div class="widget-resize"></div>`;

        document.body.appendChild(el);
        this._instances[id] = el;

        // Закрытие
        el.querySelector('.widget-close').addEventListener('click', () => {
            el.style.display = 'none';
        });

        // Прозрачность
        el.querySelector('.widget-opacity').addEventListener('input', e => {
            const v = e.target.value / 100;
            el.style.opacity = v;
            this._persistPos(id, el, v);
        });

        // Drag
        this._makeDraggable(el, el.querySelector('[data-drag]'), id);

        // Resize
        this._makeResizable(el, el.querySelector('.widget-resize'), id);

        return el;
    },

    _makeDraggable(el, handle, id) {
        let ox, oy, startX, startY;
        handle.addEventListener('mousedown', e => {
            if (e.target.closest('.widget-controls')) return;
            e.preventDefault();
            // Конвертируем right/bottom в left/top для перетаскивания
            const rect = el.getBoundingClientRect();
            el.style.left   = rect.left + 'px';
            el.style.top    = rect.top  + 'px';
            el.style.right  = 'auto';
            el.style.bottom = 'auto';
            startX = e.clientX - rect.left;
            startY = e.clientY - rect.top;

            const move = e => {
                el.style.left = Math.max(0, e.clientX - startX) + 'px';
                el.style.top  = Math.max(0, e.clientY - startY) + 'px';
            };
            const up = () => {
                document.removeEventListener('mousemove', move);
                document.removeEventListener('mouseup', up);
                this._persistPos(id, el);
            };
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up);
        });
    },

    _makeResizable(el, handle, id) {
        handle.addEventListener('mousedown', e => {
            e.preventDefault();
            const startX = e.clientX, startY = e.clientY;
            const startW = el.offsetWidth, startH = el.offsetHeight;
            const move = e => {
                el.style.width  = Math.max(240, startW + e.clientX - startX) + 'px';
                el.style.height = Math.max(150, startH + e.clientY - startY) + 'px';
            };
            const up = () => {
                document.removeEventListener('mousemove', move);
                document.removeEventListener('mouseup', up);
                this._persistPos(id, el);
            };
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up);
        });
    },

    _persistPos(id, el, opacity) {
        const rect = el.getBoundingClientRect();
        this._savePos(id, {
            left: rect.left, top: rect.top,
            width: el.offsetWidth, height: el.offsetHeight,
            opacity: opacity ?? parseFloat(el.style.opacity) ?? 0.95,
        });
    },

    toggle(id) {
        const el = document.getElementById(id);
        if (el) el.style.display = el.style.display === 'none' ? 'flex' : 'none';
    },
};
