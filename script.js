function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

const KMB_API = 'https://data.etabus.gov.hk/v1/transport/kmb';
const CTB_API = 'https://rt.data.gov.hk/v2/transport/citybus';
const NLB_API = 'https://rt.data.gov.hk/v2/transport/nlb';
const MTR_API = 'https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php';

let stopCache = {};
let allRoutesDB = [];
let nlbRouteMap = {};
let allMtrStations = [];
let allMtrLines = [];
let mtrStationNames = {};
let isMapEnabled = false; // Default OFF

const cleanName = (n) => n ? n.replace(/\s*\([A-Z0-9\s]+\)$/, '').trim() : '';

const LINE_COLORS = {
    'AEL': '#007078', 'TCL': '#F38B00', 'TML': '#923011', 'TKL': '#692E6C',
    'EAL': '#53B7E8', 'SIL': '#B6BD00', 'TWL': '#E2231A', 'ISL': '#0071CE',
    'KTL': '#00AB4E', 'DRL': '#F550A6'
};

window.cardRegistry = {};
let cardCounter = 0;
let isEditMode = false;

const debouncedHandleInput = debounce((input, listId, clearId) => handleInput(input, listId, clearId), 150);

document.addEventListener('DOMContentLoaded', () => {
    initDarkMode();
    initMapSetting();
    buildMtrDb();
    preloadAllRoutes();
    StorageManager.loadAll();
    if (StorageManager.getList().length > 0) loadSavedItem(StorageManager.getList()[0].id);

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-wrapper')) {
            document.querySelectorAll('.suggestions-list').forEach(el => el.classList.remove('show'));
        }
        if (!e.target.closest('.mtr-popup') && !e.target.closest('.mtr-trigger-btn')) {
            document.querySelectorAll('.mtr-popup').forEach(el => el.classList.remove('show'));
            document.querySelectorAll('.mtr-trigger-btn').forEach(el => el.classList.remove('active'));
        }
    });

    // Setup Drag modified for Mobile Support (With Long Press)
    const setupDrag = (containerId, selector) => {
        const el = document.getElementById(containerId);

        // --- Desktop Drag ---
        el.addEventListener('dragover', e => {
            e.preventDefault();
            const draggable = document.querySelector(`${selector}.dragging`);
            if (!draggable) return;
            const afterEl = getDragAfterElement(el, e.clientY, selector);
            if (afterEl == null) el.appendChild(draggable); else el.insertBefore(draggable, afterEl);
        });

        // --- Mobile Touch Drag (Fix for iOS / Misclick) ---
        let touchEl = null;
        let dragTimer = null;

        el.addEventListener('touchstart', e => {
            const item = e.target.closest(selector);
            if (!item) return;

            let canDrag = false;
            if (selector === '.card') {
                const header = e.target.closest('.card-header');
                // 禁止在地圖或操作按鈕上觸發拖曳
                if (header && !e.target.closest('.close-card-btn, .dir-opt, .update-time, .leaflet-container')) {
                    canDrag = true;
                }
            } else if (selector === '.saved-item') {
                if (isEditMode && !e.target.closest('.delete-btn')) {
                    canDrag = true;
                }
            }

            if (canDrag) {
                // Long press delay to prevent accidental drag when scrolling
                dragTimer = setTimeout(() => {
                    touchEl = item;
                    item.classList.add('dragging');
                    document.body.style.overflow = 'hidden'; // Lock scroll
                    if (navigator.vibrate) navigator.vibrate(50); // Haptic feedback
                }, 400); // 0.4s delay
            }
        }, {passive: false});

        el.addEventListener('touchmove', e => {
            if (!touchEl) {
                // If moving before timer fires, cancel dragging (it's a scroll)
                clearTimeout(dragTimer);
                return;
            }
            e.preventDefault(); // Prevent scrolling if dragging is active
            const touch = e.touches[0];
            const afterEl = getDragAfterElement(el, touch.clientY, selector);
            if (afterEl == null) el.appendChild(touchEl); else el.insertBefore(touchEl, afterEl);
        }, {passive: false});

        el.addEventListener('touchend', e => {
            clearTimeout(dragTimer); // Clear timer if tapped quickly
            if (!touchEl) return;
            touchEl.classList.remove('dragging');
            touchEl = null;
            document.body.style.overflow = ''; // Restore page scroll
            if (selector === '.saved-item' && isEditMode) StorageManager.updateOrder();
        });
    };

    setupDrag('cards-container', '.card');
    setupDrag('saved-list-container', '.saved-item');
});

function toggleMtrPopup(position) {
    event.stopPropagation();
    const popupId = `mtr-popup-${position}`;
    const btnId = `mtr-btn-${position}`;
    const popup = document.getElementById(popupId);
    const btn = document.getElementById(btnId);
    const isShowing = popup.classList.contains('show');

    document.querySelectorAll('.mtr-popup').forEach(el => el.classList.remove('show'));
    document.querySelectorAll('.mtr-trigger-btn').forEach(el => el.classList.remove('active'));

    if (!isShowing) {
        renderMtrGrid(position);
        popup.classList.add('show');
        btn.classList.add('active');
    }
}

function renderMtrGrid(position) {
    const gridId = `mtr-grid-${position}`;
    const grid = document.getElementById(gridId);
    if (grid.children.length > 0) return;

    grid.innerHTML = allMtrLines.map(line => `
            <div class="mtr-line-item" onclick="onMtrLineSelect('${line.lineCode}', '${position}')">
                <div class="mtr-color-dot" style="background:${LINE_COLORS[line.lineCode] || '#999'}"></div>
                <div class="mtr-line-name">${line.lineName}</div>
            </div>
        `).join('');
}

function onMtrLineSelect(lineCode, source) {
    if (source === 'top') clearAllCards(false);
    createMtrLineCard(lineCode);
    document.querySelectorAll('.mtr-popup').forEach(el => el.classList.remove('show'));
    document.querySelectorAll('.mtr-trigger-btn').forEach(el => el.classList.remove('active'));
}

function buildMtrDb() {
    const MTR_DATA = {
        'AEL': { name: '機場快綫', stations: [{ c: 'HOK', n: '香港' }, { c: 'KOW', n: '九龍' }, { c: 'TSY', n: '青衣' }, { c: 'AIR', n: '機場' }, { c: 'AWE', n: '博覽館' }]},
        'TCL': { name: '東涌綫', stations: [{ c: 'HOK', n: '香港' }, { c: 'KOW', n: '九龍' }, { c: 'OLY', n: '奧運' }, { c: 'NAC', n: '南昌' }, { c: 'LAK', n: '荔景' }, { c: 'TSY', n: '青衣' }, { c: 'SUN', n: '欣澳' }, { c: 'TUC', n: '東涌' }]},
        'TML': { name: '屯馬綫', stations: [{ c: 'WKS', n: '烏溪沙' }, { c: 'MOS', n: '馬鞍山' }, { c: 'HEO', n: '恆安' }, { c: 'TSH', n: '大水坑' }, { c: 'SHM', n: '石門' }, { c: 'CIO', n: '第一城' }, { c: 'STW', n: '沙田圍' }, { c: 'CKT', n: '車公廟' }, { c: 'TAW', n: '大圍' }, { c: 'HIK', n: '顯徑' }, { c: 'DIH', n: '鑽石山' }, { c: 'KAT', n: '啟德' }, { c: 'SUW', n: '宋皇臺' }, { c: 'TKW', n: '土瓜灣' }, { c: 'HOM', n: '何文田' }, { c: 'HUH', n: '紅磡' }, { c: 'ETS', n: '尖東' }, { c: 'AUS', n: '柯士甸' }, { c: 'NAC', n: '南昌' }, { c: 'MEF', n: '美孚' }, { c: 'TWW', n: '荃灣西' }, { c: 'KSR', n: '錦上路' }, { c: 'YUL', n: '元朗' }, { c: 'LOP', n: '朗屏' }, { c: 'TIS', n: '天水圍' }, { c: 'SIH', n: '兆康' }, { c: 'TUM', n: '屯門' }]},
        'TKL': { name: '將軍澳綫', stations: [{ c: 'NOP', n: '北角' }, { c: 'QUB', n: '鰂魚涌' }, { c: 'YAT', n: '油塘' }, { c: 'TIK', n: '調景嶺' }, { c: 'TKO', n: '將軍澳' }, { c: 'HAH', n: '坑口' }, { c: 'POA', n: '寶琳' }, { c: 'LHP', n: '康城' } ]},
        'EAL': { name: '東鐵綫', stations: [{ c: 'ADM', n: '金鐘' }, { c: 'EXC', n: '會展' }, { c: 'HUH', n: '紅磡' }, { c: 'MKK', n: '旺角東' }, { c: 'KOT', n: '九龍塘' }, { c: 'TAW', n: '大圍' }, { c: 'SHT', n: '沙田' }, { c: 'FOT', n: '火炭' }, { c: 'RAC', n: '馬場' }, { c: 'UNI', n: '大學' }, { c: 'TAP', n: '大埔墟' }, { c: 'TWO', n: '太和' }, { c: 'FAN', n: '粉嶺' }, { c: 'SHS', n: '上水' }, { c: 'LOW', n: '羅湖' }, { c: 'LMC', n: '落馬洲' }]},
        'SIL': { name: '南港島綫', stations: [{ c: 'ADM', n: '金鐘' }, { c: 'OCP', n: '海洋公園' }, { c: 'WCH', n: '黃竹坑' }, { c: 'LET', n: '利東' }, { c: 'SOH', n: '海怡半島' }]},
        'TWL': { name: '荃灣綫', stations: [{ c: 'CEN', n: '中環' }, { c: 'ADM', n: '金鐘' }, { c: 'TST', n: '尖沙咀' }, { c: 'JOR', n: '佐敦' }, { c: 'YMT', n: '油麻地' }, { c: 'MOK', n: '旺角' }, { c: 'PRE', n: '太子' }, { c: 'SSP', n: '深水埗' }, { c: 'CSW', n: '長沙灣' }, { c: 'LCK', n: '荔枝角' }, { c: 'MEF', n: '美孚' }, { c: 'LAK', n: '荔景' }, { c: 'KWF', n: '葵芳' }, { c: 'KWH', n: '葵興' }, { c: 'TWH', n: '大窩口' }, { c: 'TSW', n: '荃灣' }]},
        'ISL': { name: '港島綫', stations: [{ c: 'KET', n: '堅尼地城' }, { c: 'HKU', n: '香港大學' }, { c: 'SYP', n: '西營盤' }, { c: 'SHW', n: '上環' }, { c: 'CEN', n: '中環' }, { c: 'ADM', n: '金鐘' }, { c: 'WAC', n: '灣仔' }, { c: 'CAB', n: '銅鑼灣' }, { c: 'TIH', n: '天后' }, { c: 'FOH', n: '炮台山' }, { c: 'NOP', n: '北角' }, { c: 'QUB', n: '鰂魚涌' }, { c: 'TAK', n: '太古' }, { c: 'SWH', n: '西灣河' }, { c: 'SKW', n: '筲箕灣' }, { c: 'HFC', n: '杏花邨' }, { c: 'CHW', n: '柴灣' }]},
        'KTL': { name: '觀塘綫', stations: [{ c: 'WHA', n: '黃埔' }, { c: 'HOM', n: '何文田' }, { c: 'YMT', n: '油麻地' }, { c: 'MOK', n: '旺角' }, { c: 'PRE', n: '太子' }, { c: 'SKM', n: '石硤尾' }, { c: 'KOT', n: '九龍塘' }, { c: 'LOF', n: '樂富' }, { c: 'WTS', n: '黃大仙' }, { c: 'DIH', n: '鑽石山' }, { c: 'CHH', n: '彩虹' }, { c: 'KOB', n: '九龍灣' }, { c: 'NTK', n: '牛頭角' }, { c: 'KWT', n: '觀塘' }, { c: 'LAT', n: '藍田' }, { c: 'YAT', n: '油塘' }, { c: 'TIK', n: '調景嶺' }]},
        'DRL': { name: '迪士尼綫', stations: [{ c: 'SUN', n: '欣澳' }, { c: 'DIS', n: '迪士尼' }]}
    };
    allMtrLines = Object.entries(MTR_DATA).map(([lineCode, lineData]) => ({
        lineCode, lineName: lineData.name, stations: lineData.stations.reduce((acc, s) => { acc[s.c] = s.n; return acc; }, {}), orderedStations: lineData.stations
    }));
    for (const [lineCode, lineData] of Object.entries(MTR_DATA)) {
        lineData.stations.forEach(s => {
            allMtrStations.push({ lineCode, staCode: s.c, lineName: lineData.name, staName: s.n });
            if (!mtrStationNames[s.c]) mtrStationNames[s.c] = s.n;
        });
    }
}
const LINE_TERMINALS = {
    'AEL': { UP: '博覽館', DOWN: '香港' }, 'TCL': { UP: '東涌', DOWN: '香港' }, 'TML': { UP: '屯門', DOWN: '烏溪沙' }, 'TKL': { UP: '寶琳 / 康城', DOWN: '北角' },
    'EAL': { UP: '羅湖 / 落馬洲', DOWN: '金鐘' }, 'SIL': { UP: '海怡半島', DOWN: '金鐘' }, 'TWL': { UP: '荃灣', DOWN: '中環' }, 'ISL': { UP: '柴灣', DOWN: '堅尼地城' },
    'KTL': { UP: '調景嶺', DOWN: '黃埔' }, 'DRL': { UP: '迪士尼', DOWN: '欣澳' }
};

function calculateETA(etaTime) {
    const now = new Date();
    const diffMins = Math.floor((etaTime - now) / 60000);
    if (diffMins < 0) return null; // Permanently cancel departed logic

    const isUrgent = diffMins <= 1;
    const minStr = diffMins === 0 ? '即將' : `${diffMins}分`;
    const timeStr = formatTime(etaTime);

    return {
        minStr,
        timeStr,
        isUrgent,
        classes: `eta-minutes ${isUrgent ? 'urgent' : ''}`
    };
}

const StorageManager = {
    key: 'hk_transport_saved_list',
    tempList: null,
    getList: () => (isEditMode && StorageManager.tempList) ? StorageManager.tempList : JSON.parse(localStorage.getItem(StorageManager.key) || '[]'),
    saveItem: (name, data) => {
        let list = JSON.parse(localStorage.getItem(StorageManager.key) || '[]');
        list.push({ id: Date.now(), name: name, data: data });
        localStorage.setItem(StorageManager.key, JSON.stringify(list));
        if (isEditMode) StorageManager.tempList = list;
        StorageManager.renderList();
    },
    deleteItem: (id) => {
        const filter = list => list.filter(item => item.id !== id);
        if (isEditMode) StorageManager.tempList = filter(StorageManager.tempList);
        else localStorage.setItem(StorageManager.key, JSON.stringify(filter(StorageManager.getList())));
        StorageManager.renderList();
    },
    renameItem: (id) => {
        if (!isEditMode) return;
        const item = StorageManager.tempList.find(x => x.id === id);
        const newName = prompt("請輸入新名稱:", item ? item.name : "");
        if (item && newName && newName.trim()) { item.name = newName.trim(); StorageManager.renderList(); }
    },
    updateOrder: () => {
        if (!isEditMode) return;
        const els = document.querySelectorAll('#saved-list-container .saved-item');
        const oldList = StorageManager.tempList;
        StorageManager.tempList = Array.from(els).map(el => oldList.find(x => x.id === parseInt(el.dataset.id))).filter(x=>x);
        StorageManager.renderList();
    },
    commit: () => { if (StorageManager.tempList) { localStorage.setItem(StorageManager.key, JSON.stringify(StorageManager.tempList)); StorageManager.tempList = null; } },
    discard: () => { StorageManager.tempList = null; },
    initTemp: () => { StorageManager.tempList = JSON.parse(localStorage.getItem(StorageManager.key) || '[]'); },
    loadAll: () => { StorageManager.renderList(); },
    renderList: () => {
        const list = StorageManager.getList();
        const container = document.getElementById('saved-list-container');
        if (list.length === 0) { container.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text-sub);">暫無儲存項目</div>'; return; }
        container.innerHTML = list.map((item, i) => {
            const isDefault = i === 0;
            let desc;
            const firstItem = item.data[0];
             if (firstItem.type === 'MTR_LINE') {
                const line = allMtrLines.find(l => l.lineCode === firstItem.lineCode);
                desc = `[港鐵] ${line ? line.lineName : firstItem.lineCode}`;
            } else if (firstItem.type === 'MTR') {
                const station = allMtrStations.find(s => s.staCode === firstItem.staCode);
                desc = `[港鐵] ${station ? station.staName : firstItem.staCode} (${station ? station.lineName : ''})`;
            } else {
                 desc = `[${firstItem.co||'KMB'}] ${firstItem.route} ${firstItem.destName ? '往 '+firstItem.destName : (firstItem.dir==='outbound'?'去程':'回程')}`;
            }
            if (item.data.length > 1) desc = `${item.data.length} 個項目組合`;

            return `
                    <div class="saved-item" draggable="${isEditMode}" data-id="${item.id}" onclick="onSavedItemClick(${item.id})">
                        <div class="saved-drag-handle">≡</div>
                        <div class="saved-info">
                            <div class="saved-name">${item.name} ${isDefault ? '<span class="default-badge">預設</span>' : ''}</div>
                            <div class="saved-detail">${desc}</div>
                        </div>
                        <div class="delete-btn" onclick="deleteSaved(event, ${item.id})">🗑</div>
                    </div>`;
        }).join('');
        container.classList.toggle('editing', isEditMode);
        StorageManager.bindEvents();
    },
    bindEvents: () => {
        document.querySelectorAll('.saved-item').forEach(item => {
            item.addEventListener('dragstart', () => item.classList.add('dragging'));
            item.addEventListener('dragend', () => { item.classList.remove('dragging'); if(isEditMode) StorageManager.updateOrder(); });
        });
    }
};

function toggleSidebar(show) {
    const sb = document.getElementById('sidebar'), ov = document.getElementById('overlay');
    if (show) { sb.classList.add('active'); ov.classList.add('active'); }
    else {
        if (isEditMode) { isEditMode = false; StorageManager.discard(); document.getElementById('edit-btn').innerHTML = '✎'; document.getElementById('edit-btn').classList.remove('active'); StorageManager.renderList(); }
        sb.classList.remove('active'); ov.classList.remove('active');
    }
}
function toggleEditMode() {
    isEditMode = !isEditMode;
    const btn = document.getElementById('edit-btn');
    if (isEditMode) { StorageManager.initTemp(); btn.innerHTML = '💾'; btn.classList.add('active'); }
    else { StorageManager.commit(); btn.innerHTML = '✎'; btn.classList.remove('active'); }
    StorageManager.renderList();
}
function onSavedItemClick(id) { isEditMode ? StorageManager.renameItem(id) : loadSavedItem(id); }
function deleteSaved(e, id) { e.stopPropagation(); if(confirm('確定要刪除嗎？')) StorageManager.deleteItem(id); }

function saveCurrentAsGroup() {
    const cards = document.querySelectorAll('.card');
    if (cards.length === 0) return alert('目前沒有任何卡片可儲存');

    let defName;
    const firstCard = window.cardRegistry[cards[0].id];
    if (firstCard instanceof MTRLineCard) {
        defName = `港鐵 ${firstCard.lineInfo.lineName}`;
    } else if (firstCard instanceof MTRStationCard) {
        defName = `港鐵 ${firstCard.stationInfo.staName}`;
    } else {
        defName = `${firstCard.company} ${firstCard.route}` + (firstCard.currentDestName ? ` 往 ${firstCard.currentDestName}` : '');
    }
    if (cards.length > 1) defName = '我的通勤組合';

    const name = prompt('請輸入名稱：', defName);
    if (name) {
        const data = Array.from(cards).map(c => {
            const o = window.cardRegistry[c.id];
            if (!o) return null;
            if (o instanceof MTRStationCard) {
                return { type: 'MTR', lineCode: o.lineCode, staCode: o.staCode };
            } else if (o instanceof MTRLineCard) {
                return { type: 'MTR_LINE', lineCode: o.lineCode, dir: o.dir, markedSeq: o.markedSeq, filteredSeq: o.filteredSeq };
            } else {
                return { type: 'BUS', route: o.route, dir: o.dir, co: o.company, destName: o.currentDestName, filteredSeq: o.filteredSeq, markedSeq: o.markedSeq };
            }
        }).filter(x=>x);
        StorageManager.saveItem(name, data);
    }
}
function loadSavedItem(id) {
    const item = StorageManager.getList().find(x => x.id === id);
    if (!item) return;
    clearAllCards(false);
    item.data.forEach(d => {
        if (d.type === 'MTR') {
            createMtrCard(d.lineCode, d.staCode, d);
        } else if (d.type === 'MTR_LINE') {
            createMtrLineCard(d.lineCode, d, d.markedSeq);
        } else {
            createCard(d.route, d.co || 'KMB', d);
        }
    });
    toggleSidebar(false);
}
function clearAllCards(showEmpty = true) {
    document.getElementById('cards-container').innerHTML = showEmpty ? '<div id="empty-state"><div class="big-icon">🚍</div><div>請輸入巴士路線、港鐵綫或車站開始查詢</div></div>' : '';
    window.cardRegistry = {};
    document.getElementById('add-card-section').style.display = 'none';
}

function toggleAddSearch(show) {
    document.getElementById('show-add-btn').style.display = show ? 'none' : 'flex';
    const wrapper = document.getElementById('add-search-wrapper');
    wrapper.classList.toggle('active', show);
    if(show) document.getElementById('add-route-input').focus();
}
function handleInput(input, listId, clearId) {
    const val = input.value.trim();
    const upperVal = val.toUpperCase();
    document.getElementById(clearId).style.display = val.length ? 'flex' : 'none';
    const list = document.getElementById(listId);
    if (!val) {
        list.classList.remove('show');
        return;
    }

    const busMatches = allRoutesDB.filter(r => r.route.startsWith(upperVal)).slice(0, 50);
    const mtrLineMatches = allMtrLines.filter(l => l.lineName.includes(val) || l.lineCode.startsWith(upperVal));
    const mtrStationMatches = allMtrStations.filter(s => s.staName.includes(val) || s.staCode.startsWith(upperVal)).slice(0, 20);

    const getBadgeClass = co => ({'KMB':'badge-kmb', 'CTB':'badge-ctb', 'NLB':'badge-nlb', 'MTR': 'badge-mtr'}[co]);
    const getBadgeText = co => ({'KMB':'九巴', 'CTB':'城巴', 'NLB':'嶼巴', 'MTR':'港鐵'}[co]);

    const mtrLineHtml = mtrLineMatches.map(l => `
            <div class="suggestion-item" onmousedown="selectSuggestion({type: 'MTR_LINE', lineCode: '${l.lineCode}', inputId: '${input.id}', listId: '${listId}'})">
                 <div class="sug-left"><span class="co-badge ${getBadgeClass('MTR')}">${getBadgeText('MTR')}</span><span class="sug-route">${l.lineName}</span></div>
                <span class="sug-desc">顯示整條路綫</span>
            </div>`).join('');

    const mtrStationHtml = mtrStationMatches.map(s => `
            <div class="suggestion-item" onmousedown="selectSuggestion({type: 'MTR_STATION', lineCode: '${s.lineCode}', staCode: '${s.staCode}', inputId: '${input.id}', listId: '${listId}'})">
                 <div class="sug-left"><span class="co-badge ${getBadgeClass('MTR')}">${getBadgeText('MTR')}</span><span class="sug-route">${s.staName}</span></div>
                <span class="sug-desc">跳轉至 ${s.lineName}</span>
            </div>`).join('');

    const busHtml = busMatches.map(r => `
            <div class="suggestion-item" onmousedown="selectSuggestion({type: 'BUS', route: '${r.route}', co: '${r.co}', inputId: '${input.id}', listId: '${listId}'})">
                <div class="sug-left"><span class="co-badge ${getBadgeClass(r.co)}">${getBadgeText(r.co)}</span><span class="sug-route">${r.route}</span></div>
                <span class="sug-desc">${r.orig} ⇄ ${r.dest}</span>
            </div>`).join('');

    list.innerHTML = mtrLineHtml + mtrStationHtml + busHtml;
    list.classList.toggle('show', list.innerHTML.length > 0);
}
function clearSearch(id) {
    const el = document.getElementById(id); el.value = ''; el.focus();
    document.getElementById(id==='route-input'?'clear-search':'add-clear-search').style.display='none';
}
function selectSuggestion(params) {
    const { type, inputId, listId } = params;
    const inputEl = document.getElementById(inputId);
    document.getElementById(listId).classList.remove('show');
    const actionMap = {
        'BUS': () => createCard(params.route, params.co),
        'MTR_LINE': () => createMtrLineCard(params.lineCode),
        'MTR_STATION': () => createMtrLineCard(params.lineCode, null, params.staCode)
    };
    if (inputId === 'route-input') { clearAllCards(false); actionMap[type](); }
    else { actionMap[type](); toggleAddSearch(false); }
    inputEl.value = '';
}

function triggerShake(id) {
    const el = document.getElementById(id);
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
    setTimeout(() => el.classList.remove('shake'), 400);
    el.focus();
}

function performSearch(inputId) {
    const input = document.getElementById(inputId);
    const val = input.value.trim().toUpperCase();
    const listId = inputId === 'route-input' ? 'suggestions' : 'add-suggestions';

    if (!val) { triggerShake(inputId); return; }

    const line = allMtrLines.find(l => l.lineName === val || l.lineCode === val);
    if (line) {
        if(inputId === 'route-input') clearAllCards(false);
        createMtrLineCard(line.lineCode);
        finishSearch(inputId, listId);
        return;
    }

    const station = allMtrStations.find(s => s.staName === val || s.staCode === val);
    if (station) {
        if(inputId === 'route-input') clearAllCards(false);
        createMtrCard(station.lineCode, station.staCode);
        finishSearch(inputId, listId);
        return;
    }

    const bus = allRoutesDB.find(r => r.route === val);
    if (bus) {
        if(inputId === 'route-input') clearAllCards(false);
        createCard(bus.route, bus.co);
        finishSearch(inputId, listId);
        return;
    }
    triggerShake(inputId);
}

function finishSearch(inputId, listId) {
    const el = document.getElementById(inputId);
    el.value = ''; el.blur();
    document.getElementById(listId).classList.remove('show');
    document.getElementById(inputId==='route-input'?'clear-search':'add-clear-search').style.display='none';
    if (inputId === 'add-route-input') toggleAddSearch(false);
}

function searchTopItem() { performSearch('route-input'); }
function addItem() { performSearch('add-route-input'); }

function createCard(route, company, saved = null) {
    const id = `card-${++cardCounter}`;
    const card = new BusRouteCard(route, id, saved, company);
    window.cardRegistry[id] = card;
    card.init();
    document.getElementById('add-card-section').style.display = 'flex';
}

function createMtrCard(lineCode, staCode, saved = null) {
    const id = `card-${++cardCounter}`;
    const card = new MTRStationCard(lineCode, staCode, id, saved);
    window.cardRegistry[id] = card;
    card.init();
    document.getElementById('add-card-section').style.display = 'flex';
}

function createMtrLineCard(lineCode, saved = null, initialPin = null) {
    const id = `card-${++cardCounter}`;
    const card = new MTRLineCard(lineCode, id, saved, initialPin);
    window.cardRegistry[id] = card;
    card.init();
    document.getElementById('add-card-section').style.display = 'flex';
}

class BaseCard {
    destroy() {
        if (this.map) { this.map.remove(); this.map = null; }
        clearInterval(this.timer);
        this.element.style.cssText = 'opacity:0; transform:scale(0.9); margin-bottom:0; max-height:0;';
        setTimeout(() => {
            this.element.remove();
            delete window.cardRegistry[this.id];
            if(Object.keys(window.cardRegistry).length===0) clearAllCards(true);
        }, 300);
    }
    toggleMode(el, forceToTime = false) {
        const isTime = el.classList.contains('mode-time');
        if (forceToTime && isTime) return;
        el.classList.toggle('mode-time');
        const showTime = el.classList.contains('mode-time');
        el.querySelectorAll('.eta-minutes').forEach(s => {
            s.innerText = s.dataset[showTime ? 'time' : 'min'];
            s.classList.toggle('show-real-time', showTime);
        });
    }
    pin(e, id) {
        e.stopPropagation();
        if (this.filteredSeq === id) { 
            // Unpinning
            this.filteredSeq = null; this.markedSeq = null; 
        } else if (this.markedSeq === id) { 
            // Second click -> Filter
            this.filteredSeq = id; 
        } else { 
            // First click -> Mark
            this.markedSeq = id; this.filteredSeq = null; 
        }
        this.applyVisual();
        // 如果是巴士卡片，觸發地圖更新（縮放或隱藏）
        if (this instanceof BusRouteCard) {
            this.updateMap();
        }
    }
}

function getCardHeaderHtml(id, titleHtml, extraHtml = '') {
    return `
            <div class="card-header" 
                 onmousedown="if(!event.target.closest('.close-card-btn, .dir-opt, .update-time, .leaflet-container')) this.closest('.card').setAttribute('draggable', 'true')" 
                 onmouseup="this.closest('.card').setAttribute('draggable', 'false')"
                 ontouchstart="if(!event.target.closest('.close-card-btn, .dir-opt, .update-time, .leaflet-container')) this.closest('.card').setAttribute('draggable', 'true')" 
                 ontouchend="this.closest('.card').setAttribute('draggable', 'false')">
                
                <div class="close-card-btn" onclick="window.cardRegistry['${id}'].destroy()" onmousedown="event.stopPropagation()" ontouchstart="event.stopPropagation()">✕</div>
                <div class="header-top">
                    <div style="display:flex;align-items:center;">${titleHtml}</div>
                    <div class="update-time" onclick="window.cardRegistry['${id}'].fetchData()" onmousedown="event.stopPropagation()" ontouchstart="event.stopPropagation()"></div>
                </div>
                ${extraHtml}
            </div>`;
}

class MTRStationCard extends BaseCard {
    constructor(lineCode, staCode, id, saved) {
        super();
        this.id = id; this.lineCode = lineCode; this.staCode = staCode;
        this.stationInfo = allMtrStations.find(s => s.lineCode === lineCode && s.staCode === staCode);
        this.element = null; this.timer = null;
        this.viewMode = 'MIN'; // MIN or TIME
    }
    init() {
        document.getElementById('empty-state')?.remove();
        const div = document.createElement('div');
        div.setAttribute('draggable', 'false');
        div.className = 'card mtr-card'; div.id = this.id;
        div.innerHTML = `
                ${getCardHeaderHtml(this.id, `<span class="icon">🚇</span><span class="card-title">${this.stationInfo.staName} <small>(${this.stationInfo.lineName})</small></span>`)}
                <div class="card-content"><div class="status-msg">正在獲取列車資料...</div></div>`;
        document.getElementById('cards-container').appendChild(div);
        this.element = div;
        setTimeout(() => div.scrollIntoView({behavior:'smooth', block:'start'}), 100);
        div.addEventListener('dragstart', () => div.classList.add('dragging'));
        div.addEventListener('dragend', () => { div.classList.remove('dragging'); div.setAttribute('draggable', 'false'); });
        this.fetchData(); this.timer = setInterval(() => this.fetchData(), 30000);
    }
    renderError(message) { this.element.querySelector('.card-content').innerHTML = `<div class="status-msg error">${message}</div>`; }
    async fetchData() {
        this.element.querySelector('.update-time').innerText = '更新中...';
        try {
            const response = await fetch(`${MTR_API}?line=${this.lineCode}&sta=${this.staCode}&lang=TC`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (data.status === 0) { this.renderError(data.message || '服務現正暫停'); return; }
            this.render(data.data[`${this.lineCode}-${this.staCode}`]);
            this.element.querySelector('.update-time').innerText = '更新於 ' + formatTime(new Date());
        } catch (e) { this.renderError('資料載入失敗，請稍後再試'); console.error(e); }
    }
    toggleGlobalMode() {
        this.viewMode = this.viewMode === 'MIN' ? 'TIME' : 'MIN';
        this.fetchData(); // re-render to apply logic
    }
    _formatTrains(trains) {
        if (!trains || trains.length === 0) return '';

        const items = trains.map(train => {
            const etaInfo = calculateETA(new Date(train.time));
            if (!etaInfo) return null; // Filter out departed

            const destName = mtrStationNames[train.dest] || train.dest;
            const platCircled = ['⓪','①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩'][parseInt(train.plat)] || `(${train.plat})`;

            const displayText = (this.viewMode === 'TIME') ? etaInfo.timeStr : etaInfo.minStr;
            const classList = `${etaInfo.classes} ${this.viewMode === 'TIME' ? 'show-real-time' : ''}`;

            // Onclick toggles the global card mode
            return `<span class="${classList}" onclick="window.cardRegistry['${this.id}'].toggleGlobalMode()">${displayText}</span><span class="mtr-eta-details">${platCircled} ${destName}</span>`;
        }).filter(x => x);

        if (items.length === 0) return '';
        const inner = items.join('');
        return `<div class="mtr-train-grid">${inner}</div>`;
    }
    render(data) {
        const contentEl = this.element.querySelector('.card-content');
        if (!data || (!data.UP && !data.DOWN)) { this.renderError('暫無班次資料'); return; }
        const upHtml = this._formatTrains(data.UP);
        const downHtml = this._formatTrains(data.DOWN);
        let finalHtml = '';
        if (upHtml) finalHtml += `<div class="mtr-direction-group">${upHtml}</div>`;
        if (downHtml) finalHtml += `<div class="mtr-direction-group">${downHtml}</div>`;
        if (!finalHtml) this.renderError('暫無班次資料'); else contentEl.innerHTML = finalHtml;
    }
}

class MTRLineCard extends BaseCard {
    constructor(lineCode, id, saved, initialPin = null) {
        super();
        this.id = id; this.lineCode = lineCode;
        this.lineInfo = allMtrLines.find(l => l.lineCode === lineCode);
        const s = saved || {};
        this.dir = s.dir || 'UP';
        this.markedSeq = s.markedSeq || initialPin || null;
        this.filteredSeq = s.filteredSeq || (initialPin ? initialPin : null);
        this.element = null; this.timer = null;
    }
    init() {
        document.getElementById('empty-state')?.remove();
        const div = document.createElement('div');
        div.setAttribute('draggable', 'false');
        div.className = 'card mtr-card'; div.id = this.id;
        const terminals = LINE_TERMINALS[this.lineCode];
        const extraHtml = `<div class="direction-switch" onmousedown="event.stopPropagation()" ontouchstart="event.stopPropagation()"><span class="dir-opt btn-up" onclick="window.cardRegistry['${this.id}'].switchDir('UP')">往 ${terminals.UP}</span><span class="dir-opt btn-down" onclick="window.cardRegistry['${this.id}'].switchDir('DOWN')">往 ${terminals.DOWN}</span></div>`;

        div.innerHTML = `
                ${getCardHeaderHtml(this.id, `<span class="icon">🚇</span><span class="card-title">${this.lineInfo.lineName}</span>`, extraHtml)}
                <div class="card-content"><div class="status-msg">正在獲取整條綫列車資料...</div></div>`;
        document.getElementById('cards-container').appendChild(div);
        this.element = div;
        div.addEventListener('dragstart', () => div.classList.add('dragging'));
        div.addEventListener('dragend', () => { div.classList.remove('dragging'); div.setAttribute('draggable', 'false'); });
        this.updateUI(); this.fetchData(); this.timer = setInterval(() => this.fetchData(), 30000);
        setTimeout(() => div.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    }
    switchDir(dir) { if (this.dir === dir) return; this.dir = dir; this.filteredSeq = null; this.markedSeq = null; this.updateUI(); this.fetchData(); }
    updateUI() { this.element.querySelector('.btn-up').classList.toggle('active', this.dir === 'UP'); this.element.querySelector('.btn-down').classList.toggle('active', this.dir === 'DOWN'); }
    renderError(message) { this.element.querySelector('.card-content').innerHTML = `<div class="status-msg error">${message}</div>`; }
    applyVisual() {
        this.element.querySelectorAll('.schedule-item').forEach(el => {
            const staCode = el.dataset.stacode; const span = el.querySelector('.dest-seq'); const serial = el.dataset.serial;
            el.classList.toggle('hidden-row', this.filteredSeq !== null && this.filteredSeq !== staCode);
            el.classList.toggle('no-border', this.filteredSeq === staCode);
            if (this.markedSeq === staCode) { span.innerHTML = '<span class="pin-icon">📌</span>'; span.style.opacity = '1'; } else { span.innerHTML = serial; span.style.opacity = ''; }
        });
        if (this.filteredSeq) { const targetEl = this.element.querySelector(`.schedule-item[data-stacode="${this.filteredSeq}"]`); if (targetEl) targetEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    }
    async fetchData() {
        this.element.querySelector('.update-time').innerText = '更新中...';
        const stationList = this.lineInfo.orderedStations;
        try {
            const responses = await Promise.all(stationList.map(s => fetch(`${MTR_API}?line=${this.lineCode}&sta=${s.c}&lang=TC`).then(res => res.json())));
            const allData = responses.map((data, i) => ({ staCode: stationList[i].c, schedule: data.data ? data.data[`${this.lineCode}-${stationList[i].c}`] : null, }));
            this.render(allData);
            this.element.querySelector('.update-time').innerText = '更新於 ' + formatTime(new Date());
        } catch (e) { this.renderError('全綫資料載入失敗'); console.error(e); }
    }
    render(data) {
        // Check which rows are currently in Time mode
        const activeStaCodes = new Set();
        this.element.querySelectorAll('.schedule-item.mode-time').forEach(el => activeStaCodes.add(el.dataset.stacode));

        const contentEl = this.element.querySelector('.card-content');
        let finalHtml = '';
        if (this.dir === 'DOWN') data.reverse();
        let serial = 1;
        for (const stationData of data) {
            const { staCode, schedule } = stationData;
            let trainHtml = '';
            if (schedule) {
                const trains = schedule[this.dir] || [];
                const items = trains.map(train => {
                    if (this.lineCode === 'EAL' && this.dir === 'UP' && !['LOW', 'LMC', 'SHT', 'TAP', 'FAN', 'SHS'].includes(train.dest)) return null;
                    if (this.lineCode === 'TKL' && this.dir === 'UP' && !['POA', 'LHP'].includes(train.dest)) return null;

                    const etaInfo = calculateETA(new Date(train.time));
                    if (!etaInfo) return null; // Filter out departed

                    const destName = mtrStationNames[train.dest] || train.dest;
                    const platCircled = ['⓪','①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩'][parseInt(train.plat)] || `(${train.plat})`;

                    return `<span class="${etaInfo.classes}" data-min="${etaInfo.minStr}" data-time="${etaInfo.timeStr}">${etaInfo.minStr}</span><span class="mtr-eta-details">${platCircled} ${destName}</span>`;
                }).filter(x => x);

                if (items.length > 0) {
                    trainHtml = `<div class="mtr-train-grid">${items.join('')}</div>`;
                }
            }
            if (!trainHtml) trainHtml = '<span class="no-schedule">暫無班次</span>';
            finalHtml += `<div class="schedule-item" data-stacode="${staCode}" data-serial="${serial}" onclick="window.cardRegistry['${this.id}'].toggleMode(this)"><div class="stop-info"><span class="dest-seq" onclick="window.cardRegistry['${this.id}'].pin(event, '${staCode}')">${serial}</span><span class="dest-name">${mtrStationNames[staCode]}</span></div><div class="eta-container">${trainHtml}</div></div>`;
            serial++;
        }
        contentEl.innerHTML = finalHtml;
        this.applyVisual();

        // Restore Time Mode
        activeStaCodes.forEach(code => {
            const row = this.element.querySelector(`.schedule-item[data-stacode="${code}"]`);
            if(row) this.toggleMode(row, true);
        });
    }
}

class BusRouteCard extends BaseCard {
    constructor(route, id, saved, company) {
        super();
        this.id = id; this.route = route; this.company = (saved ? saved.co : company) || company;
        const s = saved || {};
        this.dir = s.dir || 'outbound';
        this.markedSeq = s.markedSeq || null;
        this.filteredSeq = s.filteredSeq || null;
        this.currentDestName = s.destName || '';
        this.element = null; this.timer = null; this.currentStops = [];
        this.nlbIds = {}; this.lastRenderedDir = null;
        this.map = null; this.mapGroup = null; this.stopMapData = [];
    }
    init() {
        document.getElementById('empty-state')?.remove();
        let cardClass = '', coName = '九巴';
        if (this.company === 'CTB') { cardClass = 'ctb-card'; coName = '城巴'; }
        else if (this.company === 'NLB') { cardClass = 'nlb-card'; coName = '嶼巴'; }
        const div = document.createElement('div');
        div.setAttribute('draggable', 'false');
        div.className = `card ${cardClass}`; div.id = this.id;
        const extraHtml = `<div class="direction-switch" onmousedown="event.stopPropagation()" ontouchstart="event.stopPropagation()"><span class="dir-opt btn-out" onclick="window.cardRegistry['${this.id}'].switchDir('outbound')">往 ...</span><span class="dir-opt btn-in" onclick="window.cardRegistry['${this.id}'].switchDir('inbound')">往 ...</span></div>`;

        div.innerHTML = `
                ${getCardHeaderHtml(this.id, `<span class="icon">🚌</span><span class="card-title">${coName} ${this.route}</span>`, extraHtml)}
                <div class="card-content">
                    <div id="map-container-${this.id}" class="route-map-container" onmousedown="event.stopPropagation()" ontouchstart="event.stopPropagation()"></div>
                    <div id="list-${this.id}"><div class="status-msg">正在分析路線資料...</div></div>
                </div>`;
        document.getElementById('cards-container').appendChild(div);
        this.element = div;
        setTimeout(() => div.scrollIntoView({behavior:'smooth', block:'start'}), 100);
        div.addEventListener('dragstart', () => div.classList.add('dragging'));
        div.addEventListener('dragend', () => { div.classList.remove('dragging'); div.setAttribute('draggable', 'false'); });
        this.updateUI();
        this.fetchBoundaries().then(() => { this.fetchData(); this.timer = setInterval(() => this.fetchData(), 30000); });
    }
    async fetchBoundaries() {
        let outStops = [], inStops = [], outName = '', inName = '';
        if (this.company === 'NLB') {
            const variants = nlbRouteMap[this.route] || [];
            const processNLB = async (variant, dirKey) => {
                if (!variant) return [];
                this.nlbIds[dirKey] = variant.routeId;
                try {
                    const data = await fetch(`${NLB_API}/stop.php?action=list&routeId=${variant.routeId}`).then(r=>r.json());
                    const stops = data.stops || [];
                    stops.forEach(s => {
                        stopCache[`NLB_${s.stopId}`] = { 
                            name: s.stopName_c, 
                            lat: s.latitude, 
                            long: s.longitude 
                        };
                    });
                    return stops.map((s, i) => ({ stop: s.stopId, seq: i+1, name: cleanName(s.stopName_c) }));
                } catch { return []; }
            };
            [outStops, inStops] = await Promise.all([processNLB(variants[0], 'outbound'), processNLB(variants[1], 'inbound')]);
            outName = variants[0] ? variants[0].routeName_c.split('>')[1]?.trim() || variants[0].routeName_c : '';
            inName = variants[1] ? variants[1].routeName_c.split('>')[1]?.trim() || variants[1].routeName_c : '';
        } else {
            const api = this.company === 'KMB' ? KMB_API : CTB_API;
            const getStops = async (d) => { try { return (await (await fetch(`${api}/route-stop/${this.company==='KMB'?'': 'CTB/'}${this.route}/${d}${this.company==='KMB'?'/1':''}`)).json()).data; } catch{ return []; } };
            [outStops, inStops] = await Promise.all([getStops('outbound'), getStops('inbound')]);
            
            const getName = async (list) => {
                if (!list.length) return '';
                const lastStop = list[list.length-1];
                const info = await getStopName(lastStop.stop, this.company);
                return info ? info.name : '';
            };
            [outName, inName] = await Promise.all([getName(outStops), getName(inStops)]);
        }
        outName = cleanName(outName);
        inName = cleanName(inName);
        this.element.querySelector('.btn-out').innerText = outStops.length ? `往 ${outName || '去程'}` : '去程 (無資料)';
        this.element.querySelector('.btn-in').innerText = inStops.length ? `往 ${inName || '回程'}` : '回程 (無資料)';
        this.element.querySelector('.btn-in').style.display = inStops.length ? 'block' : 'none';
        if(!inStops.length && outStops.length) this.element.querySelector('.btn-out').innerText += ' (循環線)';
        this.destMap = { outbound: outName || '去程', inbound: inName || '回程' };
        this.currentDestName = this.destMap[this.dir];
        this.stopLists = { outbound: outStops, inbound: inStops };
    }
    switchDir(dir) { 
        if(this.dir === dir) return; 
        this.dir = dir; 
        this.markedSeq = null; 
        this.filteredSeq = null; 
        this.currentDestName = this.destMap[dir]; 
        this.updateUI(); 
        if(this.mapGroup) this.mapGroup.clearLayers();
        this.fetchData(); 
    }
    updateUI() { this.element.querySelector('.btn-out').classList.toggle('active', this.dir === 'outbound'); this.element.querySelector('.btn-in').classList.toggle('active', this.dir === 'inbound'); }
    
    initMap() {
        const containerId = `map-container-${this.id}`;
        if (!this.map) {
            this.map = L.map(containerId, {
                attributionControl: false,
                zoomControl: false,
                dragging: true,
                touchZoom: true,
                scrollWheelZoom: false
            });
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { opacity: 0.7 }).addTo(this.map);
            this.mapGroup = L.layerGroup().addTo(this.map);
        }
        setTimeout(() => this.map.invalidateSize(), 200);
    }

    updateMap() {
        const container = document.getElementById(`map-container-${this.id}`);
        
        // 如果功能未開啟，或 PIN 功能生效 (filteredSeq 有值)，則隱藏地圖
        if (!isMapEnabled || this.filteredSeq) {
            container.classList.remove('show');
            return;
        }

        container.classList.add('show');
        this.initMap();
        this.mapGroup.clearLayers();

        if (!this.stopMapData || this.stopMapData.length === 0) return;

        const points = [];
        let targetLatLong = null;

        this.stopMapData.forEach(s => {
            if (s.lat && s.long) {
                const latLng = [parseFloat(s.lat), parseFloat(s.long)];
                points.push(latLng);
                
                // 如果目前的 markedSeq 對應到這個站，記錄下來
                if (this.markedSeq === s.seq) {
                    targetLatLong = latLng;
                }

                // 繪製圓點
                L.circleMarker(latLng, {
                    radius: this.markedSeq === s.seq ? 8 : 5, // 標記時變大
                    color: 'white',
                    weight: 1,
                    fillColor: this.company === 'KMB' ? '#E3001B' : (this.company === 'NLB' ? '#007D8F' : '#F9D300'),
                    fillOpacity: 1
                }).bindPopup(`${s.seq}. ${s.name}`).addTo(this.mapGroup);
            }
        });

        if (points.length > 0) {
            // 決定路線顏色
            let lineColor = '#007AFF'; // 預設藍色
            if (this.company === 'KMB') lineColor = '#E3001B'; // 九巴紅
            else if (this.company === 'CTB') lineColor = '#F9D300'; // 城巴黃
            
            L.polyline(points, { color: lineColor, weight: 3, opacity: 0.8 }).addTo(this.mapGroup);
            
            // 視角控制：如果有標記(First Click)，放大到該站；否則顯示全路線
            if (targetLatLong) {
                this.map.setView(targetLatLong, 16, { animate: true });
            } else {
                this.map.fitBounds(L.latLngBounds(points), { padding: [20, 20] });
            }
        }
    }

    async fetchData() {
        const listEl = document.getElementById(`list-${this.id}`);
        this.element.querySelector('.update-time').innerText = '更新中...';
        if(listEl.innerText.includes('暫無')) listEl.classList.add('fading');
        
        try {
            this.currentStops = this.stopLists?.[this.dir];
            if (!this.currentStops?.length) await this.fetchBoundaries();
            this.currentStops = this.stopLists?.[this.dir];
            
            if (!this.currentStops?.length) { 
                listEl.innerHTML = '<div class="status-msg">此方向無車站資料</div>'; 
                return listEl.classList.remove('fading'); 
            }
            
            const needsRender = this.dir !== this.lastRenderedDir || !this.element.querySelector('.schedule-item');
            let rows = [];
            this.stopMapData = []; 

            const processStopInfo = async (s) => {
                let info = { name: s.name, lat: null, long: null };
                if (this.company === 'NLB') {
                    const cached = stopCache[`NLB_${s.stop}`];
                    if (cached) info = cached;
                } else {
                    const cached = await getStopName(s.stop, this.company);
                    if (cached) info = cached;
                }
                
                this.stopMapData.push({
                    seq: s.seq,
                    name: cleanName(info.name),
                    lat: info.lat,
                    long: info.long
                });
                
                return { seq: parseInt(s.seq), name: cleanName(info.name) };
            };

            if (this.company === 'NLB') {
                if (needsRender) { 
                    await Promise.all(this.currentStops.map(s => processStopInfo(s)));
                    this.stopMapData.sort((a,b) => a.seq - b.seq);
                    this.render(this.stopMapData.map(s => ({seq: s.seq, name: s.name, etas: []}))); 
                    this.lastRenderedDir = this.dir; 
                }
                
                const routeId = this.nlbIds[this.dir];
                this.currentStops.forEach(s => { 
                    fetch(`${NLB_API}/stop.php?action=estimatedArrivals&routeId=${routeId}&stopId=${s.stop}&language=zh`)
                    .then(r => r.json())
                    .then(data => this.updateRow(s.seq, (data.estimatedArrivals || []).map(e => ({ eta: e.estimatedArrivalTime })).sort((a,b)=>new Date(a.eta)-new Date(b.eta))))
                    .catch(() => this.updateRow(s.seq, null)); 
                });
            } else {
                if (this.company === 'KMB') {
                    const allEtas = (await (await fetch(`${KMB_API}/route-eta/${this.route}/1`)).json()).data || [];
                    const dirCode = this.dir === 'outbound' ? 'O' : 'I';
                    
                    rows = await Promise.all(this.currentStops.map(async s => {
                        const info = await processStopInfo(s);
                        return { 
                            ...info, 
                            etas: allEtas.filter(e => e.seq === parseInt(s.seq) && e.dir === dirCode && e.eta).sort((a,b)=>new Date(a.eta)-new Date(b.eta)) 
                        };
                    }));
                } else {
                    rows = await Promise.all(this.currentStops.map(async s => { 
                        const info = await processStopInfo(s);
                        const data = (await (await fetch(`${CTB_API}/eta/CTB/${s.stop}/${this.route}`)).json()).data || []; 
                        return { 
                            ...info, 
                            etas: data.filter(e => e.dir === (this.dir === 'outbound' ? 'O' : 'I') && e.eta).sort((a,b)=>new Date(a.eta)-new Date(b.eta)) 
                        }; 
                    }));
                }
                this.stopMapData.sort((a,b) => a.seq - b.seq);
                this.render(rows); 
                this.lastRenderedDir = this.dir;
            }
            
            this.updateMap();
            
            this.element.querySelector('.update-time').innerText = '更新於 ' + formatTime(new Date());
        } catch (e) { 
            listEl.innerHTML = '<div class="status-msg error">資料載入失敗</div>'; 
            console.error(e); 
        }
        listEl.classList.remove('fading');
    }
    generateTimeHtml(etas) {
        if (!etas || !etas.length) return '<span style="color:var(--text-sub);font-size:0.85rem;">暫無班次</span>';
        const items = etas.map(e => calculateETA(new Date(e.eta))).filter(x => x).slice(0, 3);
        if (items.length === 0) return '<span style="color:var(--text-sub);font-size:0.85rem;">暫無班次</span>';

        return items.map(info =>
            `<span class="${info.classes}" data-min="${info.minStr}" data-time="${info.timeStr}" style="margin-left:4px;">${info.minStr}</span>`
        ).join('');
    }
    render(rows) {
        const activeSeqs = new Set();
        this.element.querySelectorAll('.schedule-item.mode-time').forEach(el => activeSeqs.add(parseInt(el.dataset.seq)));

        const el = document.getElementById(`list-${this.id}`);
        if(!rows.length) { el.innerHTML = '<div class="status-msg">暫無資料</div>'; return; }
        el.innerHTML = rows.sort((a,b)=>a.seq-b.seq).map(r => `
                <div class="schedule-item" data-seq="${r.seq}" onclick="window.cardRegistry['${this.id}'].toggleMode(this)">
                    <div class="stop-info">
                        <span class="dest-seq" onclick="window.cardRegistry['${this.id}'].pin(event,${r.seq})">${r.seq}</span>
                        <span class="dest-name">${r.name}</span>
                    </div>
                    <div class="eta-container">${this.generateTimeHtml(r.etas)}</div>
                </div>`).join('');
        this.applyVisual();

        activeSeqs.forEach(seq => {
            const row = this.element.querySelector(`.schedule-item[data-seq="${seq}"]`);
            if(row) this.toggleMode(row, true);
        });
        
        this.updateMap();
    }
    updateRow(seq, etas) {
        const container = this.element.querySelector(`.schedule-item[data-seq="${seq}"] .eta-container`);
        if (!container) return;
        container.innerHTML = this.generateTimeHtml(etas);
        if (container.parentElement.classList.contains('mode-time')) this.toggleMode(container.parentElement, true);
    }
    applyVisual() {
        this.element.querySelectorAll('.schedule-item').forEach(el => {
            const seq = parseInt(el.dataset.seq), span = el.querySelector('.dest-seq');
            el.classList.toggle('hidden-row', this.filteredSeq !== null && this.filteredSeq !== seq);
            el.classList.toggle('no-border', this.filteredSeq === seq);
            span.innerHTML = (this.markedSeq === seq) ? '<span class="pin-icon">📌</span>' : seq;
        });
    }
}

function getDragAfterElement(container, y, selector) {
    return [...container.querySelectorAll(`${selector}:not(.dragging)`)].reduce((closest, child) => {
        const offset = y - child.getBoundingClientRect().top - child.getBoundingClientRect().height / 2;
        return (offset < 0 && offset > closest.offset) ? { offset, element: child } : closest;
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

async function preloadAllRoutes() {
    try {
        const [k, c, n] = await Promise.all([
            fetch(`${KMB_API}/route/`).then(r=>r.json()).catch(()=>({data:[]})),
            fetch(`${CTB_API}/route/CTB`).then(r=>r.json()).catch(()=>({data:[]})),
            fetch(`${NLB_API}/route.php?action=list`).then(r=>r.json()).catch(()=>({routes:[]}))
        ]);
        nlbRouteMap = (n.routes || []).reduce((acc, r) => { if(!acc[r.routeNo]) acc[r.routeNo] = []; acc[r.routeNo].push(r); return acc; }, {});
        const nlbList = Object.keys(nlbRouteMap).map(rNo => { const parts = nlbRouteMap[rNo][0].routeName_c.split('>'); return { route: rNo, orig: parts[0]?.trim() || '?', dest: parts[1]?.trim() || '?', co: 'NLB' }; });
        const seen = new Set();
        allRoutesDB = [...(k.data||[]).map(r=>({route:r.route,orig:r.orig_tc,dest:r.dest_tc,co:'KMB'})), ...(c.data||[]).map(r=>({route:r.route,orig:r.orig_tc,dest:r.dest_tc,co:'CTB'})), ...nlbList].filter(r => seen.has(r.route+'_'+r.co) ? false : seen.add(r.route+'_'+r.co)).sort((a,b) => (parseInt(a.route.replace(/\D/g,''))||0) - (parseInt(b.route.replace(/\D/g,''))||0) || a.route.localeCompare(b.route));
    } catch (e) { console.error("Failed to preload routes", e); }
}

async function getStopName(id, co) {
    const key = `${co}_${id}`; 
    if (stopCache[key]) return stopCache[key];
    
    try { 
        const d = await (await fetch(`${co==='KMB'?KMB_API:CTB_API}/stop/${id}`)).json(); 
        const info = {
            name: d.data.name_tc,
            lat: d.data.lat,
            long: d.data.long
        };
        return stopCache[key] = info; 
    } catch { 
        return { name: '未知車站', lat: null, long: null }; 
    }
}

function toggleDarkMode() { const on = document.getElementById('dm-toggle').checked; document.body.classList.toggle('dark-mode', on); localStorage.setItem('darkMode', on ? 'enabled' : 'disabled'); }
function initDarkMode() { const m = localStorage.getItem('darkMode'); if (m === 'enabled' || (!m && window.matchMedia('(prefers-color-scheme: dark)').matches)) { document.body.classList.add('dark-mode'); document.getElementById('dm-toggle').checked = true; } }

// 地圖開關設定
function toggleMapSetting() { 
    isMapEnabled = document.getElementById('map-toggle').checked; 
    localStorage.setItem('mapEnabled', isMapEnabled ? 'enabled' : 'disabled'); 
    // 重新整理現有卡片以套用設定
    Object.values(window.cardRegistry).forEach(card => {
        if(card instanceof BusRouteCard) card.updateMap();
    });
}
function initMapSetting() { 
    const m = localStorage.getItem('mapEnabled'); 
    isMapEnabled = (m === 'enabled');
    document.getElementById('map-toggle').checked = isMapEnabled; 
}

function formatTime(date) {
    if (!date) return '';
    return date.toLocaleTimeString('zh-HK', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false // 強制使用24小時制
    });
}
