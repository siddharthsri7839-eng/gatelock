// GateLock Pro Frontend Client
let ws = null;
let currentTab = 'live';
let presenceFilter = 'ALL';
let logsFilter = { gate: 'ALL', search: '', date: '', page: 0, limit: 50 };
let audioCtx = null;

// Initialize Web Audio Chime
function playBeep(isEntry = true) {
    try {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        
        if (isEntry) {
            osc.frequency.setValueAtTime(587.33, audioCtx.currentTime); // D5
            osc.frequency.exponentialRampToValueAtTime(880, audioCtx.currentTime + 0.15); // A5
        } else {
            osc.frequency.setValueAtTime(440, audioCtx.currentTime); // A4
            osc.frequency.exponentialRampToValueAtTime(329.63, audioCtx.currentTime + 0.15); // E4
        }
        gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.25);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.25);
    } catch (e) {
        // Audio policy or unsupported
    }
}

// Toast Notifications
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    const colors = {
        success: 'bg-emerald-950/90 border-emerald-500/50 text-emerald-300',
        error: 'bg-rose-950/90 border-rose-500/50 text-rose-300',
        warning: 'bg-amber-950/90 border-amber-500/50 text-amber-300',
        info: 'bg-slate-900/90 border-blue-500/50 text-blue-300'
    };
    const icons = {
        success: 'fa-circle-check',
        error: 'fa-circle-xmark',
        warning: 'fa-triangle-exclamation',
        info: 'fa-bell'
    };

    toast.className = `toast max-w-sm p-4 rounded-2xl border shadow-xl flex items-center gap-3 text-sm backdrop-blur-md ${colors[type] || colors.info}`;
    toast.innerHTML = `
        <i class="fa-solid ${icons[type] || icons.info} text-base shrink-0"></i>
        <div class="flex-1 font-medium leading-snug">${message}</div>
        <button onclick="this.parentElement.remove()" class="text-slate-400 hover:text-white shrink-0"><i class="fa-solid fa-xmark"></i></button>
    `;
    container.appendChild(toast);
    setTimeout(() => {
        if (toast.parentElement) toast.remove();
    }, 4500);
}

// WebSocket Setup
function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        const badge = document.getElementById('wsStatusBadge');
        if (badge) {
            badge.innerHTML = `<span class="h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></span><span class="text-xs font-semibold text-emerald-400">LIVE SYNCED</span>`;
        }
    };

    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            handleWsMessage(msg);
        } catch (e) {
            // Raw text or pong
        }
    };

    ws.onclose = () => {
        const badge = document.getElementById('wsStatusBadge');
        if (badge) {
            badge.innerHTML = `<span class="h-2 w-2 rounded-full bg-rose-500"></span><span class="text-xs font-semibold text-rose-400">DISCONNECTED</span>`;
        }
        setTimeout(initWebSocket, 3000);
    };

    // Keepalive ping
    setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send('ping');
        }
    }, 25000);
}

function handleWsMessage(msg) {
    const event = msg.event;
    const data = msg.data;

    if (event === 'NEW_PUNCH') {
        const isEntry = data.gate_type === 'ENTRY';
        playBeep(isEntry);
        
        // Show banner alert
        showLivePunchAlert(data);
        
        // Refresh live roster & KPI summary
        fetchStatsSummary();
        fetchLivePresence();
        if (currentTab === 'logs') {
            fetchLogs();
        }
    } else if (event === 'LOG_DELETED') {
        showToast(`Log #${data.log_id} (${data.user_name}) was deleted by Admin ${data.deleted_by}`, 'warning');
        fetchStatsSummary();
        fetchLivePresence();
        if (currentTab === 'logs') {
            fetchLogs();
        }
    } else if (event === 'USER_REMOVED') {
        showToast(`User ${data.name} (${data.bio_user_id}) was removed by Admin`, 'warning');
        fetchStatsSummary();
        fetchLivePresence();
        fetchUsers();
    } else if (event === 'USER_CREATED' || event === 'USER_UPDATED') {
        showToast(`User database updated (${data.name})`, 'info');
        fetchLivePresence();
        fetchUsers();
    } else if (event === 'GATE_UNLOCKED') {
        showToast(`Gate unlocked remotely by Admin ${data.unlocked_by}`, 'success');
    } else if (event === 'DEVICE_LOGS_CLEARED') {
        showToast(`Device biometric logs cleared by Admin ${data.cleared_by}`, 'warning');
    }
}

function showLivePunchAlert(punch) {
    const banner = document.getElementById('latestPunchBanner');
    if (!banner) return;

    const isEntry = punch.gate_type === 'ENTRY';
    banner.classList.remove('hidden');
    banner.className = `p-4 rounded-2xl border transition-all duration-300 flex items-center justify-between shadow-2xl mb-6 ${
        isEntry 
            ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-200' 
            : 'bg-rose-950/60 border-rose-500/40 text-rose-200'
    }`;

    banner.innerHTML = `
        <div class="flex items-center gap-4">
            <div class="w-12 h-12 rounded-xl flex items-center justify-center font-bold text-lg ${
                isEntry ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'bg-rose-500/20 text-rose-400 border border-rose-500/40'
            }">
                <i class="fa-solid ${isEntry ? 'fa-arrow-right-to-bracket' : 'fa-arrow-right-from-bracket'}"></i>
            </div>
            <div>
                <div class="flex items-center gap-2">
                    <span class="text-base font-bold text-white">${punch.user_name}</span>
                    <span class="text-xs px-2 py-0.5 rounded-full font-mono bg-slate-800 text-slate-300">ID: ${punch.bio_user_id}</span>
                    <span class="text-xs px-2 py-0.5 rounded-full font-bold uppercase tracking-wider ${
                        isEntry ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                    }">${punch.gate_type}</span>
                </div>
                <div class="text-xs text-slate-400 mt-1 flex items-center gap-3">
                    <span><i class="fa-solid fa-building text-slate-500 mr-1"></i>${punch.department || 'General'}</span>
                    <span><i class="fa-solid fa-fingerprint text-slate-500 mr-1"></i>${punch.verify_mode}</span>
                    <span><i class="fa-solid fa-clock text-slate-500 mr-1"></i>${new Date(punch.timestamp).toLocaleTimeString()}</span>
                    <span class="font-semibold text-slate-300">Today: Entered ${punch.entry_count}x | Exited ${punch.exit_count}x</span>
                </div>
            </div>
        </div>
        <div class="text-right">
            <span class="text-xs font-mono uppercase px-2.5 py-1 rounded-lg ${
                punch.current_status === 'INSIDE' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-bold' : 'bg-slate-800 text-slate-400 font-medium'
            }">Status: ${punch.current_status}</span>
        </div>
    `;

    // Add to Live Feed mini-timeline if present
    const feed = document.getElementById('liveGateFeed');
    if (feed) {
        const item = document.createElement('div');
        item.className = 'p-3 rounded-xl bg-slate-900/60 border border-slate-800/80 flex items-center justify-between text-xs transition-all hover:border-slate-700 animate-fadeIn';
        item.innerHTML = `
            <div class="flex items-center gap-3">
                <span class="w-7 h-7 rounded-lg flex items-center justify-center font-bold text-xs ${
                    isEntry ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'
                }">
                    <i class="fa-solid ${isEntry ? 'fa-arrow-right-to-bracket' : 'fa-arrow-right-from-bracket'}"></i>
                </span>
                <div>
                    <div class="font-bold text-slate-200">${punch.user_name} <span class="font-normal text-slate-400 font-mono text-[11px]">(ID: ${punch.bio_user_id})</span></div>
                    <div class="text-[11px] text-slate-400">${punch.device_name} • ${punch.verify_mode}</div>
                </div>
            </div>
            <div class="text-right">
                <div class="font-mono text-slate-300">${new Date(punch.timestamp).toLocaleTimeString()}</div>
                <div class="text-[10px] text-slate-500">${new Date(punch.timestamp).toLocaleDateString()}</div>
            </div>
        `;
        feed.prepend(item);
        if (feed.children.length > 20) {
            feed.removeChild(feed.lastChild);
        }
    }
}

async function populateEnrolledPins(defaultStart = 1, defaultEnd = 120) {
    const endStr = prompt(`How many enrolled users are in your biometric machine?\nEnter highest User ID (e.g. 100, 120, 150):`, defaultEnd);
    if (!endStr) return;
    const end = parseInt(endStr);
    const start = 1;
    if (isNaN(end) || end < 1) {
        showToast("Invalid number entered", "error");
        return;
    }
    showToast(`Enrolling biometric machine IDs ${start} to ${end}...`, 'info');
    try {
        const res = await fetch('/api/users/import-range', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ start_id: start, end_id: end, role_title: 'Staff', department: 'Main Gate' })
        });
        const data = await res.json();
        if (res.ok) {
            showToast(data.message, 'success');
            fetchUsers();
            fetchStatsSummary();
            fetchLivePresence();
        } else {
            showToast(data.detail || "Failed to import pins", 'error');
        }
    } catch (e) {
        showToast("Error communicating with server", 'error');
    }
}

function openEditUserModal(id, bioId, name, role, dept, phone) {
    const modal = document.getElementById('editUserModal');
    if (!modal) return;
    document.getElementById('editUserId').value = id;
    document.getElementById('editBioId').value = bioId;
    document.getElementById('editName').value = name;
    document.getElementById('editRole').value = role || 'Staff';
    document.getElementById('editDept').value = dept || 'Main Gate';
    document.getElementById('editPhone').value = phone || '';
    modal.classList.remove('hidden');
}

async function handleSaveEditUser(e) {
    e.preventDefault();
    const id = document.getElementById('editUserId').value;
    const name = document.getElementById('editName').value.trim();
    const role_title = document.getElementById('editRole').value.trim();
    const department = document.getElementById('editDept').value.trim();
    const phone = document.getElementById('editPhone').value.trim();

    try {
        const res = await fetch(`/api/users/${id}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ name, role_title, department, phone })
        });
        const data = await res.json();
        if (res.ok) {
            showToast(`User ${name} updated successfully!`, 'success');
            document.getElementById('editUserModal').classList.add('hidden');
            fetchUsers();
            fetchLivePresence();
        } else {
            showToast(data.detail || "Failed to update user", 'error');
        }
    } catch (err) {
        showToast("Server error updating user", 'error');
    }
}

async function handleUploadUserFile(inputEl) {
    const file = inputEl.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    showToast(`Uploading and importing ${file.name}...`, 'info');
    try {
        const res = await fetch('/api/users/import-file', {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        if (res.ok) {
            showToast(data.message, 'success');
            fetchUsers();
            fetchStatsSummary();
            fetchLivePresence();
        } else {
            showToast(data.detail || "File import failed", 'error');
        }
    } catch (e) {
        showToast("Error uploading file", 'error');
    } finally {
        inputEl.value = '';
    }
}

// Data Fetchers
async function fetchStatsSummary() {
    try {
        const res = await fetch('/api/stats/summary');
        if (!res.ok) return;
        const data = await res.json();
        
        document.getElementById('statCurrentlyInside').textContent = data.currently_inside;
        document.getElementById('statTodayEntries').textContent = data.today_entries;
        document.getElementById('statTodayExits').textContent = data.today_exits;
        document.getElementById('statTotalUsers').textContent = data.total_registered_users;
        document.getElementById('statOnlineDevices').textContent = `${data.online_devices} / ${data.total_devices}`;
        
        const simBadge = document.getElementById('simulationStatusBadge');
        if (simBadge) {
            if (data.is_simulation_active) {
                simBadge.innerHTML = `<span class="h-2 w-2 rounded-full bg-emerald-400 animate-ping"></span><span class="text-xs text-emerald-400 font-bold">Simulator: RUNNING</span>`;
            } else {
                simBadge.innerHTML = `<span class="h-2 w-2 rounded-full bg-slate-500"></span><span class="text-xs text-slate-400">Simulator: Idle</span>`;
            }
        }
    } catch (e) {
        console.error("Failed to load stats summary", e);
    }
}

async function fetchLivePresence(filter = presenceFilter) {
    presenceFilter = filter;
    const url = filter === 'ALL' ? '/api/presence/live' : `/api/presence/live?status_filter=${filter}`;
    try {
        const res = await fetch(url);
        if (!res.ok) return;
        const roster = await res.json();
        renderPresenceTables(roster);
    } catch (e) {
        console.error("Failed to load presence", e);
    }
}

function renderPresenceTables(roster) {
    // 1. "Who Is Inside" Table (Filtered only to current inside users)
    const insideBody = document.getElementById('insideRosterTableBody');
    if (insideBody) {
        const insideUsers = roster.filter(u => u.current_status === 'INSIDE');
        document.getElementById('insideCountBadge').textContent = `${insideUsers.length} Active`;
        if (insideUsers.length === 0) {
            insideBody.innerHTML = `<tr><td colspan="6" class="text-center py-8 text-slate-500 text-sm">No one is currently inside the gate. Gate is clear.</td></tr>`;
        } else {
            insideBody.innerHTML = insideUsers.map(u => `
                <tr class="hover:bg-slate-800/40 border-b border-slate-800/60 transition-colors">
                    <td class="py-3 px-4">
                        <div class="flex items-center gap-3">
                            <div class="w-9 h-9 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-400 flex items-center justify-center font-bold text-xs">
                                ${u.name.substring(0, 2).toUpperCase()}
                            </div>
                            <div>
                                <div class="font-bold text-white text-sm">${u.name}</div>
                                <div class="text-xs text-slate-400 font-mono">ID: ${u.bio_user_id}</div>
                            </div>
                        </div>
                    </td>
                    <td class="py-3 px-4">
                        <div class="text-xs text-slate-300 font-medium">${u.department || 'General'}</div>
                        <div class="text-[11px] text-slate-500">${u.role_title || 'Employee'}</div>
                    </td>
                    <td class="py-3 px-4 font-mono text-xs text-slate-300">
                        ${u.first_entry_time ? new Date(u.first_entry_time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '--:--'}
                    </td>
                    <td class="py-3 px-4 font-mono text-xs text-slate-300">
                        ${u.last_punch_time ? new Date(u.last_punch_time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '--:--'}
                    </td>
                    <td class="py-3 px-4">
                        <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                            <span class="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                            INSIDE
                        </span>
                    </td>
                    <td class="py-3 px-4 text-xs font-semibold text-blue-400 font-mono">
                        ${u.time_spent_str}
                    </td>
                </tr>
            `).join('');
        }
    }

    // 2. Full Activity Roster (How Come / How Go / How Many Times)
    const activityBody = document.getElementById('activityRosterTableBody');
    if (activityBody) {
        if (roster.length === 0) {
            activityBody.innerHTML = `<tr><td colspan="8" class="text-center py-12 text-slate-500 text-sm">
                <i class="fa-solid fa-fingerprint text-2xl mb-2 text-slate-600 block"></i>
                No biometric activity recorded yet today.<br>
                <span class="text-xs text-slate-500">Live punches from Gate 1 (192.168.1.165) and Gate 2 (192.168.1.224) will appear here automatically.</span>
            </td></tr>`;
        } else {
            activityBody.innerHTML = roster.map(u => {
                const isInside = u.current_status === 'INSIDE';
                return `
                <tr class="hover:bg-slate-800/40 border-b border-slate-800/60 transition-colors">
                    <td class="py-3 px-4">
                        <div class="flex items-center gap-3">
                            <div class="w-8 h-8 rounded-lg bg-slate-800 text-slate-300 flex items-center justify-center font-bold text-xs">
                                ${u.name.substring(0, 2).toUpperCase()}
                            </div>
                            <div>
                                <span class="font-bold text-white text-sm">${u.name}</span>
                                <span class="text-xs text-slate-400 block font-mono">Bio ID: ${u.bio_user_id}</span>
                            </div>
                        </div>
                    </td>
                    <td class="py-3 px-4 text-xs text-slate-300">${u.department}</td>
                    <td class="py-3 px-4">
                        <span class="px-2 py-0.5 rounded text-xs font-mono font-bold ${
                            isInside ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-slate-800 text-slate-400'
                        }">
                            ${u.current_status}
                        </span>
                    </td>
                    <td class="py-3 px-4 text-xs text-emerald-400 font-bold font-mono">
                        ${u.entry_count} times
                    </td>
                    <td class="py-3 px-4 text-xs text-rose-400 font-bold font-mono">
                        ${u.exit_count} times
                    </td>
                    <td class="py-3 px-4 text-xs text-slate-300 font-bold font-mono">
                        ${u.total_count} total
                    </td>
                    <td class="py-3 px-4 text-xs text-blue-400 font-mono">
                        ${u.time_spent_str}
                    </td>
                    <td class="py-3 px-4 text-xs font-mono text-slate-400">
                        ${u.last_punch_time ? new Date(u.last_punch_time).toLocaleTimeString() : 'No Punch'}
                    </td>
                </tr>
                `;
            }).join('');
        }
    }
}

async function fetchLogs(page = 0) {
    logsFilter.page = page;
    const offset = page * logsFilter.limit;
    let url = `/api/logs?limit=${logsFilter.limit}&offset=${offset}`;
    if (logsFilter.gate !== 'ALL') url += `&gate_type=${logsFilter.gate}`;
    if (logsFilter.search) url += `&search=${encodeURIComponent(logsFilter.search)}`;
    if (logsFilter.date) url += `&date=${logsFilter.date}`;

    try {
        const res = await fetch(url);
        if (!res.ok) return;
        const data = await res.json();
        renderLogsTable(data.logs, data.total);
    } catch (e) {
        console.error("Failed to fetch logs", e);
    }
}

function renderLogsTable(logs, total) {
    const tbody = document.getElementById('logsTableBody');
    if (!tbody) return;

    const isAdmin = window.CURRENT_ROLE === 'admin';
    document.getElementById('totalLogsCount').textContent = `${total} Logs Found`;

    if (logs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${isAdmin ? 8 : 7}" class="text-center py-12 text-slate-500 text-sm">
            <i class="fa-solid fa-list-check text-2xl mb-2 text-slate-600 block"></i>
            No access logs recorded yet.<br>
            <span class="text-xs text-slate-500">Live gate punches from 192.168.1.165 and 192.168.1.224 will be logged here in real-time.</span>
        </td></tr>`;
        return;
    }

    tbody.innerHTML = logs.map(l => {
        const isEntry = l.gate_type === 'ENTRY';
        return `
        <tr class="hover:bg-slate-800/40 border-b border-slate-800/60 transition-colors text-xs">
            <td class="py-3 px-4 font-mono text-slate-500">#${l.id}</td>
            <td class="py-3 px-4">
                <span class="font-bold text-white">${l.user_name}</span>
                <span class="block text-[11px] font-mono text-slate-400">ID: ${l.bio_user_id}</span>
            </td>
            <td class="py-3 px-4">
                <span class="px-2 py-1 rounded font-bold uppercase tracking-wider ${
                    isEntry ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                }">
                    <i class="fa-solid ${isEntry ? 'fa-arrow-right-to-bracket' : 'fa-arrow-right-from-bracket'} mr-1"></i>
                    ${l.gate_type}
                </span>
            </td>
            <td class="py-3 px-4 text-slate-300">${l.device_name}</td>
            <td class="py-3 px-4 text-slate-400"><i class="fa-solid fa-fingerprint mr-1"></i>${l.verify_mode}</td>
            <td class="py-3 px-4 font-mono text-slate-300">${l.timestamp}</td>
            <td class="py-3 px-4 text-slate-400">${l.note || '-'}</td>
            ${isAdmin ? `
            <td class="py-3 px-4 text-right">
                <button onclick="confirmDeleteLog(${l.id}, '${l.user_name}')" title="Admin: Remove this record" 
                        class="px-2.5 py-1 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 transition-all">
                    <i class="fa-solid fa-trash-can mr-1"></i> Remove
                </button>
            </td>
            ` : ''}
        </tr>
        `;
    }).join('');
}

async function confirmDeleteLog(logId, userName) {
    if (window.CURRENT_ROLE !== 'admin') {
        showToast("Owner role has read-only access. Only Admin can remove records.", "error");
        return;
    }
    if (!confirm(`Are you sure you want to remove gate record #${logId} for ${userName}?`)) {
        return;
    }

    try {
        const res = await fetch(`/api/logs/${logId}`, { method: 'DELETE' });
        const data = await res.json();
        if (res.ok) {
            showToast(data.message, 'success');
            fetchLogs(logsFilter.page);
            fetchStatsSummary();
            fetchLivePresence();
        } else {
            showToast(data.detail || "Failed to remove log", 'error');
        }
    } catch (e) {
        showToast("Error connecting to server", 'error');
    }
}

let allLoadedUsers = [];

async function fetchUsers() {
    try {
        const res = await fetch('/api/users');
        if (!res.ok) return;
        allLoadedUsers = await res.json();
        renderUsersTable(allLoadedUsers);
    } catch (e) {
        console.error("Failed to fetch users", e);
    }
}

function filterUsersList(term) {
    if (!term) {
        renderUsersTable(allLoadedUsers);
        return;
    }
    const clean = term.toLowerCase().trim();
    const filtered = allLoadedUsers.filter(u => 
        (u.name && u.name.toLowerCase().includes(clean)) ||
        (u.bio_user_id && u.bio_user_id.toLowerCase().includes(clean)) ||
        (u.role_title && u.role_title.toLowerCase().includes(clean)) ||
        (u.department && u.department.toLowerCase().includes(clean))
    );
    renderUsersTable(filtered);
}

function renderUsersTable(users) {
    const tbody = document.getElementById('usersTableBody');
    if (!tbody) return;

    const isAdmin = window.CURRENT_ROLE === 'admin';
    document.getElementById('totalUsersCount').textContent = `${users.length} Users`;

    if (users.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${isAdmin ? 6 : 5}" class="text-center py-12 text-slate-500 text-sm">
            <i class="fa-solid fa-users text-2xl mb-2 text-slate-600 block"></i>
            No registered users in directory.<br>
            <span class="text-xs text-slate-500">Users are automatically registered when they punch at the gate, or click <strong>'+ Add New User'</strong> above.</span>
        </td></tr>`;
        return;
    }

    tbody.innerHTML = users.map(u => `
        <tr class="hover:bg-slate-800/40 border-b border-slate-800/60 transition-colors text-xs">
            <td class="py-3 px-4 font-mono font-bold text-blue-400">${u.bio_user_id}</td>
            <td class="py-3 px-4 font-bold text-white text-sm">${u.name}</td>
            <td class="py-3 px-4 text-slate-300">${u.role_title}</td>
            <td class="py-3 px-4 text-slate-300">${u.department}</td>
            <td class="py-3 px-4 font-mono text-slate-400">${u.phone || 'N/A'}</td>
            ${isAdmin ? `
            <td class="py-3 px-4 text-right flex items-center justify-end gap-2">
                <button onclick="openEditUserModal(${u.id}, '${u.bio_user_id}', '${u.name}', '${u.role_title}', '${u.department}', '${u.phone || ''}')" 
                        class="px-2.5 py-1 rounded-lg bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 border border-blue-500/30 transition-all font-semibold">
                    <i class="fa-solid fa-pen-to-square mr-1"></i> Edit
                </button>
                <button onclick="confirmRemoveUser(${u.id}, '${u.name}', '${u.bio_user_id}')" 
                        class="px-2.5 py-1 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 transition-all font-semibold">
                    <i class="fa-solid fa-user-xmark mr-1"></i> Remove
                </button>
            </td>
            ` : ''}
        </tr>
    `).join('');
}

async function confirmRemoveUser(userId, userName, bioId) {
    if (window.CURRENT_ROLE !== 'admin') {
        showToast("Owner role has read-only access. Only Admin can remove users.", "error");
        return;
    }
    if (!confirm(`Are you sure you want to remove user ${userName} (Bio ID: ${bioId})? This will update live on Owner's screen.`)) {
        return;
    }

    try {
        const res = await fetch(`/api/users/${userId}`, { method: 'DELETE' });
        const data = await res.json();
        if (res.ok) {
            showToast(data.message, 'success');
            fetchUsers();
            fetchLivePresence();
            fetchStatsSummary();
        } else {
            showToast(data.detail || "Failed to remove user", 'error');
        }
    } catch (e) {
        showToast("Error connecting to server", 'error');
    }
}

async function fetchDevices() {
    try {
        const res = await fetch('/api/devices');
        if (!res.ok) return;
        const devices = await res.json();
        renderDevicesCards(devices);
    } catch (e) {
        console.error("Failed to fetch devices", e);
    }
}

function renderDevicesCards(devices) {
    const container = document.getElementById('devicesContainer');
    if (!container) return;

    const isAdmin = window.CURRENT_ROLE === 'admin';

    container.innerHTML = devices.map(d => {
        const isOnline = d.last_status === 'ONLINE';
        const isEntry = d.gate_type === 'ENTRY';
        return `
        <div class="glass-card rounded-2xl p-6 border transition-all hover:border-slate-600">
            <div class="flex items-center justify-between mb-4">
                <div class="flex items-center gap-3">
                    <div class="w-12 h-12 rounded-xl flex items-center justify-center text-lg ${
                        isEntry ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'bg-rose-500/20 text-rose-400 border border-rose-500/40'
                    }">
                        <i class="fa-solid fa-fingerprint"></i>
                    </div>
                    <div>
                        <h4 class="font-bold text-white text-base">${d.name}</h4>
                        <span class="text-xs uppercase px-2 py-0.5 rounded font-bold font-mono ${
                            isEntry ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'
                        }">Direction: ${d.gate_type}</span>
                    </div>
                </div>
                <div class="text-right">
                    <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold ${
                        isOnline ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'bg-rose-500/20 text-rose-400 border border-rose-500/40'
                    }">
                        <span class="h-2 w-2 rounded-full ${isOnline ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}"></span>
                        ${d.last_status}
                    </span>
                </div>
            </div>

            <div class="space-y-2 py-3 border-y border-slate-800 text-xs font-mono">
                <div class="flex justify-between text-slate-400">
                    <span>IP Address:</span>
                    <span class="text-white font-bold">${d.ip_address}</span>
                </div>
                <div class="flex justify-between text-slate-400">
                    <span>Port:</span>
                    <span class="text-white">${d.port}</span>
                </div>
                <div class="flex justify-between text-slate-400">
                    <span>Hardware Model:</span>
                    <span class="text-white font-semibold">Bio S-B251CB</span>
                </div>
                <div class="flex justify-between text-slate-400">
                    <span>Last Connected:</span>
                    <span class="text-white">${d.last_connected_at ? new Date(d.last_connected_at).toLocaleTimeString() : 'Never'}</span>
                </div>
            </div>

            ${isAdmin ? `
            <div class="mt-4 grid grid-cols-2 gap-2">
                <button onclick="promptSyncDevice('${d.device_key}', '${d.name}')" class="col-span-2 py-2 px-3 rounded-xl bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 font-bold text-xs border border-indigo-500/40 transition-all flex items-center justify-center gap-1.5 shadow-lg shadow-indigo-500/10">
                    <i class="fa-solid fa-cloud-arrow-down text-indigo-400"></i> Sync Enrolled Users from Machine
                </button>
                <button onclick="testDevice('${d.device_key}')" class="py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-semibold text-xs border border-slate-700 transition-all flex items-center justify-center gap-1.5">
                    <i class="fa-solid fa-network-wired text-blue-400"></i> Test Ping
                </button>
                <button onclick="syncDevice('${d.device_key}')" class="py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-semibold text-xs border border-slate-700 transition-all flex items-center justify-center gap-1.5">
                    <i class="fa-solid fa-arrows-rotate text-emerald-400"></i> Sync Logs
                </button>
                <button onclick="unlockGate('${d.device_key}')" class="py-2 px-3 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 font-semibold text-xs border border-emerald-500/40 transition-all flex items-center justify-center gap-1.5">
                    <i class="fa-solid fa-lock-open"></i> Unlock Gate
                </button>
                <button onclick="clearDeviceLogs('${d.device_key}')" class="py-2 px-3 rounded-xl bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 font-semibold text-xs border border-rose-500/40 transition-all flex items-center justify-center gap-1.5" title="Remove all biometric records from hardware">
                    <i class="fa-solid fa-eraser"></i> Wipe Bio Logs
                </button>
                <button onclick="openConfigModal('${d.device_key}', '${d.name}', '${d.ip_address}', ${d.port}, '${d.gate_type}')" class="col-span-2 py-2 px-3 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-300 font-semibold text-xs border border-slate-700 transition-all flex items-center justify-center gap-1.5">
                    <i class="fa-solid fa-gear text-amber-400"></i> Edit Device IP & Port
                </button>
            </div>
            ` : `
            <div class="mt-4 p-2.5 rounded-xl bg-slate-900/60 border border-slate-800 text-center text-xs text-slate-400">
                <i class="fa-solid fa-shield text-blue-400 mr-1"></i> Owner View: Monitored 24/7
            </div>
            `}
        </div>
        `;
    }).join('');
}

function openConfigModal(deviceKey, name, ip, port, gateType) {
    const modal = document.getElementById('deviceConfigModal');
    if (!modal) return;
    document.getElementById('cfgDeviceKey').value = deviceKey;
    document.getElementById('cfgDeviceName').value = name;
    document.getElementById('cfgIp').value = ip;
    document.getElementById('cfgPort').value = port;
    document.getElementById('cfgGateType').value = gateType;
    modal.classList.remove('hidden');
}

async function handleSaveDeviceConfig(e) {
    e.preventDefault();
    const deviceKey = document.getElementById('cfgDeviceKey').value;
    const name = document.getElementById('cfgDeviceName').value.trim();
    const ip_address = document.getElementById('cfgIp').value.trim();
    const port = parseInt(document.getElementById('cfgPort').value.trim());
    const gate_type = document.getElementById('cfgGateType').value;

    try {
        const res = await fetch(`/api/devices/${deviceKey}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                device_key: deviceKey,
                name: name,
                ip_address: ip_address,
                port: port,
                gate_type: gate_type
            })
        });
        const data = await res.json();
        if (res.ok) {
            showToast(data.message || "Device updated", 'success');
            document.getElementById('deviceConfigModal').classList.add('hidden');
            fetchDevices();
        } else {
            showToast(data.detail || "Update failed", 'error');
        }
    } catch (err) {
        showToast("Error updating device configuration", 'error');
    }
}

// Admin Hardware Actions
async function testDevice(deviceKey) {
    showToast(`Pinging ${deviceKey}...`, 'info');
    try {
        const res = await fetch(`/api/devices/${deviceKey}/test`, { method: 'POST' });
        const data = await res.json();
        showToast(data.message, data.success ? 'success' : 'error');
        fetchDevices();
        fetchStatsSummary();
    } catch (e) {
        showToast("Failed to test device", 'error');
    }
}

async function syncDevice(deviceKey) {
    showToast(`Syncing gate open/close records from ${deviceKey}...`, 'info');
    try {
        const res = await fetch(`/api/devices/${deviceKey}/sync`, { method: 'POST' });
        const data = await res.json();
        showToast(data.message, data.success ? 'success' : 'error');
        fetchLogs();
        fetchLivePresence();
        fetchStatsSummary();
    } catch (e) {
        showToast("Failed to sync records", 'error');
    }
}

async function unlockGate(deviceKey) {
    if (!confirm(`Trigger remote gate door unlock for ${deviceKey}?`)) return;
    try {
        const res = await fetch(`/api/devices/${deviceKey}/unlock`, { method: 'POST' });
        const data = await res.json();
        showToast(data.message, data.success ? 'success' : 'error');
    } catch (e) {
        showToast("Gate unlock command failed", 'error');
    }
}

async function clearDeviceLogs(deviceKey) {
    if (!confirm(`CAUTION: This will delete/wipe all gate movement logs stored directly in the ${deviceKey} biometric machine memory. Are you sure?`)) {
        return;
    }
    try {
        const res = await fetch(`/api/devices/${deviceKey}/clear-logs`, { method: 'POST' });
        const data = await res.json();
        showToast(data.message, data.success ? 'warning' : 'error');
        fetchDevices();
    } catch (e) {
        showToast("Failed to clear device logs", 'error');
    }
}

// Simulation & Quick Punch
async function triggerQuickPunch(bioUserId, gateType) {
    try {
        const res = await fetch('/api/simulate/punch', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                bio_user_id: bioUserId,
                gate_type: gateType,
                verify_mode: 'Fingerprint'
            })
        });
        const data = await res.json();
        if (res.ok) {
            showToast(`Simulated ${gateType} punch for ${data.user}`, 'success');
        } else {
            showToast(data.detail || "Punch error", 'error');
        }
    } catch (e) {
        showToast("Server error triggering punch", 'error');
    }
}

async function toggleSimulator() {
    try {
        const currentText = document.getElementById('btnToggleSimText').textContent;
        const willEnable = currentText.includes('Start');
        const res = await fetch(`/api/simulate/toggle?enable=${willEnable}`, { method: 'POST' });
        const data = await res.json();
        document.getElementById('btnToggleSimText').textContent = data.simulation_active ? 'Stop Simulator' : 'Start Live Simulator';
        showToast(`Simulation feed is now ${data.simulation_active ? 'ACTIVE' : 'STOPPED'}`, 'info');
        fetchStatsSummary();
    } catch (e) {
        showToast("Error toggling simulator", 'error');
    }
}

// Navigation Tab Switcher
function switchTab(tabId) {
    currentTab = tabId;
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.remove('bg-blue-600', 'text-white', 'shadow-lg', 'shadow-blue-600/30');
        btn.classList.add('text-slate-400', 'hover:bg-slate-800');
    });

    const activeContent = document.getElementById(`tabContent-${tabId}`);
    const activeBtn = document.getElementById(`navBtn-${tabId}`);
    if (activeContent) activeContent.classList.remove('hidden');
    if (activeBtn) {
        activeBtn.classList.remove('text-slate-400', 'hover:bg-slate-800');
        activeBtn.classList.add('bg-blue-600', 'text-white', 'shadow-lg', 'shadow-blue-600/30');
    }

    if (tabId === 'live') {
        fetchLivePresence();
    } else if (tabId === 'monthly') {
        fetchMonthlyReport();
    } else if (tabId === 'analytics') {
        fetchLivePresence();
    } else if (tabId === 'logs') {
        fetchLogs();
    } else if (tabId === 'users') {
        fetchUsers();
    } else if (tabId === 'devices') {
        fetchDevices();
    }
}

// Logout
async function logout() {
    try {
        await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
        localStorage.removeItem('gatelock_user');
        window.location.href = '/login';
    }
}

// Live Clock
function updateClock() {
    const clockEl = document.getElementById('liveClock');
    if (clockEl) {
        const now = new Date();
        clockEl.textContent = now.toLocaleTimeString() + ' • ' + now.toLocaleDateString();
    }
}

// Initialization on DOM Ready
document.addEventListener('DOMContentLoaded', () => {
    initWebSocket();
    fetchStatsSummary();
    fetchLivePresence();
    setInterval(updateClock, 1000);
    setInterval(fetchStatsSummary, 10000); // Poll KPIs every 10s

    // Logs Search & Filters
    const searchInput = document.getElementById('logsSearchInput');
    if (searchInput) {
        let debounceTimer;
        searchInput.addEventListener('input', (e) => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                logsFilter.search = e.target.value.trim();
                fetchLogs(0);
            }, 300);
        });
    }

    const gateFilterSelect = document.getElementById('logsGateFilter');
    if (gateFilterSelect) {
        gateFilterSelect.addEventListener('change', (e) => {
            logsFilter.gate = e.target.value;
            fetchLogs(0);
        });
    }

    const dateFilterInput = document.getElementById('logsDateFilter');
    if (dateFilterInput) {
        dateFilterInput.addEventListener('change', (e) => {
            logsFilter.date = e.target.value;
            fetchLogs(0);
        });
    }

    // Modal handler for adding user (Admin only)
    const addUserForm = document.getElementById('addUserForm');
    if (addUserForm) {
        addUserForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const bio_user_id = document.getElementById('newBioId').value.trim();
            const name = document.getElementById('newName').value.trim();
            const department = document.getElementById('newDept').value.trim();
            const role_title = document.getElementById('newRole').value.trim();
            const phone = document.getElementById('newPhone').value.trim();

            try {
                const res = await fetch('/api/users', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ bio_user_id, name, department, role_title, phone })
                });
                const data = await res.json();
                if (res.ok) {
                    showToast(`User ${name} registered successfully!`, 'success');
                    addUserForm.reset();
                    document.getElementById('addUserModal').classList.add('hidden');
                    fetchUsers();
                    fetchLivePresence();
                } else {
                    showToast(data.detail || "Failed to register user", 'error');
                }
            } catch (err) {
                showToast("Server connection error", 'error');
            }
        });
    }
});

// Direct Hardware Sync Tool
async function promptSyncDevice(deviceKey, deviceName) {
    if (window.CURRENT_ROLE !== 'admin') {
        showToast("Only Admin can trigger biometric machine sync.", "error");
        return;
    }

    let password = "";
    if (deviceKey === 'entry_gate') {
        password = prompt(`Enter device admin password for ${deviceName}:\n(Default for CP PLUS / Dahua terminals is often admin123, Admin@123, or custom screen password)`, "");
        if (password === null) return; // user cancelled
    }

    showToast(`Connecting to ${deviceName} to extract enrolled users...`, "info");

    try {
        const res = await fetch(`/api/devices/${deviceKey}/sync_users`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ password: password })
        });
        const data = await res.json();
        if (res.ok && data.success) {
            showToast(data.message, "success");
            fetchUsers();
            fetchLivePresence();
            fetchStatsSummary();
        } else {
            showToast(data.message || data.detail || "Failed to sync users from machine.", "error");
        }
    } catch (e) {
        showToast("Error communicating with server", "error");
    }
}

// Clear All Users (Fresh Start)
async function confirmClearAllUsers() {
    if (window.CURRENT_ROLE !== 'admin') {
        showToast("Only Admin can clear the roster.", "error");
        return;
    }

    if (!confirm("Are you sure you want to CLEAR the current users roster? This removes all non-machine imported users so only freshly synced biometric device users are displayed.")) {
        return;
    }

    try {
        const res = await fetch('/api/users/clear-all', { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
            showToast(data.message, "success");
            fetchUsers();
            fetchLivePresence();
            fetchStatsSummary();
        } else {
            showToast(data.detail || "Failed to clear users.", "error");
        }
    } catch (e) {
        showToast("Error connecting to server", "error");
    }
}

// ==========================================
// MONTHLY & YEARLY GATE OPEN & CLOSE MOVEMENT REPORTS
// ==========================================
let monthlyReportData = null;
let monthlyReportDebounce = null;

async function fetchMonthlyReport() {
    const yearSelect = document.getElementById('reportYearSelect');
    const monthSelect = document.getElementById('reportMonthSelect');
    const searchInput = document.getElementById('reportSearchInput');

    const year = yearSelect ? yearSelect.value : new Date().getFullYear();
    const month = monthSelect ? monthSelect.value : (new Date().getMonth() + 1);
    const search = searchInput ? searchInput.value.trim() : '';

    let url = `/api/reports/monthly?year=${year}`;
    if (month) url += `&month=${month}`;
    if (search) url += `&search=${encodeURIComponent(search)}`;

    const tbody = document.getElementById('monthlyReportTableBody');
    if (tbody) tbody.innerHTML = `<tr><td colspan="9" class="text-center py-8 text-slate-500 text-sm"><i class="fa-solid fa-spinner fa-spin mr-2"></i>Loading gate movement report...</td></tr>`;

    try {
        const res = await fetch(url);
        if (res.status === 401) {
            window.location.href = '/login';
            return;
        }
        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.detail || `Server responded with ${res.status}`);
        }
        const data = await res.json();
        monthlyReportData = data;
        renderMonthlyReport(data);
    } catch (e) {
        console.error("fetchMonthlyReport error:", e);
        if (tbody) tbody.innerHTML = `<tr><td colspan="9" class="text-center py-8 text-rose-400 text-sm"><i class="fa-solid fa-circle-exclamation mr-1.5"></i>Failed to load gate open/close movement data (${e.message || 'Network error'}).</td></tr>`;
    }
}

function debounceMonthlyReportSearch() {
    clearTimeout(monthlyReportDebounce);
    monthlyReportDebounce = setTimeout(fetchMonthlyReport, 350);
}

function renderMonthlyReport(data) {
    const totalInEl = document.getElementById('reportTotalIn');
    const totalOutEl = document.getElementById('reportTotalOut');
    const totalTripsEl = document.getElementById('reportTotalTrips');
    const activeUsersEl = document.getElementById('reportActiveUsers');
    const tbody = document.getElementById('monthlyReportTableBody');

    if (totalInEl) totalInEl.textContent = data.total_period_entries || 0;
    if (totalOutEl) totalOutEl.textContent = data.total_period_exits || 0;
    if (totalTripsEl) totalTripsEl.textContent = data.total_movements || 0;
    if (activeUsersEl) {
        const activeCount = data.users.filter(u => u.total_trips > 0).length;
        activeUsersEl.textContent = `${activeCount} / ${data.total_users}`;
    }

    if (!tbody) return;

    if (!data.users || data.users.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" class="text-center py-8 text-slate-500 text-sm">No user records found.</td></tr>`;
        return;
    }

    tbody.innerHTML = data.users.map(u => {
        return `
        <tr class="hover:bg-slate-800/40 border-b border-slate-800/60 transition-colors">
            <td class="py-3 px-4 font-mono font-bold text-white text-xs">${u.bio_user_id}</td>
            <td class="py-3 px-4 font-semibold text-white text-sm">
                ${u.name}
            </td>
            <td class="py-3 px-4 text-xs text-slate-300">
                <div>${u.department}</div>
                <div class="text-[11px] text-slate-500">${u.role_title}</div>
            </td>
            <td class="py-3 px-4 text-xs font-mono font-bold ${u.days_present > 0 ? 'text-emerald-400' : 'text-slate-500'}">
                ${u.days_present} days
            </td>
            <td class="py-3 px-4 text-xs font-mono font-bold text-emerald-400">
                ${u.entry_count} times
            </td>
            <td class="py-3 px-4 text-xs font-mono font-bold text-rose-400">
                ${u.exit_count} times
            </td>
            <td class="py-3 px-4 text-xs font-mono font-bold text-blue-400">
                ${u.total_trips} total
            </td>
            <td class="py-3 px-4 text-xs font-mono font-semibold text-slate-200">
                ${u.total_time_str}
            </td>
            <td class="py-3 px-4 text-right">
                <button onclick="showUserHistoryModal('${u.bio_user_id}', '${u.name}')" 
                        class="px-2.5 py-1.5 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 text-xs font-semibold flex items-center gap-1.5 ml-auto transition-all">
                    <i class="fa-solid fa-clock-rotate-left text-xs"></i>
                    <span>View In/Out History</span>
                </button>
            </td>
        </tr>
        `;
    }).join('');
}

function showUserHistoryModal(bioId, userName) {
    if (!monthlyReportData) return;
    const user = monthlyReportData.users.find(u => u.bio_user_id === bioId);
    if (!user) return;

    const modal = document.getElementById('userHistoryModal');
    const title = document.getElementById('historyModalTitle');
    const subtitle = document.getElementById('historyModalSubtitle');
    const tbody = document.getElementById('userHistoryTableBody');

    if (!modal) return;

    if (title) title.innerHTML = `<i class="fa-solid fa-clock-rotate-left text-amber-400 mr-2"></i> ${userName} (Bio ID: ${bioId})`;
    if (subtitle) {
        const periodStr = monthlyReportData.month ? `Month: ${monthlyReportData.month} / ${monthlyReportData.year}` : `Full Year: ${monthlyReportData.year}`;
        subtitle.textContent = `${periodStr} • Days Present: ${user.days_present} • Total Trips: ${user.total_trips} • Time Inside: ${user.total_time_str}`;
    }

    if (tbody) {
        if (!user.daily_history || user.daily_history.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="text-center py-8 text-slate-500 text-sm">No gate movements logged for this period.</td></tr>`;
        } else {
            tbody.innerHTML = user.daily_history.map(d => `
                <tr class="hover:bg-slate-800/40 border-b border-slate-800/60">
                    <td class="py-2 px-3 font-mono font-bold text-white">${d.date}</td>
                    <td class="py-2 px-3 font-mono text-emerald-400 font-semibold">${d.first_in ? d.first_in : '--:--'}</td>
                    <td class="py-2 px-3 font-mono text-rose-400 font-semibold">${d.last_out ? d.last_out : '--:--'}</td>
                    <td class="py-2 px-3 font-mono text-emerald-300 font-bold">${d.in_count}x</td>
                    <td class="py-2 px-3 font-mono text-rose-300 font-bold">${d.out_count}x</td>
                    <td class="py-2 px-3 font-mono text-blue-400 font-bold">${d.duration_str}</td>
                </tr>
            `).join('');
        }
    }

    modal.classList.remove('hidden');
}

function downloadReportCsv() {
    const yearSelect = document.getElementById('reportYearSelect');
    const monthSelect = document.getElementById('reportMonthSelect');
    const year = yearSelect ? yearSelect.value : new Date().getFullYear();
    const month = monthSelect ? monthSelect.value : '';

    let url = `/api/reports/export?year=${year}`;
    if (month) url += `&month=${month}`;
    window.location.href = url;
}
