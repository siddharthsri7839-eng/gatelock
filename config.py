import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent

# Database
DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{BASE_DIR / 'gatelock.db'}")

# Security
SECRET_KEY = os.getenv("SECRET_KEY", "gatelock-secret-key-super-secure-2026")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7  # 7 days

# Default Credentials
DEFAULT_OWNER = {
    "username": "owner",
    "password": "owner123",
    "name": "GateLock Owner",
    "role": "owner"
}

DEFAULT_ADMIN = {
    "username": "admin",
    "password": "admin123",
    "name": "GateLock Administrator",
    "role": "admin"
}

# Biometric Devices (S-B251CB)
DEFAULT_DEVICES = [
    {
        "device_key": "entry_gate",
        "name": "Gate 1 - ENTRY (Bio S-B251CB)",
        "ip_address": "192.168.1.165",
        "port": 80,
        "gate_type": "ENTRY",
        "is_enabled": True
    },
    {
        "device_key": "exit_gate",
        "name": "Gate 2 - EXIT (Bio S-B251CB)",
        "ip_address": "192.168.1.224",
        "port": 5005,
        "gate_type": "EXIT",
        "is_enabled": True
    }
]

