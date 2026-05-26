from dotenv import load_dotenv
import os

load_dotenv()

PLATFORM_URL: str = os.getenv('PLATFORM_URL', '')
BOT_TOKEN: str    = os.getenv('BOT_TOKEN', '')
PROXY_URL: str    = os.getenv('PROXY_URL', '')
