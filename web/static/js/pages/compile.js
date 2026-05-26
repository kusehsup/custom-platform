const COMPILE_KEY = 'compile_last';

app.register('compile', {
    render(root) {
        const saved = (() => { try { return JSON.parse(localStorage.getItem(COMPILE_KEY)); } catch { return null; } })();

        root.innerHTML = `
        <div class="card">
            <div class="card-header">
                <span class="card-title">Компиляция</span>
            </div>
            <div class="btn-row" style="margin-bottom:16px">
                <button class="btn btn-primary" id="btn-compile">🔨 Запустить компиляцию</button>
            </div>
            <div id="compile-status" style="color:var(--text-2);font-size:13px;margin-bottom:14px"></div>
            <div id="compile-out" class="compile-out ${saved ? '' : 'hidden'}"></div>
        </div>`;

        if (saved) this._render(saved.text, false);
        if (app.state.compile) {
            document.getElementById('compile-status').textContent = '⏳ Компиляция уже выполняется...';
            document.getElementById('btn-compile').disabled = true;
        }

        document.getElementById('btn-compile').addEventListener('click', async () => {
            try {
                await API.post('/api/compile');
                document.getElementById('compile-status').textContent = '⏳ Компиляция запущена, ожидаем результат...';
                document.getElementById('btn-compile').disabled = true;
                document.getElementById('compile-out').classList.add('hidden');
            } catch (e) {
                document.getElementById('compile-status').textContent = 'Ошибка: ' + e.message;
            }
        });
    },

    onResult(text) {
        document.getElementById('compile-status').textContent = '';
        const btn = document.getElementById('btn-compile');
        if (btn) btn.disabled = false;
        localStorage.setItem(COMPILE_KEY, JSON.stringify({ text, ts: Date.now() }));
        this._render(text, true);
    },

    _render(text, isNew) {
        const out = document.getElementById('compile-out');
        if (!out) return;
        out.classList.remove('hidden');

        // Считаем сколько строк уже отрендерено (для подсветки новых)
        const existingCount = out.querySelectorAll('.compile-line').length;

        const lines = text.split('\n');
        out.innerHTML = lines.map((raw, i) => {
            const safe = raw.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            let cls = 'compile-line';
            if (/error/i.test(raw))            cls += ' line-err';
            else if (/warning/i.test(raw))     cls += ' line-warn';
            else if (/done|success|\(0 error/i.test(raw)) cls += ' line-ok';
            if (isNew && i >= existingCount)   cls += ' line-new';
            return `<span class="${cls}">${safe}</span>`;
        }).join('\n');

        out.scrollTop = out.scrollHeight;
    },
});
