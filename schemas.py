from typing import Optional, List
from datetime import datetime
from pydantic import BaseModel

class LoginRequest(BaseModel):
    username: str
    password: str

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str
    full_name: str
    username: str

class UserCreate(BaseModel):
    bio_user_id: str
    name: str
    role_title: Optional[str] = "Employee"
    department: Optional[str] = "General"
    phone: Optional[str] = None
    card_number: Optional[str] = None

class ImportRangeRequest(BaseModel):
    start_id: int = 1
    end_id: int = 37
    department: Optional[str] = "Main Gate"
    role_title: Optional[str] = "Staff"

class SyncUsersRequest(BaseModel):
    password: Optional[str] = ""

class UserUpdate(BaseModel):
    name: Optional[str] = None
    role_title: Optional[str] = None
    department: Optional[str] = None
    phone: Optional[str] = None
    card_number: Optional[str] = None
    is_active: Optional[bool] = None

class UserResponse(BaseModel):
    id: int
    bio_user_id: str
    name: str
    role_title: str
    department: str
    phone: Optional[str] = None
    card_number: Optional[str] = None
    avatar: Optional[str] = None
    is_active: bool
    created_at: Optional[datetime] = None

    class Config:
        from_attributes = True

class GatePunchCreate(BaseModel):
    bio_user_id: str
    gate_type: str  # 'ENTRY' or 'EXIT'
    verify_mode: Optional[str] = "Manual"
    device_key: Optional[str] = None

class GateLogResponse(BaseModel):
    id: int
    bio_user_id: str
    user_id: Optional[int]
    user_name: str
    device_key: str
    device_name: str
    gate_type: str
    timestamp: datetime
    verify_mode: str
    status: str
    is_deleted: bool
    note: Optional[str] = None

    class Config:
        from_attributes = True

class DeviceConfigUpdate(BaseModel):
    device_key: str
    name: Optional[str] = None
    ip_address: str
    port: int = 4370
    gate_type: str
    is_enabled: bool = True

class DeviceStatusResponse(BaseModel):
    id: int
    device_key: str
    name: str
    ip_address: str
    port: int
    gate_type: str
    is_enabled: bool
    last_status: str
    last_connected_at: Optional[datetime] = None
    total_device_punches: int

    class Config:
        from_attributes = True

class UserLiveStatus(BaseModel):
    bio_user_id: str
    name: str
    role_title: str
    department: str
    current_status: str  # 'INSIDE' or 'OUTSIDE'
    entry_count: int     # How many times entered today
    exit_count: int      # How many times exited today
    total_count: int     # Total entries + exits today
    first_entry_time: Optional[datetime] = None
    last_punch_time: Optional[datetime] = None
    last_gate: Optional[str] = None
    time_spent_str: str  # e.g. "2h 15m" or "0m"
    avatar: Optional[str] = None

