// ── Loader ───────────────────────────────────────────────────────────
//
// Полноэкранный оверлей на время загрузки: пока boot/login тянут API,
// пока _showApp навешивает WS, пока страница ре-рендерится после
// отключения-подключения. По умолчанию включён; можно выключить в
// настройках (localStorage: loader_enabled = '0').

const Loader = {
    _el: null,
    _shownAt: 0,
    _hideTimer: null,
    _minVisible: 250,   // ms — чтобы лоадер не мелькал 20мс

    isEnabled() {
        try {
            const v = localStorage.getItem('loader_enabled');
            return v !== '0';
        } catch { return true; }
    },
    setEnabled(v) {
        try { localStorage.setItem('loader_enabled', v ? '1' : '0'); } catch {}
    },

    _create(text) {
        const el = document.createElement('div');
        el.id = 'app-loader';
        el.className = 'app-loader';
        el.innerHTML = `
            <div class="app-loader-inner">
                <div class="app-loader-spinner"></div>
                <div class="app-loader-text">${text || 'Загрузка…'}</div>
            </div>`;
        document.body.appendChild(el);
        // triggerreflow → плавное появление
        requestAnimationFrame(() => el.classList.add('is-shown'));
        return el;
    },

    show(text) {
        if (!this.isEnabled()) return;
        if (this._hideTimer) { clearTimeout(this._hideTimer); this._hideTimer = null; }
        if (this._el) {
            // Обновим текст если задан
            if (text) {
                const t = this._el.querySelector('.app-loader-text');
                if (t) t.textContent = text;
            }
            return;
        }
        this._el = this._create(text);
        this._shownAt = Date.now();
    },

    hide() {
        if (!this._el) return;
        const elapsed = Date.now() - this._shownAt;
        const delay = Math.max(0, this._minVisible - elapsed);
        this._hideTimer = setTimeout(() => {
            if (!this._el) return;
            this._el.classList.remove('is-shown');
            const el = this._el;
            this._el = null;
            setTimeout(() => el.remove(), 200);
        }, delay);
    },
};

window.Loader = Loader;
