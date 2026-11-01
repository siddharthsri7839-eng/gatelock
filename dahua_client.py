"""
Dahua / CP PLUS Face Terminal Client (Web3.0 JSON-RPC & CGI API)
Supports CP-VTA-F1043 / Dahua Face Access Control Terminals
"""
import requests
import hashlib
import json
from requests.auth import HTTPDigestAuth
from typing import List, Dict, Any, Optional

def md5_upper(s: str) -> str:
    return hashlib.md5(s.encode('utf-8')).hexdigest().upper()

class DahuaTerminalClient:
    def __init__(self, ip: str = "192.168.1.165", port: int = 80, username: str = "admin", password: str = ""):
        self.ip = ip
        self.port = port
        self.username = username
        self.password = password
        self.session_id: Optional[str] = None
        self.base_url = f"http://{ip}:{port}"
        self.rpc_id = 1

    def login(self) -> Dict[str, Any]:
        """Perform Dahua Web3.0 challenge-response authentication."""
        url = f"{self.base_url}/RPC2_Login"
        
        # Step 1: Request Challenge
        p1 = {
            "method": "global.login",
            "params": {
                "userName": self.username,
                "password": "",
                "clientType": "Web3.0",
                "loginType": "Direct"
            },
            "id": self.rpc_id
        }
        self.rpc_id += 1
        
        try:
            r1 = requests.post(url, json=p1, timeout=3)
            d1 = r1.json()
        except Exception as e:
            return {"success": False, "message": f"Connection to {self.ip}:{self.port} failed: {str(e)}"}
        
        realm = d1.get("params", {}).get("realm", "")
        random_str = d1.get("params", {}).get("random", "")
        session = d1.get("session", "")
        
        if not realm or not random_str:
            return {"success": False, "message": f"Invalid challenge received from terminal: {d1}"}
        
        # Step 2: Calculate Dahua Web3.0 MD5 hash
        # hex_md5(username + ":" + random + ":" + hex_md5(username + ":" + realm + ":" + password))
        inner_hash = md5_upper(f"{self.username}:{realm}:{self.password}")
        outer_hash = md5_upper(f"{self.username}:{random_str}:{inner_hash}")
        
        p2 = {
            "method": "global.login",
            "params": {
                "userName": self.username,
                "password": outer_hash,
                "clientType": "Web3.0",
                "loginType": "Direct",
                "authorityType": "Default"
            },
            "id": self.rpc_id,
            "session": session
        }
        self.rpc_id += 1
        
        headers = {"DWebClientSessionID": session}
        try:
            r2 = requests.post(url, json=p2, headers=headers, timeout=3)
            d2 = r2.json()
        except Exception as e:
            return {"success": False, "message": f"Login post failed: {str(e)}"}
        
        if d2.get("result") is True:
            self.session_id = d2.get("session") or session
            return {"success": True, "session": self.session_id}
        else:
            err = d2.get("error", {})
            err_code = err.get("code")
            params = d2.get("params", {})
            remain = params.get("remainLoginTimes")
            if err_code == 268632081:
                msg = "Terminal account temporarily locked due to failed attempts. Please wait 3 minutes."
            elif err_code == 268632085:
                msg = f"Invalid device password! Remaining attempts: {remain}"
            else:
                msg = f"Login failed (Error code {err_code})"
            return {"success": False, "message": msg, "error_code": err_code, "params": params}

    def send_rpc(self, method: str, params: Any = None) -> Dict[str, Any]:
        if not self.session_id:
            login_res = self.login()
            if not login_res["success"]:
                return login_res
        
        url = f"{self.base_url}/RPC2"
        payload = {
            "method": method,
            "params": params,
            "id": self.rpc_id,
            "session": self.session_id
        }
        self.rpc_id += 1
        headers = {"DWebClientSessionID": self.session_id}
        
        try:
            r = requests.post(url, json=payload, headers=headers, timeout=5)
            return r.json()
        except Exception as e:
            return {"result": False, "error": str(e)}

    def fetch_all_enrolled_users(self) -> List[Dict[str, Any]]:
        """
        Pull all real enrolled users directly from the physical CP PLUS / Dahua machine.
        """
        users = []
        
        # Method A: Try accessControl card/user list
        res = self.send_rpc("accessControl.getUserList", {"count": 300})
        if res.get("result") and "users" in res.get("params", {}):
            for u in res["params"]["users"]:
                users.append({
                    "bio_user_id": str(u.get("userID") or u.get("id")),
                    "name": u.get("userName") or f"User {u.get('userID')}",
                    "department": u.get("department") or "Enrolled Staff",
                    "role_title": u.get("userType") or "Staff",
                    "card_number": u.get("cardNumber")
                })
            return users
        
        # Method B: Try recordFinder for AccessControlCardRec
        create_res = self.send_rpc("recordFinder.create", {"name": "AccessControlCardRec"})
        token = create_res.get("result") or create_res.get("params", {}).get("token")
        if token:
            find_res = self.send_rpc("recordFinder.findNextRecord", {"token": token, "count": 300})
            records = find_res.get("params", {}).get("records", [])
            for r in records:
                uid = str(r.get("UserID") or r.get("CardNo") or r.get("id"))
                name = r.get("CardName") or r.get("UserName") or f"User {uid}"
                users.append({
                    "bio_user_id": uid,
                    "name": name,
                    "department": "Biometric Enrolled",
                    "role_title": "Staff",
                    "card_number": r.get("CardNo")
                })
            self.send_rpc("recordFinder.destroy", {"token": token})
            if users:
                return users

        # Method C: CGI Fallback with HTTP Digest Auth
        try:
            cgi_url = f"{self.base_url}/cgi-bin/recordFinder.cgi?action=factory.create&name=AccessControlCardRec"
            auth = HTTPDigestAuth(self.username, self.password)
            r = requests.get(cgi_url, auth=auth, timeout=3)
            if "result=" in r.text:
                finder_id = r.text.split("result=")[1].strip()
                seek_url = f"{self.base_url}/cgi-bin/recordFinder.cgi?action=findNextRecord&name=AccessControlCardRec&count=300"
                r2 = requests.get(seek_url, auth=auth, timeout=5)
                # Parse key=value lines
                current_user = {}
                for line in r2.text.splitlines():
                    if "=" in line:
                        k, v = line.split("=", 1)
                        if "CardName" in k:
                            current_user["name"] = v
                        elif "UserID" in k:
                            current_user["bio_user_id"] = v
                        elif "CardNo" in k:
                            current_user["card_number"] = v
                        if "CardName" in current_user and "UserID" in current_user:
                            users.append({
                                "bio_user_id": current_user.get("UserID"),
                                "name": current_user.get("name"),
                                "department": "Biometric Enrolled",
                                "role_title": "Staff",
                                "card_number": current_user.get("card_number")
                            })
                            current_user = {}
        except Exception:
            pass

        return users

