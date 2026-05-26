const CONSOLE_KEY   = 'console_lines';
const CONSOLE_LIMIT = 200;

app.register('console', {
    _el: null,
    _paused: false,
    _lines: [],

    _load() {
        try { this._lines = JSON.parse(localStorage.getItem(CONSOLE_KEY) || '[]'); } catch { this._lines = []; }
    },

    _save() {
        if (this._lines.length > CONSOLE_LIMIT) this._lines = this._lines.slice(-CONSOLE_LIMIT);
        try { localStorage.setItem(CONSOLE_KEY, JSON.stringify(this._lines)); } catch {}
    },

    _flush() {
        if (!this._el) return;
        this._el.textContent = this._lines.join('');
        this._el.scrollTop   = this._el.scrollHeight;
        const cnt = document.getElementById('console-count');
        if (cnt) cnt.textContent = `${this._lines.length} / ${CONSOLE_LIMIT} строк`;
    },

    render(root) {
        this._load();
        this._paused = false;

        root.innerHTML = `
        <div class="card" style="padding:0;overflow:hidden">
            <div class="console-toolbar">
                <span class="card-title" style="margin:0">Консоль сервера</span>
                <span class="spacer"></span>
                <span class="console-count" id="console-count"></span>
                <button class="btn btn-ghost btn-sm" id="btn-pause">⏸ Пауза</button>
                <button class="btn btn-ghost btn-sm" id="btn-download">↓ Скачать</button>
                <button class="btn btn-ghost btn-sm" id="btn-clear">🗑 Очистить</button>
            </div>
            <div class="console" id="console-out"></div>
        </div>`;

        this._el = document.getElementById('console-out');
        this._flush();

        document.getElementById('btn-pause').addEventListener('click', () => {
            this._paused = !this._paused;
            document.getElementById('btn-pause').textContent = this._paused ? '▶ Продолжить' : '⏸ Пауза';
        });

        document.getElementById('btn-clear').addEventListener('click', () => {
            this._lines = [];
            this._save();
            this._flush();
        });

        document.getElementById('btn-download').addEventListener('click', () => {
            const blob = new Blob([this._lines.join('')], { type: 'text/plain' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `console_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.txt`;
            a.click();
            URL.revokeObjectURL(a.href);
        });
    },

    onLog(data) {
        this._lines.push(data);
        this._save();
        if (this._paused || !this._el) return;
        this._el.textContent += data;
        this._el.scrollTop = this._el.scrollHeight;
        const cnt = document.getElementById('console-count');
        if (cnt) cnt.textContent = `${this._lines.length} / ${CONSOLE_LIMIT} строк`;
    },
});
