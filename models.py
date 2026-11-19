import datetime
from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey, Text
from sqlalchemy.orm import relationship
from database import Base

class Account(Base):
    __tablename__ = "accounts"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, index=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    role = Column(String(20), nullable=False)  # 'owner' or 'admin'
    full_name = Column(String(100), nullable=False)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    last_login = Column(DateTime, nullable=True)

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    bio_user_id = Column(String(50), unique=True, index=True, nullable=False)
    name = Column(String(100), nullable=False)
    role_title = Column(String(50), default="Employee")
    department = Column(String(50), default="General")
    phone = Column(String(20), nullable=True)
    card_number = Column(String(50), nullable=True)
    avatar = Column(String(255), nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)

    logs = relationship("GateLog", back_populates="user", cascade="all, delete-orphan")

class GateLog(Base):
    __tablename__ = "gate_logs"

    id = Column(Integer, primary_key=True, index=True)
    bio_user_id = Column(String(50), index=True, nullable=False)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    user_name = Column(String(100), nullable=False)
    device_key = Column(String(50), nullable=False)  # 'entry_gate' or 'exit_gate'
    device_name = Column(String(100), nullable=False)
    gate_type = Column(String(10), nullable=False)   # 'ENTRY' or 'EXIT'
    timestamp = Column(DateTime, default=datetime.datetime.utcnow, index=True)
    verify_mode = Column(String(30), default="Fingerprint") # Fingerprint, Card, Password, Face, Manual
    punch_code = Column(Integer, default=0)
    status = Column(String(20), default="SUCCESS")
    is_deleted = Column(Boolean, default=False, index=True)
    deleted_by = Column(String(50), nullable=True)
    deleted_at = Column(DateTime, nullable=True)
    note = Column(Text, nullable=True)

    user = relationship("User", back_populates="logs")

class DeviceSetting(Base):
    __tablename__ = "device_settings"

    id = Column(Integer, primary_key=True, index=True)
    device_key = Column(String(50), unique=True, nullable=False)
    name = Column(String(100), nullable=False)
    ip_address = Column(String(50), nullable=False)
    port = Column(Integer, default=4370)
    gate_type = Column(String(10), default="ENTRY") # ENTRY or EXIT
    is_enabled = Column(Boolean, default=True)
    last_status = Column(String(20), default="OFFLINE") # ONLINE, OFFLINE, ERROR
    last_connected_at = Column(DateTime, nullable=True)
    total_device_punches = Column(Integer, default=0)

class AdminAuditLog(Base):
    __tablename__ = "admin_audit_logs"

    id = Column(Integer, primary_key=True, index=True)
    action = Column(String(50), nullable=False)
    details = Column(Text, nullable=False)
    performed_by = Column(String(50), nullable=False)
    timestamp = Column(DateTime, default=datetime.datetime.utcnow)

class CameraSetting(Base):
    __tablename__ = "camera_settings"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), default="Gate 1 Entry IP Camera")
    ip_address = Column(String(50), default="192.168.1.164")
    port = Column(Integer, default=554)
    username = Column(String(50), default="admin")
    password = Column(String(100), default="")
    brand = Column(String(50), default="cpplus") # cpplus, hikvision, onvif, custom, webcam
    rtsp_url = Column(String(255), nullable=True)
    gate_type = Column(String(20), default="ENTRY")
    is_enabled = Column(Boolean, default=True)
    last_status = Column(String(20), default="IDLE")

class BagViolationLog(Base):
    __tablename__ = "bag_violation_logs"

    id = Column(Integer, primary_key=True, index=True)
    bio_user_id = Column(String(50), index=True, default="UNKNOWN")
    user_name = Column(String(100), nullable=False)
    department = Column(String(100), default="Entry Gate")
    camera_name = Column(String(100), default="Gate 1 Entry IP Camera")
    camera_ip = Column(String(50), default="192.168.1.164")
    bag_type = Column(String(80), nullable=False) # Backpack, Handbag, Suitcase, etc.
    confidence = Column(Integer, default=85)
    detected_objects = Column(String(255), default="Person, Bag")
    snapshot_url = Column(String(255), nullable=True)
    clip_url = Column(String(255), nullable=True)
    timestamp = Column(DateTime, default=datetime.datetime.now, index=True)
    note = Column(Text, nullable=True)
    is_deleted = Column(Boolean, default=False, index=True)


