// GateLock Pro Frontend Client
let ws = null;
let currentTab = 'live';
let presenceFilter = 'ALL';
let logsFilter = { gate: 'ALL', search: '', date: '', page: 0, limit: 50 };
let audioCtx = null;

function getLocalDateStr(offsetDays = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

let feedFilter = { mode: 'TODAY', date: getLocalDateStr(0), gate: 'ALL', search: '' };
let liveRosterFilter = { mode: 'TODAY', date: getLocalDateStr(0) };
let reportDateFilter = { mode: 'MONTH', date: '' };
let liveFeedDebounce = null;

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
        success: 'bg-white border-emerald-300 text-emerald-800 shadow-lg shadow-emerald-500/10',
        error: 'bg-white border-rose-300 text-rose-800 shadow-lg shadow-rose-500/10',
        warning: 'bg-white border-amber-300 text-amber-800 shadow-lg shadow-amber-500/10',
        info: 'bg-white border-blue-300 text-blue-900 shadow-lg shadow-blue-500/10'
    };
    const icons = {
        success: 'fa-circle-check text-emerald-600',
        error: 'fa-circle-xmark text-rose-600',
        warning: 'fa-triangle-exclamation text-amber-600',
        info: 'fa-bell text-blue-600'
    };

    toast.className = `toast max-w-sm p-4 rounded-2xl border shadow-md flex items-center gap-3 text-sm backdrop-blur-md ${colors[type] || colors.info}`;
    toast.innerHTML = `
        <i class="fa-solid ${icons[type] || icons.info} text-base shrink-0"></i>
        <div class="flex-1 font-medium leading-snug">${message}</div>
        <button onclick="this.parentElement.remove()" class="text-slate-400 hover:text-slate-700 shrink-0"><i class="fa-solid fa-xmark"></i></button>
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
        
        // Refresh live roster, feed & KPI summary
        fetchStatsSummary();
        fetchLivePresence();
        fetchLiveGateFeed();
        if (currentTab === 'logs') {
            fetchLogs();
        }
    } else if (event === 'LOG_DELETED') {
        showToast(`Log #${data.log_id} (${data.user_name}) was deleted by Admin ${data.deleted_by}`, 'warning');
        fetchStatsSummary();
        fetchLivePresence();
        fetchLiveGateFeed();
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
    } else if (event === 'BAG_VIOLATION') {
        playBeep(false);
        showToast(`⚠️ BAG VIOLATION: ${data.user_name} (ID: ${data.bio_user_id}) detected with ${data.bag_type}! Clip & Snapshot recorded.`, 'error');
        showBagViolationAlertBanner(data);
        fetchBagViolations();
        refreshAiCameraHud();
    }
}

function showBagViolationAlertBanner(v) {
    const banner = document.getElementById('latestPunchBanner');
    if (!banner) return;
    banner.classList.remove('hidden');
    banner.className = 'p-4 rounded-2xl border transition-all duration-300 flex flex-wrap items-center justify-between gap-4 shadow-md mb-6 bg-rose-50 border-rose-300 text-rose-950';
    banner.innerHTML = `
        <div class="flex items-center gap-4">
            <div class="w-12 h-12 rounded-xl flex items-center justify-center font-bold text-lg bg-rose-100 text-rose-700 border border-rose-300">
                <i class="fa-solid fa-briefcase"></i>
            </div>
            <div>
                <div class="flex items-center gap-2 flex-wrap">
                    <span class="text-xs px-2 py-0.5 rounded-full font-bold uppercase tracking-wider bg-rose-600 text-white">BAG POLICY VIOLATION</span>
                    <span class="text-base font-bold text-slate-900">${v.user_name}</span>
                    <span class="text-xs px-2 py-0.5 rounded-full font-mono bg-white text-slate-700 border border-slate-200 font-semibold">ID: ${v.bio_user_id}</span>
                    <span class="text-xs px-2 py-0.5 rounded-full font-bold bg-amber-100 text-amber-800 border border-amber-300">${v.bag_type} (${v.confidence}%)</span>
                </div>
                <div class="text-xs text-slate-700 mt-1 flex items-center gap-3 flex-wrap">
                    <span><i class="fa-solid fa-video text-rose-600 mr-1"></i>${v.camera_name} (${v.camera_ip})</span>
                    <span><i class="fa-solid fa-eye text-slate-500 mr-1"></i>Detected: ${v.detected_objects}</span>
                    <span><i class="fa-solid fa-clock text-slate-500 mr-1"></i>${v.timestamp}</span>
                </div>
            </div>
        </div>
        <div class="flex items-center gap-2">
            ${v.snapshot_url ? `<button onclick="openBagMediaModal('IMAGE', '${v.snapshot_url}', '${v.user_name}', '${v.bag_type} • ${v.timestamp}')" class="px-3 py-1.5 rounded-xl bg-white hover:bg-slate-50 text-slate-800 border border-slate-300 text-xs font-bold shadow-sm"><i class="fa-solid fa-image text-blue-600 mr-1"></i>View Snapshot</button>` : ''}
            ${v.clip_url ? `<button onclick="openBagMediaModal('VIDEO', '${v.clip_url}', '${v.user_name}', '${v.bag_type} • ${v.timestamp}')" class="px-3 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold shadow-sm"><i class="fa-solid fa-circle-play mr-1"></i>Play Clip</button>` : ''}
        </div>
    `;
}

function showLivePunchAlert(punch) {
    const banner = document.getElementById('latestPunchBanner');
    if (!banner) return;

    const isEntry = punch.gate_type === 'ENTRY';
    banner.classList.remove('hidden');
    banner.className = `p-4 rounded-2xl border transition-all duration-300 flex items-center justify-between shadow-md mb-6 ${
        isEntry 
            ? 'bg-emerald-50 border-emerald-200 text-emerald-950' 
            : 'bg-rose-50 border-rose-200 text-rose-950'
    }`;

    banner.innerHTML = `
        <div class="flex items-center gap-4">
            <div class="w-12 h-12 rounded-xl flex items-center justify-center font-bold text-lg ${
                isEntry ? 'bg-emerald-100 text-emerald-700 border border-emerald-300' : 'bg-rose-100 text-rose-700 border border-rose-300'
            }">
                <i class="fa-solid ${isEntry ? 'fa-arrow-right-to-bracket' : 'fa-arrow-right-from-bracket'}"></i>
            </div>
            <div>
                <div class="flex items-center gap-2">
                    <span class="text-base font-bold text-slate-900">${punch.user_name}</span>
                    <span class="text-xs px-2 py-0.5 rounded-full font-mono bg-white text-slate-700 border border-slate-200 font-semibold">ID: ${punch.bio_user_id}</span>
                    <span class="text-xs px-2 py-0.5 rounded-full font-bold uppercase tracking-wider ${
                        isEntry ? 'bg-emerald-100 text-emerald-800 border border-emerald-300' : 'bg-rose-100 text-rose-800 border border-rose-300'
                    }">${punch.gate_type}</span>
                </div>
                <div class="text-xs text-slate-600 mt-1 flex items-center gap-3">
                    <span><i class="fa-solid fa-building text-slate-400 mr-1"></i>${punch.department || 'General'}</span>
                    <span><i class="fa-solid fa-fingerprint text-slate-400 mr-1"></i>${punch.verify_mode}</span>
                    <span><i class="fa-solid fa-clock text-slate-400 mr-1"></i>${new Date(punch.timestamp).toLocaleTimeString()}</span>
                    <span class="font-semibold text-slate-700">Today: Entered ${punch.entry_count}x | Exited ${punch.exit_count}x</span>
                </div>
            </div>
        </div>
        <div class="text-right">
            <span class="text-xs font-mono uppercase px-2.5 py-1 rounded-lg ${
                punch.current_status === 'INSIDE' ? 'bg-emerald-100 text-emerald-800 border border-emerald-300 font-bold' : 'bg-slate-100 text-slate-600 border border-slate-200 font-medium'
            }">Status: ${punch.current_status}</span>
        </div>
    `;

    // Add to Live Feed mini-timeline if present
    const feed = document.getElementById('liveGateFeed');
    if (feed) {
        const item = document.createElement('div');
        item.className = 'p-3 rounded-xl bg-white border border-slate-200 flex items-center justify-between text-xs transition-all hover:border-blue-300 shadow-sm animate-fadeIn';
        item.innerHTML = `
            <div class="flex items-center gap-3">
                <span class="w-7 h-7 rounded-lg flex items-center justify-center font-bold text-xs ${
                    isEntry ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'
                }">
                    <i class="fa-solid ${isEntry ? 'fa-arrow-right-to-bracket' : 'fa-arrow-right-from-bracket'}"></i>
                </span>
                <div>
                    <div class="font-bold text-slate-900">${punch.user_name} <span class="font-normal text-slate-500 font-mono text-[11px]">(ID: ${punch.bio_user_id})</span></div>
                    <div class="text-[11px] text-slate-500">${punch.device_name} • ${punch.verify_mode}</div>
                </div>
            </div>
            <div class="text-right">
                <div class="font-mono text-slate-800 font-semibold">${new Date(punch.timestamp).toLocaleTimeString()}</div>
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
function computeFallbackDuration(firstEntryIso, lastPunchIso, isToday = true) {
    if (!firstEntryIso) return '0m';
    const start = new Date(firstEntryIso);
    if (isNaN(start.getTime())) return '0m';
    const now = new Date();
    const last = lastPunchIso ? new Date(lastPunchIso) : now;
    const end = isToday ? (now > last ? now : last) : last;
    const diffSec = Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000));
    const hrs = Math.floor(diffSec / 3600);
    const mins = Math.floor((diffSec % 3600) / 60);
    if (hrs > 0) return `${hrs}h ${mins}m`;
    return `${Math.max(1, mins)}m`;
}

function setFeedDateFilter(mode, customDate = '') {
    feedFilter.mode = mode;
    if (mode === 'TODAY') {
        feedFilter.date = getLocalDateStr(0);
    } else if (mode === 'YESTERDAY') {
        feedFilter.date = getLocalDateStr(-1);
    } else if (mode === 'TOMORROW') {
        feedFilter.date = getLocalDateStr(1);
    } else if (mode === 'ALL') {
        feedFilter.date = '';
    } else if (mode === 'CUSTOM') {
        feedFilter.date = customDate;
    }

    const dateInput = document.getElementById('liveFeedDateInput');
    if (dateInput) dateInput.value = feedFilter.date;

    document.querySelectorAll('.feed-date-btn').forEach(btn => {
        btn.classList.remove('bg-blue-600', 'text-white', 'border-blue-600', 'font-bold', 'shadow-sm');
        btn.classList.add('bg-slate-50', 'text-slate-600', 'border-slate-200', 'font-semibold');
    });
    const activeBtn = document.getElementById(`feedDateBtn-${mode}`);
    if (activeBtn) {
        activeBtn.classList.remove('bg-slate-50', 'text-slate-600', 'border-slate-200', 'font-semibold');
        activeBtn.classList.add('bg-blue-600', 'text-white', 'border-blue-600', 'font-bold', 'shadow-sm');
    }

    fetchLiveGateFeed();
}

function debounceLiveFeedSearch() {
    clearTimeout(liveFeedDebounce);
    liveFeedDebounce = setTimeout(() => {
        fetchLiveGateFeed();
    }, 250);
}

async function fetchLiveGateFeed() {
    const feed = document.getElementById('liveGateFeed');
    if (!feed) return;

    const gateSelect = document.getElementById('liveFeedGateSelect');
    const searchInput = document.getElementById('liveFeedSearchInput');
    const gate = gateSelect ? gateSelect.value : 'ALL';
    const search = searchInput ? searchInput.value.trim() : '';

    let url = `/api/logs?limit=100&offset=0`;
    if (gate && gate !== 'ALL') url += `&gate_type=${gate}`;
    if (search) url += `&search=${encodeURIComponent(search)}`;
    if (feedFilter.date) url += `&date=${feedFilter.date}`;

    try {
        const res = await fetch(url);
        if (!res.ok) return;
        const data = await res.json();
        renderLiveGateFeed(data.logs || [], data.total || 0);
    } catch (e) {
        console.error("Failed to fetch live gate feed", e);
    }
}

function renderLiveGateFeed(logs, total) {
    const feed = document.getElementById('liveGateFeed');
    const badge = document.getElementById('liveFeedCountBadge');
    if (badge) {
        badge.textContent = `${total} punch${total === 1 ? '' : 'es'}`;
    }
    if (!feed) return;

    const dateLabel = feedFilter.mode === 'TODAY' ? `Today (${feedFilter.date})`
        : feedFilter.mode === 'YESTERDAY' ? `Yesterday (${feedFilter.date})`
        : feedFilter.mode === 'TOMORROW' ? `Tomorrow (${feedFilter.date})`
        : feedFilter.mode === 'ALL' ? 'All Dates'
        : (feedFilter.date || 'All Dates');

    if (!logs || logs.length === 0) {
        feed.innerHTML = `
            <div class="text-center py-8 px-3 text-slate-400 text-xs space-y-2">
                <i class="fa-solid fa-calendar-day text-xl text-slate-300 block"></i>
                <div>No biometric punches found for <span class="font-bold text-slate-600">${dateLabel}</span>.</div>
                ${feedFilter.mode !== 'ALL' ? `
                <button onclick="setFeedDateFilter('ALL')" class="mt-2 px-3 py-1.5 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 font-semibold text-[11px] transition-all">
                    Show All Dates Punches
                </button>` : ''}
            </div>
        `;
        return;
    }

    feed.innerHTML = logs.map(punch => {
        const isEntry = punch.gate_type === 'ENTRY';
        const dt = new Date(punch.timestamp.replace(' ', 'T'));
        const timeStr = !isNaN(dt.getTime()) ? dt.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'}) : punch.timestamp.split(' ')[1] || '';
        const dateStr = !isNaN(dt.getTime()) ? dt.toLocaleDateString([], {day: '2-digit', month: 'short', year: 'numeric'}) : punch.timestamp.split(' ')[0] || '';
        return `
            <div class="p-3 rounded-xl bg-white border border-slate-200 flex items-center justify-between text-xs transition-all hover:border-blue-300 shadow-sm">
                <div class="flex items-center gap-2.5 min-w-0">
                    <span class="w-7 h-7 shrink-0 rounded-lg flex items-center justify-center font-bold text-xs ${
                        isEntry ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'
                    }">
                        <i class="fa-solid ${isEntry ? 'fa-arrow-right-to-bracket' : 'fa-arrow-right-from-bracket'}"></i>
                    </span>
                    <div class="truncate">
                        <div class="font-bold text-slate-900 truncate">
                            ${punch.user_name}
                            <span class="font-normal text-slate-500 font-mono text-[10px]">(ID: ${punch.bio_user_id})</span>
                        </div>
                        <div class="text-[10px] text-slate-500 flex items-center gap-1.5">
                            <span class="font-bold uppercase ${isEntry ? 'text-emerald-700' : 'text-rose-700'}">${isEntry ? 'IN' : 'OUT'}</span>
                            <span>•</span>
                            <span class="truncate">${punch.device_name}</span>
                        </div>
                    </div>
                </div>
                <div class="text-right shrink-0 ml-2">
                    <div class="font-mono text-slate-800 font-semibold text-[11px]">${timeStr}</div>
                    <div class="text-[10px] text-slate-500 font-mono">${dateStr}</div>
                </div>
            </div>
        `;
    }).join('');
}

function setLiveDateFilter(mode, customDate = '') {
    liveRosterFilter.mode = mode;
    if (mode === 'TODAY') {
        liveRosterFilter.date = getLocalDateStr(0);
    } else if (mode === 'YESTERDAY') {
        liveRosterFilter.date = getLocalDateStr(-1);
    } else if (mode === 'TOMORROW') {
        liveRosterFilter.date = getLocalDateStr(1);
    } else if (mode === 'ALL') {
        liveRosterFilter.date = 'ALL';
    } else if (mode === 'CUSTOM') {
        liveRosterFilter.date = customDate || getLocalDateStr(0);
    }

    const dateInput = document.getElementById('liveRosterDateInput');
    if (dateInput) {
        dateInput.value = (liveRosterFilter.date && liveRosterFilter.date !== 'ALL') ? liveRosterFilter.date : '';
    }

    document.querySelectorAll('.live-date-btn').forEach(btn => {
        btn.classList.remove('bg-blue-600', 'text-white', 'border-blue-600', 'font-bold', 'shadow-sm');
        btn.classList.add('bg-slate-50', 'text-slate-600', 'border-slate-200', 'font-semibold');
    });
    const activeBtn = document.getElementById(`liveDateBtn-${mode}`);
    if (activeBtn) {
        activeBtn.classList.remove('bg-slate-50', 'text-slate-600', 'border-slate-200', 'font-semibold');
        activeBtn.classList.add('bg-blue-600', 'text-white', 'border-blue-600', 'font-bold', 'shadow-sm');
    }

    // Also synchronize the Live Gate Feed filter when clicking the top date bar
    if (mode === 'ALL') {
        setFeedDateFilter('ALL');
    } else {
        setFeedDateFilter(mode, liveRosterFilter.date);
    }

    fetchLivePresence();
    fetchStatsSummary();
}

async function fetchStatsSummary() {
    try {
        let url = '/api/stats/summary';
        if (liveRosterFilter.date) {
            url += `?date=${encodeURIComponent(liveRosterFilter.date)}`;
        }
        const res = await fetch(url);
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
    const params = new URLSearchParams();
    if (filter && filter !== 'ALL') params.set('status_filter', filter);
    if (liveRosterFilter.date) params.set('date', liveRosterFilter.date);
    const qs = params.toString();
    const url = qs ? `/api/presence/live?${qs}` : '/api/presence/live';
    try {
        const res = await fetch(url);
        if (!res.ok) return;
        let roster = await res.json();

        // If viewing a non-Today date and the backend didn't filter by date (e.g. before reload), compute from /api/logs for that date
        const todayStr = getLocalDateStr(0);
        if (liveRosterFilter.date && liveRosterFilter.date !== todayStr) {
            const logsUrl = liveRosterFilter.date === 'ALL'
                ? `/api/logs?limit=2000`
                : `/api/logs?limit=1000&date=${encodeURIComponent(liveRosterFilter.date)}`;
            const logsRes = await fetch(logsUrl);
            if (logsRes.ok) {
                const logsData = await logsRes.json();
                const byUser = {};
                (logsData.logs || []).slice().reverse().forEach(l => {
                    if (!byUser[l.bio_user_id]) {
                        byUser[l.bio_user_id] = {
                            bio_user_id: l.bio_user_id,
                            name: l.user_name,
                            department: 'Gate Access',
                            role_title: 'Staff',
                            entry_count: 0,
                            exit_count: 0,
                            total_count: 0,
                            first_entry_time: null,
                            last_punch_time: null,
                            current_status: 'OUTSIDE',
                            time_spent_str: '0m'
                        };
                    }
                    const uObj = byUser[l.bio_user_id];
                    if (l.gate_type === 'ENTRY') {
                        uObj.entry_count += 1;
                        if (!uObj.first_entry_time) uObj.first_entry_time = l.timestamp.replace(' ', 'T');
                    } else {
                        uObj.exit_count += 1;
                    }
                    uObj.total_count = uObj.entry_count + uObj.exit_count;
                    uObj.last_punch_time = l.timestamp.replace(' ', 'T');
                    uObj.current_status = (l.gate_type === 'ENTRY') ? 'INSIDE' : 'OUTSIDE';
                });
                roster = Object.values(byUser).map(uObj => {
                    uObj.time_spent_str = computeFallbackDuration(uObj.first_entry_time, uObj.last_punch_time, false);
                    return uObj;
                });
            }
        }

        renderPresenceTables(roster);
    } catch (e) {
        console.error("Failed to load presence", e);
    }
}

function renderPresenceTables(roster) {
    const isToday = (liveRosterFilter.mode === 'TODAY' || liveRosterFilter.date === getLocalDateStr(0));
    // 1. "Who Is Inside" Table (Filtered only to current inside users)
    const insideBody = document.getElementById('insideRosterTableBody');
    if (insideBody) {
        const insideUsers = roster.filter(u => u.current_status === 'INSIDE');
        document.getElementById('insideCountBadge').textContent = `${insideUsers.length} Active`;
        if (insideUsers.length === 0) {
            const label = liveRosterFilter.date === 'ALL' ? 'All Dates' : (liveRosterFilter.date || 'Today');
            insideBody.innerHTML = `<tr><td colspan="6" class="text-center py-8 text-slate-500 text-sm">No one is marked inside the gate for <span class="font-semibold">${label}</span>.</td></tr>`;
        } else {
            insideBody.innerHTML = insideUsers.map(u => {
                const displayDuration = (!u.time_spent_str || u.time_spent_str === '0m')
                    ? computeFallbackDuration(u.first_entry_time, u.last_punch_time, isToday)
                    : u.time_spent_str;
                return `
                <tr class="hover:bg-blue-50/50 border-b border-slate-100 transition-colors">
                    <td class="py-3 px-4">
                        <div class="flex items-center gap-3">
                            <div class="w-9 h-9 rounded-xl bg-blue-50 border border-blue-200 text-blue-700 flex items-center justify-center font-bold text-xs">
                                ${u.name.substring(0, 2).toUpperCase()}
                            </div>
                            <div>
                                <div class="font-bold text-slate-900 text-sm">${u.name}</div>
                                <div class="text-xs text-slate-500 font-mono">ID: ${u.bio_user_id}</div>
                            </div>
                        </div>
                    </td>
                    <td class="py-3 px-4">
                        <div class="text-xs text-slate-700 font-medium">${u.department || 'General'}</div>
                        <div class="text-[11px] text-slate-500">${u.role_title || 'Employee'}</div>
                    </td>
                    <td class="py-3 px-4 font-mono text-xs text-slate-700">
                        ${u.first_entry_time ? new Date(u.first_entry_time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '--:--'}
                    </td>
                    <td class="py-3 px-4 font-mono text-xs text-slate-700">
                        ${u.last_punch_time ? new Date(u.last_punch_time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '--:--'}
                    </td>
                    <td class="py-3 px-4">
                        <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                            <span class="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                            INSIDE
                        </span>
                    </td>
                    <td class="py-3 px-4 text-xs font-semibold text-blue-700 font-mono">
                        ${displayDuration}
                    </td>
                </tr>
            `}).join('');
        }
    }

    // 2. Full Activity Roster (How Come / How Go / How Many Times)
    const activityBody = document.getElementById('activityRosterTableBody');
    if (activityBody) {
        if (roster.length === 0) {
            activityBody.innerHTML = `<tr><td colspan="8" class="text-center py-12 text-slate-500 text-sm">
                <i class="fa-solid fa-fingerprint text-2xl mb-2 text-slate-400 block"></i>
                No biometric activity recorded yet today.<br>
                <span class="text-xs text-slate-500">Live punches from Gate 1 (192.168.1.224) and Gate 2 (192.168.1.165) will appear here automatically.</span>
            </td></tr>`;
        } else {
            activityBody.innerHTML = roster.map(u => {
                const isInside = u.current_status === 'INSIDE';
                const displayDuration = (isInside && (!u.time_spent_str || u.time_spent_str === '0m'))
                    ? computeFallbackDuration(u.first_entry_time, u.last_punch_time, isToday)
                    : u.time_spent_str;
                return `
                <tr class="hover:bg-blue-50/50 border-b border-slate-100 transition-colors">
                    <td class="py-3 px-4">
                        <div class="flex items-center gap-3">
                            <div class="w-8 h-8 rounded-lg bg-slate-100 text-slate-700 border border-slate-200 flex items-center justify-center font-bold text-xs">
                                ${u.name.substring(0, 2).toUpperCase()}
                            </div>
                            <div>
                                <span class="font-bold text-slate-900 text-sm">${u.name}</span>
                                <span class="text-xs text-slate-500 block font-mono">Bio ID: ${u.bio_user_id}</span>
                            </div>
                        </div>
                    </td>
                    <td class="py-3 px-4 text-xs text-slate-700">${u.department}</td>
                    <td class="py-3 px-4">
                        <span class="px-2 py-0.5 rounded text-xs font-mono font-bold ${
                            isInside ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-slate-100 text-slate-600 border border-slate-200'
                        }">
                            ${u.current_status}
                        </span>
                    </td>
                    <td class="py-3 px-4 text-xs text-emerald-700 font-bold font-mono">
                        ${u.entry_count} times
                    </td>
                    <td class="py-3 px-4 text-xs text-rose-700 font-bold font-mono">
                        ${u.exit_count} times
                    </td>
                    <td class="py-3 px-4 text-xs text-slate-800 font-bold font-mono">
                        ${u.total_count} total
                    </td>
                    <td class="py-3 px-4 text-xs text-blue-700 font-mono">
                        ${displayDuration}
                    </td>
                    <td class="py-3 px-4 text-xs font-mono text-slate-600">
                        ${u.last_punch_time ? new Date(u.last_punch_time).toLocaleTimeString() : 'No Punch'}
                    </td>
                </tr>
                `;
            }).join('');
        }
    }
}

function setLogsQuickDate(mode) {
    if (mode === 'TODAY') logsFilter.date = getLocalDateStr(0);
    else if (mode === 'YESTERDAY') logsFilter.date = getLocalDateStr(-1);
    else if (mode === 'TOMORROW') logsFilter.date = getLocalDateStr(1);
    else logsFilter.date = '';

    const dateInput = document.getElementById('logsDateFilter');
    if (dateInput) dateInput.value = logsFilter.date;
    fetchLogs(0);
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
            <i class="fa-solid fa-list-check text-2xl mb-2 text-slate-400 block"></i>
            No access logs recorded yet.<br>
            <span class="text-xs text-slate-500">Live gate punches from 192.168.1.224 and 192.168.1.165 will be logged here in real-time.</span>
        </td></tr>`;
        return;
    }

    tbody.innerHTML = logs.map(l => {
        const isEntry = l.gate_type === 'ENTRY';
        return `
        <tr class="hover:bg-blue-50/50 border-b border-slate-100 transition-colors text-xs">
            <td class="py-3 px-4 font-mono text-slate-400">#${l.id}</td>
            <td class="py-3 px-4">
                <span class="font-bold text-slate-900">${l.user_name}</span>
                <span class="block text-[11px] font-mono text-slate-500">ID: ${l.bio_user_id}</span>
            </td>
            <td class="py-3 px-4">
                <span class="px-2 py-1 rounded font-bold uppercase tracking-wider ${
                    isEntry ? 'bg-emerald-50 text-emerald-800 border border-emerald-300' : 'bg-rose-50 text-rose-800 border border-rose-300'
                }">
                    <i class="fa-solid ${isEntry ? 'fa-arrow-right-to-bracket' : 'fa-arrow-right-from-bracket'} mr-1"></i>
                    ${l.gate_type}
                </span>
            </td>
            <td class="py-3 px-4 text-slate-700 font-medium">${l.device_name}</td>
            <td class="py-3 px-4 text-slate-600"><i class="fa-solid fa-fingerprint mr-1 text-slate-400"></i>${l.verify_mode}</td>
            <td class="py-3 px-4 font-mono text-slate-700">${l.timestamp}</td>
            <td class="py-3 px-4 text-slate-500">${l.note || '-'}</td>
            ${isAdmin ? `
            <td class="py-3 px-4 text-right">
                <button onclick="confirmDeleteLog(${l.id}, '${l.user_name}')" title="Admin: Remove this record" 
                        class="px-2.5 py-1 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 transition-all font-medium">
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
            <i class="fa-solid fa-users text-2xl mb-2 text-slate-400 block"></i>
            No registered users in directory.<br>
            <span class="text-xs text-slate-500">Users are automatically registered when they punch at the gate, or click <strong>'+ Add New User'</strong> above.</span>
        </td></tr>`;
        return;
    }

    tbody.innerHTML = users.map(u => `
        <tr class="hover:bg-blue-50/50 border-b border-slate-100 transition-colors text-xs">
            <td class="py-3 px-4 font-mono font-bold text-blue-700">${u.bio_user_id}</td>
            <td class="py-3 px-4 font-bold text-slate-900 text-sm">${u.name}</td>
            <td class="py-3 px-4 text-slate-700">${u.role_title}</td>
            <td class="py-3 px-4 text-slate-700">${u.department}</td>
            <td class="py-3 px-4 font-mono text-slate-600">${u.phone || 'N/A'}</td>
            ${isAdmin ? `
            <td class="py-3 px-4 text-right flex items-center justify-end gap-2">
                <button onclick="openEditUserModal(${u.id}, '${u.bio_user_id}', '${u.name}', '${u.role_title}', '${u.department}', '${u.phone || ''}')" 
                        class="px-2.5 py-1 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 transition-all font-semibold">
                    <i class="fa-solid fa-pen-to-square mr-1"></i> Edit
                </button>
                <button onclick="confirmRemoveUser(${u.id}, '${u.name}', '${u.bio_user_id}')" 
                        class="px-2.5 py-1 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 transition-all font-semibold">
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
        <div class="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm transition-all hover:border-blue-300 hover:shadow-md">
            <div class="flex items-center justify-between mb-4">
                <div class="flex items-center gap-3">
                    <div class="w-12 h-12 rounded-xl flex items-center justify-center text-lg ${
                        isEntry ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-rose-50 text-rose-700 border border-rose-200'
                    }">
                        <i class="fa-solid fa-fingerprint"></i>
                    </div>
                    <div>
                        <h4 class="font-bold text-slate-900 text-base">${d.name}</h4>
                        <span class="text-xs uppercase px-2 py-0.5 rounded font-bold font-mono ${
                            isEntry ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-rose-50 text-rose-800 border border-rose-200'
                        }">Direction: ${d.gate_type}</span>
                    </div>
                </div>
                <div class="text-right">
                    <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold ${
                        isOnline ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-rose-50 text-rose-700 border border-rose-200'
                    }">
                        <span class="h-2 w-2 rounded-full ${isOnline ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}"></span>
                        ${d.last_status}
                    </span>
                </div>
            </div>

            <div class="space-y-2 py-3 border-y border-slate-100 text-xs font-mono">
                <div class="flex justify-between text-slate-500">
                    <span>IP Address:</span>
                    <span class="text-blue-700 font-bold">${d.ip_address}</span>
                </div>
                <div class="flex justify-between text-slate-500">
                    <span>Port:</span>
                    <span class="text-slate-800 font-semibold">${d.port}</span>
                </div>
                <div class="flex justify-between text-slate-500">
                    <span>Hardware Model:</span>
                    <span class="text-slate-800 font-semibold">Bio S-B251CB</span>
                </div>
                <div class="flex justify-between text-slate-500">
                    <span>Last Connected:</span>
                    <span class="text-slate-800">${d.last_connected_at ? new Date(d.last_connected_at).toLocaleTimeString() : 'Never'}</span>
                </div>
            </div>

            ${isAdmin ? `
            <div class="mt-4 grid grid-cols-2 gap-2">
                <button onclick="promptSyncDevice('${d.device_key}', '${d.name}')" class="col-span-2 py-2 px-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs shadow-md shadow-blue-500/20 transition-all flex items-center justify-center gap-1.5">
                    <i class="fa-solid fa-cloud-arrow-down"></i> Sync Enrolled Users from Machine
                </button>
                <button onclick="testDevice('${d.device_key}')" class="py-2 px-3 rounded-xl bg-slate-50 hover:bg-slate-100 text-slate-700 font-semibold text-xs border border-slate-200 transition-all flex items-center justify-center gap-1.5">
                    <i class="fa-solid fa-network-wired text-blue-600"></i> Test Ping
                </button>
                <button onclick="syncDevice('${d.device_key}')" class="py-2 px-3 rounded-xl bg-slate-50 hover:bg-slate-100 text-slate-700 font-semibold text-xs border border-slate-200 transition-all flex items-center justify-center gap-1.5">
                    <i class="fa-solid fa-arrows-rotate text-emerald-600"></i> Sync Logs
                </button>
                <button onclick="unlockGate('${d.device_key}')" class="py-2 px-3 rounded-xl bg-emerald-50 hover:bg-emerald-100 text-emerald-700 font-semibold text-xs border border-emerald-200 transition-all flex items-center justify-center gap-1.5">
                    <i class="fa-solid fa-lock-open"></i> Unlock Gate
                </button>
                <button onclick="clearDeviceLogs('${d.device_key}')" class="py-2 px-3 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-700 font-semibold text-xs border border-rose-200 transition-all flex items-center justify-center gap-1.5" title="Remove all biometric records from hardware">
                    <i class="fa-solid fa-eraser"></i> Wipe Bio Logs
                </button>
                <button onclick="openConfigModal('${d.device_key}', '${d.name}', '${d.ip_address}', ${d.port}, '${d.gate_type}')" class="col-span-2 py-2 px-3 rounded-xl bg-slate-50 hover:bg-slate-100 text-slate-700 font-semibold text-xs border border-slate-200 transition-all flex items-center justify-center gap-1.5">
                    <i class="fa-solid fa-gear text-amber-600"></i> Edit Device IP & Port
                </button>
            </div>
            ` : `
            <div class="mt-4 p-2.5 rounded-xl bg-blue-50 border border-blue-200 text-center text-xs text-blue-700 font-medium">
                <i class="fa-solid fa-shield text-blue-600 mr-1"></i> Owner View: Monitored 24/7
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
        btn.classList.remove('bg-blue-600', 'text-white', 'shadow-md', 'shadow-blue-500/25', 'border-blue-600');
        btn.classList.add('bg-white', 'text-slate-600', 'hover:bg-blue-50', 'hover:text-blue-600', 'border-slate-200', 'shadow-sm');
    });

    const activeContent = document.getElementById(`tabContent-${tabId}`);
    const activeBtn = document.getElementById(`navBtn-${tabId}`);
    if (activeContent) activeContent.classList.remove('hidden');
    if (activeBtn) {
        activeBtn.classList.remove('bg-white', 'text-slate-600', 'hover:bg-blue-50', 'hover:text-blue-600', 'border-slate-200', 'shadow-sm');
        activeBtn.classList.add('bg-blue-600', 'text-white', 'shadow-md', 'shadow-blue-500/25', 'border-blue-600');
    }

    if (tabId === 'live') {
        fetchLivePresence();
        fetchLiveGateFeed();
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
    } else if (tabId === 'camera') {
        fetchCameraConfig();
        fetchBagViolations();
        refreshAiCameraStreamImg();
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
    const todayStr = getLocalDateStr(0);
    const feedDateEl = document.getElementById('liveFeedDateInput');
    if (feedDateEl) feedDateEl.value = todayStr;
    const rosterDateEl = document.getElementById('liveRosterDateInput');
    if (rosterDateEl) rosterDateEl.value = todayStr;

    initWebSocket();
    fetchStatsSummary();
    fetchLivePresence();
    fetchLiveGateFeed();
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

function setReportQuickDate(mode, customDate = '') {
    reportDateFilter.mode = mode;
    if (mode === 'TODAY') {
        reportDateFilter.date = getLocalDateStr(0);
    } else if (mode === 'YESTERDAY') {
        reportDateFilter.date = getLocalDateStr(-1);
    } else if (mode === 'TOMORROW') {
        reportDateFilter.date = getLocalDateStr(1);
    } else if (mode === 'MONTH') {
        reportDateFilter.date = '';
    } else if (mode === 'ALL') {
        reportDateFilter.date = 'ALL';
    } else if (mode === 'CUSTOM') {
        reportDateFilter.date = customDate || '';
    }

    const reportDateInput = document.getElementById('reportDateInput');
    if (reportDateInput) {
        reportDateInput.value = (reportDateFilter.date && reportDateFilter.date !== 'ALL') ? reportDateFilter.date : '';
    }

    document.querySelectorAll('.report-date-btn').forEach(btn => {
        btn.classList.remove('bg-blue-600', 'text-white', 'border-blue-600', 'font-bold', 'shadow-sm');
        btn.classList.add('bg-slate-50', 'text-slate-700', 'border-slate-200', 'font-semibold');
    });
    const activeBtn = document.getElementById(`reportDateBtn-${mode}`);
    if (activeBtn) {
        activeBtn.classList.remove('bg-slate-50', 'text-slate-700', 'border-slate-200', 'font-semibold');
        activeBtn.classList.add('bg-blue-600', 'text-white', 'border-blue-600', 'font-bold', 'shadow-sm');
    }

    if (reportDateFilter.date && reportDateFilter.date !== 'ALL' && reportDateFilter.date.includes('-')) {
        const parts = reportDateFilter.date.split('-');
        const yEl = document.getElementById('reportYearSelect');
        const mEl = document.getElementById('reportMonthSelect');
        if (yEl) yEl.value = parts[0];
        if (mEl) mEl.value = String(parseInt(parts[1], 10));
    }

    fetchMonthlyReport();
}

async function fetchMonthlyReport() {
    const yearSelect = document.getElementById('reportYearSelect');
    const monthSelect = document.getElementById('reportMonthSelect');
    const searchInput = document.getElementById('reportSearchInput');

    const year = yearSelect ? yearSelect.value : new Date().getFullYear();
    const month = monthSelect ? monthSelect.value : (new Date().getMonth() + 1);
    const search = searchInput ? searchInput.value.trim() : '';

    let url = `/api/reports/monthly?year=${year}`;
    if (month && reportDateFilter.mode !== 'ALL') url += `&month=${month}`;
    if (reportDateFilter.date) url += `&date=${encodeURIComponent(reportDateFilter.date)}`;
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

        // Client-side filter fallback if a specific date (Today / Yesterday / Tomorrow / Custom) is active
        if (reportDateFilter.date && reportDateFilter.date !== 'ALL' && data.users) {
            const targetDate = reportDateFilter.date;
            let totIn = 0;
            let totOut = 0;
            data.users = data.users.map(u => {
                const matchingDays = (u.daily_history || []).filter(d => d.date === targetDate);
                const inC = matchingDays.reduce((s, d) => s + (d.in_count || 0), 0);
                const outC = matchingDays.reduce((s, d) => s + (d.out_count || 0), 0);
                totIn += inC;
                totOut += outC;
                const durStr = matchingDays.length === 1 ? (matchingDays[0].duration_str || '0m') : '0m';
                return {
                    ...u,
                    days_present: matchingDays.length,
                    entry_count: inC,
                    exit_count: outC,
                    total_trips: inC + outC,
                    total_time_str: durStr,
                    daily_history: matchingDays
                };
            });
            data.total_period_entries = totIn;
            data.total_period_exits = totOut;
            data.total_movements = totIn + totOut;
        }

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
        <tr class="hover:bg-blue-50/50 border-b border-slate-100 transition-colors">
            <td class="py-3 px-4 font-mono font-bold text-slate-900 text-xs">${u.bio_user_id}</td>
            <td class="py-3 px-4 font-semibold text-slate-900 text-sm">
                ${u.name}
            </td>
            <td class="py-3 px-4 text-xs text-slate-700">
                <div>${u.department}</div>
                <div class="text-[11px] text-slate-500">${u.role_title}</div>
            </td>
            <td class="py-3 px-4 text-xs font-mono font-bold ${u.days_present > 0 ? 'text-emerald-700' : 'text-slate-400'}">
                ${u.days_present} days
            </td>
            <td class="py-3 px-4 text-xs font-mono font-bold text-emerald-700">
                ${u.entry_count} times
            </td>
            <td class="py-3 px-4 text-xs font-mono font-bold text-rose-700">
                ${u.exit_count} times
            </td>
            <td class="py-3 px-4 text-xs font-mono font-bold text-blue-700">
                ${u.total_trips} total
            </td>
            <td class="py-3 px-4 text-xs font-mono font-semibold text-slate-800">
                ${u.total_time_str}
            </td>
            <td class="py-3 px-4 text-right">
                <button onclick="showUserHistoryModal('${u.bio_user_id}', '${u.name}')" 
                        class="px-2.5 py-1.5 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 text-xs font-semibold flex items-center gap-1.5 ml-auto transition-all shadow-sm">
                    <i class="fa-solid fa-clock-rotate-left text-xs text-amber-600"></i>
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

    if (title) title.innerHTML = `<i class="fa-solid fa-clock-rotate-left text-amber-600 mr-2"></i> ${userName} (Bio ID: ${bioId})`;
    if (subtitle) {
        const periodStr = monthlyReportData.month ? `Month: ${monthlyReportData.month} / ${monthlyReportData.year}` : `Full Year: ${monthlyReportData.year}`;
        subtitle.textContent = `${periodStr} • Days Present: ${user.days_present} • Total Trips: ${user.total_trips} • Time Inside: ${user.total_time_str}`;
    }

    if (tbody) {
        if (!user.daily_history || user.daily_history.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" class="text-center py-8 text-slate-500 text-sm">No gate movements logged for this period.</td></tr>`;
        } else {
            tbody.innerHTML = user.daily_history.map(d => `
                <tr class="hover:bg-blue-50/50 border-b border-slate-100">
                    <td class="py-2 px-3 font-mono font-bold text-slate-900">${d.date}</td>
                    <td class="py-2 px-3 font-mono text-emerald-700 font-semibold">${d.first_in ? d.first_in : '--:--'}</td>
                    <td class="py-2 px-3 font-mono text-rose-700 font-semibold">${d.last_out ? d.last_out : '--:--'}</td>
                    <td class="py-2 px-3 font-mono text-emerald-700 font-bold">${d.in_count}x</td>
                    <td class="py-2 px-3 font-mono text-rose-700 font-bold">${d.out_count}x</td>
                    <td class="py-2 px-3 font-mono text-blue-700 font-bold">${d.duration_str}</td>
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

// ==========================================
// AI IP CAMERA & NO-BAG POLICY DETECTION CENTER
// ==========================================
let bagViolationDateFilter = { mode: 'TODAY', date: getLocalDateStr(0) };
let browserWebcamStream = null;
let browserWebcamTimer = null;
let cameraApiBase = '';
let cameraWs = null;

async function resolveCameraApiBase() {
    if (cameraApiBase !== '') return cameraApiBase;
    try {
        const r = await fetch('/api/camera/config');
        if (r.ok) {
            cameraApiBase = '';
            return '';
        }
    } catch (e) {}
    cameraApiBase = `${window.location.protocol}//${window.location.hostname}:8001`;
    initCameraWebSocket();
    return cameraApiBase;
}

function initCameraWebSocket() {
    if (cameraWs || !cameraApiBase) return;
    try {
        const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        cameraWs = new WebSocket(`${wsProto}//${window.location.hostname}:8001/ws`);
        cameraWs.onmessage = (ev) => {
            try {
                const msg = JSON.parse(ev.data);
                if (msg.event === 'BAG_VIOLATION') {
                    handleWsMessage(msg);
                }
            } catch (e) {}
        };
        cameraWs.onclose = () => {
            cameraWs = null;
        };
    } catch (e) {}
}

function toggleCamPasswordVisibility() {
    const passInput = document.getElementById('camPassInput');
    const eyeIcon = document.getElementById('camPassEyeIcon');
    if (!passInput || !eyeIcon) return;
    if (passInput.type === 'password') {
        passInput.type = 'text';
        eyeIcon.classList.remove('fa-eye');
        eyeIcon.classList.add('fa-eye-slash', 'text-blue-600');
    } else {
        passInput.type = 'password';
        eyeIcon.classList.remove('fa-eye-slash', 'text-blue-600');
        eyeIcon.classList.add('fa-eye');
    }
}

async function refreshAiCameraStreamImg() {
    const base = await resolveCameraApiBase();
    const img = document.getElementById('aiCameraStreamImg');
    if (img && !browserWebcamStream) {
        img.src = `${base}/api/camera/mjpeg?t=${Date.now()}`;
    }
}

async function fetchCameraConfig() {
    try {
        const base = await resolveCameraApiBase();
        const res = await fetch(`${base}/api/camera/config`);
        if (!res.ok) return;
        const cfg = await res.json();

        const ipEl = document.getElementById('camIpInput');
        const portEl = document.getElementById('camPortInput');
        const brandEl = document.getElementById('camBrandInput');
        const nameEl = document.getElementById('camNameInput');
        const userEl = document.getElementById('camUserInput');
        const passEl = document.getElementById('camPassInput');
        const rtspEl = document.getElementById('camRtspUrlInput');

        if (ipEl) ipEl.value = cfg.ip_address || '192.168.1.164';
        if (portEl) portEl.value = cfg.port || 554;
        if (brandEl) brandEl.value = cfg.brand || 'cpplus';
        if (nameEl) nameEl.value = cfg.name || 'Gate 1 Entry IP Camera';
        if (userEl) userEl.value = cfg.username || 'admin';
        if (passEl) passEl.value = cfg.password || 'admin$2023';
        if (rtspEl) rtspEl.value = cfg.rtsp_url || '';

        updateCameraHudFromConfig(cfg);
    } catch (e) {
        console.error("Failed to fetch camera config", e);
    }
}

async function refreshAiCameraHud() {
    try {
        const base = await resolveCameraApiBase();
        const res = await fetch(`${base}/api/camera/config`);
        if (!res.ok) return;
        const cfg = await res.json();
        updateCameraHudFromConfig(cfg);
    } catch (e) {}
}

function updateCameraHudFromConfig(cfg) {
    const badge = document.getElementById('aiCameraStatusBadge');
    if (badge) {
        badge.textContent = `${cfg.scanner_status || 'READY'}${cfg.fps ? ` • ${cfg.fps} FPS` : ''}`;
    }
    const pill = document.getElementById('aiMatchedPersonPill');
    if (pill && cfg.recent_gate_user) {
        const u = cfg.recent_gate_user;
        pill.innerHTML = `<i class="fa-solid fa-fingerprint mr-1"></i> Gate Person: ${u.user_name} (ID: ${u.bio_user_id})`;
    }
    const detList = document.getElementById('liveDetectedObjectsList');
    if (detList && cfg.latest_detections) {
        if (cfg.latest_detections.length === 0) {
            detList.innerHTML = `<span class="px-2 py-0.5 rounded bg-white border border-slate-200 text-slate-500 font-mono text-[11px]">No prohibited bag in frame</span>`;
        } else {
            detList.innerHTML = cfg.latest_detections.map(d => `
                <span class="px-2 py-0.5 rounded font-mono text-[11px] font-bold ${
                    d.is_bag ? 'bg-rose-100 text-rose-800 border border-rose-300' : 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                }">
                    ${d.is_bag ? '⚠️ ' : ''}${d.display_name} (${d.confidence}%)
                </span>
            `).join('');
        }
    }
}

function selectDiscoveredCamera(ip) {
    if (!ip) return;
    const ipEl = document.getElementById('camIpInput');
    if (ipEl) ipEl.value = ip;
    showToast(`Selected IP Camera ${ip}. Enter camera password (if required) and click Save & Connect.`, 'info');
}

async function discoverLanCameras() {
    showToast("Scanning 192.168.1.x network for RTSP IP cameras...", "info");
    try {
        const base = await resolveCameraApiBase();
        const res = await fetch(`${base}/api/camera/discover`);
        const data = await res.json();
        if (res.ok && data.cameras) {
            const sel = document.getElementById('discoveredCamerasSelect');
            if (sel) {
                sel.innerHTML = `<option value="">-- Found ${data.total} IP Cameras on 192.168.1.x --</option>` +
                    data.cameras.map(c => `<option value="${c.ip}">${c.ip} (${c.brand_hint})</option>`).join('');
            }
            showToast(`Found ${data.total} RTSP IP cameras on 192.168.1.x!`, "success");
        }
    } catch (e) {
        showToast("Network camera scan failed", "error");
    }
}

async function saveCameraConfig() {
    const payload = {
        name: document.getElementById('camNameInput')?.value || 'Gate 1 Entry IP Camera',
        ip_address: document.getElementById('camIpInput')?.value || '192.168.1.164',
        port: parseInt(document.getElementById('camPortInput')?.value || '554', 10),
        brand: document.getElementById('camBrandInput')?.value || 'cpplus',
        username: document.getElementById('camUserInput')?.value || 'admin',
        password: document.getElementById('camPassInput')?.value || '',
        rtsp_url: document.getElementById('camRtspUrlInput')?.value || ''
    };
    showToast(`Connecting to IP Camera ${payload.ip_address}:${payload.port}...`, 'info');
    try {
        const base = await resolveCameraApiBase();
        const res = await fetch(`${base}/api/camera/config`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok) {
            showToast(data.message, 'success');
            refreshAiCameraStreamImg();
            setTimeout(refreshAiCameraHud, 1500);
        } else {
            showToast(data.detail || "Failed to update camera", 'error');
        }
    } catch (e) {
        showToast("Error saving camera configuration", 'error');
    }
}

async function startIpCameraStream() {
    if (browserWebcamStream) {
        stopBrowserWebcamScan();
    }
    try {
        const base = await resolveCameraApiBase();
        await fetch(`${base}/api/camera/toggle?enable=true`, { method: 'POST' });
        refreshAiCameraStreamImg();
        showToast("Started IP Camera AI Bag Detection stream.", "success");
        setTimeout(refreshAiCameraHud, 1200);
    } catch (e) {
        showToast("Failed to start camera stream", "error");
    }
}

async function toggleBrowserWebcamScan() {
    if (browserWebcamStream) {
        stopBrowserWebcamScan();
        return;
    }
    try {
        browserWebcamStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 360 }, audio: false });
        const video = document.getElementById('localWebcamVideo');
        const img = document.getElementById('aiCameraStreamImg');
        const btn = document.getElementById('btnBrowserWebcam');
        if (video) {
            video.srcObject = browserWebcamStream;
            video.classList.remove('hidden');
        }
        if (img) img.classList.add('hidden');
        if (btn) btn.innerHTML = `<i class="fa-solid fa-stop text-rose-600"></i> Stop PC Camera`;
        showToast("PC Camera active! AI is scanning live frames for bags & objects...", "success");

        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 360;
        const ctx = canvas.getContext('2d');

        browserWebcamTimer = setInterval(async () => {
            if (!browserWebcamStream || !video || video.readyState < 2) return;
            ctx.drawImage(video, 0, 0, 640, 360);
            canvas.toBlob(async (blob) => {
                if (!blob) return;
                const fd = new FormData();
                fd.append('file', blob, 'webcam.jpg');
                try {
                    const base = await resolveCameraApiBase();
                    const r = await fetch(`${base}/api/camera/scan-frame?record_if_bag=true`, { method: 'POST', body: fd });
                    if (r.ok) {
                        const resData = await r.json();
                        updateCameraHudFromConfig({
                            scanner_status: 'LIVE WEBCAM AI',
                            recent_gate_user: resData.matched_user,
                            latest_detections: resData.detections
                        });
                        if (resData.has_bag_violation) {
                            fetchBagViolations();
                        }
                    }
                } catch (err) {}
            }, 'image/jpeg', 0.82);
        }, 1200);
    } catch (e) {
        showToast("Could not access browser/PC webcam: " + (e.message || "Permission denied"), "error");
    }
}

function stopBrowserWebcamScan() {
    if (browserWebcamTimer) {
        clearInterval(browserWebcamTimer);
        browserWebcamTimer = null;
    }
    if (browserWebcamStream) {
        browserWebcamStream.getTracks().forEach(t => t.stop());
        browserWebcamStream = null;
    }
    const video = document.getElementById('localWebcamVideo');
    const img = document.getElementById('aiCameraStreamImg');
    const btn = document.getElementById('btnBrowserWebcam');
    if (video) video.classList.add('hidden');
    if (img) {
        img.classList.remove('hidden');
        refreshAiCameraStreamImg();
    }
    if (btn) btn.innerHTML = `<i class="fa-solid fa-camera"></i> Use PC / Browser Camera`;
}

async function handleScanUploadedImage(inputEl) {
    const file = inputEl.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    showToast(`Scanning image ${file.name} with YOLOv5n AI...`, 'info');
    try {
        const base = await resolveCameraApiBase();
        const res = await fetch(`${base}/api/camera/scan-frame?record_if_bag=true`, { method: 'POST', body: fd });
        const data = await res.json();
        if (res.ok) {
            refreshAiCameraStreamImg();
            updateCameraHudFromConfig({
                scanner_status: 'PHOTO SCANNED',
                recent_gate_user: data.matched_user,
                latest_detections: data.detections
            });
            if (data.has_bag_violation) {
                showToast(`⚠️ Prohibited Bag Detected! Logged under ${data.matched_user.user_name}`, 'error');
                fetchBagViolations();
            } else {
                const count = (data.detections || []).length;
                showToast(`Scan complete: ${count} object(s) detected, no prohibited bag found.`, 'success');
            }
        }
    } catch (e) {
        showToast("Error scanning uploaded image", "error");
    } finally {
        inputEl.value = '';
    }
}

async function triggerTestBagViolation() {
    showToast("Running AI Bag Scan & recording video clip...", "info");
    try {
        const base = await resolveCameraApiBase();
        const res = await fetch(`${base}/api/camera/test-violation`, { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
            if (data.violation) {
                showBagViolationAlertBanner(data.violation);
                showToast(data.message, 'error');
            }
            refreshAiCameraStreamImg();
            refreshAiCameraHud();
            fetchBagViolations();
        } else {
            showToast(data.detail || "Test scan failed", "error");
        }
    } catch (e) {
        showToast("Error triggering bag scan test", "error");
    }
}

function setBagViolationDateFilter(mode, customDate = '') {
    bagViolationDateFilter.mode = mode;
    if (mode === 'TODAY') bagViolationDateFilter.date = getLocalDateStr(0);
    else if (mode === 'YESTERDAY') bagViolationDateFilter.date = getLocalDateStr(-1);
    else if (mode === 'TOMORROW') bagViolationDateFilter.date = getLocalDateStr(1);
    else if (mode === 'ALL') bagViolationDateFilter.date = 'ALL';
    else if (mode === 'CUSTOM') bagViolationDateFilter.date = customDate || 'ALL';

    const dtInput = document.getElementById('bagViolationDateInput');
    if (dtInput) dtInput.value = (bagViolationDateFilter.date && bagViolationDateFilter.date !== 'ALL') ? bagViolationDateFilter.date : '';

    document.querySelectorAll('.bag-date-btn').forEach(btn => {
        btn.classList.remove('bg-blue-600', 'text-white', 'border-blue-600', 'font-bold', 'shadow-sm');
        btn.classList.add('bg-slate-50', 'text-slate-700', 'border-slate-200', 'font-semibold');
    });
    const activeBtn = document.getElementById(`bagDateBtn-${mode}`);
    if (activeBtn) {
        activeBtn.classList.remove('bg-slate-50', 'text-slate-700', 'border-slate-200', 'font-semibold');
        activeBtn.classList.add('bg-blue-600', 'text-white', 'border-blue-600', 'font-bold', 'shadow-sm');
    }

    fetchBagViolations();
}

async function fetchBagViolations() {
    const tbody = document.getElementById('bagViolationsTableBody');
    if (!tbody) return;
    const search = document.getElementById('bagViolationSearchInput')?.value?.trim() || '';
    const base = await resolveCameraApiBase();
    let url = `${base}/api/camera/violations?limit=100`;
    if (bagViolationDateFilter.date) url += `&date=${encodeURIComponent(bagViolationDateFilter.date)}`;
    if (search) url += `&search=${encodeURIComponent(search)}`;

    try {
        const res = await fetch(url);
        if (!res.ok) return;
        const data = await res.json();
        renderBagViolationsTable(data.violations || []);
    } catch (e) {
        console.error("Failed to fetch bag violations", e);
    }
}

function renderBagViolationsTable(violations) {
    const tbody = document.getElementById('bagViolationsTableBody');
    if (!tbody) return;
    const isAdmin = window.CURRENT_ROLE === 'admin';

    if (violations.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" class="text-center py-10 text-slate-400 text-xs">
                    <i class="fa-solid fa-shield-halved text-2xl text-emerald-400 mb-2 block"></i>
                    No bag policy violations recorded for the selected date.<br>
                    <span class="text-[11px] text-slate-400">Click <strong>"Simulate Bag Detection & Record Clip"</strong> above to test live snapshot + video clip recording.</span>
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = violations.map(v => `
        <tr class="hover:bg-rose-50/30 border-b border-slate-100 transition-colors text-xs">
            <td class="py-3 px-4">
                ${v.snapshot_url ? `
                <img src="${v.snapshot_url}" onclick="openBagMediaModal('IMAGE', '${v.snapshot_url}', '${v.user_name}', '${v.bag_type} • ${v.timestamp}')" 
                     class="w-24 h-14 object-cover rounded-xl border border-rose-200 cursor-pointer hover:scale-105 transition-transform shadow-sm" title="Click to enlarge annotated snapshot">
                ` : `<span class="text-slate-400">No Snapshot</span>`}
            </td>
            <td class="py-3 px-4">
                <div class="font-bold text-slate-900 text-sm">${v.user_name}</div>
                <div class="font-mono text-[11px] text-blue-700 font-semibold">Bio ID: ${v.bio_user_id}</div>
                <div class="text-[11px] text-slate-500">${v.department || 'Entry Gate'}</div>
            </td>
            <td class="py-3 px-4">
                <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-rose-50 text-rose-700 border border-rose-200 font-bold text-xs">
                    <i class="fa-solid fa-briefcase"></i> ${v.bag_type} (${v.confidence}%)
                </span>
                <div class="text-[11px] text-slate-500 mt-1 font-mono">Scanned: ${v.detected_objects}</div>
            </td>
            <td class="py-3 px-4">
                <div class="font-semibold text-slate-800">${v.camera_name}</div>
                <div class="font-mono text-[11px] text-slate-500">${v.camera_ip}</div>
                <div class="text-[11px] text-emerald-700 mt-0.5">${v.note || ''}</div>
            </td>
            <td class="py-3 px-4 font-mono text-slate-700">
                ${v.timestamp}
            </td>
            <td class="py-3 px-4 text-right">
                <div class="flex items-center justify-end gap-1.5 flex-wrap">
                    ${v.snapshot_url ? `
                    <button onclick="openBagMediaModal('IMAGE', '${v.snapshot_url}', '${v.user_name}', '${v.bag_type} • ${v.timestamp}')" 
                            class="px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 font-semibold text-xs">
                        <i class="fa-solid fa-image text-blue-600 mr-1"></i> Photo
                    </button>` : ''}
                    ${v.clip_url ? `
                    <button onclick="openBagMediaModal('VIDEO', '${v.clip_url}', '${v.user_name}', '${v.bag_type} • ${v.timestamp}')" 
                            class="px-2.5 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs shadow-sm">
                        <i class="fa-solid fa-circle-play mr-1"></i> Video Clip
                    </button>` : ''}
                    ${isAdmin ? `
                    <button onclick="promptEditBagViolation(${v.id}, '${v.user_name}', '${v.bio_user_id}', '${(v.note || '').replace(/'/g, '')}')" 
                            class="px-2 py-1.5 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 font-semibold text-xs" title="Edit Name / Note">
                        <i class="fa-solid fa-user-pen"></i>
                    </button>
                    <button onclick="confirmDeleteBagViolation(${v.id})" 
                            class="px-2 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 font-semibold text-xs" title="Delete Record">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>` : ''}
                </div>
            </td>
        </tr>
    `).join('');
}

function openBagMediaModal(type, url, userName, subtitle) {
    const modal = document.getElementById('bagMediaModal');
    const titleEl = document.getElementById('bagMediaModalTitle');
    const subEl = document.getElementById('bagMediaModalSubtitle');
    const contentEl = document.getElementById('bagMediaModalContent');
    if (!modal || !contentEl) return;

    if (titleEl) titleEl.innerHTML = `<i class="fa-solid ${type === 'VIDEO' ? 'fa-circle-play text-rose-600' : 'fa-image text-blue-600'} mr-2"></i> ${userName} — Bag Policy Evidence`;
    if (subEl) subEl.textContent = subtitle || '';

    if (type === 'VIDEO') {
        contentEl.innerHTML = `
            <video src="${url}" controls autoplay loop class="w-full max-h-[60vh] object-contain"></video>
        `;
    } else {
        contentEl.innerHTML = `
            <img src="${url}" alt="Bag Violation Snapshot" class="w-full max-h-[60vh] object-contain">
        `;
    }
    modal.classList.remove('hidden');
}

function closeBagMediaModal() {
    const modal = document.getElementById('bagMediaModal');
    const contentEl = document.getElementById('bagMediaModalContent');
    if (contentEl) contentEl.innerHTML = '';
    if (modal) modal.classList.add('hidden');
}

async function promptEditBagViolation(id, currentName, currentBioId, currentNote) {
    const user_name = prompt("Enter / Confirm Employee Name who carried the bag:", currentName);
    if (user_name === null) return;
    const bio_user_id = prompt("Enter Employee Biometric ID:", currentBioId);
    if (bio_user_id === null) return;
    const note = prompt("Enter Security Note:", currentNote);
    if (note === null) return;

    try {
        const base = await resolveCameraApiBase();
        const res = await fetch(`${base}/api/camera/violations/${id}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ user_name, bio_user_id, note })
        });
        if (res.ok) {
            showToast("Updated employee name & note on bag violation record.", "success");
            fetchBagViolations();
        }
    } catch (e) {
        showToast("Failed to update record", "error");
    }
}

async function confirmDeleteBagViolation(id) {
    if (!confirm(`Delete bag violation record #${id}?`)) return;
    try {
        const base = await resolveCameraApiBase();
        const res = await fetch(`${base}/api/camera/violations/${id}`, { method: 'DELETE' });
        if (res.ok) {
            showToast(`Bag violation record #${id} removed.`, "success");
            fetchBagViolations();
        }
    } catch (e) {
        showToast("Failed to delete record", "error");
    }
}
