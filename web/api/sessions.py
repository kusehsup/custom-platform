from hassle_platform import PlatformClient

_sessions: dict[str, PlatformClient] = {}


def get_session(login: str) -> PlatformClient | None:
    return _sessions.get(login)  # возвращаем клиент даже при переподключении


def set_session(login: str, client: PlatformClient):
    _sessions[login] = client


def remove_session(login: str):
    _sessions.pop(login, None)
