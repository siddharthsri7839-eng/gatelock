import asyncio
import threading
import time
import datetime
import random
from typing import Optional, Dict, Any, List
from sqlalchemy.orm import Session
from zk import ZK

from database import SessionLocal
from models import DeviceSetting, GateLog, User, AdminAuditLog
from config import DEFAULT_DEVICES

class BiometricManager:
    def __init__(self):
        self.simulation_active = False
        self.simulation_thread = None
        self.polling_active = True
        self.polling_thread = None
        self.ws_broadcast_callback = None
        self._last_processed_timestamps: Dict[str, datetime.datetime] = {}

    def set_broadcast_callback(self, callback):
        self.ws_broadcast_callback = callback

    def init_devices(self, db: Session):
        for dev_data in DEFAULT_DEVICES:
            dev = db.query(DeviceSetting).filter(DeviceSetting.device_key == dev_data["device_key"]).first()
            if not dev:
                dev = DeviceSetting(
                    device_key=dev_data["device_key"],
                    name=dev_data["name"],
                    ip_address=dev_data["ip_address"],
                    port=dev_data["port"],
                    gate_type=dev_data["gate_type"],
                    is_enabled=dev_data["is_enabled"],
                    last_status="OFFLINE"
                )
                db.add(dev)
        db.commit()

    def test_connection(self, device_key: str, db: Session) -> Dict[str, Any]:
        dev = db.query(DeviceSetting).filter(DeviceSetting.device_key == device_key).first()
        if not dev:
            return {"success": False, "message": f"Device {device_key} not configured"}
        
        import socket
        import subprocess

        is_tcp_connected = False
        banner_info = "Connected via TCP"

        # 1. Quick TCP socket test
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(1.5)
        try:
            s.connect((dev.ip_address, dev.port))
            is_tcp_connected = True
            s.close()
        except Exception:
            pass

        # 2. If port is 80 (HTTP / Web interface like CP PLUS)
        if dev.port == 80:
            try:
                import requests
                resp = requests.get(f"http://{dev.ip_address}/", timeout=1.5)
                if resp.status_code in [200, 401, 302, 403]:
                    is_tcp_connected = True
                    server_name = resp.headers.get("Server", "Embedded Web Terminal")
                    banner_info = f"HTTP {resp.status_code} ({server_name})"
            except Exception:
                pass

        # 3. Try pyzk if port is 4370 or fallback
        if dev.port == 4370:
            zk_instance = ZK(dev.ip_address, port=dev.port, timeout=2, ommit_ping=True)
            conn = None
            try:
                conn = zk_instance.connect()
                is_tcp_connected = True
                firmware = conn.get_firmware_version() if hasattr(conn, 'get_firmware_version') else "Unknown"
                serial = conn.get_serialnumber() if hasattr(conn, 'get_serialnumber') else "Unknown"
                device_name = conn.get_device_name() if hasattr(conn, 'get_device_name') else dev.name
                banner_info = f"PyZK: {device_name} (FW: {firmware}, S/N: {serial})"
            except Exception:
                pass
            finally:
                if conn:
                    try:
                        conn.disconnect()
                    except Exception:
                        pass

        # 4. Fallback ICMP ping if TCP is restricted
        is_ping_ok = False
        if not is_tcp_connected:
            try:
                res = subprocess.run(["ping", "-n", "1", "-w", "800", dev.ip_address], capture_output=True)
                if res.returncode == 0:
                    is_ping_ok = True
                    banner_info = "ICMP Ping Reachable"
            except Exception:
                pass

        if is_tcp_connected or is_ping_ok:
            dev.last_status = "ONLINE"
            dev.last_connected_at = datetime.datetime.utcnow()
            db.commit()
            return {
                "success": True,
                "status": "ONLINE",
                "message": f"Successfully connected to {dev.name} ({dev.ip_address}:{dev.port})! [{banner_info}]",
                "device_info": banner_info
            }
        else:
            dev.last_status = "OFFLINE"
            db.commit()
            return {
                "success": False,
                "status": "OFFLINE",
                "message": f"Could not reach {dev.ip_address}:{dev.port}. Ensure the biometric machine is powered on and cable is plugged in."
            }

    def sync_records_from_device(self, device_key: str, db: Session) -> Dict[str, Any]:
        dev = db.query(DeviceSetting).filter(DeviceSetting.device_key == device_key).first()
        if not dev:
            return {"success": False, "message": "Device not found"}
        
        zk_instance = ZK(dev.ip_address, port=dev.port, timeout=4, ommit_ping=True)
        conn = None
        new_records_count = 0
        try:
            conn = zk_instance.connect()
            dev.last_status = "ONLINE"
            dev.last_connected_at = datetime.datetime.utcnow()
            
            attendances = conn.get_attendance()
            for att in attendances:
                user_pin = str(att.user_id).strip()
                punch_time = att.timestamp
                
                # Check if this exact punch already exists
                existing = db.query(GateLog).filter(
                    GateLog.bio_user_id == user_pin,
                    GateLog.timestamp == punch_time,
                    GateLog.device_key == dev.device_key
                ).first()
                
                if not existing:
                    self.record_punch(
                        bio_user_id=user_pin,
                        gate_type=dev.gate_type,
                        verify_mode="Fingerprint",
                        device_key=dev.device_key,
                        punch_time=punch_time,
                        db=db,
                        note="Synced from Bio S-B251CB terminal"
                    )
                    new_records_count += 1
            
            dev.total_device_punches = len(attendances)
            db.commit()
            return {
                "success": True,
                "message": f"Successfully synced {new_records_count} new punches from {dev.name}.",
                "new_count": new_records_count,
                "total_count": len(attendances)
            }
        except Exception as e:
            err_str = str(e)
            dev.last_status = "ONLINE" if "TCP packet invalid" in err_str else "OFFLINE"
            db.commit()
            if "TCP packet invalid" in err_str:
                return {
                    "success": False,
                    "message": f"Gate 2 (Secureye S-B251CB) is online, but pushes movements in real time via Cloud Push. Set Cloud Server IP to 192.168.1.58:8000 on the machine menu for instant live gate logs."
                }
            return {"success": False, "message": f"Failed to sync from {dev.name}: {err_str}"}
        finally:
            if conn:
                try:
                    conn.disconnect()
                except Exception:
                    pass

    def sync_users_from_device(self, device_key: str, db: Session, device_password: str = "") -> Dict[str, Any]:
        """
        Pull real enrolled users directly from physical biometric hardware (CP PLUS or Secureye).
        """
        dev = db.query(DeviceSetting).filter(DeviceSetting.device_key == device_key).first()
        if not dev:
            return {"success": False, "message": "Device not found"}

        synced_count = 0
        new_users = []

        # 1. Gate 1 - CP PLUS / Dahua Face Terminal (Port 80)
        if dev.port == 80:
            from dahua_client import DahuaTerminalClient
            client = DahuaTerminalClient(
                ip=dev.ip_address,
                port=dev.port,
                username="admin",
                password=device_password.strip() if device_password else "admin123"
            )
            login_res = client.login()
            if not login_res["success"]:
                return {
                    "success": False,
                    "message": f"Could not authenticate with {dev.name} ({dev.ip_address}): {login_res.get('message')}. Please provide the correct device password configured on this biometric machine.",
                    "requires_password": True
                }

            dev.last_status = "ONLINE"
            dev.last_connected_at = datetime.datetime.utcnow()
            users_data = client.fetch_all_enrolled_users()

            for ud in users_data:
                uid = str(ud["bio_user_id"]).strip()
                name = ud.get("name") or f"User {uid}"
                existing = db.query(User).filter(User.bio_user_id == uid).first()
                if not existing:
                    new_u = User(
                        bio_user_id=uid,
                        name=name,
                        department=ud.get("department", "Biometric Enrolled"),
                        role_title=ud.get("role_title", "Staff"),
                        card_number=ud.get("card_number"),
                        is_active=True
                    )
                    db.add(new_u)
                    synced_count += 1
                    new_users.append(name)
                else:
                    if name and not existing.name.startswith("User "):
                        existing.name = name
                    existing.is_active = True
                    synced_count += 1

            db.commit()
            return {
                "success": True,
                "message": f"Successfully synced {synced_count} real users directly from {dev.name} ({dev.ip_address})!",
                "synced_count": synced_count,
                "users": new_users[:20]
            }

        # 2. Gate 2 - Secureye / ZK Terminal (Port 5005 or 4370)
        else:
            conn = None
            try:
                zk_instance = ZK(dev.ip_address, port=dev.port, timeout=4, password=0, ommit_ping=True)
                conn = zk_instance.connect()
                dev.last_status = "ONLINE"
                dev.last_connected_at = datetime.datetime.utcnow()
                users = conn.get_users()

                for u in users:
                    uid = str(u.user_id).strip()
                    name = u.name.strip() if u.name else f"User {uid}"
                    existing = db.query(User).filter(User.bio_user_id == uid).first()
                    if not existing:
                        new_u = User(
                            bio_user_id=uid,
                            name=name,
                            department="Secureye Enrolled",
                            role_title="Admin" if u.privilege == 14 else "Staff",
                            card_number=str(u.card) if u.card else None,
                            is_active=True
                        )
                        db.add(new_u)
                        synced_count += 1
                        new_users.append(name)
                    else:
                        if name and name != f"User {uid}":
                            existing.name = name
                        existing.is_active = True
                        synced_count += 1

                db.commit()
                return {
                    "success": True,
                    "message": f"Successfully synced {synced_count} real users directly from {dev.name}!",
                    "synced_count": synced_count,
                    "users": new_users[:20]
                }
            except Exception as e:
                err_str = str(e)
                if "TCP packet invalid" in err_str or "timed out" in err_str:
                    return {
                        "success": False,
                        "message": (
                            f"Gate 2 (Secureye S-B251CB) uses Secureye Cloud Push / USB export protocol instead of direct ZK pulling. "
                            f"To load its 37 enrolled users with their real names, please click 'Import USB File' on the User Directory tab "
                            f"with a pen drive file (user.dat or txt), or configure Cloud Push to this server (192.168.1.58:8000)."
                        )
                    }
                return {
                    "success": False,
                    "message": f"Could not connect directly to {dev.name} on port {dev.port}: {err_str}"
                }
            finally:
                if conn:
                    try:
                        conn.disconnect()
                    except Exception:
                        pass

    def import_users_from_raw_data(self, raw_text: str, db: Session) -> Dict[str, Any]:
        """Parse exported user data from USB flash drive (user.dat, attlog.dat, csv/tsv)."""
        lines = raw_text.strip().splitlines()
        added = 0
        updated = 0
        
        for line in lines:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            
            # Common formats:
            # 1. Tab separated: PIN \t Name \t Card \t Role
            # 2. Comma separated: PIN, Name, Dept, Role
            # 3. ZK user.dat format
            parts = [p.strip() for p in line.replace("\t", ",").split(",") if p.strip()]
            if len(parts) >= 2:
                pin = parts[0]
                name = parts[1]
                dept = parts[2] if len(parts) > 2 else "Enrolled Staff"
                role = parts[3] if len(parts) > 3 else "Employee"
                
                # Filter out header rows
                if pin.lower() in ["pin", "user_id", "userid", "id", "bio_id", "no"]:
                    continue

                existing = db.query(User).filter(User.bio_user_id == pin).first()
                if not existing:
                    u = User(
                        bio_user_id=pin,
                        name=name,
                        department=dept,
                        role_title=role,
                        is_active=True
                    )
                    db.add(u)
                    added += 1
                else:
                    existing.name = name
                    existing.department = dept
                    existing.role_title = role
                    existing.is_active = True
                    updated += 1
        
        db.commit()
        return {
            "success": True,
            "message": f"Imported {added} new users and updated {updated} existing users directly from device export file.",
            "added": added,
            "updated": updated
        }

    def clear_device_logs(self, device_key: str, admin_user: str, db: Session) -> Dict[str, Any]:
        """Admin command to remove/wipe gate movement logs from the biometric machine."""
        dev = db.query(DeviceSetting).filter(DeviceSetting.device_key == device_key).first()
        if not dev:
            return {"success": False, "message": "Device not found"}
        
        zk_instance = ZK(dev.ip_address, port=dev.port, timeout=4, ommit_ping=True)
        conn = None
        try:
            conn = zk_instance.connect()
            conn.clear_attendance()
            
            # Log admin audit
            audit = AdminAuditLog(
                action="CLEAR_DEVICE_LOGS",
                details=f"Admin {admin_user} cleared gate access memory on device {dev.name} ({dev.ip_address})",
                performed_by=admin_user,
                timestamp=datetime.datetime.utcnow()
            )
            db.add(audit)
            dev.total_device_punches = 0
            db.commit()
            
            return {
                "success": True,
                "message": f"Successfully cleared all biometric logs from {dev.name} hardware memory."
            }
        except Exception as e:
            return {
                "success": False,
                "message": f"Device communication error while clearing {dev.name}: {str(e)}"
            }
        finally:
            if conn:
                try:
                    conn.disconnect()
                except Exception:
                    pass

    def unlock_gate(self, device_key: str, admin_user: str, db: Session) -> Dict[str, Any]:
        """Admin command to trigger gate unlock relay on the biometric terminal."""
        dev = db.query(DeviceSetting).filter(DeviceSetting.device_key == device_key).first()
        if not dev:
            return {"success": False, "message": "Device not found"}
        
        zk_instance = ZK(dev.ip_address, port=dev.port, timeout=3, ommit_ping=True)
        conn = None
        try:
            conn = zk_instance.connect()
            conn.unlock(time=5) # Unlock door for 5 seconds
            
            audit = AdminAuditLog(
                action="UNLOCK_GATE",
                details=f"Admin {admin_user} triggered remote gate unlock on {dev.name}",
                performed_by=admin_user,
                timestamp=datetime.datetime.utcnow()
            )
            db.add(audit)
            db.commit()
            return {"success": True, "message": f"Gate unlock signal sent to {dev.name} (5s pulse)"}
        except Exception as e:
            return {"success": False, "message": f"Could not unlock gate on {dev.name}: {str(e)}"}
        finally:
            if conn:
                try:
                    conn.disconnect()
                except Exception:
                    pass

    def record_punch(
        self,
        bio_user_id: str,
        gate_type: str,
        verify_mode: str = "Fingerprint",
        device_key: Optional[str] = None,
        punch_time: Optional[datetime.datetime] = None,
        db: Optional[Session] = None,
        note: Optional[str] = None
    ) -> GateLog:
        """Core punch ingestion used by direct hardware sync, push endpoint, or manual/simulation."""
        close_session = False
        if db is None:
            db = SessionLocal()
            close_session = True

        try:
            if not punch_time:
                punch_time = datetime.datetime.utcnow()

            # Find matching user profile (supports exact pin, numeric prefix, and VHPL codes)
            clean_pin = str(bio_user_id).strip()
            user = db.query(User).filter(User.bio_user_id == clean_pin).first()
            if not user and clean_pin.isdigit():
                # Try matching VHPL001 format
                vhpl_code = f"VHPL{int(clean_pin):03d}"
                user = db.query(User).filter(User.bio_user_id == vhpl_code).first()
            if not user and clean_pin.upper().startswith("VHPL"):
                # Try matching numeric format
                num_part = clean_pin[4:].lstrip("0") or "0"
                user = db.query(User).filter(User.bio_user_id == num_part).first()

            if not user:
                # If user doesn't exist yet, auto-register as visitor/guest with bio ID
                user = User(
                    bio_user_id=clean_pin,
                    name=f"User {clean_pin}",
                    role_title="Guest / Visitor",
                    department="General",
                    is_active=True
                )
                db.add(user)
                db.flush()

            # Resolve device info
            if not device_key:
                device_key = "entry_gate" if gate_type.upper() == "ENTRY" else "exit_gate"

            dev = db.query(DeviceSetting).filter(DeviceSetting.device_key == device_key).first()
            dev_name = dev.name if dev else f"Gate {gate_type.upper()} Terminal"

            # Create gate log
            log = GateLog(
                bio_user_id=user.bio_user_id,
                user_id=user.id,
                user_name=user.name,
                device_key=device_key,
                device_name=dev_name,
                gate_type=gate_type.upper(),
                timestamp=punch_time,
                verify_mode=verify_mode,
                status="SUCCESS",
                is_deleted=False,
                note=note
            )
            db.add(log)
            db.commit()
            db.refresh(log)

            # Compute updated daily presence metrics for broadcast
            today_start = datetime.datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
            today_punches = db.query(GateLog).filter(
                GateLog.bio_user_id == user.bio_user_id,
                GateLog.timestamp >= today_start,
                GateLog.is_deleted == False
            ).order_by(GateLog.timestamp.asc()).all()

            entry_count = sum(1 for p in today_punches if p.gate_type == "ENTRY")
            exit_count = sum(1 for p in today_punches if p.gate_type == "EXIT")
            last_punch = today_punches[-1] if today_punches else None
            current_status = "INSIDE" if (last_punch and last_punch.gate_type == "ENTRY") else "OUTSIDE"

            # Notify WebSocket broadcast
            if self.ws_broadcast_callback:
                asyncio.run(self.ws_broadcast_callback({
                    "event": "NEW_PUNCH",
                    "data": {
                        "log_id": log.id,
                        "bio_user_id": user.bio_user_id,
                        "user_id": user.id,
                        "user_name": user.name,
                        "role_title": user.role_title,
                        "department": user.department,
                        "gate_type": log.gate_type,
                        "device_name": log.device_name,
                        "verify_mode": log.verify_mode,
                        "timestamp": log.timestamp.isoformat(),
                        "current_status": current_status,
                        "entry_count": entry_count,
                        "exit_count": exit_count,
                        "total_today": entry_count + exit_count
                    }
                }))

            return log
        finally:
            if close_session:
                db.close()

    def start_background_polling(self):
        """Continuously checks both Gate devices on the network every 8 seconds."""
        if self.polling_thread and self.polling_thread.is_alive():
            return

        import socket
        import subprocess

        def _poll_worker():
            while self.polling_active:
                try:
                    db = SessionLocal()
                    devices = db.query(DeviceSetting).filter(DeviceSetting.is_enabled == True).all()
                    for dev in devices:
                        is_online = False
                        
                        # 1. Fast socket check
                        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                        s.settimeout(1.0)
                        try:
                            s.connect((dev.ip_address, dev.port))
                            is_online = True
                            s.close()
                        except Exception:
                            pass

                        # 2. If port is 80, fast HTTP check
                        if not is_online and dev.port == 80:
                            try:
                                import requests
                                r = requests.get(f"http://{dev.ip_address}/", timeout=1.0)
                                if r.status_code in [200, 401, 302, 403]:
                                    is_online = True
                            except Exception:
                                pass

                        # 3. If port is 4370, pyzk check
                        if dev.port == 4370:
                            try:
                                zk_inst = ZK(dev.ip_address, port=dev.port, timeout=2, ommit_ping=True)
                                conn = zk_inst.connect()
                                is_online = True
                                records = conn.get_attendance()
                                for att in records:
                                    user_pin = str(att.user_id).strip()
                                    punch_time = att.timestamp
                                    exists = db.query(GateLog).filter(
                                        GateLog.bio_user_id == user_pin,
                                        GateLog.timestamp == punch_time,
                                        GateLog.device_key == dev.device_key
                                    ).first()
                                    if not exists:
                                        self.record_punch(
                                            bio_user_id=user_pin,
                                            gate_type=dev.gate_type,
                                            verify_mode="Fingerprint",
                                            device_key=dev.device_key,
                                            punch_time=punch_time,
                                            db=db
                                        )
                                conn.disconnect()
                            except Exception:
                                pass

                        # 4. Fallback ICMP ping
                        if not is_online:
                            try:
                                res = subprocess.run(["ping", "-n", "1", "-w", "500", dev.ip_address], capture_output=True)
                                if res.returncode == 0:
                                    is_online = True
                            except Exception:
                                pass

                        dev.last_status = "ONLINE" if is_online else "OFFLINE"
                        if is_online:
                            dev.last_connected_at = datetime.datetime.utcnow()
                        db.commit()
                    db.close()
                except Exception:
                    pass
                time.sleep(8)

        self.polling_thread = threading.Thread(target=_poll_worker, daemon=True)
        self.polling_thread.start()

    def toggle_simulation(self, enable: bool) -> bool:
        self.simulation_active = enable
        if enable and (not self.simulation_thread or not self.simulation_thread.is_alive()):
            def _sim_worker():
                while self.simulation_active:
                    time.sleep(random.randint(6, 12))
                    if not self.simulation_active:
                        break
                    try:
                        db = SessionLocal()
                        users = db.query(User).filter(User.is_active == True).all()
                        if users:
                            target_user = random.choice(users)
                            # Check user's current status
                            today_start = datetime.datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
                            last_punch = db.query(GateLog).filter(
                                GateLog.bio_user_id == target_user.bio_user_id,
                                GateLog.timestamp >= today_start,
                                GateLog.is_deleted == False
                            ).order_by(GateLog.timestamp.desc()).first()

                            gate_type = "EXIT" if (last_punch and last_punch.gate_type == "ENTRY") else "ENTRY"
                            dev_key = "entry_gate" if gate_type == "ENTRY" else "exit_gate"
                            
                            self.record_punch(
                                bio_user_id=target_user.bio_user_id,
                                gate_type=gate_type,
                                verify_mode=random.choice(["Fingerprint", "Face", "Card"]),
                                device_key=dev_key,
                                db=db,
                                note="Live Simulation Feed"
                            )
                        db.close()
                    except Exception:
                        pass

            self.simulation_thread = threading.Thread(target=_sim_worker, daemon=True)
            self.simulation_thread.start()
        return self.simulation_active

biometric_manager = BiometricManager()
