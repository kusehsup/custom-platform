from datetime import datetime, timedelta
from jose import JWTError, jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

SECRET_KEY = 'change-this-secret-in-production-please'
ALGORITHM = 'HS256'
TOKEN_EXPIRE_HOURS = 24

bearer = HTTPBearer()


def create_token(login: str) -> str:
    expire = datetime.utcnow() + timedelta(hours=TOKEN_EXPIRE_HOURS)
    return jwt.encode({'sub': login, 'exp': expire}, SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str) -> str:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload.get('sub')
    except JWTError:
        return None


def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(bearer)) -> str:
    login = decode_token(credentials.credentials)
    if not login:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Неверный токен')
    return login
