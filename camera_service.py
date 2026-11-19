import os
import time
import socket
import asyncio
import datetime
import threading
import collections
import concurrent.futures
import urllib.parse
from typing import Optional, Dict, Any, List

import cv2
import numpy as np
from sqlalchemy.orm import Session

from database import SessionLocal
from models import CameraSetting, BagViolationLog, GateLog, User

COCO_CLASSES = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat", "traffic light",
    "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
    "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
    "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove", "skateboard", "surfboard",
    "tennis racket", "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple",
    "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
    "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse", "remote", "keyboard",
    "cell phone", "microwave", "oven", "toaster", "sink", "refrigerator", "book", "clock", "vase",
    "scissors", "teddy bear", "hair drier", "toothbrush"
]

BAG_CLASS_IDS = {
    24: "Backpack / Office Bag",
    26: "Handbag / Shoulder Bag",
    28: "Suitcase / Briefcase"
}

CAPTURES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "captures")
AI_MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ai_models", "yolov5n.onnx")
os.makedirs(CAPTURES_DIR, exist_ok=True)


class CameraAIManager:
    def __init__(self):
        self.net = None
        self.net_lock = threading.Lock()
        self.stream_active = False
        self.stream_thread: Optional[threading.Thread] = None
        self.latest_annotated_jpeg: Optional[bytes] = None
        self.latest_detections: List[Dict[str, Any]] = []
        self.frame_buffer = collections.deque(maxlen=36)  # ~4-5 seconds of frames at ~8 fps
        self.last_violation_time = 0.0
        self.violation_cooldown = 8.0  # seconds between automatic violation recordings
        self.ws_broadcast_callback = None
        self.current_status = "IDLE"
        self.current_error = ""
        self.fps = 0.0
        self._load_model()

    def set_broadcast_callback(self, callback):
        self.ws_broadcast_callback = callback

    def _load_model(self):
        try:
            if os.path.exists(AI_MODEL_PATH):
                self.net = cv2.dnn.readNetFromONNX(AI_MODEL_PATH)
        except Exception as e:
            print(f"[CameraAI] Warning loading ONNX model: {e}")

    def init_camera_settings(self, db: Session) -> CameraSetting:
        cam = db.query(CameraSetting).first()
        if not cam:
            cam = CameraSetting(
                name="Gate 1 Entry IP Camera",
                ip_address="192.168.1.164",
                port=554,
                username="admin",
                password="admin$2023",
                brand="cpplus",
                rtsp_url="",
                gate_type="ENTRY",
                is_enabled=True,
                last_status="IDLE"
            )
            db.add(cam)
            db.commit()
            db.refresh(cam)
        elif not cam.password:
            cam.password = "admin$2023"
            db.commit()
            db.refresh(cam)
        return cam

    def build_rtsp_urls(self, cam: CameraSetting) -> List[str]:
        if cam.brand == "webcam":
            return ["0"]
        if cam.rtsp_url and cam.rtsp_url.strip():
            raw_u = cam.rtsp_url.strip()
            # Ensure '$' in credentials inside custom rtsp://user:pass@ip is URL-encoded for FFmpeg
            if "://" in raw_u and "@" in raw_u:
                scheme, rest = raw_u.split("://", 1)
                creds, hostpart = rest.rsplit("@", 1)
                if ":" in creds:
                    cu, cp = creds.split(":", 1)
                    cp_enc = urllib.parse.quote(urllib.parse.unquote(cp), safe="")
                    raw_u = f"{scheme}://{cu}:{cp_enc}@{hostpart}"
            return [raw_u]

        ip = (cam.ip_address or "192.168.1.164").strip()
        port = cam.port or 554
        user = urllib.parse.quote((cam.username or "admin").strip(), safe="")
        pwd = urllib.parse.quote((cam.password or "admin$2023").strip(), safe="")
        auth = f"{user}:{pwd}@" if pwd else (f"{user}@" if user else "")

        urls = []
        if cam.brand == "cpplus":
            urls.append(f"rtsp://{auth}{ip}:{port}/cam/realmonitor?channel=1&subtype=0")
            urls.append(f"rtsp://{auth}{ip}:{port}/cam/realmonitor?channel=1&subtype=1")
            urls.append(f"rtsp://{auth}{ip}:{port}/Streaming/Channels/101")
            urls.append(f"rtsp://{auth}{ip}:{port}/stream1")
        elif cam.brand == "hikvision":
            urls.append(f"rtsp://{auth}{ip}:{port}/Streaming/Channels/101")
            urls.append(f"rtsp://{auth}{ip}:{port}/Streaming/Channels/102")
            urls.append(f"rtsp://{auth}{ip}:{port}/cam/realmonitor?channel=1&subtype=0")
        else:
            urls.append(f"rtsp://{auth}{ip}:{port}/stream1")
            urls.append(f"rtsp://{auth}{ip}:{port}/cam/realmonitor?channel=1&subtype=0")
            urls.append(f"rtsp://{auth}{ip}:{port}/Streaming/Channels/101")
            urls.append(f"rtsp://{auth}{ip}:{port}/live/ch0")
        return urls

    def scan_lan_cameras(self, subnet_prefix: str = "192.168.1.") -> List[Dict[str, Any]]:
        """Scans the local 192.168.1.x subnet for devices with RTSP port 554 open."""
        ips = [f"{subnet_prefix}{i}" for i in range(2, 254)]

        def probe(ip: str):
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(0.35)
            try:
                s.connect((ip, 554))
                s.close()
                # Also check if port 80 is open
                http_open = False
                s2 = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s2.settimeout(0.25)
                try:
                    s2.connect((ip, 80))
                    http_open = True
                    s2.close()
                except Exception:
                    pass
                brand_guess = "CP PLUS / Dahua RTSP" if ip.startswith("192.168.1.16") or ip.startswith("192.168.1.17") else "IP Camera (RTSP 554)"
                return {
                    "ip": ip,
                    "rtsp_port": 554,
                    "http_port": 80 if http_open else None,
                    "brand_hint": brand_guess
                }
            except Exception:
                return None

        found = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=64) as ex:
            for res in ex.map(probe, ips):
                if res:
                    found.append(res)
        found.sort(key=lambda x: int(x["ip"].split(".")[-1]))
        return found

    def get_recent_gate_user(self, db: Session, window_seconds: int = 300) -> Dict[str, str]:
        """Finds the person who most recently punched at the biometric gate to link with the camera bag scan."""
        now = datetime.datetime.now()
        cutoff = now - datetime.timedelta(seconds=window_seconds)
        recent_log = db.query(GateLog).filter(
            GateLog.is_deleted == False,
            GateLog.timestamp >= cutoff
        ).order_by(GateLog.timestamp.desc()).first()

        if not recent_log:
            # Fallback to the last person who entered today so we still associate the active gate person if needed
            today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
            recent_log = db.query(GateLog).filter(
                GateLog.is_deleted == False,
                GateLog.timestamp >= today_start
            ).order_by(GateLog.timestamp.desc()).first()

        if recent_log:
            user = db.query(User).filter(User.bio_user_id == recent_log.bio_user_id).first()
            dept = user.department if user else "Entry Gate (Gate 1)"
            diff_sec = int(abs((now - recent_log.timestamp).total_seconds()))
            time_note = f"Matched Gate Punch ({diff_sec}s ago)" if diff_sec <= window_seconds else f"Last Gate Punch ({recent_log.timestamp.strftime('%H:%M:%S')})"
            return {
                "bio_user_id": recent_log.bio_user_id,
                "user_name": recent_log.user_name,
                "department": dept,
                "match_note": time_note
            }
        return {
            "bio_user_id": "UNMATCHED",
            "user_name": "Unidentified Person (No Recent Punch)",
            "department": "Main Gate",
            "match_note": "Detected by AI Camera without recent biometric punch"
        }

    def detect_objects_in_frame(self, frame: np.ndarray, conf_thresh: float = 0.30) -> List[Dict[str, Any]]:
        """Runs YOLOv5n ONNX inference on a BGR frame and returns detected objects."""
        if self.net is None:
            self._load_model()
        if self.net is None:
            return []

        h, w = frame.shape[:2]
        blob = cv2.dnn.blobFromImage(frame, 1 / 255.0, (640, 640), swapRB=True, crop=False)
        with self.net_lock:
            self.net.setInput(blob)
            preds = self.net.forward()[0]  # (25200, 85)

        # Filter by objectness score
        mask = preds[:, 4] >= conf_thresh
        rows = preds[mask]
        if len(rows) == 0:
            return []

        boxes = []
        confidences = []
        class_ids = []

        x_factor = w / 640.0
        y_factor = h / 640.0

        for row in rows:
            obj_conf = float(row[4])
            scores = row[5:]
            cid = int(np.argmax(scores))
            cls_score = float(scores[cid]) * obj_conf
            if cls_score >= conf_thresh:
                cx, cy, bw, bh = row[0], row[1], row[2], row[3]
                left = int((cx - 0.5 * bw) * x_factor)
                top = int((cy - 0.5 * bh) * y_factor)
                width = int(bw * x_factor)
                height = int(bh * y_factor)
                boxes.append([max(0, left), max(0, top), max(1, width), max(1, height)])
                confidences.append(cls_score)
                class_ids.append(cid)

        if not boxes:
            return []

        indices = cv2.dnn.NMSBoxes(boxes, confidences, conf_thresh, 0.45)
        detections = []
        if len(indices) > 0:
            for idx in indices.flatten():
                cid = class_ids[idx]
                label = COCO_CLASSES[cid] if cid < len(COCO_CLASSES) else f"object_{cid}"
                is_bag = cid in BAG_CLASS_IDS
                bag_label = BAG_CLASS_IDS.get(cid, label.title())
                detections.append({
                    "class_id": cid,
                    "label": label,
                    "display_name": bag_label if is_bag else label.title(),
                    "is_bag": is_bag,
                    "confidence": round(confidences[idx] * 100),
                    "box": boxes[idx]  # [x, y, w, h]
                })
        return detections

    def annotate_frame(
        self,
        frame: np.ndarray,
        detections: List[Dict[str, Any]],
        matched_user: Optional[Dict[str, str]] = None,
        cam_name: str = "Gate 1 Entry Camera"
    ) -> np.ndarray:
        canvas = frame.copy()
        h, w = canvas.shape[:2]

        has_bag = any(d["is_bag"] for d in detections)
        # Top HUD bar
        overlay = canvas.copy()
        bar_color = (20, 20, 180) if has_bag else (30, 25, 20)
        cv2.rectangle(overlay, (0, 0), (w, 42), bar_color, -1)
        cv2.addWeighted(overlay, 0.78, canvas, 0.22, 0, canvas)

        now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        header_text = f"AI SCAN: {cam_name} | {now_str}"
        if has_bag:
            user_str = f"{matched_user['user_name']} (ID: {matched_user['bio_user_id']})" if matched_user else "Unknown"
            header_text = f"BAG VIOLATION DETECTED! Person: {user_str} | {now_str}"

        cv2.putText(canvas, header_text, (12, 27), cv2.FONT_HERSHEY_SIMPLEX, 0.58, (255, 255, 255), 2, cv2.LINE_AA)

        for d in detections:
            x, y, bw, bh = d["box"]
            conf = d["confidence"]
            if d["is_bag"]:
                color = (0, 0, 255)  # Red for prohibited bags
                u_tag = f" - {matched_user['user_name']}" if matched_user else ""
                tag = f"PROHIBITED BAG: {d['display_name']} ({conf}%){u_tag}"
                thickness = 3
            elif d["label"] == "person":
                color = (16, 185, 129)  # Emerald green for person
                u_tag = f": {matched_user['user_name']} ({matched_user['bio_user_id']})" if matched_user else ""
                tag = f"PERSON{u_tag} ({conf}%)"
                thickness = 2
            else:
                color = (255, 165, 0)  # Blue/orange for other scanned objects
                tag = f"{d['display_name']} ({conf}%)"
                thickness = 2

            cv2.rectangle(canvas, (x, y), (x + bw, y + bh), color, thickness)
            (tw, th), _ = cv2.getTextSize(tag, cv2.FONT_HERSHEY_SIMPLEX, 0.52, 2)
            ty = max(y - 6, th + 48)
            cv2.rectangle(canvas, (x, ty - th - 6), (x + tw + 10, ty + 4), color, -1)
            cv2.putText(canvas, tag, (x + 5, ty - 2), cv2.FONT_HERSHEY_SIMPLEX, 0.52, (255, 255, 255), 2, cv2.LINE_AA)

        return canvas

    def save_violation_evidence(
        self,
        annotated_frame: np.ndarray,
        frames_clip: List[np.ndarray],
        detections: List[Dict[str, Any]],
        cam: CameraSetting,
        db: Session,
        custom_note: Optional[str] = None
    ) -> BagViolationLog:
        matched = self.get_recent_gate_user(db)
        bag_dets = [d for d in detections if d["is_bag"]]
        primary_bag = bag_dets[0]["display_name"] if bag_dets else "Office Bag / Backpack"
        max_conf = max((d["confidence"] for d in bag_dets), default=88)

        obj_counts: Dict[str, int] = {}
        for d in detections:
            obj_counts[d["display_name"]] = obj_counts.get(d["display_name"], 0) + 1
        summary_str = ", ".join(f"{cnt}x {name}" for name, cnt in obj_counts.items()) or "1x Person, 1x Bag"

        ts_slug = datetime.datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:18]
        safe_uid = "".join(c for c in matched["bio_user_id"] if c.isalnum() or c in "-_") or "USER"

        # 1. Save Annotated Snapshot JPEG
        snap_filename = f"bag_snap_{ts_slug}_{safe_uid}.jpg"
        snap_path = os.path.join(CAPTURES_DIR, snap_filename)
        cv2.imwrite(snap_path, annotated_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
        snapshot_url = f"/static/captures/{snap_filename}"

        # 2. Save Video Clip (WebM VP8 for native Chrome/Edge playback, fallback MP4)
        clip_url = None
        if frames_clip:
            ch, cw = frames_clip[0].shape[:2]
            for ext, codec in [("webm", "VP80"), ("mp4", "mp4v")]:
                clip_filename = f"bag_clip_{ts_slug}_{safe_uid}.{ext}"
                clip_path = os.path.join(CAPTURES_DIR, clip_filename)
                try:
                    fourcc = cv2.VideoWriter_fourcc(*codec)
                    writer = cv2.VideoWriter(clip_path, fourcc, 8.0, (cw, ch))
                    if writer and writer.isOpened():
                        for frm in frames_clip:
                            if frm.shape[:2] != (ch, cw):
                                frm = cv2.resize(frm, (cw, ch))
                            writer.write(frm)
                        writer.release()
                        if os.path.exists(clip_path) and os.path.getsize(clip_path) > 500:
                            clip_url = f"/static/captures/{clip_filename}"
                            break
                except Exception:
                    pass

        violation = BagViolationLog(
            bio_user_id=matched["bio_user_id"],
            user_name=matched["user_name"],
            department=matched["department"],
            camera_name=cam.name,
            camera_ip=cam.ip_address,
            bag_type=primary_bag,
            confidence=max_conf,
            detected_objects=summary_str,
            snapshot_url=snapshot_url,
            clip_url=clip_url,
            timestamp=datetime.datetime.now(),
            note=custom_note or matched["match_note"],
            is_deleted=False
        )
        db.add(violation)
        db.commit()
        db.refresh(violation)

        # Broadcast real-time WebSocket alert
        if self.ws_broadcast_callback:
            try:
                asyncio.run(self.ws_broadcast_callback({
                    "event": "BAG_VIOLATION",
                    "data": {
                        "id": violation.id,
                        "bio_user_id": violation.bio_user_id,
                        "user_name": violation.user_name,
                        "department": violation.department,
                        "camera_name": violation.camera_name,
                        "camera_ip": violation.camera_ip,
                        "bag_type": violation.bag_type,
                        "confidence": violation.confidence,
                        "detected_objects": violation.detected_objects,
                        "snapshot_url": violation.snapshot_url,
                        "clip_url": violation.clip_url,
                        "timestamp": violation.timestamp.strftime("%Y-%m-%d %H:%M:%S"),
                        "note": violation.note
                    }
                }))
            except Exception as e:
                print(f"[CameraAI] WS broadcast error: {e}")

        return violation

    def start_stream(self):
        if self.stream_active and self.stream_thread and self.stream_thread.is_alive():
            return
        self.stream_active = True
        self.stream_thread = threading.Thread(target=self._stream_worker, daemon=True)
        self.stream_thread.start()

    def stop_stream(self):
        self.stream_active = False
        self.current_status = "STOPPED"

    def _stream_worker(self):
        os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp|stimeout;3000000"
        while self.stream_active:
            db = SessionLocal()
            try:
                cam = self.init_camera_settings(db)
                urls = self.build_rtsp_urls(cam)
                cap = None
                connected_url = None
                self.current_status = "CONNECTING"
                for u in urls:
                    if not self.stream_active:
                        break
                    target = 0 if u == "0" else u
                    c = cv2.VideoCapture(target)
                    if c.isOpened():
                        ok, test_frame = c.read()
                        if ok and test_frame is not None:
                            cap = c
                            connected_url = u
                            break
                        c.release()

                if not cap:
                    self.current_status = "AUTH_OR_STREAM_NEEDED"
                    self.current_error = (
                        f"Camera {cam.ip_address}:{cam.port} is reachable on network, "
                        f"waiting for valid RTSP username/password or stream path."
                    )
                    cam.last_status = "AUTH_REQUIRED"
                    db.commit()
                    db.close()
                    time.sleep(4)
                    continue

                self.current_status = "STREAMING_AI"
                self.current_error = ""
                cam.last_status = "ONLINE"
                db.commit()

                frame_idx = 0
                last_dets: List[Dict[str, Any]] = []
                t0 = time.time()

                while self.stream_active:
                    ok, frame = cap.read()
                    if not ok or frame is None:
                        break
                    frame_idx += 1
                    # Resize large 1080p/4K frames to 640x360 for fast AI inference
                    fh, fw = frame.shape[:2]
                    if fw > 800:
                        scale = 640.0 / fw
                        frame = cv2.resize(frame, (640, int(fh * scale)))

                    # Run YOLOv5n every 2nd frame for smooth streaming
                    if frame_idx % 2 == 1:
                        last_dets = self.detect_objects_in_frame(frame, conf_thresh=0.30)
                        self.latest_detections = last_dets

                    matched_user = self.get_recent_gate_user(db) if any(d["is_bag"] or d["label"] == "person" for d in last_dets) else None
                    annotated = self.annotate_frame(frame, last_dets, matched_user, cam.name)
                    self.frame_buffer.append(annotated)

                    ok_jpg, buf = cv2.imencode(".jpg", annotated, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
                    if ok_jpg:
                        self.latest_annotated_jpeg = buf.tobytes()

                    # Check if a prohibited bag was detected
                    if any(d["is_bag"] for d in last_dets):
                        now_ts = time.time()
                        if now_ts - self.last_violation_time >= self.violation_cooldown:
                            self.last_violation_time = now_ts
                            clip_frames = list(self.frame_buffer)
                            self.save_violation_evidence(annotated, clip_frames, last_dets, cam, db)

                    dt = time.time() - t0
                    if dt > 0:
                        self.fps = round(1.0 / dt, 1)
                    t0 = time.time()
                    time.sleep(0.04)

                cap.release()
            except Exception as e:
                self.current_status = "ERROR"
                self.current_error = str(e)
            finally:
                db.close()
            time.sleep(2)


    def get_preview_jpeg(self, cam: CameraSetting) -> bytes:
        if self.latest_annotated_jpeg:
            return self.latest_annotated_jpeg

        # Render informative HUD frame when waiting for RTSP stream or credentials
        img = np.zeros((360, 640, 3), dtype=np.uint8)
        img[:] = (30, 24, 18)
        cv2.rectangle(img, (0, 0), (640, 44), (45, 35, 25), -1)
        now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        cv2.putText(img, f"AI BAG & OBJECT SCANNER | {cam.name}", (14, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.58, (255, 255, 255), 2, cv2.LINE_AA)
        cv2.putText(img, f"Camera IP: {cam.ip_address}:{cam.port} ({cam.brand.upper()})", (30, 110), cv2.FONT_HERSHEY_SIMPLEX, 0.62, (96, 165, 250), 2, cv2.LINE_AA)
        cv2.putText(img, f"Scanner Status: {self.current_status}", (30, 150), cv2.FONT_HERSHEY_SIMPLEX, 0.58, (52, 211, 153), 2, cv2.LINE_AA)
        cv2.putText(img, "AI Model: YOLOv5n COCO-80 (Person + Bag Policy Active)", (30, 190), cv2.FONT_HERSHEY_SIMPLEX, 0.52, (203, 213, 225), 1, cv2.LINE_AA)
        if self.current_error:
            cv2.putText(img, self.current_error[:68], (30, 235), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (120, 120, 255), 1, cv2.LINE_AA)
            if len(self.current_error) > 68:
                cv2.putText(img, self.current_error[68:136], (30, 258), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (120, 120, 255), 1, cv2.LINE_AA)
        cv2.putText(img, f"Rule: NO BAGS ALLOWED IN OFFICE | {now_str}", (30, 325), cv2.FONT_HERSHEY_SIMPLEX, 0.48, (148, 163, 184), 1, cv2.LINE_AA)
        _, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
        return buf.tobytes()

    def trigger_test_bag_violation(self, db: Session, bag_type: str = "Backpack / Office Bag") -> BagViolationLog:
        """Generates an animated gate entry clip + annotated snapshot matched to the latest biometric gate user."""
        cam = self.init_camera_settings(db)
        matched = self.get_recent_gate_user(db)

        frames = []
        dets = [
            {"class_id": 0, "label": "person", "display_name": "Person", "is_bag": False, "confidence": 94, "box": [210, 65, 190, 275]},
            {"class_id": 24, "label": "backpack", "display_name": bag_type, "is_bag": True, "confidence": 91, "box": [325, 130, 95, 125]},
            {"class_id": 67, "label": "cell phone", "display_name": "Cell Phone", "is_bag": False, "confidence": 82, "box": [185, 175, 32, 48]}
        ]

        for i in range(28):
            frm = np.zeros((360, 640, 3), dtype=np.uint8)
            frm[:] = (42, 38, 34)
            # Draw corridor / gate background
            cv2.rectangle(frm, (60, 40), (580, 340), (58, 52, 46), -1)
            cv2.rectangle(frm, (140, 40), (500, 340), (70, 64, 58), 2)
            cv2.putText(frm, "GATE 1 - ENTRY CORRIDOR (NO BAG ZONE)", (155, 62), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (160, 175, 190), 1, cv2.LINE_AA)

            # Moving person + bag silhouette across gate
            dx = int((i - 14) * 5)
            px, py, pw, ph = 210 + dx, 75, 170, 255
            bx, by, bw, bh = px + 115, py + 65, 85, 115

            # Person body & head
            cv2.circle(frm, (px + 85, py + 35), 28, (190, 170, 150), -1)
            cv2.rectangle(frm, (px + 40, py + 68), (px + 130, py + 200), (140, 95, 55), -1)
            cv2.rectangle(frm, (px + 45, py + 200), (px + 80, py + 255), (60, 60, 75), -1)
            cv2.rectangle(frm, (px + 90, py + 200), (px + 125, py + 255), (60, 60, 75), -1)

            # Prohibited Backpack on shoulder
            cv2.rectangle(frm, (bx, by), (bx + bw, by + bh), (35, 45, 165), -1)
            cv2.putText(frm, "BAG", (bx + 20, by + 65), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 255, 255), 2, cv2.LINE_AA)

            step_dets = [
                {"class_id": 0, "label": "person", "display_name": "Person", "is_bag": False, "confidence": 94, "box": [px, py, pw, ph]},
                {"class_id": 24, "label": "backpack", "display_name": bag_type, "is_bag": True, "confidence": 91, "box": [bx, by, bw, bh]},
                {"class_id": 67, "label": "cell phone", "display_name": "Cell Phone", "is_bag": False, "confidence": 82, "box": [px + 10, py + 110, 32, 48]}
            ]
            ann = self.annotate_frame(frm, step_dets, matched, cam.name)
            frames.append(ann)

        mid_frame = frames[14]
        ok_jpg, buf = cv2.imencode(".jpg", mid_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 88])
        if ok_jpg:
            self.latest_annotated_jpeg = buf.tobytes()
        self.latest_detections = dets

        return self.save_violation_evidence(
            annotated_frame=mid_frame,
            frames_clip=frames,
            detections=dets,
            cam=cam,
            db=db,
            custom_note=f"AI Camera Scan matched with {matched['user_name']} ({matched['match_note']})"
        )


camera_ai_manager = CameraAIManager()
