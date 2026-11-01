import hashlib
import os
import hmac
import json
import base64
from datetime import datetime, timedelta
from typing import Optional
from fastapi import Depends, HTTPException, status, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session

from config import SECRET_KEY, DEFAULT_OWNER, DEFAULT_ADMIN
from database import get_db
from models import Account

security = HTTPBearer(auto_error=False)

def hash_password(password: str) -> str:
    salt = "gatelock_salt_key_secure_2026"
    return hashlib.pbkdf2_hmac(
        'sha256',
        password.encode('utf-8'),
        salt.encode('utf-8'),
        100000
    ).hex()

def verify_password(plain_password: str, hashed_password: str) -> bool:
    return hmac.compare_digest(hash_password(plain_password), hashed_password)

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(days=7)
    to_encode.update({"exp": int(expire.timestamp())})
    
    header = {"alg": "HS256", "typ": "JWT"}
    encoded_header = base64.urlsafe_b64encode(json.dumps(header).encode()).decode().rstrip("=")
    encoded_payload = base64.urlsafe_b64encode(json.dumps(to_encode).encode()).decode().rstrip("=")
    signature = hmac.new(
        SECRET_KEY.encode(),
        f"{encoded_header}.{encoded_payload}".encode(),
        hashlib.sha256
    ).digest()
    encoded_sig = base64.urlsafe_b64encode(signature).decode().rstrip("=")
    return f"{encoded_header}.{encoded_payload}.{encoded_sig}"

def decode_access_token(token: str) -> Optional[dict]:
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return None
        encoded_header, encoded_payload, encoded_sig = parts
        expected_sig = hmac.new(
            SECRET_KEY.encode(),
            f"{encoded_header}.{encoded_payload}".encode(),
            hashlib.sha256
        ).digest()
        actual_sig = base64.urlsafe_b64decode(encoded_sig + "=" * (-len(encoded_sig) % 4))
        if not hmac.compare_digest(expected_sig, actual_sig):
            return None
        
        payload_bytes = base64.urlsafe_b64decode(encoded_payload + "=" * (-len(encoded_payload) % 4))
        payload = json.loads(payload_bytes.decode())
        if datetime.utcnow().timestamp() > payload.get("exp", 0):
            return None
        return payload
    except Exception:
        return None

def init_default_accounts(db: Session):
    for default_acc in [DEFAULT_OWNER, DEFAULT_ADMIN]:
        acc = db.query(Account).filter(Account.username == default_acc["username"]).first()
        if not acc:
            acc = Account(
                username=default_acc["username"],
                password_hash=hash_password(default_acc["password"]),
                role=default_acc["role"],
                full_name=default_acc["name"],
                created_at=datetime.utcnow()
            )
            db.add(acc)
        else:
            # Refresh password hash in case it was altered
            acc.password_hash = hash_password(default_acc["password"])
    db.commit()

async def get_current_account(
    request: Request,
    auth: Optional[HTTPAuthorizationCredentials] = Depends(security),
    db: Session = Depends(get_db)
) -> Account:
    token = None
    if auth and auth.credentials:
        token = auth.credentials
    elif "gatelock_token" in request.cookies:
        token = request.cookies.get("gatelock_token")
    
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required. Please log in."
        )
    
    payload = decode_access_token(token)
    if not payload or "sub" not in payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session invalid or expired. Please log in again."
        )
    
    username = payload["sub"]
    acc = db.query(Account).filter(Account.username == username).first()
    if not acc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User account not found."
        )
    return acc

async def require_admin(current_user: Account = Depends(get_current_account)) -> Account:
    if current_user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Owner role has view-only access. Only Admin can modify or delete data."
        )
    return current_user

async def require_any(current_user: Account = Depends(get_current_account)) -> Account:
    return current_user

