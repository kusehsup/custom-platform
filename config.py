from dotenv import load_dotenv
import os

load_dotenv()

PLATFORM_URL: str = os.getenv('PLATFORM_URL', '')
BOT_TOKEN: str    = os.getenv('BOT_TOKEN', '')
PROXY_URL: str    = os.getenv('PROXY_URL', '')
# URL встроенной IDE (code-server), проксируемой под тем же доменом.
# Пусто — вкладка IDE скрыта. По умолчанию — сабпуть /ide/ на том же хосте.
IDE_URL: str      = os.getenv('IDE_URL', '/ide/')
