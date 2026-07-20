"""
Сборка sync-агента в самодостаточный бинарь (PyInstaller).

Один скрипт для всех ОС: запусти его на нужной платформе (Windows/macOS/Linux)
интерпретатором с установленными зависимостями проекта и pyinstaller —
получишь бинарь в vscode-extension/bin/<platform>-<arch>/platform-agent[.exe].
Кросс-компиляции у PyInstaller нет: Windows-бинарь собирается на Windows и т.д.
(в CI — матрица ОС, см. .github/workflows/build-extension.yml).

Использование:
    python scripts/build_agent.py
"""

import os
import platform
import sys

import PyInstaller.__main__

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def vscode_target() -> str:
    p = sys.platform
    plat = 'win32' if p.startswith('win') else ('darwin' if p == 'darwin' else 'linux')
    m = platform.machine().lower()
    arch = 'arm64' if m in ('arm64', 'aarch64') else 'x64'
    return f'{plat}-{arch}'


def main() -> None:
    out_dir = os.path.join(ROOT, 'vscode-extension', 'bin', vscode_target())
    args = [
        os.path.join(ROOT, 'sync', 'agent.py'),
        '--onefile',
        '--name', 'platform-agent',
        '--distpath', out_dir,
        '--workpath', os.path.join(ROOT, 'build', 'pyi'),
        '--specpath', os.path.join(ROOT, 'build'),
        '--paths', ROOT,
        # Локальные модули репозитория (импортируются лениво в агенте)
        '--hidden-import', 'hassle_platform',
        '--hidden-import', 'hassle_platform.client',
        '--hidden-import', 'config',
        # Транзитивные зависимости с ленивыми/динамическими импортами
        '--collect-all', 'python_socks',
        '--collect-all', 'websockets',
        '--hidden-import', 'dotenv',
        '--noconfirm',
        '--clean',
    ]
    print(f'[build_agent] target={vscode_target()} → {out_dir}')
    PyInstaller.__main__.run(args)
    print('[build_agent] done')


if __name__ == '__main__':
    main()
