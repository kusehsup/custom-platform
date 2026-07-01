// ── SmartSelect ──────────────────────────────────────────────────────
//
// Кастомная замена <select> с поиском, клавиатурой и тёмной темой.
//
// Как это работает:
//   1. Ищем все <select> в документе (кроме multiple/size>1 и явно
//      помеченных data-no-smart).
//   2. Рядом с оригинальным <select> ставим кнопку-триггер и dropdown.
//      Оригинал скрываем через visually-hidden (нужен для form-events
//      и programmatic .value = ...).
//   3. При изменении в UI — пишем в оригинал и диспатчим 'change'.
//      Существующие onchange-обработчики продолжают работать.
//   4. Наблюдаем через MutationObserver: если <select> добавили или
//      его <option>-ы поменялись — переинициализируем.
//
// На мобильном (<980px) кастом отключается — там нативный picker
// удобнее.

(function () {
    'use strict';

    const MOBILE_BREAKPOINT = 980;
    const MARKER = 'data-smart-select-inited';

    // ── Helpers ─────────────────────────────────────────────────────

    function isMobile() {
        return window.innerWidth < MOBILE_BREAKPOINT;
    }

    function shouldSkip(sel) {
        if (sel.hasAttribute(MARKER)) return true;
        if (sel.multiple) return true;
        if (sel.size && sel.size > 1) return true;
        if (sel.hasAttribute('data-no-smart')) return true;
        // native picker для мобильных
        if (isMobile()) return true;
        return false;
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // ── Match / score ───────────────────────────────────────────────

    function scoreMatch(text, query) {
        if (!query) return 1;
        const t = text.toLowerCase();
        const q = query.toLowerCase();
        if (t === q) return 1000;
        if (t.startsWith(q)) return 500;
        const idx = t.indexOf(q);
        if (idx >= 0) return 300 - idx;
        // Fuzzy — все символы q встречаются по порядку в t
        let ti = 0, qi = 0, hit = 0;
        while (ti < t.length && qi < q.length) {
            if (t[ti] === q[qi]) { hit++; qi++; }
            ti++;
        }
        return qi === q.length ? hit : 0;
    }

    // ── Инициализация одного <select> ───────────────────────────────

    function init(sel) {
        if (shouldSkip(sel)) return;
        sel.setAttribute(MARKER, '1');

        // Обёртка вокруг <select>. Пытаемся аккуратно унаследовать
        // раскладку оригинального селекта:
        //   - inline-width из style
        //   - width: 100% если селект тянулся на 100% через CSS-класс
        //   - flex-грамматику если родитель — flex-контейнер
        const wrap = document.createElement('span');
        wrap.className = 'ss-wrap';
        const cs = window.getComputedStyle(sel);
        if (sel.style.width) {
            wrap.style.width = sel.style.width;
        } else if (cs.width && cs.display !== 'none') {
            const parent = sel.parentElement;
            if (parent) {
                const pcs = window.getComputedStyle(parent);
                if (pcs.display.includes('flex') || pcs.display.includes('grid')) {
                    // В flex/grid — wrapper должен занимать 100% как block
                    wrap.style.width = '100%';
                    wrap.style.display = 'block';
                    if (sel.style.flex)     wrap.style.flex     = sel.style.flex;
                    if (sel.style.flexGrow) wrap.style.flexGrow = sel.style.flexGrow;
                    if (sel.style.minWidth) wrap.style.minWidth = sel.style.minWidth;
                }
            }
        }

        // Кнопка-триггер
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'ss-trigger';
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');

        const label = document.createElement('span');
        label.className = 'ss-label';
        trigger.appendChild(label);

        const caret = document.createElement('span');
        caret.className = 'ss-caret';
        caret.textContent = '▾';
        trigger.appendChild(caret);

        // Popover
        const pop = document.createElement('div');
        pop.className = 'ss-popover';
        pop.setAttribute('role', 'listbox');
        pop.style.display = 'none';

        const searchBox = document.createElement('input');
        searchBox.type = 'text';
        searchBox.className = 'ss-search';
        searchBox.placeholder = 'Поиск...';
        searchBox.autocomplete = 'off';
        searchBox.spellcheck = false;
        pop.appendChild(searchBox);

        const listBox = document.createElement('div');
        listBox.className = 'ss-list';
        pop.appendChild(listBox);

        // Вставляем: <span.ss-wrap> [trigger] [pop] </span> и переносим select внутрь
        sel.parentNode.insertBefore(wrap, sel);
        wrap.appendChild(sel);
        wrap.appendChild(trigger);
        wrap.appendChild(pop);
        sel.classList.add('ss-native');

        // Наследуем disabled
        function syncDisabled() {
            trigger.disabled = sel.disabled;
            trigger.classList.toggle('is-disabled', sel.disabled);
        }
        syncDisabled();

        // ── State ───────────────────────────────────────────────────
        let filter = '';
        let hoverIdx = -1;
        let openMode = false;
        let filtered = [];

        function collectOptions() {
            return Array.from(sel.options).map((o, i) => ({
                el: o,
                value: o.value,
                label: o.textContent || '',
                disabled: o.disabled,
                selected: o.selected,
                idx: i,
            }));
        }

        function currentLabel() {
            const o = sel.options[sel.selectedIndex];
            return o ? (o.textContent || '') : '';
        }

        function refreshLabel() {
            const t = currentLabel();
            if (t) {
                label.textContent = t;
                label.classList.remove('ss-placeholder');
            } else {
                label.textContent = sel.getAttribute('data-placeholder') || 'Выбрать...';
                label.classList.add('ss-placeholder');
            }
        }
        refreshLabel();

        function renderList() {
            const all = collectOptions();
            filtered = all
                .map((o) => ({o, score: scoreMatch(o.label + ' ' + o.value, filter)}))
                .filter((x) => x.score > 0)
                .sort((a, b) => b.score - a.score)
                .map((x) => x.o);

            if (!filtered.length) {
                listBox.innerHTML = '<div class="ss-empty">Ничего не найдено</div>';
                hoverIdx = -1;
                return;
            }

            const html = filtered.map((o, i) => {
                const cls = [
                    'ss-item',
                    o.selected ? 'is-selected' : '',
                    o.disabled ? 'is-disabled' : '',
                    i === hoverIdx ? 'is-hover' : '',
                ].filter(Boolean).join(' ');
                return `<div class="${cls}" data-i="${i}" role="option" aria-selected="${o.selected}">${esc(o.label)}</div>`;
            }).join('');
            listBox.innerHTML = html;
        }

        function highlight(idx) {
            if (idx < 0 || idx >= filtered.length) return;
            hoverIdx = idx;
            const nodes = listBox.querySelectorAll('.ss-item');
            nodes.forEach((n, i) => n.classList.toggle('is-hover', i === idx));
            const node = nodes[idx];
            if (node) {
                const nr = node.getBoundingClientRect();
                const lr = listBox.getBoundingClientRect();
                if (nr.top < lr.top) node.scrollIntoView({block: 'nearest'});
                if (nr.bottom > lr.bottom) node.scrollIntoView({block: 'nearest'});
            }
        }

        function selectOption(opt) {
            if (!opt || opt.disabled) return;
            // Пишем в оригинал + диспатчим change
            sel.value = opt.value;
            sel.dispatchEvent(new Event('input',  {bubbles: true}));
            sel.dispatchEvent(new Event('change', {bubbles: true}));
            refreshLabel();
            close();
        }

        // ── Open / close ────────────────────────────────────────────

        function open() {
            if (openMode || sel.disabled) return;
            openMode = true;
            pop.style.display = 'block';
            trigger.setAttribute('aria-expanded', 'true');
            wrap.classList.add('ss-open');
            filter = '';
            searchBox.value = '';
            hoverIdx = -1;
            renderList();
            // Ставим hover на текущий selected
            const cur = filtered.findIndex((o) => o.selected);
            if (cur >= 0) highlight(cur);
            // Позиция popover — если не влезает вниз, показать сверху
            positionPopover();
            setTimeout(() => searchBox.focus(), 0);
            document.addEventListener('mousedown', onDocDown, true);
            document.addEventListener('keydown', onDocKey, true);
            window.addEventListener('resize', close);
            window.addEventListener('scroll', close, true);
        }

        function close() {
            if (!openMode) return;
            openMode = false;
            pop.style.display = 'none';
            trigger.setAttribute('aria-expanded', 'false');
            wrap.classList.remove('ss-open');
            document.removeEventListener('mousedown', onDocDown, true);
            document.removeEventListener('keydown', onDocKey, true);
            window.removeEventListener('resize', close);
            window.removeEventListener('scroll', close, true);
        }

        function positionPopover() {
            pop.classList.remove('ss-above');
            const tr = trigger.getBoundingClientRect();
            const spaceBelow = window.innerHeight - tr.bottom;
            const spaceAbove = tr.top;
            if (spaceBelow < 220 && spaceAbove > spaceBelow) {
                pop.classList.add('ss-above');
            }
        }

        function onDocDown(e) {
            if (!wrap.contains(e.target)) close();
        }
        function onDocKey(e) {
            // Обрабатываем только когда попап открыт
            if (e.key === 'Escape') { e.preventDefault(); close(); trigger.focus(); return; }
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (!filtered.length) return;
                highlight(Math.min(filtered.length - 1, hoverIdx + 1));
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (!filtered.length) return;
                highlight(Math.max(0, hoverIdx - 1));
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const o = filtered[hoverIdx >= 0 ? hoverIdx : 0];
                if (o) selectOption(o);
            } else if (e.key === 'Home') {
                e.preventDefault(); highlight(0);
            } else if (e.key === 'End') {
                e.preventDefault(); highlight(filtered.length - 1);
            }
        }

        // ── DOM events ──────────────────────────────────────────────

        trigger.addEventListener('click', (e) => {
            e.preventDefault();
            if (openMode) close(); else open();
        });
        trigger.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
                e.preventDefault();
                open();
            }
        });

        searchBox.addEventListener('input', () => {
            filter = searchBox.value;
            hoverIdx = filter ? 0 : -1;
            renderList();
        });

        listBox.addEventListener('mousemove', (e) => {
            const node = e.target.closest('.ss-item');
            if (!node) return;
            const i = parseInt(node.dataset.i, 10);
            if (i !== hoverIdx) highlight(i);
        });
        listBox.addEventListener('click', (e) => {
            const node = e.target.closest('.ss-item');
            if (!node) return;
            const i = parseInt(node.dataset.i, 10);
            const o = filtered[i];
            if (o) selectOption(o);
        });

        // Сохраняем handle чтобы можно было пересобрать при mutation
        sel._ss = {refreshLabel, renderList, syncDisabled, wrap};
    }

    // Полностью удалить наш wrapper (например если атрибут data-no-smart добавили динамически)
    function destroy(sel) {
        if (!sel._ss) return;
        const w = sel._ss.wrap;
        if (!w) return;
        // Возвращаем select наружу
        w.parentNode.insertBefore(sel, w);
        w.remove();
        sel.removeAttribute(MARKER);
        sel.classList.remove('ss-native');
        delete sel._ss;
    }

    // Пересканировать document
    function scan(root) {
        root = root || document;
        root.querySelectorAll('select').forEach((s) => {
            try { init(s); } catch (e) { console.warn('SmartSelect init failed:', e, s); }
        });
    }

    // Наблюдаем за DOM: новые select-ы + изменение <option>-ов
    let observer = null;
    function watch() {
        if (observer) return;
        observer = new MutationObserver((mutations) => {
            let touched = new Set();
            for (const m of mutations) {
                if (m.type === 'childList') {
                    m.addedNodes.forEach((n) => {
                        if (!(n instanceof Element)) return;
                        if (n.tagName === 'SELECT') touched.add(n);
                        n.querySelectorAll?.('select').forEach((s) => touched.add(s));
                    });
                    // options могли поменяться у уже инитенного select
                    const parent = m.target;
                    if (parent && parent.tagName === 'SELECT' && parent._ss) {
                        parent._ss.refreshLabel();
                    }
                } else if (m.type === 'attributes' && m.target.tagName === 'SELECT' && m.target._ss) {
                    if (m.attributeName === 'disabled') m.target._ss.syncDisabled();
                    if (m.attributeName === 'value')     m.target._ss.refreshLabel();
                }
            }
            touched.forEach((s) => {
                try { init(s); } catch {}
            });
        });
        observer.observe(document.body, {
            childList: true, subtree: true, attributes: true,
            attributeFilter: ['disabled', 'value'],
        });
    }

    // Реакция на programmatic sel.value = 'x' — MutationObserver это не ловит,
    // поэтому патчим setter один раз.
    (function patchValueSetter() {
        const proto = HTMLSelectElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (!desc || !desc.set) return;
        const origSet = desc.set;
        Object.defineProperty(proto, 'value', {
            configurable: true,
            enumerable: desc.enumerable,
            get: desc.get,
            set(v) {
                origSet.call(this, v);
                if (this._ss) this._ss.refreshLabel();
            },
        });
    })();

    // Ре-инит на смене viewport (десктоп ↔ мобилка)
    let lastMobile = isMobile();
    window.addEventListener('resize', () => {
        const nowMobile = isMobile();
        if (nowMobile !== lastMobile) {
            lastMobile = nowMobile;
            document.querySelectorAll('select[' + MARKER + ']').forEach((s) => {
                if (nowMobile) destroy(s);
            });
            if (!nowMobile) scan();
        }
    });

    // Boot
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { scan(); watch(); });
    } else {
        scan();
        watch();
    }

    // Публичный API — на случай если понадобится дёргать вручную
    window.SmartSelect = { scan, init, destroy };
})();
