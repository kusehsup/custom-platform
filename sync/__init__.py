"""
Локальный агент синхронизации кода с платформой для редакторов
(VS Code / Cursor). Переиспользует протокол из hassle_platform.PlatformClient
и предоставляет расширению простой JSON-RPC поверх stdio.

Компоненты:
  - agent.py          — сам агент (stdin/stdout JSON-RPC).
  - mock_platform.py  — мок Socket.IO-платформы для локальных тестов.
"""
