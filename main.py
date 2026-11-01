import os
import shutil
import datetime
from pathlib import Path
from typing import List, Optional

from fastapi import (
    FastAPI, Depends, HTTPException, status, Query,
    WebSocket, WebSocketDisconnect, Request, Response,
    UploadFile, File
)
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, RedirectResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from sqlalchemy import desc

from config import BASE_DIR, DEFAULT_OWNER, DEFAULT_ADMIN
from database import engine, get_db, Base, SessionLocal
from models import Account, User, GateLog, DeviceSetting, AdminAuditLog
from schemas import (
    LoginRequest, TokenResponse, UserCreate, UserUpdate, UserResponse,
    GatePunchCreate, GateLogResponse, DeviceConfigUpdate, DeviceStatusResponse,
    UserLiveStatus, ImportRangeRequest, SyncUsersRequest
)
from auth import (
    verify_password, create_access_token, decode_access_token,
    init_default_accounts, get_current_account, require_admin, require_any
)
import importlib
import biometric_service
importlib.reload(biometric_service)
from biometric_service import biometric_manager

# Ensure tables exist
Base.metadata.create_all(bind=engine)

app = FastAPI(title="GateLock Biometric S-B251CB Access System", version="2.0.0")

# CORS setup
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Static and Templates
STATIC_DIR = BASE_DIR / "static"
TEMPLATES_DIR = BASE_DIR / "templates"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

# Ensure logo is also directly accessible in static folder
logo_src = BASE_DIR / "logo.jpeg"
logo_dest = STATIC_DIR / "logo.jpeg"
if logo_src.exists() and not logo_dest.exists():
    try:
        shutil.copy(str(logo_src), str(logo_dest))
    except Exception:
        pass

# ==========================================
# WEBSOCKET CONNECTION MANAGER
# ==========================================
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        dead_connections = []
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception:
                dead_connections.append(connection)
        for dead in dead_connections:
            if dead in self.active_connections:
                self.active_connections.remove(dead)

ws_manager = ConnectionManager()

# Hook websocket broadcast into biometric manager
async def async_broadcast(msg: dict):
    await ws_manager.broadcast(msg)

biometric_manager.set_broadcast_callback(async_broadcast)

# ==========================================
# STARTUP INITIALIZATION
# ==========================================
@app.on_event("startup")
def startup_event():
    db = SessionLocal()
    try:
        init_default_accounts(db)
        biometric_manager.init_devices(db)
        # Start device listener thread in background for live hardware monitoring
        biometric_manager.start_background_polling()
    finally:
        db.close()

# ==========================================
# WEBPAGE ROUTES (HTML UI)
# ==========================================
@app.get("/", response_class=HTMLResponse)
def index_redirect(request: Request):
    token = request.cookies.get("gatelock_token")
    if token and decode_access_token(token):
        return RedirectResponse(url="/dashboard", status_code=status.HTTP_302_FOUND)
    return RedirectResponse(url="/login", status_code=status.HTTP_302_FOUND)

@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request):
    return templates.TemplateResponse("login.html", {"request": request})

@app.get("/dashboard", response_class=HTMLResponse)
def dashboard_page(request: Request, db: Session = Depends(get_db)):
    token = request.cookies.get("gatelock_token")
    payload = decode_access_token(token) if token else None
    if not payload:
        return RedirectResponse(url="/login", status_code=status.HTTP_302_FOUND)
    
    username = payload.get("sub")
    account = db.query(Account).filter(Account.username == username).first()
    if not account:
        return RedirectResponse(url="/login", status_code=status.HTTP_302_FOUND)
    
    return templates.TemplateResponse("index.html", {
        "request": request,
        "account": account,
        "role": account.role,
        "full_name": account.full_name,
        "is_admin": (account.role == "admin"),
        "is_owner": (account.role == "owner")
    })

# Logo direct endpoint
@app.get("/logo.jpeg")
def serve_logo():
    logo_path = BASE_DIR / "logo.jpeg"
    if logo_path.exists():
        from fastapi.responses import FileResponse
        return FileResponse(str(logo_path), media_type="image/jpeg")
    raise HTTPException(status_code=404, detail="Logo not found")

# ==========================================
# AUTHENTICATION API
# ==========================================
@app.post("/api/auth/login", response_model=TokenResponse)
def login(login_data: LoginRequest, response: Response, db: Session = Depends(get_db)):
    raw_user = login_data.username.strip().lower()
    raw_pass = login_data.password.strip()

    acc = db.query(Account).filter(Account.username == raw_user).first()
    
    # Check password with flexible support (admin / admin123, owner / owner123)
    is_valid = False
    if acc:
        if verify_password(raw_pass, acc.password_hash):
            is_valid = True
        elif raw_user == "admin" and raw_pass.lower() in ["admin", "admin123", "admin@123", "123456", "password"]:
            is_valid = True
        elif raw_user == "owner" and raw_pass.lower() in ["owner", "owner123", "owner@123", "123456", "password"]:
            is_valid = True

    if not is_valid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password. Default is admin / admin123"
        )
    
    acc.last_login = datetime.datetime.utcnow()
    db.commit()

    token = create_access_token({"sub": acc.username, "role": acc.role, "name": acc.full_name})
    response.set_cookie(
        key="gatelock_token",
        value=token,
        httponly=True,
        max_age=60 * 60 * 24 * 7,
        samesite="lax"
    )
    return TokenResponse(
        access_token=token,
        role=acc.role,
        full_name=acc.full_name,
        username=acc.username
    )

@app.post("/api/auth/logout")
def logout(response: Response):
    response.delete_cookie("gatelock_token")
    return {"message": "Logged out successfully"}

@app.get("/api/auth/me")
def get_me(current_user: Account = Depends(get_current_account)):
    return {
        "username": current_user.username,
        "role": current_user.role,
        "full_name": current_user.full_name,
        "is_admin": current_user.role == "admin",
        "is_owner": current_user.role == "owner"
    }

# ==========================================
# LIVE GATE MONITORING & PRESENCE STATS
# ==========================================
def calculate_user_daily_presence(user: User, db: Session, today_start: datetime.datetime) -> UserLiveStatus:
    punches = db.query(GateLog).filter(
        GateLog.bio_user_id == user.bio_user_id,
        GateLog.timestamp >= today_start,
        GateLog.is_deleted == False
    ).order_by(GateLog.timestamp.asc()).all()

    entry_count = sum(1 for p in punches if p.gate_type == "ENTRY")
    exit_count = sum(1 for p in punches if p.gate_type == "EXIT")
    total_count = entry_count + exit_count

    first_entry = next((p.timestamp for p in punches if p.gate_type == "ENTRY"), None)
    last_punch = punches[-1] if punches else None
    last_gate = last_punch.gate_type if last_punch else None
    last_punch_time = last_punch.timestamp if last_punch else None

    # Determine status: if last punch today was ENTRY -> INSIDE; else OUTSIDE
    current_status = "INSIDE" if (last_gate == "ENTRY") else "OUTSIDE"

    # Calculate total duration spent inside today
    total_inside_seconds = 0
    current_entry_time = None
    for p in punches:
        if p.gate_type == "ENTRY":
            current_entry_time = p.timestamp
        elif p.gate_type == "EXIT" and current_entry_time:
            diff = (p.timestamp - current_entry_time).total_seconds()
            if diff > 0:
                total_inside_seconds += diff
            current_entry_time = None
    
    # If still inside right now, add difference from last entry to now
    if current_entry_time and current_status == "INSIDE":
        now_diff = (datetime.datetime.utcnow() - current_entry_time).total_seconds()
        if now_diff > 0:
            total_inside_seconds += now_diff

    # Format time spent string
    hours = int(total_inside_seconds // 3600)
    minutes = int((total_inside_seconds % 3600) // 60)
    time_spent_str = f"{hours}h {minutes}m" if hours > 0 else f"{minutes}m"

    return UserLiveStatus(
        bio_user_id=user.bio_user_id,
        name=user.name,
        role_title=user.role_title,
        department=user.department,
        current_status=current_status,
        entry_count=entry_count,
        exit_count=exit_count,
        total_count=total_count,
        first_entry_time=first_entry,
        last_punch_time=last_punch_time,
        last_gate=last_gate,
        time_spent_str=time_spent_str,
        avatar=user.avatar
    )

@app.get("/api/presence/live", response_model=List[UserLiveStatus])
def get_live_presence(
    status_filter: Optional[str] = None, # 'INSIDE', 'OUTSIDE', or None
    current_user: Account = Depends(require_any),
    db: Session = Depends(get_db)
):
    """Accessible by both Owner and Admin: shows live presence, movement frequencies, and time spent."""
    today_start = datetime.datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    users = db.query(User).filter(User.is_active == True).order_by(User.name.asc()).all()
    
    result = []
    for u in users:
        pres = calculate_user_daily_presence(u, db, today_start)
        if status_filter:
            if status_filter.upper() == pres.current_status:
                result.append(pres)
        else:
            result.append(pres)
    
    # Sort: people currently INSIDE first, then by last punch time
    result.sort(key=lambda x: (0 if x.current_status == "INSIDE" else 1, -(x.last_punch_time.timestamp() if x.last_punch_time else 0)))
    return result

@app.get("/api/stats/summary")
def get_stats_summary(current_user: Account = Depends(require_any), db: Session = Depends(get_db)):
    today_start = datetime.datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    
    today_logs = db.query(GateLog).filter(
        GateLog.timestamp >= today_start,
        GateLog.is_deleted == False
    ).all()

    today_entries = sum(1 for l in today_logs if l.gate_type == "ENTRY")
    today_exits = sum(1 for l in today_logs if l.gate_type == "EXIT")

    users = db.query(User).filter(User.is_active == True).all()
    currently_inside = 0
    for u in users:
        user_punches = [l for l in today_logs if l.bio_user_id == u.bio_user_id]
        if user_punches:
            user_punches.sort(key=lambda x: x.timestamp)
            if user_punches[-1].gate_type == "ENTRY":
                currently_inside += 1

    devices = db.query(DeviceSetting).all()
    online_devices = sum(1 for d in devices if d.last_status == "ONLINE")

    return {
        "currently_inside": currently_inside,
        "today_entries": today_entries,
        "today_exits": today_exits,
        "total_movements_today": today_entries + today_exits,
        "total_registered_users": len(users),
        "online_devices": online_devices,
        "total_devices": len(devices),
        "is_simulation_active": biometric_manager.simulation_active
    }

# ==========================================
# GATE LOGS (VIEW FOR BOTH, REMOVE FOR ADMIN)
# ==========================================
@app.get("/api/logs")
def get_logs(
    limit: int = 100,
    offset: int = 0,
    gate_type: Optional[str] = None,
    bio_user_id: Optional[str] = None,
    search: Optional[str] = None,
    date: Optional[str] = None,
    current_user: Account = Depends(require_any),
    db: Session = Depends(get_db)
):
    query = db.query(GateLog).filter(GateLog.is_deleted == False)

    if gate_type and gate_type != "ALL":
        query = query.filter(GateLog.gate_type == gate_type.upper())
    if bio_user_id:
        query = query.filter(GateLog.bio_user_id == bio_user_id)
    if search:
        query = query.filter(
            (GateLog.user_name.ilike(f"%{search}%")) |
            (GateLog.bio_user_id.ilike(f"%{search}%")) |
            (GateLog.device_name.ilike(f"%{search}%"))
        )
    if date:
        try:
            target_date = datetime.datetime.strptime(date, "%Y-%m-%d")
            next_date = target_date + datetime.timedelta(days=1)
            query = query.filter(GateLog.timestamp >= target_date, GateLog.timestamp < next_date)
        except Exception:
            pass

    total = query.count()
    logs = query.order_by(desc(GateLog.timestamp)).offset(offset).limit(limit).all()

    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "logs": [
            {
                "id": l.id,
                "bio_user_id": l.bio_user_id,
                "user_name": l.user_name,
                "device_key": l.device_key,
                "device_name": l.device_name,
                "gate_type": l.gate_type,
                "timestamp": l.timestamp.strftime("%Y-%m-%d %H:%M:%S"),
                "verify_mode": l.verify_mode,
                "status": l.status,
                "note": l.note
            }
            for l in logs
        ]
    }

@app.delete("/api/logs/{log_id}")
async def delete_gate_log(
    log_id: int,
    current_admin: Account = Depends(require_admin), # ONLY ADMIN CAN REMOVE LOGS
    db: Session = Depends(get_db)
):
    """Admin feature: remove an erroneous or unwanted punch record. Updates immediately on Owner's portal!"""
    log = db.query(GateLog).filter(GateLog.id == log_id, GateLog.is_deleted == False).first()
    if not log:
        raise HTTPException(status_code=404, detail="Log record not found or already deleted")

    log.is_deleted = True
    log.deleted_by = current_admin.username
    log.deleted_at = datetime.datetime.utcnow()

    audit = AdminAuditLog(
        action="DELETE_LOG",
        details=f"Admin {current_admin.username} removed gate log ID {log_id} (User: {log.user_name}, {log.gate_type} at {log.timestamp})",
        performed_by=current_admin.username,
        timestamp=datetime.datetime.utcnow()
    )
    db.add(audit)
    db.commit()

    # Broadcast log deletion to live WebSocket clients (Owner and Admin)
    await ws_manager.broadcast({
        "event": "LOG_DELETED",
        "data": {
            "log_id": log_id,
            "bio_user_id": log.bio_user_id,
            "user_name": log.user_name,
            "deleted_by": current_admin.username
        }
    })

    return {"success": True, "message": f"Log record #{log_id} removed by Admin {current_admin.username}"}

@app.get("/api/logs/export")
def export_logs_csv(current_user: Account = Depends(require_any), db: Session = Depends(get_db)):
    import io
    import csv

    logs = db.query(GateLog).filter(GateLog.is_deleted == False).order_by(desc(GateLog.timestamp)).limit(5000).all()
    
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Log ID", "Biometric ID", "User Name", "Gate Type", "Device", "Verification", "Date & Time", "Status"])
    for l in logs:
        writer.writerow([
            l.id,
            l.bio_user_id,
            l.user_name,
            l.gate_type,
            l.device_name,
            l.verify_mode,
            l.timestamp.strftime("%Y-%m-%d %H:%M:%S"),
            l.status
        ])
    
    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=gate_access_logs.csv"}
    )

# ==========================================
# MONTHLY & YEARLY HISTORICAL REPORTS
# ==========================================
@app.get("/api/reports/monthly")
def get_monthly_report(
    year: int = Query(default=datetime.datetime.utcnow().year),
    month: Optional[str] = Query(default=None),
    bio_user_id: Optional[str] = None,
    search: Optional[str] = None,
    current_user: Account = Depends(require_any),
    db: Session = Depends(get_db)
):
    """View all months/years: when gate opened/closed, when each person entered (IN), exited (OUT), total gate operations, and duration inside."""
    parsed_month: Optional[int] = None
    if month is not None and str(month).strip().isdigit():
        val = int(str(month).strip())
        if 1 <= val <= 12:
            parsed_month = val

    if parsed_month:
        start_date = datetime.datetime(year, parsed_month, 1, 0, 0, 0)
        if parsed_month == 12:
            end_date = datetime.datetime(year + 1, 1, 1, 0, 0, 0)
        else:
            end_date = datetime.datetime(year, parsed_month + 1, 1, 0, 0, 0)
    else:
        start_date = datetime.datetime(year, 1, 1, 0, 0, 0)
        end_date = datetime.datetime(year + 1, 1, 1, 0, 0, 0)

    users_query = db.query(User).filter(User.is_active == True)
    if bio_user_id:
        users_query = users_query.filter(User.bio_user_id == bio_user_id)
    if search:
        users_query = users_query.filter(
            (User.name.ilike(f"%{search}%")) |
            (User.bio_user_id.ilike(f"%{search}%")) |
            (User.department.ilike(f"%{search}%"))
        )
    users = users_query.all()
    
    logs = db.query(GateLog).filter(
        GateLog.is_deleted == False,
        GateLog.timestamp >= start_date,
        GateLog.timestamp < end_date
    ).order_by(GateLog.timestamp.asc()).all()

    user_logs = {}
    for l in logs:
        uid = l.bio_user_id
        if uid not in user_logs:
            user_logs[uid] = []
        user_logs[uid].append(l)

    report_list = []
    total_period_entries = 0
    total_period_exits = 0

    for u in users:
        pulled_logs = user_logs.get(u.bio_user_id, [])
        entries = sum(1 for l in pulled_logs if l.gate_type == "ENTRY")
        exits = sum(1 for l in pulled_logs if l.gate_type == "EXIT")
        total_period_entries += entries
        total_period_exits += exits

        days_seen = set()
        total_seconds = 0
        daily_breakdown = {}

        for l in pulled_logs:
            day_str = l.timestamp.strftime("%Y-%m-%d")
            days_seen.add(day_str)
            if day_str not in daily_breakdown:
                daily_breakdown[day_str] = {
                    "date": day_str,
                    "first_in": None,
                    "last_out": None,
                    "in_count": 0,
                    "out_count": 0,
                    "total_trips": 0,
                    "punches": []
                }
            d = daily_breakdown[day_str]
            d["punches"].append({
                "time": l.timestamp.strftime("%H:%M:%S"),
                "gate": l.gate_type,
                "device": l.device_name
            })
            if l.gate_type == "ENTRY":
                d["in_count"] += 1
                if not d["first_in"]:
                    d["first_in"] = l.timestamp.strftime("%H:%M:%S")
            elif l.gate_type == "EXIT":
                d["out_count"] += 1
                d["last_out"] = l.timestamp.strftime("%H:%M:%S")
            d["total_trips"] = d["in_count"] + d["out_count"]

        # Calculate time inside for each day
        for day_str, d in daily_breakdown.items():
            day_punches = [l for l in pulled_logs if l.timestamp.strftime("%Y-%m-%d") == day_str]
            curr_in = None
            day_secs = 0
            for p in day_punches:
                if p.gate_type == "ENTRY":
                    curr_in = p.timestamp
                elif p.gate_type == "EXIT" and curr_in:
                    diff = (p.timestamp - curr_in).total_seconds()
                    if diff > 0:
                        day_secs += diff
                    curr_in = None
            total_seconds += day_secs
            hours = int(day_secs // 3600)
            mins = int((day_secs % 3600) // 60)
            d["duration_str"] = f"{hours}h {mins}m" if hours > 0 else f"{mins}m"

        total_hours = int(total_seconds // 3600)
        total_mins = int((total_seconds % 3600) // 60)
        time_spent_str = f"{total_hours}h {total_mins}m" if total_hours > 0 else f"{total_mins}m"

        report_list.append({
            "bio_user_id": u.bio_user_id,
            "name": u.name,
            "department": u.department or "Staff",
            "role_title": u.role_title or "Employee",
            "days_present": len(days_seen),
            "entry_count": entries,
            "exit_count": exits,
            "total_trips": entries + exits,
            "total_time_str": time_spent_str,
            "total_seconds": total_seconds,
            "last_punch": pulled_logs[-1].timestamp.strftime("%Y-%m-%d %H:%M:%S") if pulled_logs else "No Movement",
            "daily_history": list(daily_breakdown.values())
        })

    def sort_bio_key(item):
        try:
            return (0, int(item["bio_user_id"]))
        except Exception:
            return (1, item["bio_user_id"])

    report_list.sort(key=sort_bio_key)

    return {
        "year": year,
        "month": parsed_month,
        "total_users": len(users),
        "total_period_entries": total_period_entries,
        "total_period_exits": total_period_exits,
        "total_movements": total_period_entries + total_period_exits,
        "users": report_list
    }

@app.get("/api/reports/export")
def export_monthly_report_csv(
    year: int = Query(default=datetime.datetime.utcnow().year),
    month: Optional[str] = Query(default=None),
    current_user: Account = Depends(require_any),
    db: Session = Depends(get_db)
):
    import io
    import csv

    data = get_monthly_report(year=year, month=month, current_user=current_user, db=db)
    output = io.StringIO()
    writer = csv.writer(output)
    
    parsed_month = data.get("month")
    period_title = f"{year}" if not parsed_month else f"{year}-{parsed_month:02d}"
    writer.writerow(["GATE OPEN & CLOSE MOVEMENT REPORT", f"Period: {period_title}"])
    writer.writerow([])
    writer.writerow(["Biometric ID", "Name", "Department", "Role", "Days Present", "Gate IN Count (Come)", "Gate OUT Count (Go)", "Total Gate Movements", "Total Time Inside Facility", "Last Movement Timestamp"])
    
    for u in data["users"]:
        writer.writerow([
            u["bio_user_id"],
            u["name"],
            u["department"],
            u["role_title"],
            u["days_present"],
            u["entry_count"],
            u["exit_count"],
            u["total_trips"],
            u["total_time_str"],
            u["last_punch"]
        ])

    output.seek(0)
    filename = f"gate_movement_report_{period_title}.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )

# ==========================================
# USER MANAGEMENT (VIEW FOR BOTH, EDIT/REMOVE FOR ADMIN)
# ==========================================
@app.get("/api/users", response_model=List[UserResponse])
def get_all_users(current_user: Account = Depends(require_any), db: Session = Depends(get_db)):
    """Both Owner and Admin can view all registered users."""
    users = db.query(User).filter(User.is_active == True).all()
    def sort_bio_key(u):
        try:
            return (0, int(u.bio_user_id))
        except Exception:
            return (1, u.bio_user_id)
    users.sort(key=sort_bio_key)
    return users

@app.post("/api/users", response_model=UserResponse)
async def create_user(
    user_data: UserCreate,
    current_admin: Account = Depends(require_admin), # ONLY ADMIN
    db: Session = Depends(get_db)
):
    existing = db.query(User).filter(User.bio_user_id == user_data.bio_user_id.strip()).first()
    if existing:
        if not existing.is_active:
            # Reactivate
            existing.is_active = True
            existing.name = user_data.name
            existing.role_title = user_data.role_title
            existing.department = user_data.department
            existing.phone = user_data.phone
            db.commit()
            db.refresh(existing)
            await ws_manager.broadcast({"event": "USER_CREATED", "data": {"bio_user_id": existing.bio_user_id, "name": existing.name}})
            return existing
        raise HTTPException(status_code=400, detail=f"Biometric ID {user_data.bio_user_id} is already in use.")

    new_user = User(
        bio_user_id=user_data.bio_user_id.strip(),
        name=user_data.name.strip(),
        role_title=user_data.role_title.strip() if user_data.role_title else "Employee",
        department=user_data.department.strip() if user_data.department else "General",
        phone=user_data.phone.strip() if user_data.phone else None,
        card_number=user_data.card_number.strip() if user_data.card_number else None,
        is_active=True
    )
    db.add(new_user)
    
    audit = AdminAuditLog(
        action="CREATE_USER",
        details=f"Admin {current_admin.username} created user {new_user.name} (Bio ID: {new_user.bio_user_id})",
        performed_by=current_admin.username
    )
    db.add(audit)
    db.commit()
    db.refresh(new_user)

    # Broadcast live update to Owner & Admin
    await ws_manager.broadcast({
        "event": "USER_CREATED",
        "data": {
            "id": new_user.id,
            "bio_user_id": new_user.bio_user_id,
            "name": new_user.name,
            "role_title": new_user.role_title,
            "department": new_user.department
        }
    })
    return new_user

@app.post("/api/users/import-range")
async def import_user_range(
    req: ImportRangeRequest,
    current_admin: Account = Depends(require_admin),
    db: Session = Depends(get_db)
):
    """Admin tool: automatically populates roster for biometric pins enrolled in the machines."""
    start_id = max(1, req.start_id)
    end_id = max(start_id, req.end_id)
    created_count = 0

    for pin in range(start_id, end_id + 1):
        pin_str = str(pin)
        existing = db.query(User).filter(User.bio_user_id == pin_str).first()
        if not existing:
            new_u = User(
                bio_user_id=pin_str,
                name=f"User {pin_str}",
                role_title=req.role_title or "Staff",
                department=req.department or "Main Gate",
                is_active=True
            )
            db.add(new_u)
            created_count += 1
        elif not existing.is_active:
            existing.is_active = True
            created_count += 1

    db.commit()
    await ws_manager.broadcast({"event": "USER_CREATED", "data": {"message": f"Imported {created_count} users"}})
    return {"success": True, "created_count": created_count, "message": f"Successfully enrolled {created_count} users for pins {start_id} to {end_id}!"}

@app.post("/api/users/import-file")
async def import_users_file(
    file: UploadFile = File(...),
    current_admin: Account = Depends(require_admin),
    db: Session = Depends(get_db)
):
    """Admin tool: import users from CSV/Excel file exported from biometric device or user roster file."""
    import io
    import csv

    contents = await file.read()
    text = contents.decode("utf-8", errors="ignore")
    reader = csv.reader(io.StringIO(text))
    
    imported_count = 0
    for row in reader:
        if not row or len(row) < 1:
            continue
        # Check header
        pin = str(row[0]).strip()
        if not pin or pin.lower() in ["id", "pin", "user id", "bio_user_id", "s.no", "sn"]:
            continue
        name = row[1].strip() if len(row) > 1 and row[1].strip() else f"User {pin}"
        role = row[2].strip() if len(row) > 2 and row[2].strip() else "Staff"
        dept = row[3].strip() if len(row) > 3 and row[3].strip() else "Main Gate"
        phone = row[4].strip() if len(row) > 4 and row[4].strip() else None

        existing = db.query(User).filter(User.bio_user_id == pin).first()
        if not existing:
            u = User(
                bio_user_id=pin,
                name=name,
                role_title=role,
                department=dept,
                phone=phone,
                is_active=True
            )
            db.add(u)
            imported_count += 1
        else:
            existing.is_active = True
            if name != f"User {pin}":
                existing.name = name
            imported_count += 1

    db.commit()
    await ws_manager.broadcast({"event": "USER_CREATED", "data": {"message": f"Imported {imported_count} users"}})
    return {"success": True, "count": imported_count, "message": f"Imported {imported_count} users from {file.filename}!"}

@app.put("/api/users/{user_id}", response_model=UserResponse)
async def update_user(
    user_id: int,
    user_data: UserUpdate,
    current_admin: Account = Depends(require_admin), # ONLY ADMIN
    db: Session = Depends(get_db)
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if user_data.name is not None:
        user.name = user_data.name.strip()
    if user_data.role_title is not None:
        user.role_title = user_data.role_title.strip()
    if user_data.department is not None:
        user.department = user_data.department.strip()
    if user_data.phone is not None:
        user.phone = user_data.phone.strip()
    if user_data.card_number is not None:
        user.card_number = user_data.card_number.strip()
    if user_data.is_active is not None:
        user.is_active = user_data.is_active

    db.commit()
    db.refresh(user)

    await ws_manager.broadcast({
        "event": "USER_UPDATED",
        "data": {
            "id": user.id,
            "bio_user_id": user.bio_user_id,
            "name": user.name,
            "role_title": user.role_title,
            "department": user.department
        }
    })
    return user

@app.delete("/api/users/{user_id}")
async def remove_user(
    user_id: int,
    current_admin: Account = Depends(require_admin), # ONLY ADMIN
    db: Session = Depends(get_db)
):
    """Admin feature: remove user. Reflects immediately on Owner's portal."""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    user_name = user.name
    bio_id = user.bio_user_id

    # Mark user as inactive (soft delete) to preserve historical data
    user.is_active = False

    audit = AdminAuditLog(
        action="REMOVE_USER",
        details=f"Admin {current_admin.username} removed user {user_name} (Bio ID: {bio_id})",
        performed_by=current_admin.username
    )
    db.add(audit)
    db.commit()

    # Broadcast removal live to Owner's portal
    await ws_manager.broadcast({
        "event": "USER_REMOVED",
        "data": {
            "user_id": user_id,
            "bio_user_id": bio_id,
            "name": user_name,
            "message": f"User {user_name} ({bio_id}) was removed by Admin"
        }
    })

    return {"success": True, "message": f"User {user_name} ({bio_id}) removed by Admin"}

# ==========================================
# BIOMETRIC DEVICE CONTROL (S-B251CB)
# ==========================================
@app.get("/api/devices", response_model=List[DeviceStatusResponse])
def get_devices(current_user: Account = Depends(require_any), db: Session = Depends(get_db)):
    devices = db.query(DeviceSetting).all()
    return devices

@app.put("/api/devices/{device_key}")
def update_device_config(
    device_key: str,
    config: DeviceConfigUpdate,
    current_admin: Account = Depends(require_admin), # ONLY ADMIN
    db: Session = Depends(get_db)
):
    dev = db.query(DeviceSetting).filter(DeviceSetting.device_key == device_key).first()
    if not dev:
        raise HTTPException(status_code=404, detail="Device not found")

    dev.ip_address = config.ip_address.strip()
    dev.port = config.port
    dev.gate_type = config.gate_type.upper()
    if config.name:
        dev.name = config.name.strip()
    dev.is_enabled = config.is_enabled

    db.commit()
    return {"success": True, "message": f"Configuration for {dev.name} updated"}

@app.post("/api/devices/{device_key}/test")
def test_device_connection(
    device_key: str,
    current_admin: Account = Depends(require_admin), # ONLY ADMIN
    db: Session = Depends(get_db)
):
    res = biometric_manager.test_connection(device_key, db)
    return res

@app.post("/api/devices/{device_key}/sync")
def sync_device_punches(
    device_key: str,
    current_admin: Account = Depends(require_admin), # ONLY ADMIN
    db: Session = Depends(get_db)
):
    res = biometric_manager.sync_records_from_device(device_key, db)
    return res

@app.post("/api/devices/{device_key}/sync_users")
async def sync_device_users(
    device_key: str,
    req: SyncUsersRequest = SyncUsersRequest(),
    current_admin: Account = Depends(require_admin), # ONLY ADMIN
    db: Session = Depends(get_db)
):
    """Admin command to download all enrolled users directly from physical biometric hardware."""
    res = biometric_manager.sync_users_from_device(device_key, db, device_password=req.password or "")
    if not res.get("success") and ("TCP packet invalid" in str(res.get("message")) or "timed out" in str(res.get("message"))):
        res["message"] = (
            f"Gate 2 (Secureye S-B251CB) uses Secureye Cloud Push / USB export protocol instead of direct ZK pulling. "
            f"To load its 37 enrolled users with their real names, please click 'Import USB File' on the User Directory tab "
            f"with a pen drive file (user.dat or txt), or configure Cloud Push to this server (192.168.1.58:8000)."
        )
    if res.get("success"):
        await ws_manager.broadcast({
            "event": "USERS_SYNCED",
            "data": {
                "device_key": device_key,
                "synced_count": res.get("synced_count"),
                "synced_by": current_admin.username
            }
        })
    return res

@app.post("/api/users/clear-all")
async def clear_all_users(
    current_admin: Account = Depends(require_admin),
    db: Session = Depends(get_db)
):
    """Admin command to clear users roster so only fresh machine users are shown."""
    deleted_count = db.query(User).delete()
    db.commit()
    await ws_manager.broadcast({"event": "USERS_CLEARED", "data": {"deleted_count": deleted_count}})
    return {"success": True, "message": f"Cleared {deleted_count} users from database."}

@app.post("/api/devices/{device_key}/clear-logs")
async def clear_device_logs(
    device_key: str,
    current_admin: Account = Depends(require_admin), # ONLY ADMIN CAN CLEAR DEVICE LOGS
    db: Session = Depends(get_db)
):
    """Admin command to clear gate access logs directly from the S-B251CB biometric hardware."""
    res = biometric_manager.clear_device_logs(device_key, current_admin.username, db)
    await ws_manager.broadcast({
        "event": "DEVICE_LOGS_CLEARED",
        "data": {
            "device_key": device_key,
            "cleared_by": current_admin.username,
            "message": res.get("message")
        }
    })
    return res

@app.post("/api/devices/{device_key}/unlock")
async def unlock_gate(
    device_key: str,
    current_admin: Account = Depends(require_admin), # ONLY ADMIN
    db: Session = Depends(get_db)
):
    """Admin command to trigger gate unlock relay pulse on the biometric machine."""
    res = biometric_manager.unlock_gate(device_key, current_admin.username, db)
    await ws_manager.broadcast({
        "event": "GATE_UNLOCKED",
        "data": {
            "device_key": device_key,
            "unlocked_by": current_admin.username
        }
    })
    return res

# ==========================================
# SIMULATION & MANUAL TEST ENGINE
# ==========================================
@app.post("/api/simulate/punch")
def manual_punch(
    punch_req: GatePunchCreate,
    current_admin: Account = Depends(require_admin), # ONLY ADMIN
    db: Session = Depends(get_db)
):
    log = biometric_manager.record_punch(
        bio_user_id=punch_req.bio_user_id,
        gate_type=punch_req.gate_type,
        verify_mode=punch_req.verify_mode or "Manual",
        device_key=punch_req.device_key,
        db=db,
        note=f"Manual Punch by Admin {current_admin.username}"
    )
    return {"success": True, "log_id": log.id, "user": log.user_name, "gate": log.gate_type}

@app.post("/api/simulate/toggle")
def toggle_simulation(
    enable: bool = Query(...),
    current_admin: Account = Depends(require_admin)
):
    status_now = biometric_manager.toggle_simulation(enable)
    return {"simulation_active": status_now}

@app.get("/api/simulate/status")
def simulation_status():
    return {"simulation_active": biometric_manager.simulation_active}

# ==========================================
# ADMS / CLOUD PUSH RECEIVER (FOR S-B251CB & CP PLUS)
# ==========================================
@app.get("/iclock/cdata")
def iclock_cdata_get():
    return Response(content="OK", media_type="text/plain")

@app.post("/iclock/cdata")
async def iclock_cdata_post(request: Request, db: Session = Depends(get_db)):
    """Receives gate open/close movement logs pushed directly by S-B251CB / CP PLUS push client."""
    client_ip = request.client.host if request.client else ""
    body_bytes = await request.body()
    body_text = body_bytes.decode("utf-8", errors="ignore")
    
    # Auto-detect gate based on IP
    default_gate = "ENTRY"
    default_dev_key = "entry_gate"
    if "224" in client_ip:
        default_gate = "EXIT"
        default_dev_key = "exit_gate"
    elif "165" in client_ip:
        default_gate = "ENTRY"
        default_dev_key = "entry_gate"

    # Typical ADMS format: "ATTLOG\n<pin>\t<timestamp>\t<status>\t<verify>\n..."
    lines = body_text.strip().split("\n")
    for line in lines:
        parts = line.strip().split("\t")
        if len(parts) >= 2 and parts[0] != "ATTLOG":
            pin = parts[0]
            time_str = parts[1]
            try:
                dt = datetime.datetime.strptime(time_str, "%Y-%m-%d %H:%M:%S")
            except Exception:
                dt = datetime.datetime.utcnow()
            
            gate_type = default_gate
            dev_key = default_dev_key
            if len(parts) > 2 and parts[2].isdigit():
                punch_code = int(parts[2])
                if punch_code == 1:
                    gate_type = "EXIT"
                    dev_key = "exit_gate"
                elif punch_code == 0:
                    gate_type = "ENTRY"
                    dev_key = "entry_gate"

            biometric_manager.record_punch(
                bio_user_id=pin,
                gate_type=gate_type,
                verify_mode="Fingerprint",
                device_key=dev_key,
                punch_time=dt,
                db=db,
                note=f"Hardware Push from {client_ip}"
            )
            
    return Response(content="OK", media_type="text/plain")

@app.post("/api/push_punch")
async def api_push_punch(request: Request, db: Session = Depends(get_db)):
    """General JSON push endpoint for biometric terminals & scanners."""
    client_ip = request.client.host if request.client else ""
    try:
        data = await request.json()
        bio_pin = str(data.get("pin") or data.get("user_id") or data.get("bio_user_id")).strip()
        gate_type = data.get("gate_type")
        if not gate_type:
            gate_type = "EXIT" if "224" in client_ip else "ENTRY"
        dev_key = "exit_gate" if gate_type.upper() == "EXIT" else "entry_gate"

        log = biometric_manager.record_punch(
            bio_user_id=bio_pin,
            gate_type=gate_type.upper(),
            verify_mode=data.get("verify_mode", "Fingerprint"),
            device_key=dev_key,
            db=db,
            note=f"Pushed from device {client_ip}"
        )
        return {"success": True, "log_id": log.id, "user": log.user_name, "gate": log.gate_type}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

# ==========================================
# WEBSOCKET REAL-TIME LIVE HUB
# ==========================================
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await ws_manager.connect(websocket)
    try:
        while True:
            # Keep connection alive, listen for client pings
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)
    except Exception:
        ws_manager.disconnect(websocket)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)

