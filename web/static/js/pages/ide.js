// ── IDE (встроенный VS Code / code-server) ───────────────────────
//
// Вкладка-альтернатива редактору: полноэкранный iframe с code-server,
// который проксируется под тем же доменом (по умолчанию /ide/), чтобы
// не упираться в cross-origin/iframe-ограничения. URL берётся из
// /api/info (app.ideUrl), настраивается переменной IDE_URL на сервере.

const IdePage = {
    render(el) {
        const url = (window.app && app.ideUrl) ? app.ideUrl : '/ide/';

        if (!url) {
            el.innerHTML = `
            <div style="max-width:520px;margin:80px auto;padding:24px;text-align:center;color:var(--text)">
                <div style="font-size:28px;margin-bottom:8px">🧩</div>
                <div style="font-size:16px;font-weight:600;margin-bottom:6px">IDE не настроена</div>
                <div style="font-size:12px;color:var(--text-2)">Задайте переменную окружения <code>IDE_URL</code> на сервере (адрес code-server).</div>
            </div>`;
            return;
        }

        // Полноэкранный режим main: без паддингов, iframe на весь блок.
        el.classList.add('main--fullscreen');
        el.innerHTML = `
        <div class="ide-wrap">
            <iframe class="ide-frame" src="${url}"
                allow="clipboard-read; clipboard-write"
                title="IDE"></iframe>
        </div>`;
    },
};

app.register('ide', IdePage);
