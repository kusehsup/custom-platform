from hassle_platform import PlatformClient

# user_id -> PlatformClient
_sessions: dict[int, PlatformClient] = {}


def get_session(user_id: int) -> PlatformClient | None:
    return _sessions.get(user_id)


def set_session(user_id: int, client: PlatformClient):
    _sessions[user_id] = client


def remove_session(user_id: int):
    client = _sessions.pop(user_id, None)
    return client
