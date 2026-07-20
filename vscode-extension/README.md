# CustomPlatform Sync (VS Code / Cursor)

Расширение для работы с кодом SA-MP веб-платформы **напрямую по WebSocket**, минуя веб-интерфейс: подтягивание файлов/блоков, сохранение правок, компиляция, старт/стоп игрового сервера и просмотр консоли сервера — прямо в редакторе.

## Как устроено

Расширение (TypeScript) — тонкий UI. Всю работу по протоколу платформы (Engine.IO/Socket.IO, авторизация, ack-и, реконнект, hash-конкурентность, SOCKS5) выполняет **sync-агент** на Python (`sync/agent.py` в корне репозитория), который переиспользует `hassle_platform.PlatformClient`. Расширение запускает агент дочерним процессом и общается с ним по JSON-RPC (stdio).

```
VS Code / Cursor  ──JSON-RPC(stdio)──►  sync.agent  ──WS(Socket.IO)──►  платформа
                                          (через xray SOCKS5)
```

### Модель кода
Платформа отдаёт код не файлами, а **блоками** (parts): `file_id → [{line, content, hash}]`, и доступны только выданные блоки. Поэтому один блок = один виртуальный файл (`pawn:/<file_id>~<part_index>/<name>`). При доступе на весь файл это ровно один блок. Сохранение (`Ctrl+S`) шлёт `set_code` по нужному `part_index` с текущим `hash`; при расхождении версий расширение спросит перезапись (оптимистичная блокировка).

## Возможности (MVP)
- Дерево файлов платформы с бейджами доступа (файл целиком / N блоков / нет доступа).
- Открытие блока в редакторе, сохранение обратно на `Ctrl+S`.
- Команды: подключиться/отключиться, обновить, компилировать, запустить/остановить сервер, консоль сервера.
- Консоль сервера и вывод компиляции — отдельные Output-каналы; статус подключения и сервера — в статус-баре.
- Реалтайм: при `update_code` с платформы дерево обновляется.

## Требования
- Запущенный локальный **xray** (SOCKS5), если платформа доступна только через туннель (см. `platformSync.proxyUrl`).
- **Релизный `.vsix`** содержит встроенный бинарь агента (PyInstaller) — Python пользователю НЕ нужен.
- Только для режима разработки: Python + корень репозитория с пакетом `sync`.

## Установка релизного `.vsix` (пользователю)
1. Скачай `.vsix` под свою ОС **одним кликом со вкладки Releases** репозитория (для Windows — `custom-platform-sync-win32-x64.vsix`). Релиз с прикреплёнными файлами публикуется автоматически при пуше тега `v*` (CI собирает бинари под win/mac/linux). Как альтернатива — артефакты запуска workflow «Build VS Code extension».
2. Установи:
   - Cursor / VS Code: палитра команд → **Extensions: Install from VSIX…** → выбери файл.
   - или из терминала: `code --install-extension custom-platform-sync-win32-x64.vsix` (в Cursor — `cursor --install-extension ...`).
3. Задай `platformSync.platformUrl` и (если нужен туннель) `platformSync.proxyUrl`. Запусти локальный xray.
4. **Platform: Подключиться**.

Расширение автоматически предпочитает встроенный бинарь `bin/<platform>-<arch>/platform-agent[.exe]`; `platformSync.pythonPath` используется только как fallback в деве.

## Сборка `.vsix` (релиз)
Кросс-компиляции у PyInstaller нет — бинарь под каждую ОС собирается на этой ОС. В CI это матрица (`.github/workflows/build-extension.yml`, цели `win32-x64`/`linux-x64`/`darwin-x64`/`darwin-arm64`); по тегу `v*` результаты автоматически прикрепляются к GitHub Release. Локально под текущую ОС:
```bash
pip install -r requirements.txt pyinstaller
python scripts/build_agent.py            # → vscode-extension/bin/<platform>-<arch>/platform-agent
cd vscode-extension && npm install && npm run compile
npx vsce package --target <target>       # напр. win32-x64 → .vsix со встроенным агентом
```

## Сборка (dev, без бинаря)
```bash
cd vscode-extension
npm install
npm run compile      # tsc → out/
```
Открой папку `vscode-extension` в VS Code и нажми F5 (Extension Development Host). Без бинаря агент запускается через `platformSync.pythonPath` (`python -m sync.agent`), поэтому задай `platformSync.agentCwd` = корень репозитория.

## Настройки
- `platformSync.platformUrl` — URL платформы.
- `platformSync.proxyUrl` — SOCKS5 (по умолчанию `socks5://127.0.0.1:10808`); пусто = напрямую.
- `platformSync.pythonPath` — Python для запуска агента (dev).
- `platformSync.agentCwd` — корень репозитория с пакетом `sync` (пусто = папка воркспейса).

## Использование
1. Задай `platformSync.platformUrl` (и `proxyUrl`, если нужен xray).
2. Команда **Platform: Подключиться** → введи логин/пароль (пароль не сохраняется, логин — в SecretStorage).
3. В сайдбаре **Platform** появится дерево файлов. Клик по файлу/блоку — открывает его.
4. Правь и сохраняй (`Ctrl+S`) — уходит на платформу.
5. **Platform: Компилировать / Запустить сервер / Остановить сервер / Консоль сервера** — из шапки панели или палитры команд.
