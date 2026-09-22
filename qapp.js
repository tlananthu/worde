let version = '5.13';
let appConfig = JSON.parse(localStorage.getItem('quadra_config')) || {};
let isDocMode = false;
let tokenHeartbeatId = null;
let autoSyncTimerId = null; // NEW: Tracks the 20-minute sync loop
let isSyncingSingle = false;
let localDbFileHandle = null;
let currentTrackerMode = 'day';
let dbFileHandle = null; 
let activeRightPane = 'todaysPlan';
let isLeftPaneOpen = true;
let timeIndicatorInterval = null;
let preMaxLeftOpen = true;
let preMaxRightOpen = false;
let isMaximizingTransition = false;
let isActionBoardMaximized = false;

const IDB_NAME = 'QuadraFileCache';
const IDB_STORE = 'handles';

if (!appConfig.ignoreKeywords) appConfig.ignoreKeywords = 'out of office, ooo, away, vacation, holiday';
if (!appConfig.calSource) appConfig.calSource = 'google';
if (!appConfig.icsUrl) appConfig.icsUrl = '';
if (!appConfig.viewsEnabled) appConfig.viewsEnabled = { grid: true, kanban: true, overdue: true, tracker: true, notebook: true };
if (appConfig.viewsEnabled.notebook === undefined) appConfig.viewsEnabled.notebook = true;
if (!appConfig.defaultView) appConfig.defaultView = 'grid';
if (!appConfig.primaryTz) appConfig.primaryTz = 'local';
if (!appConfig.secondaryTz) appConfig.secondaryTz = 'none';
if (!appConfig.quadrantOrder) {
    appConfig.quadrantOrder = ['q1', 'q2', 'q3', 'q4', 'tray-inbox', 'tray-calendar', 'tray-closed'];
} else if (!appConfig.quadrantOrder.includes('notes')) {
    // Force inject 'notes' after 'tray-inbox' for existing saved layouts
    const inboxIdx = appConfig.quadrantOrder.indexOf('tray-inbox');
    if (inboxIdx !== -1) {
        appConfig.quadrantOrder.splice(inboxIdx + 1, 0, 'notes');
    } else {
        appConfig.quadrantOrder.push('notes');
    }
    localStorage.setItem('quadra_config', JSON.stringify(appConfig));
}
if (!appConfig.oooDates) {
    appConfig.oooDates = [];
}
if (!appConfig.quadrantWidths) appConfig.quadrantWidths = {};

if (!appConfig.projects || appConfig.projects.length === 0) {
    appConfig.projects = [{ id: 'p_default', name: 'Default', visible: true }];
}

let tokenClient;
let isGoogleSynced = false;
let clockIntervalId = null;
let timelineZoom = parseFloat(localStorage.getItem('quadra_zoom')) || 1;
let autoSaveTimerId = null;
let currentEditingId = null; 
let currentAddingQuadrant = null;
let pendingTimelineContext = null;
let dragState = null;
let isDraggingBlock = false;

// --- SQLite Database Engine ---
let db;
let SQL;
let driveFileId = null; // Will store the Google Drive file ID

async function initSQLite(binaryData = null) {
    if (!SQL) {
        SQL = await initSqlJs({
            // Fetch the WebAssembly file from the CDN
            locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${file}`
        });
    }
    
    if (binaryData) {
        // Load existing database from Google Drive
        db = new SQL.Database(new Uint8Array(binaryData));
        console.log("Loaded existing SQLite database from Google Drive.");
    } else {
        // Create a fresh database and schema
        db = new SQL.Database();
        db.run(`
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                text TEXT,
                quadrant TEXT,
                status TEXT,
                dueDate TEXT,
                timeBlocks TEXT,
                deleted INTEGER DEFAULT 0,
                projectId TEXT DEFAULT 'p_default'
            );
        `);
        db.run(`
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT,
                status TEXT
            );
        `);
        try { db.run(`ALTER TABLE tasks ADD COLUMN projectId TEXT DEFAULT 'p_default'`); } catch (e) {}
        console.log("Created fresh SQLite database in memory.");
    }
}

function syncNotesToSQLite() {
    if (!db) return;

    // Ensure the table exists
    db.run(`
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            text TEXT,
            quadrant TEXT,
            status TEXT,
            dueDate TEXT,
            timeBlocks TEXT,
            deleted INTEGER DEFAULT 0,
            projectId TEXT DEFAULT 'p_default'
        );
    `);
    try { db.run(`ALTER TABLE tasks ADD COLUMN projectId TEXT DEFAULT 'p_default'`); } catch (e) {}

    // Prepare a statement to insert or replace task records
    const stmt = db.prepare(`
        INSERT OR REPLACE INTO tasks (id, text, quadrant, status, dueDate, timeBlocks, deleted, projectId)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?);
    `);

    notes.forEach(note => {
        stmt.run([
            note.id.toString(),
            note.text || '',
            note.quadrant || 'inbox',
            note.status || 'active',
            note.dueDate || null,
            JSON.stringify(note.timeBlocks || []),
            note.deleted ? 1 : 0,
            JSON.stringify(note.projectIds || [note.projectId || 'p_default'])
        ]);
    });

    stmt.free();
}

// --- Google Drive AppData Sync ---
async function downloadDatabaseFromDrive() {
    // --- FIXED: True Promise-based await for the anti-race condition ---
    if (typeof gapi === 'undefined' || !gapi.client || !gapi.client.drive) {
        console.log("Waiting for Google Drive API to initialize...");
        await new Promise(resolve => setTimeout(resolve, 500));
        return await downloadDatabaseFromDrive(); // Recursively try again and block execution
    }

    try {
        // 1. Search the user's visible Drive for the database file
        const response = await gapi.client.drive.files.list({
            q: "name='quadra.sqlite' and trashed=false", 
            fields: 'files(id, name)',
            orderBy: 'createdTime desc' // Always grab the newest one if duplicates exist
        });
        
        const files = response.result.files;
        if (files && files.length > 0) {
            driveFileId = files[0].id;
            
            // 2. If found, download the binary contents
            const fileRes = await fetch(`https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`, {
                headers: { 'Authorization': `Bearer ${gapi.client.getToken().access_token}` }
            });
            const arrayBuffer = await fileRes.arrayBuffer();
            
            // 3. Boot SQLite with the downloaded data
            await initSQLite(arrayBuffer);
            loadNotesFromSQLite();
            setCloudSyncIcon('saved');
        } else {
            // No file exists yet in Drive, boot a fresh database
            await initSQLite(null);
        }
    } catch (e) {
        console.error("Failed to load DB from Drive:", e);
        await initSQLite(null); // Fallback to fresh DB
    }
}

async function uploadDatabaseToDrive() {
    if (!isGoogleSynced) {
        setCloudSyncIcon('error');
        return;
    }
    
    // 1. Change UI to "Saving" state immediately
    setCloudSyncIcon('saving');
    
    if (!db) {
        await initSQLite(null);
    }
    syncNotesToSQLite();

    try {
        const binaryData = db.export();
        const blob = new Blob([binaryData], { type: 'application/x-sqlite3' });
        const token = gapi.client.getToken().access_token;
        
        // --- FIX: Prevent duplicates by double-checking Drive if driveFileId is missing ---
        if (!driveFileId && gapi.client.drive) {
            const searchRes = await gapi.client.drive.files.list({
                q: "name='quadra.sqlite' and trashed=false",
                fields: 'files(id, name)',
                orderBy: 'createdTime desc'
            });
            if (searchRes.result.files && searchRes.result.files.length > 0) {
                driveFileId = searchRes.result.files[0].id;
            }
        }
        
        let url;
        let method;
        let metadata = { name: 'quadra.sqlite' };

        if (driveFileId) {
            url = `https://www.googleapis.com/upload/drive/v3/files/${driveFileId}?uploadType=multipart`;
            method = 'PATCH';
        } else {
            url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
            method = 'POST';
        }
        
        const form = new FormData();
        form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
        form.append('file', blob);
        
        const res = await fetch(url, {
            method: method,
            headers: { 'Authorization': `Bearer ${token}` },
            body: form
        });
        
        if (!res.ok) {
            const errData = await res.json();
            throw new Error(errData.error?.message || "Upload request failed");
        }
        
        const result = await res.json();
        if (result.id) driveFileId = result.id;
        
        // 2. Change UI to "Saved" state on success
        setCloudSyncIcon('saved');
        
    } catch (e) {
        console.error("Failed to upload DB to Drive:", e);
        // 3. Change UI to "Error" state on failure
        setCloudSyncIcon('error');
    }
}

function toggleDocMode() {
    const modalContent = document.querySelector('#taskModal .modal-content');
    const toggleBtn = document.getElementById('docModeToggleBtn');
    
    isDocMode = !isDocMode;
    
    if (isDocMode) {
        modalContent.classList.add('doc-mode');
        toggleBtn.innerText = '🗗'; // Window restore icon
        toggleBtn.title = "Exit Doc Mode";
        
        // Focus the main body text automatically when entering Doc Mode
        setTimeout(() => document.getElementById('taskInfoInput').focus(), 250);
    } else {
        modalContent.classList.remove('doc-mode');
        toggleBtn.innerText = '⛶'; // Maximize icon
        toggleBtn.title = "Enter Doc Mode";
    }
}

const SCOPES = 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/drive.file';

const defaultSchedule = [
    { title: 'Out of office hours', startHour: 14, endHour: 29 }, 
    { title: 'Lunch', startHour: 13, endHour: 14 }
];
let appSchedule = JSON.parse(localStorage.getItem('quadra_schedule')) || defaultSchedule;

// Data Migration
// --- Data Migration (Upgrade to Multi-Day Architecture) ---
let notes = JSON.parse(localStorage.getItem('quadra_notes')) || [];

notes = notes.map(note => {
    // 1. Initialize the new timeBlocks array if it doesn't exist
    if (!note.timeBlocks) {
        note.timeBlocks = [];
    }

    // 2. Safely port existing scheduled times into the new array format
    if (note.dueDate && note.dueTime !== undefined && note.dueDuration !== undefined) {
        
        // Prevent duplicates if the migration runs multiple times
        const alreadyMigrated = note.timeBlocks.some(b => b.date === note.dueDate && b.startHour === note.dueTime);
        
        if (!alreadyMigrated) {
            note.timeBlocks.push({
                blockId: 'b_' + Date.now().toString() + Math.floor(Math.random() * 1000),
                date: note.dueDate,
                startHour: note.dueTime,
                duration: note.dueDuration
            });
        }
        
        // 3. Clean up the outdated root-level scheduling variables
        delete note.dueTime;
        delete note.dueDuration;
    }

    // Ensure standard properties exist
    if (note.syncFailed === undefined) note.syncFailed = false;
    delete note.timeLogs; // Remove legacy unused property
    
    return { 
        ...note, 
        status: note.status || 'active', 
        dirty: note.dirty || false, 
        deleted: note.deleted || false, 
        eventId: note.eventId || null, 
        quadrant: note.quadrant || 'q2' 
    };
});

const uniqueIds = new Set();
notes = notes.filter(n => {
    if (uniqueIds.has(n.id)) return false; // Destroy the clone
    uniqueIds.add(n.id);
    return true; // Keep the original
});


const todayStr = new Date().toLocaleDateString('en-CA').split('T')[0]; 
let savedDate = localStorage.getItem('quadra_tracker_date');
document.getElementById('trackerDate').value = savedDate || todayStr;

document.getElementById('taskTitleInput')?.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
    }
});

// --- Saving Quadrant Order and Width States ---
function saveQuadrantState() {
    const container = document.getElementById('matrix');
    const quads = [...container.querySelectorAll('.quadrant')];
    appConfig.quadrantOrder = quads.map(q => q.id);
    localStorage.setItem('quadra_config', JSON.stringify(appConfig));
}

let quadResizeTimeout;
const quadResizeObserver = new ResizeObserver(entries => {
    clearTimeout(quadResizeTimeout);
    quadResizeTimeout = setTimeout(() => {
        let changed = false;
        entries.forEach(entry => {
            const el = entry.target;
            if (el.style.width && appConfig.quadrantWidths[el.id] !== el.style.width) {
                appConfig.quadrantWidths[el.id] = el.style.width;
                changed = true;
            }
        });
        if (changed) {
            localStorage.setItem('quadra_config', JSON.stringify(appConfig));
        }
    }, 500);
});

// --- Edge Splitter Pull Resizing Engine ---
function initQuadResize(event, quadId) {
    event.preventDefault();
    event.stopPropagation();
    const quadEl = document.getElementById(quadId);
    if (!quadEl) return;
    const startX = event.clientX;
    const startWidth = quadEl.getBoundingClientRect().width;
    document.body.style.cursor = 'col-resize';
    function onMouseMove(e) {
        const deltaX = e.clientX - startX;
        const newWidth = Math.max(260, Math.min(1000, Math.round(startWidth + deltaX)));
        quadEl.style.width = newWidth + 'px';
        appConfig.quadrantWidths[quadId] = newWidth + 'px';
    }
    function onMouseUp() {
        document.body.style.cursor = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        localStorage.setItem('quadra_config', JSON.stringify(appConfig));
    }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
}

function formatCurrentTimeBadge(date) {
    let primaryOpts = { hour: '2-digit', minute:'2-digit' };
    if (appConfig.primaryTz !== 'local') primaryOpts.timeZone = appConfig.primaryTz;
    let text = date.toLocaleTimeString([], primaryOpts);

    if (appConfig.secondaryTz && appConfig.secondaryTz !== 'none') {
        let secOpts = { hour: '2-digit', minute:'2-digit', timeZoneName: 'short' };
        secOpts.timeZone = appConfig.secondaryTz;
        let secText = date.toLocaleTimeString([], secOpts);
        text += ` (${secText})`;
    }
    return text;
}

function adjustTimelineZoom(amount) {
    timelineZoom = Math.max(0.5, Math.min(3, roundToQuarterHour(timelineZoom + amount)));
    localStorage.setItem('quadra_zoom', timelineZoom);
    updateZoomDisplay();
    renderTrackerTimeline();
}

function updateZoomDisplay() {
    const display = document.getElementById('zoomLevelDisplay');
    if (display) display.innerText = `${timelineZoom}x`;
}

function toggleCalSourceFields(source) {
    if (source === 'outlook') {
        document.getElementById('googleCalGroup').style.display = 'none';
        document.getElementById('outlookIcsGroup').style.display = 'block';
    } else {
        document.getElementById('googleCalGroup').style.display = 'block';
        document.getElementById('outlookIcsGroup').style.display = 'none';
    }
}

function setTrackerMode(mode) {
    currentTrackerMode = mode;
    document.getElementById('btnTrackerDay').classList.toggle('active', mode === 'day');
    document.getElementById('btnTrackerWeek').classList.toggle('active', mode === 'week');
    renderTrackerTimeline();
}

function saveNotes() { 
    localStorage.setItem('quadra_notes', JSON.stringify(notes)); 
    setCloudSyncIcon('unsaved');
}

function startLiveClock() {
    if(clockIntervalId) clearInterval(clockIntervalId);
    clockIntervalId = setInterval(() => {
        if (currentTrackerMode === 'day') { // <-- Removed currentLayout check
            const line = document.querySelector('.current-time-line');
            const badge = document.querySelector('.current-time-badge');
            if (line && badge) {
                const hourPx = 60 * timelineZoom;
                const now = new Date();
                const primaryTime = getTzTime(now, appConfig.primaryTz);
                const currentHour = primaryTime.h + (primaryTime.m / 60) + (primaryTime.s / 3600);
                
                line.style.top = `${currentHour * hourPx}px`;
                badge.innerText = formatCurrentTimeBadge(now);
            }
        }
    }, 30000); 
}

function stopLiveClock() {
    if(clockIntervalId) { clearInterval(clockIntervalId); clockIntervalId = null; }
}

// --- Drag/Drop Quadrants (Columns) Logic ---
function dragStartQuad(e) {
    if (e.target.classList.contains('quadrant')) {
        e.dataTransfer.setData('quadrant_id', e.target.id);
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => e.target.style.opacity = '0.5', 0);
    }
}

function dragEndQuad(e) {
    if (e.target.classList.contains('quadrant')) {
        e.target.style.opacity = '1';
        document.querySelectorAll('.quadrant').forEach(q => q.classList.remove('quad-drag-over', 'drag-over'));
    }
}

function allowDropQuad(e) {
    e.preventDefault();
    if(e.dataTransfer.types.includes('quadrant_id')) {
        e.currentTarget.classList.add('quad-drag-over');
    } else {
        e.currentTarget.classList.add('drag-over');
    }
}

function dragLeaveQuad(e) {
    e.currentTarget.classList.remove('quad-drag-over', 'drag-over');
}

function dropQuad(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('quad-drag-over', 'drag-over');
    
    const quadId = e.dataTransfer.getData('quadrant_id');
    if (quadId) {
        const draggedQuad = document.getElementById(quadId);
        const targetQuad = e.currentTarget;
        if (draggedQuad && targetQuad && draggedQuad !== targetQuad) {
            const container = document.getElementById('matrix');
            const allQuads = [...container.querySelectorAll('.quadrant')];
            const draggedIdx = allQuads.indexOf(draggedQuad);
            const targetIdx = allQuads.indexOf(targetQuad);
            
            if (draggedIdx < targetIdx) {
                targetQuad.parentNode.insertBefore(draggedQuad, targetQuad.nextSibling);
            } else {
                targetQuad.parentNode.insertBefore(draggedQuad, targetQuad);
            }
            saveQuadrantState();
        }
    } else {
        const noteId = e.dataTransfer.getData("text/plain");
        if(!noteId) return;
        const note = notes.find(n => n.id === noteId);
        
        // 1. Grab the exact ID we just added to the HTML columns
        let targetKey = e.currentTarget.id; 
        
        // 2. Fallback for Inbox/Notebook which drop onto the inner .task-list
        if (!targetKey) {
            const listEl = e.currentTarget.querySelector('.task-list') || e.currentTarget;
            targetKey = listEl.id;
        }
        
        // 3. Strip prefixes and assign ultimate failsafe
        targetKey = (targetKey || '').replace('list-', '').replace('tray-', '');
        if (!targetKey) targetKey = 'inbox'; 
        
        if (note && note.status === 'active' && note.quadrant !== targetKey) { 
            if (targetKey === 'closed') note.status = 'closed';
            if (targetKey === 'notes' && !note.text.includes('#note')) {
                note.text += ' #note';
            }
            
            note.quadrant = targetKey; 
            note.dirty = true; 
            saveNotes();
            handleSearch(); 
        }
    }
}

function changeTrackerDay(offset) {
    const dateInput = document.getElementById('trackerDate');
    
    // Split to explicitly force local time instead of UTC midnight
    const [y, m, d] = dateInput.value.split('-'); 
    const dateObj = new Date(y, m - 1, d);
    
    dateObj.setDate(dateObj.getDate() + offset);
    
    const localY = dateObj.getFullYear();
    const localM = String(dateObj.getMonth() + 1).padStart(2, '0');
    const localD = String(dateObj.getDate()).padStart(2, '0');
    
    dateInput.value = `${localY}-${localM}-${localD}`;
    renderTrackerTimeline();
}

function goToToday() {
    const dateInput = document.getElementById('trackerDate');
    dateInput.value = new Date().toLocaleDateString('en-CA').split('T')[0];
    renderTrackerTimeline();
}

function renderTrackerPalette() {
    const globalSearchInput = document.getElementById('searchInput');
    const globalQuery = globalSearchInput ? globalSearchInput.value : '';
    
    const paletteSearchInput = document.getElementById('paletteSearchInput');
    const paletteSearchText = paletteSearchInput ? paletteSearchInput.value : '';
    
    const clearPaletteBtn = document.getElementById('clearPaletteSearchBtn');
    if (clearPaletteBtn) {
        clearPaletteBtn.style.display = paletteSearchText.trim().length > 0 ? 'block' : 'none';
    }
    
    const effectivePaletteQuery = paletteSearchText.trim().length > 0 ? paletteSearchText : globalQuery;

    const paletteList = document.getElementById('tracker-palette-list');
    if (!paletteList) return;
    
    paletteList.innerHTML = '';
    
    const trackerDate = document.getElementById('trackerDate') ? document.getElementById('trackerDate').value : new Date().toLocaleDateString('en-CA').split('T')[0];
    const dueToggle = document.getElementById('dueFilterToggle');
    const isDueFilterOn = dueToggle && dueToggle.checked;

    // Shifted todayStr up so the filter can use it
    const todayStr = new Date().toLocaleDateString('en-CA').split('T')[0];

    let paletteNotes = notes.filter(n => !n.deleted && n.status !== 'closed' && matchesSearchQuery(n.text, effectivePaletteQuery) && !n.eventId && isProjectVisible(n));
    
    // 1. If Global Due is ON: Show tasks due on the selected date AND overdue tasks
    if (isDueFilterOn) {
        paletteNotes = paletteNotes.filter(n => n.dueDate && n.dueDate <= todayStr);
    }

    const quadPriority = { 'q1': 1, 'q2': 2, 'q3': 3, 'q4': 4, 'inbox': 5, 'calendar': 6 };
    
    paletteNotes.sort((a, b) => {
        const aIsDueSelectedDay = a.dueDate === trackerDate;
        const bIsDueSelectedDay = b.dueDate === trackerDate;

        // 2. If Global Due is OFF: Force tasks due on the selected day to the very top
        if (aIsDueSelectedDay && !bIsDueSelectedDay) return -1;
        if (!aIsDueSelectedDay && bIsDueSelectedDay) return 1;

        // Standard sorting for the rest
        if (a.dueDate && b.dueDate) {
            const dateCompare = a.dueDate.localeCompare(b.dueDate);
            if (dateCompare !== 0) return dateCompare;
        } 
        else if (a.dueDate && !b.dueDate) return -1;
        else if (!a.dueDate && b.dueDate) return 1;
        
        const pA = quadPriority[a.quadrant] || 99;
        const pB = quadPriority[b.quadrant] || 99;
        return pA - pB;
    });

    const quadStyles = {
        'q1': { color: 'var(--q1-text)', border: 'var(--q1-border)', bg: 'var(--q1-bg)', label: 'Q1 (Urgent)' },
        'q2': { color: 'var(--q2-text)', border: 'var(--q2-border)', bg: 'var(--q2-bg)', label: 'Q2 (Schedule)' },
        'q3': { color: 'var(--q3-text)', border: 'var(--q3-border)', bg: 'var(--q3-bg)', label: 'Q3 (Delegate)' },
        'q4': { color: 'var(--q4-text)', border: 'var(--q4-border)', bg: 'var(--q4-bg)', label: 'Q4 (Later)' },
        'inbox': { color: 'var(--text-muted)', border: 'var(--border-color)', bg: '#F1F5F9', label: 'Inbox' },
        'calendar': { color: 'var(--cal-text)', border: 'var(--cal-border)', bg: 'var(--cal-bg)', label: 'Calendar' }
    };

    paletteNotes.forEach(note => {
        const el = document.createElement('div');
        el.className = 'note'; 
        el.style.marginBottom = '8px'; 
        el.style.cursor = 'grab';
        el.draggable = true;
        el.ondragstart = (e) => e.dataTransfer.setData('text/plain', note.id);
        
        const qStyle = quadStyles[note.quadrant] || { color: 'var(--text-muted)', border: 'var(--border-color)', bg: '#F1F5F9', label: note.quadrant };

        // --- NEW: Apply a thick left border matching the CSS variable ---
        el.style.borderLeft = `4px solid ${qStyle.border}`;

        const isPlannedOnCalendar = note.timeBlocks && note.timeBlocks.some(block => block.date >= todayStr);
        
        if (isPlannedOnCalendar) {
            el.style.backgroundColor = '#F8FAFC';
            el.style.borderTop = '1px solid var(--border-color)';
            el.style.borderRight = '1px solid var(--border-color)';
            el.style.borderBottom = '1px solid var(--border-color)';
        }
        
        const contentWrapper = document.createElement('div');
        contentWrapper.className = 'note-content-wrapper';
        contentWrapper.style.maxWidth = '100%'; 
        
        let overdueIndicator = '';
        if (note.dueDate) {
            const dueDateStr = note.dueDate.split('T')[0];
            if (dueDateStr < todayStr) {
                overdueIndicator = `<span style="background: #FFF1F2; color: #9F1239; border: 1px solid #FECDD3; font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; margin-right: 6px;">OVERDUE</span>`;
            }
        }

        let cleanTextTitle = cleanHTMLToPlainText(note.text).split('\n')[0];
        contentWrapper.innerHTML = `<div class="note-text">${overdueIndicator}${parseTags(cleanTextTitle)}</div>`;
        
        // --- NEW: Inject the Quadrant Badge utilizing the full CSS theme ---
        let metaHTML = `<div style="font-size:11px; margin-top:10px; font-weight:600; display: flex; align-items: center; flex-wrap: wrap; gap: 8px;">`;
        
        metaHTML += `<span style="color: ${qStyle.color}; background-color: ${qStyle.bg}; border: 1px solid ${qStyle.border}; padding: 2px 6px; border-radius: 4px;">${qStyle.label}</span>`;

        if (note.dueDate) {
            metaHTML += `<span style="color: var(--text-muted); display: flex; align-items: center; gap: 4px;">🗓️ ${note.dueDate.split('T')[0]}</span>`;
        }
        
        if (isPlannedOnCalendar) {
            metaHTML += `<span style="margin-left: auto; background: var(--q2-bg); color: var(--q2-text); border: 1px solid var(--q2-border); padding: 2px 6px; border-radius: 4px; font-size: 9px; font-weight: 800; letter-spacing: 0.5px;">🕒 PLANNED</span>`;
        }

        metaHTML += `</div>`;
        contentWrapper.innerHTML += metaHTML;
        
        contentWrapper.onclick = (e) => openTaskModal(null, note.id, e);
        
        el.appendChild(contentWrapper);
        paletteList.appendChild(el);
    });
}

function renderTrackerTimeline() {
    const canvas = document.getElementById('timelineCanvas');
    const dateInput = document.getElementById('trackerDate');
    
    // SAFETY CHECK: Abort if the HTML elements don't exist yet
    if (!canvas || !dateInput) return; 

    // SAFETY CHECK: Prevent blank/invalid date crashes
    let baseDateStr = dateInput.value;
    if (!baseDateStr) {
        baseDateStr = new Date().toLocaleDateString('en-CA').split('T')[0];
        dateInput.value = baseDateStr;
    }

    const searchInput = document.getElementById('searchInput');
    const globalQuery = searchInput ? searchInput.value.toLowerCase() : '';
    
    const hourPx = 60 * timelineZoom;
    
    canvas.innerHTML = '';
    canvas.style.height = `${24 * hourPx}px`;

    const bgLines = document.createElement('div');
    bgLines.className = 'timeline-bg-lines';
    
    let hasSecTz = appConfig.secondaryTz && appConfig.secondaryTz !== 'none';
    let secOffsetDiff = 0;
    if (hasSecTz) {
        let primOff = getTzOffset(appConfig.primaryTz);
        let secOff = getTzOffset(appConfig.secondaryTz);
        secOffsetDiff = secOff - primOff;
    }

    const timeGutterWidth = hasSecTz ? 120 : 55;

    for (let i = 0; i <= 24; i++) {
        const row = document.createElement('div');
        row.className = 'time-row'; 
        row.style.top = `${i * hourPx}px`;
        
        let labelText = `${i.toString().padStart(2, '0')}:00`;
        if (hasSecTz) {
            let secHourRaw = i + secOffsetDiff;
            let sH = Math.floor(secHourRaw);
            let sM = Math.round((secHourRaw - sH) * 60);
            if (sM < 0) { sM += 60; sH -= 1; }
            if (sM === 60) { sH += 1; sM = 0; }
            let dispH = sH % 24;
            if (dispH < 0) dispH += 24;
            labelText += ` (${dispH.toString().padStart(2, '0')}:${sM.toString().padStart(2, '0')})`;
        }
        
        // 2. Force the display, width, and alignment directly inline
        row.innerHTML = `<span class="time-row-label" style="display: inline-block; width: ${timeGutterWidth - 8}px; text-align: right;">${labelText}</span>`;
        bgLines.appendChild(row);
    }
    canvas.appendChild(bgLines);

    localStorage.setItem('quadra_tracker_date', baseDateStr);
    
    const [y, m, d] = baseDateStr.split('-');
    const baseDate = new Date(y, m - 1, d);
    
    const daySpan = document.getElementById('trackerDayOfWeek');
    if (daySpan) {
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        daySpan.innerText = dayNames[baseDate.getDay()];
    }

    const weekStart = new Date(baseDate);
    const dayOfWeek = baseDate.getDay();
    weekStart.setDate(baseDate.getDate() - dayOfWeek);
    const weekDateKeys = new Set();
    for (let i = 0; i < 7; i++) {
        const dateIter = new Date(weekStart);
        dateIter.setDate(weekStart.getDate() + i);
        const localY = dateIter.getFullYear();
        const localM = String(dateIter.getMonth() + 1).padStart(2, '0');
        const localD = String(dateIter.getDate()).padStart(2, '0');
        weekDateKeys.add(`${localY}-${localM}-${localD}`);
    }

    let datesToRender = [];
    if (currentTrackerMode === 'day') {
        datesToRender.push({ date: baseDateStr, label: '' });
    } else {
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        for(let i=0; i<7; i++) {
            let dateIter = new Date(weekStart);
            dateIter.setDate(weekStart.getDate() + i);
            const localY = dateIter.getFullYear();
            const localM = String(dateIter.getMonth() + 1).padStart(2, '0');
            const localD = String(dateIter.getDate()).padStart(2, '0');
            datesToRender.push({ date: `${localY}-${localM}-${localD}`, label: `${dayNames[i]} ${dateIter.getDate()}` });
        }
    }

    const colsContainer = document.createElement('div');
    colsContainer.className = 'timeline-cols-container';
    //const timeGutterWidth = hasSecTz ? 120 : 55;
    const overlayPadding = hasSecTz ? 130 : 65;
    
    colsContainer.style.left = `${timeGutterWidth}px`;
    canvas.style.setProperty('--gutter-width', `${timeGutterWidth}px`);
    canvas.appendChild(colsContainer);

    let totalTimeRendered = 0;
    let weeklyTotalRendered = 0;

    datesToRender.forEach(dtObj => {
        const dateStr = dtObj.date;
        const col = document.createElement('div');
        col.className = 'time-col';
        col.ondragover = allowTrackerDrop;
        col.ondragleave = dragLeaveTracker;
        col.ondrop = (e) => dropToTracker(e, dateStr);
        col.onclick = (e) => handleTimelineClick(e, dateStr);

        const todayStr = new Date().toLocaleDateString('en-CA').split('T')[0];

        if (currentTrackerMode === 'week') {
            const header = document.createElement('div');
            header.className = 'col-header';
            if (dateStr === todayStr) header.classList.add('today');
            header.innerText = dtObj.label;
            col.appendChild(header);
        }

        if (currentTrackerMode === 'day' && dateStr === todayStr) {
            const now = new Date();
            const primaryTime = getTzTime(now, appConfig.primaryTz);
            const currentHour = primaryTime.h + (primaryTime.m / 60) + (primaryTime.s / 3600);
            
            const timeLine = document.createElement('div');
            timeLine.className = 'current-time-line';
            timeLine.style.top = `${currentHour * hourPx}px`;
            timeLine.innerHTML = `<span class="current-time-badge">${formatCurrentTimeBadge(now)}</span>`;
            col.appendChild(timeLine);
        }

        appSchedule.forEach(block => {
            let start = roundToQuarterHour(block.startHour);
            let end = roundToQuarterHour(block.endHour);

            if (start < 24) {
                let renderEnd = Math.min(end, 24);
                const overlay = document.createElement('div');
                overlay.className = 'schedule-overlay';
                overlay.style.top = `${start * hourPx}px`;
                overlay.style.height = `${(renderEnd - start) * hourPx}px`;
                overlay.style.left = `-${timeGutterWidth}px`;
                overlay.style.paddingLeft = `${overlayPadding}px`;
                if (currentTrackerMode === 'day') overlay.innerText = block.title;
                col.appendChild(overlay);
            }

            appSchedule.forEach(prevBlock => {
                if (prevBlock.endHour > 24 && dtObj.date === dateStr) {
                    let wrappedSpan = roundToQuarterHour(prevBlock.endHour - 24);
                    if (wrappedSpan > 0) {
                        const overlay = document.createElement('div');
                        overlay.className = 'schedule-overlay';
                        overlay.style.top = `0px`;
                        overlay.style.height = `${Math.min(wrappedSpan, 24) * hourPx}px`;
                        overlay.style.left = `-${timeGutterWidth}px`;
                        overlay.style.paddingLeft = `${overlayPadding}px`;
                        if (currentTrackerMode === 'day') overlay.innerText = prevBlock.title;
                        col.appendChild(overlay);
                    }
                }
            });
        });

        let dayBlocks = [];

        notes.forEach(note => {
            if (!note || note.deleted) return; 
            
            const isCalendarEvent = note.eventId !== null && note.eventId !== undefined;
            let blocksToProcess = note.timeBlocks || [];
            
            // Dynamic fallback for Imported Google Events
            if (isCalendarEvent && note.dueTime !== undefined) {
                blocksToProcess = [{ blockId: 'cal', date: note.dueDate, startHour: note.dueTime, duration: note.dueDuration }];
            }

            blocksToProcess.forEach(tBlock => {
                // SAFETY CHECK: Ensure the block has a valid date string before comparing
                if (!tBlock || !tBlock.date) return;

                let blockStart = roundToQuarterHour(tBlock.startHour || 0);
                let duration = roundToQuarterHour(tBlock.duration || 1.0);
                let blockEnd = blockStart + duration;
                if (blockEnd < blockStart) { blockEnd += 24; }
                let actualDuration = roundToQuarterHour(blockEnd - blockStart);

                if (tBlock.date === dateStr) {
                    let renderStart = blockStart % 24;
                    let renderDuration = duration;

                    if (blockStart < 24 && blockEnd > 24) {
                        renderDuration = 24 - blockStart; 
                    } else if (blockStart >= 24) {
                        return; 
                    }

                    const blockEl = document.createElement('div');
                    const quadClass = note.quadrant || 'q2';
                    blockEl.className = 'logged-block' + (isCalendarEvent ? ' is-meeting' : ` ${quadClass}`) + (note.status === 'closed' ? ' is-closed' : '');
                    
                    blockEl.id = `block-${note.id}-${tBlock.blockId || 'base'}`;
                    blockEl.style.top = `${renderStart * hourPx}px`;
                    blockEl.style.height = `${Math.max(15, renderDuration * hourPx)}px`;
                    
                    let pid = note.projectId || note.projectIds?.[0] || 'p_default';
                    let pObj = appConfig.projects ? appConfig.projects.find(p => p.id === pid) : null;
                    let pName = pObj ? `${pObj.name} - ` : '';
                    let cleanTitle = cleanHTMLToPlainText(note.text || '').split('\n')[0];

                    let displayTitle = pName + cleanTitle;
                    const actualEndHour = (blockStart + actualDuration) % 24;
                    const timeStr = `${decToTime(blockStart)} - ${decToTime(actualEndHour)}`;

                    blockEl.innerHTML = `
                        <div class="block-info">
                            <div class="block-title">${displayTitle}</div>
                            <div class="block-meta">${timeStr}</div>
                        </div>
                        <div class="resize-handle" onmousedown="startBlockDrag(event, '${note.id}', '${tBlock.blockId || ''}', true)"></div>
                    `;
                    
                    blockEl.onclick = (e) => {
                        if(isDraggingBlock) return;
                        if(e.target.closest('.resize-handle')) return;
                        openTaskModal(null, note.id, e);
                    };

                    blockEl.onmousedown = (e) => {
                        if(e.target.closest('.resize-handle')) return;
                        startBlockDrag(e, note.id, tBlock.blockId || '', false);
                    };
                    
                    dayBlocks.push({ el: blockEl, start: renderStart, end: renderStart + renderDuration, duration: renderDuration });
                } 
                else if (tBlock.date === addDays(dateStr, -1)) {
                    if (blockStart < 24 && blockEnd > 24) {
                        let overflowDuration = roundToQuarterHour(blockEnd - 24);
                        const blockEl = document.createElement('div');
                        const quadClass = note.quadrant || 'q2';
                        blockEl.className = 'logged-block' + (isCalendarEvent ? ' is-meeting' : ` ${quadClass}`) + (note.status === 'closed' ? ' is-closed' : '');
                        blockEl.id = `block-overflow-${note.id}-${tBlock.blockId || 'base'}`;
                        blockEl.style.top = `0px`;
                        blockEl.style.height = `${Math.max(15, overflowDuration * hourPx)}px`;
                        
                        let pid = note.projectId || note.projectIds?.[0] || 'p_default';
                        let pObj = appConfig.projects ? appConfig.projects.find(p => p.id === pid) : null;
                        let pName = pObj ? `${pObj.name} - ` : '';
                        let cleanTitle = cleanHTMLToPlainText(note.text || '').split('\n')[0];

                        let displayTitle = pName + cleanTitle;
                        const actualEndHour = (blockStart + actualDuration) % 24;
                        const timeStr = `${decToTime(blockStart)} - ${decToTime(actualEndHour)}`;

                        blockEl.innerHTML = `
                            <div class="block-info">
                                <div class="block-title">${displayTitle} (cont.)</div>
                                <div class="block-meta">${timeStr}</div>
                            </div>
                        `;
                        blockEl.onclick = (e) => {
                            if(isDraggingBlock) return;
                            openTaskModal(null, note.id, e);
                        };
                        dayBlocks.push({ el: blockEl, start: 0, end: overflowDuration, duration: overflowDuration });
                    }
                }
            });
        });

        // Apply overlapping layout
        let groups = [];
        let currentGroup = [];
        let currentGroupEnd = -1;

        dayBlocks.sort((a, b) => a.start - b.start || b.duration - a.duration);

        dayBlocks.forEach(block => {
            if (currentGroup.length === 0) {
                currentGroup.push(block);
                currentGroupEnd = block.end;
            } else if (block.start < currentGroupEnd) {
                currentGroup.push(block);
                currentGroupEnd = Math.max(currentGroupEnd, block.end);
            } else {
                groups.push(currentGroup);
                currentGroup = [block];
                currentGroupEnd = block.end;
            }
        });
        if (currentGroup.length > 0) groups.push(currentGroup);

        groups.forEach(group => {
            let columns = [];
            group.forEach(block => {
                let placed = false;
                for (let i = 0; i < columns.length; i++) {
                    let lastBlock = columns[i][columns[i].length - 1];
                    if (block.start >= lastBlock.end) {
                        columns[i].push(block);
                        block.colIndex = i;
                        placed = true;
                        break;
                    }
                }
                if (!placed) {
                    block.colIndex = columns.length;
                    columns.push([block]);
                }
            });

            let numCols = columns.length;
            group.forEach(block => {
                block.el.style.left = `calc(${block.colIndex} * (100% / ${numCols}) + 6px)`;
                block.el.style.width = `calc((100% / ${numCols}) - 12px)`;
                block.el.style.right = 'auto';
                col.appendChild(block.el);
            });
        });

        colsContainer.appendChild(col);
    });

    // --- Daily/Weekly Hour Calculations loop through timeBlocks ---
    let actualWeekly = 0;
    let countedIds = new Set();
    notes.forEach(note => {
        if (!note || note.deleted || note.eventId || note.status === 'closed') return;
        (note.timeBlocks || []).forEach(tb => {
            if (tb && tb.date && weekDateKeys.has(tb.date) && !countedIds.has(`${note.id}-${tb.blockId}`)) {
                actualWeekly += roundToQuarterHour(tb.duration || 1.0);
                countedIds.add(`${note.id}-${tb.blockId}`);
            }
        });
    });

    let actualDaily = 0;
    notes.forEach(note => {
        if (!note || note.deleted || note.eventId || note.status === 'closed') return;
        (note.timeBlocks || []).forEach(tb => {
            if (tb && tb.date === baseDateStr) {
                actualDaily += roundToQuarterHour(tb.duration || 1.0);
            }
        });
    });

    const dailyTotalEl = document.getElementById('trackerDailyTotal');
    if(dailyTotalEl) dailyTotalEl.innerText = `🎯: ${actualDaily}h/${actualWeekly}h`;

    const scrollArea = document.getElementById('timelineScrollArea');
    if (scrollArea && scrollArea.scrollTop === 0) scrollArea.scrollTop = 7 * hourPx; 
}

function toggleDueFilter() {
    const toggle = document.getElementById('dueFilterToggle');
    if (toggle) {
        localStorage.setItem('quadra_due_filter', toggle.checked);
        handleSearch(); 
    }
}

function toggleOOODay(dateStr) {
    if (!appConfig.oooDates) appConfig.oooDates = [];
    const idx = appConfig.oooDates.indexOf(dateStr);
    
    if (idx > -1) appConfig.oooDates.splice(idx, 1);
    else appConfig.oooDates.push(dateStr);
    
    localStorage.setItem('quadra_config', JSON.stringify(appConfig));
    renderTrackerTimeline(); // <--- Replaces renderOverdueTasksPage()
}

function allowBacklogDrop(ev) {
    ev.preventDefault();
    ev.currentTarget.classList.add('drag-over');
}
function dragLeaveBacklog(ev) {
    ev.currentTarget.classList.remove('drag-over');
}
function dropToBacklog(ev) {
    ev.preventDefault();
    ev.currentTarget.classList.remove('drag-over');
    
    const noteId = ev.dataTransfer.getData("text/plain");
    const note = notes.find(n => n.id === noteId);
    
    if (note) {
        note.dueDate = null;
        if (note.timeBlocks && note.timeBlocks.length > 0) {
            note.timeBlocks.forEach(tb => {
                if (tb.targetEventId) queueTargetEventDeletion(tb.targetEventId);
            });
            note.timeBlocks = [];
        }
        note.dirty = true;
        saveNotes();
        handleSearch();
    }
}

// --- Drag & Resize Engine (Multi-Day Architecture) ---
function startBlockDrag(e, noteId, blockId, isResize) {
    e.stopPropagation();
    const note = notes.find(n => n.id === noteId);
    if (!note || !note.timeBlocks) return;
    
    let tBlock = note.timeBlocks.find(b => b.blockId === blockId);
    if (!tBlock) return;
    
    isDraggingBlock = true;

    dragState = {
        noteId, blockId, isResize,
        startX: e.clientX,
        startY: e.clientY,
        originalStart: tBlock.startHour,
        originalDuration: tBlock.duration,
        hasMoved: false,
        el: document.getElementById(`block-${noteId}-${blockId}`)
    };

    if (dragState.el) {
        dragState.el.style.zIndex = '100';
        dragState.el.style.transition = 'none';
    }
    
    document.addEventListener('mousemove', onBlockDrag);
    document.addEventListener('mouseup', stopBlockDrag);
}

function onBlockDrag(e) {
    if (!dragState) return;
    
    if (!dragState.hasMoved && (Math.abs(e.clientY - dragState.startY) > 3 || Math.abs(e.clientX - dragState.startX) > 3)) {
        dragState.hasMoved = true;
        isDraggingBlock = true;
    }

    if (!dragState.hasMoved) return;

    const hourPx = 60 * timelineZoom;
    const dy = e.clientY - dragState.startY;
    const dx = e.clientX - dragState.startX;
    const dHours = roundToQuarterHour(dy / hourPx); 
    
    const note = notes.find(n => n.id === dragState.noteId);
    if (!note || !note.timeBlocks) return;
    
    let tBlock = note.timeBlocks.find(b => b.blockId === dragState.blockId);
    if (!tBlock) return;
    
    // --- V5 LOGIC: Check if dragging outside the Calendar Pane ---
    const rightPane = document.getElementById('rightPane');
    let isOutsideCalendar = false;
    
    if (rightPane && !dragState.isResize) {
        const rect = rightPane.getBoundingClientRect();
        // If the mouse moves past the left edge of the right pane
        if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
            isOutsideCalendar = true;
        }
    }

    if (dragState.isResize) {
        let newDuration = Math.max(0.25, dragState.originalDuration + dHours);
        tBlock.duration = newDuration;
        if (dragState.el) {
            dragState.el.style.height = `${newDuration * hourPx}px`;
            const actualEndHour = (tBlock.startHour + newDuration) % 24;
            const timeStr = `${decToTime(tBlock.startHour)} - ${decToTime(actualEndHour)}`;
            const metaEl = dragState.el.querySelector('.block-meta');
            if (metaEl) metaEl.innerText = timeStr;
        }
    } else {
        let newStart = Math.max(0, Math.min(30 - tBlock.duration, dragState.originalStart + dHours));
        tBlock.startHour = newStart;
        if (dragState.el) {
            dragState.el.style.top = `${(newStart % 24) * hourPx}px`;
            
            // Visual feedback: block follows the mouse left and turns red
            if (isOutsideCalendar) {
                dragState.el.style.transform = `translateX(${dx}px)`;
                dragState.el.style.opacity = '0.5';
                dragState.el.style.border = '2px dashed #EF4444';
            } else {
                dragState.el.style.transform = '';
                dragState.el.style.opacity = '1';
                dragState.el.style.border = '';
            }

            const actualEndHour = (newStart + tBlock.duration) % 24;
            const timeStr = `${decToTime(newStart)} - ${decToTime(actualEndHour)}`;
            const metaEl = dragState.el.querySelector('.block-meta');
            if (metaEl) metaEl.innerText = timeStr;
        }
    }
}

function stopBlockDrag(e) {
    if (dragState) {
        document.removeEventListener('mousemove', onBlockDrag);
        document.removeEventListener('mouseup', stopBlockDrag);
        
        let didMove = dragState.hasMoved;
        let unscheduled = false;

        // --- V5 LOGIC: Unschedule if dropped outside the Calendar Pane ---
        const rightPane = document.getElementById('rightPane');
        if (rightPane && !dragState.isResize) {
            const rect = rightPane.getBoundingClientRect();
            if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
                
                const note = notes.find(n => n.id === dragState.noteId);
                if (note && note.timeBlocks) {
                    // 1. Queue the target calendar event for deletion if synced
                    const tbToRemove = note.timeBlocks.find(b => b.blockId === dragState.blockId);
                    if (tbToRemove && tbToRemove.targetEventId) {
                        queueTargetEventDeletion(tbToRemove.targetEventId);
                    }
                    
                    // 2. Remove the block locally
                    note.timeBlocks = note.timeBlocks.filter(b => b.blockId !== dragState.blockId);
                    note.dirty = true;
                    unscheduled = true;
                    saveNotes();
                }
            }
        }

        if (didMove && !unscheduled) {
            const note = notes.find(n => n.id === dragState.noteId);
            if (note) { note.dirty = true; saveNotes(); }
        }
        
        if (dragState.el) {
            dragState.el.style.zIndex = '10';
            dragState.el.style.transition = ''; 
            dragState.el.style.transform = ''; 
            dragState.el.style.opacity = '1';
            dragState.el.style.border = ''; // Clean up dashed border
        }
        
        dragState = null;
        if (didMove || unscheduled) { 
            renderTrackerTimeline(); 
            setTimeout(() => { isDraggingBlock = false; }, 50); 
        } else { 
            isDraggingBlock = false; 
        }
    }
}

function dropToTracker(ev, dateStr) {
    ev.preventDefault(); ev.currentTarget.classList.remove('drag-over');
    const noteId = ev.dataTransfer.getData("text/plain");
    const note = notes.find(n => n.id === noteId);
    const hourPx = 60 * timelineZoom;
    
    if (note) {
        const rect = ev.currentTarget.getBoundingClientRect();
        const y = ev.clientY - rect.top; 
        let dropHour = roundToQuarterHour(y / hourPx);

        if (!note.timeBlocks) note.timeBlocks = [];
        
        // NEW: Push a fresh calendar instance instead of overwriting a date
        note.timeBlocks.push({
            blockId: 'b_' + Date.now().toString() + Math.floor(Math.random() * 1000),
            date: dateStr,
            startHour: dropHour,
            duration: 1.0
        });

        // We purposely do NOT overwrite note.dueDate here, allowing the deadline to stay distinct
        note.dirty = true; 
        saveNotes(); 
        handleSearch(); 
    }
}

function handleTimelineClick(ev, dateStr) {
    if (isDraggingBlock) return;
    if (ev.target.closest('.logged-block')) return; 
    const hourPx = 60 * timelineZoom;
    
    const rect = ev.currentTarget.getBoundingClientRect();
    const y = ev.clientY - rect.top; 
    let dropHour = roundToQuarterHour(y / hourPx);

    openTaskModal('calendar', null, ev, { date: dateStr, startHour: dropHour });
}

function allowTrackerDrop(ev) { ev.preventDefault(); ev.currentTarget.classList.add('drag-over'); }
function dragLeaveTracker(ev) { ev.currentTarget.classList.remove('drag-over'); }

function openShortcutsModal() {
    const modal = document.getElementById('shortcutsModal');
    if (modal) modal.style.display = 'flex';
}

function closeShortcutsModal() {
    const modal = document.getElementById('shortcutsModal');
    if (modal) modal.style.display = 'none';
}

document.addEventListener('click', function(e) {
    const li = e.target.closest('li.todo-item');
    if (li) {
        // The padding-left is 28px. If the click is on the far left side, 
        // they clicked the ::before pseudo-element (the checkbox).
        if (e.offsetX >= 0 && e.offsetX <= 26) {
            e.preventDefault();
            e.stopPropagation();
            
            li.classList.toggle('completed');
            triggerAutoSaveInterval(); // Save the state
        }
    }
});

function toggleTaskCompleteFromModal() {
    if (!currentEditingId) return;
    
    const quadrantSelect = document.getElementById('taskQuadrant');
    
    if (quadrantSelect) {
        // 1. Force the dropdown menu to "Closed" (or back to "Inbox" if restoring)
        if (quadrantSelect.value === 'closed') {
            quadrantSelect.value = 'inbox';
        } else {
            quadrantSelect.value = 'closed';
        }
        saveTaskModal();
    }
}

function triggerAutoSaveInterval() {
    if (autoSaveTimerId) return; 
    autoSaveTimerId = setInterval(() => {
        if (!currentEditingId) return;
        const note = notes.find(n => n.id === currentEditingId);
        if (note) {
            const titleText = document.getElementById('taskTitleInput').innerHTML;
            const infoText = document.getElementById('taskInfoInput').innerHTML;
            
            if ((!titleText || titleText === '<br>') && (!infoText || infoText === '<br>')) return;

            const revisedFullText = titleText + (infoText && infoText !== '<br>' ? ('\n' + infoText) : '');
            if (note.text !== revisedFullText) {
                note.text = revisedFullText;
                note.dirty = true;
                saveNotes();
                console.log("⏰ Snapshot checkpoint autosaved into LocalStorage.");
            }
        }
    }, 30000); 
}

function clearAutoSaveInterval() {
    if (autoSaveTimerId) {
        clearInterval(autoSaveTimerId);
        autoSaveTimerId = null;
    }
}

function openTaskModal(quadrant = null, noteId = null, event = null, timelineContext = null) {
    if (event) event.stopPropagation();

    isDocMode = false;
    document.querySelector('#taskModal .modal-content').classList.remove('doc-mode');
    const toggleBtn = document.getElementById('docModeToggleBtn');
    if (toggleBtn) {
        toggleBtn.innerText = '⛶';
        toggleBtn.title = "Enter Doc Mode";
    }
    
    const modal = document.getElementById('taskModal');
    const titleInput = document.getElementById('taskTitleInput');
    const infoInput = document.getElementById('taskInfoInput');
    const dueDateInput = document.getElementById('taskDueDate');
    const quadrantInput = document.getElementById('taskQuadrant');
    const completeBtn = document.getElementById('taskModalCompleteBtn');

    clearAutoSaveInterval();

    if (noteId) {
        currentEditingId = noteId; 
        const note = notes.find(n => n.id === noteId); 
        document.getElementById('taskModalTitle').innerText = 'Task Details'; 

        let rawText = note.text || "";
        let match = rawText.match(/\n|<br\s*\/?>/i);

        if (!match) {
            titleInput.innerHTML = rawText.trim();
            infoInput.innerHTML = '';
        } else {
            let splitIdx = match.index;
            let skipLen = match[0].length;
            
            titleInput.innerHTML = rawText.substring(0, splitIdx).trim();
            let bodyHTML = rawText.substring(splitIdx + skipLen);
            
            if (!/<[a-z][\s\S]*>/i.test(bodyHTML)) {
                bodyHTML = bodyHTML.replace(/\n/g, '<br>');
            }
            infoInput.innerHTML = bodyHTML;
        }

        formatEditorNodes('taskTitleInput');
        formatEditorNodes('taskInfoInput');

        dueDateInput.value = note.dueDate || '';
        
        // AUTO-HEAL: Clean up any incorrectly saved quadrants and apply a strict fallback
        if (quadrantInput) {
            let qVal = (note.quadrant || 'inbox').replace('list-', '').replace('tray-', '');
            quadrantInput.value = qVal;
            
            // Failsafe: if the value STILL doesn't match an option, force it to 'inbox'
            if (!quadrantInput.value) {
                quadrantInput.value = 'inbox';
            }
        } 

        completeBtn.style.display = 'inline-block';
        if (note.status === 'closed') {
            completeBtn.innerHTML = '↺ Restore Task';
            completeBtn.style.color = '#3B82F6';
            completeBtn.style.borderColor = '#3B82F6';
        } else {
            completeBtn.innerHTML = '✓ Mark Complete';
            completeBtn.style.color = '#10B981';
            completeBtn.style.borderColor = '#10B981';
        }

    } else { 
        currentEditingId = null; 
        currentAddingQuadrant = quadrant || 'inbox'; 
        document.getElementById('taskModalTitle').innerText = 'Add Task'; 
        titleInput.innerHTML = '';
        infoInput.innerHTML = '';
        dueDateInput.value = timelineContext ? timelineContext.date : '';
        
        // SAFE FALLBACK FOR NEW TASKS
        if (quadrantInput) {
            let qVal = currentAddingQuadrant.replace('list-', '').replace('tray-', '');
            quadrantInput.value = qVal;
            if (!quadrantInput.value) quadrantInput.value = 'inbox';
        } 
        
        completeBtn.style.display = 'none';
        
        pendingTimelineContext = timelineContext || null;
    }
    
    // --- UPDATED: Populate Project Dropdown with "All" Option & Archive Logic ---
    const projectInput = document.getElementById('taskProject');
    if (projectInput) {
        projectInput.innerHTML = '<option value="all">🌐 All Projects (Global)</option>';
        
        let assigned = 'p_default';
        if (noteId) {
            const activeNote = notes.find(n => n.id === noteId);
            assigned = activeNote?.projectIds?.[0] || activeNote?.projectId || 'p_default';
        }

        appConfig.projects.forEach(p => {
            // Only add if it's NOT archived, or if it IS archived but currently assigned to this task
            if (!p.archived || p.id === assigned) {
                const opt = document.createElement('option');
                opt.value = p.id; 
                opt.innerText = p.name + (p.archived ? ' (Archived)' : '');
                projectInput.appendChild(opt);
            }
        });
        
        if (noteId) {
            projectInput.value = assigned;
        } else {
            // If adding a task, default to the currently visible unarchived project
            const visibleProjects = appConfig.projects.filter(p => p.visible && !p.archived);
            projectInput.value = visibleProjects.length === 1 ? visibleProjects[0].id : 'p_default';
        }
    }
    document.getElementById('taskModalContent').classList.remove('time-panel-open');
    document.getElementById('taskModalRightPane').style.display = 'none';
    
    document.getElementById('quickLogDate').value = new Date().toLocaleDateString('en-CA').split('T')[0];
    document.getElementById('quickLogHours').value = '';
    const deleteBtn = document.getElementById('taskModalDeleteBtn');
    if (deleteBtn) deleteBtn.style.display = noteId ? 'inline-block' : 'none';

    renderQuickTimeLogs();
    modal.style.display = 'flex'; 
    setTimeout(() => titleInput.focus(), 100);
}

function closeTaskModal() { 
    clearAutoSaveInterval();
    document.getElementById('taskModal').style.display = 'none'; 
    pendingTimelineContext = null; 
}

function updateModalForQuadrant() {
    const quadrantInput = document.getElementById('taskQuadrant');
    const dueDateInput = document.getElementById('taskDueDate');
    const completeBtn = document.getElementById('taskModalCompleteBtn');
    
    if (!quadrantInput || !dueDateInput) return;
    
    const isNotes = quadrantInput.value === 'notes';
    dueDateInput.style.display = isNotes ? 'none' : 'block';
    
    if (completeBtn && currentEditingId) {
        completeBtn.style.display = isNotes ? 'none' : 'inline-block';
    }
}

// Add the listener right after DOM load or just float it in the global scope:
document.addEventListener('DOMContentLoaded', () => {
    const isMobile = window.innerWidth <= 768;

    const quadrantInput = document.getElementById('taskQuadrant');
    if (quadrantInput) quadrantInput.addEventListener('change', updateModalForQuadrant);

    // Restore Left Pane (Backlog)
    const leftState = localStorage.getItem('quadra_leftPane');
    if (leftState === 'closed' && typeof isLeftPaneOpen !== 'undefined' && isLeftPaneOpen) {
        toggleLeftPane(); 
    }

    // Restore Right Pane (Notebook or Timeline)
    const rightState = localStorage.getItem('quadra_rightPane');
    const rightPane = document.getElementById('rightPane');

    if (rightPane) rightPane.style.display = 'none';

    if (isMobile) {
        // MOBILE: Always start closed. 
        // We do not call toggleRightPane here, so it remains hidden.
        if (rightState && rightState !== 'closed') {
            toggleRightPane(rightState);
        }
    } else {
        // DESKTOP: Restore previous state from memory
        if (rightState && rightState !== 'closed') {
            toggleRightPane(rightState);
        }
    }
});

// --- 1. NEW: Save Modal (Multi-Day Architecture & Projects) ---
function saveTaskModal() {
    clearAutoSaveInterval();
    const titleText = document.getElementById('taskTitleInput').innerHTML; 
    const infoText = document.getElementById('taskInfoInput').innerHTML; 
    const dueDate = document.getElementById('taskDueDate').value;
    
    if ((!titleText || titleText === '<br>') && (!infoText || infoText === '<br>')) return closeTaskModal();

    const fullText = titleText + (infoText && infoText !== '<br>' ? ('\n' + infoText) : '');

    const quadrantSelect = document.getElementById('taskQuadrant');
    const selectedQuadrant = quadrantSelect ? quadrantSelect.value : null;
    let targetQuadForNote = selectedQuadrant || currentAddingQuadrant || 'inbox';
    
    let finalPayloadText = fullText;
    if (targetQuadForNote === 'notes' && !finalPayloadText.includes('#note')) {
        finalPayloadText += ' #note';
    }

    let newTimeBlock = null;
    if (pendingTimelineContext && pendingTimelineContext.startHour !== undefined) {
        newTimeBlock = {
            blockId: 'b_' + Date.now().toString() + Math.floor(Math.random() * 1000),
            date: pendingTimelineContext.date,
            startHour: roundToQuarterHour(pendingTimelineContext.startHour),
            duration: 1.0
        };
    }

    // --- UPDATED: Extract Target Projects ---
    const projectSelect = document.getElementById('taskProject');
    const selectedVal = projectSelect ? projectSelect.value : 'p_default';
    const targetProjects = [selectedVal];

    if (currentEditingId) { 
        const note = notes.find(n => n.id === currentEditingId); 
        if (note) { 
            note.projectIds = targetProjects;
            note.projectId = selectedVal; // Backward compatibility
            note.text = finalPayloadText; 
            note.dueDate = dueDate || null;
            
            if (selectedQuadrant) note.quadrant = selectedQuadrant;
            
            if (selectedQuadrant === 'closed') note.status = 'closed';
            else if (note.status === 'closed' && selectedQuadrant !== 'closed') note.status = 'active';

            if (newTimeBlock) {
                if(!note.timeBlocks) note.timeBlocks = [];
                note.timeBlocks.push(newTimeBlock);
            }
            note.dirty = true; 
            saveNotes(); 
            handleSearch(); 
        } 
    } else { 
        let targetQuad = selectedQuadrant || currentAddingQuadrant || 'inbox';
        let newNoteId = Date.now().toString(); 
        let newStatus = targetQuad === 'closed' ? 'closed' : 'active';
        
        notes.push({ 
            id: newNoteId, 
            text: finalPayloadText, 
            quadrant: targetQuad, 
            status: newStatus, 
            dueDate: dueDate || null,
            timeBlocks: newTimeBlock ? [newTimeBlock] : [],
            dirty: true, 
            deleted: false, 
            eventId: null,
            syncFailed: false,
            projectId: selectedVal, // Backward compatibility
            projectIds: targetProjects
        }); 
        saveNotes(); 
        handleSearch(); 
    }
    closeTaskModal();
}

function clearCalendarCache() {
    if (confirm("Are you sure you want to clear the calendar event cache? This will allow re-importing all meetings when you click Sync Meetings.")) {
        notes = notes.filter(n => !n.eventId);
        saveNotes();
        handleSearch();
        showToast("Calendar event cache cleared!");
    }
}

function openTimesheetModal() {
    const baseDateStr = document.getElementById('trackerDate').value;
    const [y, m, d] = baseDateStr.split('-');
    const baseDate = new Date(y, m - 1, d);
    
    // Find the Monday of the current week
    const dayOfWeek = baseDate.getDay();
    const startOfWeek = new Date(baseDate);
    startOfWeek.setDate(baseDate.getDate() - dayOfWeek); // Moves to Sunday
    
    // Collect specific Mon-Fri date strings
    const workWeekDates = new Set();
    for (let i = 1; i <= 5; i++) {
        let dateIter = new Date(startOfWeek);
        dateIter.setDate(startOfWeek.getDate() + i);
        const localY = dateIter.getFullYear();
        const localM = String(dateIter.getMonth() + 1).padStart(2, '0');
        const localD = String(dateIter.getDate()).padStart(2, '0');
        workWeekDates.add(`${localY}-${localM}-${localD}`);
    }

    let projectTotals = {};
    let totalLogged = 0;
    let detailedLogs = []; // NEW: Array to hold line-by-line data

    notes.forEach(note => {
        if (note.deleted) return;
        
        // Get actual assigned project (fallback to generic if none)
        const pid = note.projectId || note.projectIds?.[0] || 'p_default';
        
        let blocksToProcess = note.timeBlocks || [];
        // Catch legacy or Google imported formats
        if (note.eventId && note.dueTime !== undefined) {
            blocksToProcess = [{ date: note.dueDate, startHour: note.dueTime, duration: note.dueDuration }];
        }

        blocksToProcess.forEach(tb => {
            if (workWeekDates.has(tb.date)) {
                const dur = roundToQuarterHour(tb.duration || 0);
                if (dur > 0) {
                    // 1. Tally for the UI Summary
                    if (!projectTotals[pid]) projectTotals[pid] = 0;
                    projectTotals[pid] += dur;
                    totalLogged += dur;
                    
                    // 2. Log for the Google Sheets Payload
                    let cleanTextTitle = cleanHTMLToPlainText(note.text).split('\n')[0];
                    detailedLogs.push({
                        date: tb.date,
                        projectId: pid,
                        title: cleanTextTitle,
                        hours: dur
                    });
                }
            }
        });
    });

    const tbody = document.getElementById('timesheetTableBody');
    tbody.innerHTML = '';
    
    Object.keys(projectTotals).forEach(pid => {
        const pObj = appConfig.projects.find(p => p.id === pid);
        const pName = pObj ? pObj.name : pid;
        
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${pName}</td><td style="text-align: right;">${projectTotals[pid].toFixed(2)}</td>`;
        tbody.appendChild(tr);
    });
    
    document.getElementById('timesheetTotalHours').innerText = totalLogged.toFixed(2);
    
    // Progress Bar Math
    const target = 40;
    const remaining = Math.max(0, target - totalLogged);
    const pct = Math.min(100, (totalLogged / target) * 100);
    
    const remEl = document.getElementById('timesheetRemaining');
    const barEl = document.getElementById('timesheetProgressBar');
    
    remEl.innerText = remaining > 0 ? `${remaining.toFixed(2)} Hours Remaining` : `Target Met!`;
    remEl.style.color = remaining > 0 ? '#F59E0B' : '#10B981';
    
    barEl.style.width = `${pct}%`;
    barEl.className = 'progress-bar-fill'; 
    if (pct < 50) barEl.classList.add('danger');
    else if (pct < 100) barEl.classList.add('warning');
    
    document.getElementById('timesheetModal').style.display = 'flex';
    
    // --- UPDATED: Pass the detailed logs instead of the summary totals ---
    document.getElementById('btnSyncTimesheet').onclick = () => confirmAndSyncTimesheet(detailedLogs, baseDateStr);
}

async function confirmAndSyncTimesheet(payloadData, dateRef) {
    if (!appConfig.timesheetUrl) {
        return showToast("❌ Please add your Timesheet Web App URL in Settings first.");
    }

    const btn = document.getElementById('btnSyncTimesheet');
    const originalText = btn.innerText;
    
    btn.innerText = "Syncing to Sheets...";
    btn.disabled = true;

    const payload = {
        weekOf: dateRef,
        data: payloadData
    };

    try {
        const response = await fetch(appConfig.timesheetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' }, 
            body: JSON.stringify(payload)
        });
        
        const result = await response.json();
        
        if (result.status === 'success') {
            showToast("✅ Timesheet successfully logged to Google Sheets!");
            document.getElementById('timesheetModal').style.display = 'none';
        } else {
            throw new Error(result.message);
        }
    } catch (e) {
        console.error("Timesheet Sync Error:", e);
        showToast("❌ Sync failed. Check the console or verify your Web App URL.");
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

async function loadCalendars() {
    if (typeof gapi === 'undefined' || !gapi.client || !gapi.client.getToken()) return;
    const token = gapi.client.getToken();
    if (!token || !token.access_token) return;
    try {
        const res = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
            headers: { 'Authorization': `Bearer ${token.access_token}` }
        });
        const data = await res.json();
        if (data.error) return;

        const calendars = data.items || [];
        
        const sourceSelect = document.getElementById('sourceCalendar');
        const targetSelect = document.getElementById('targetCalendar');
        
        if (!sourceSelect || !targetSelect) return;

        sourceSelect.innerHTML = '<option value="">-- Select Source Calendar --</option>';
        targetSelect.innerHTML = '<option value="">-- Select Target Calendar --</option>';
        
        calendars.forEach(cal => {
            // Populate Source Dropdown
            const opt1 = document.createElement('option');
            opt1.value = cal.id; opt1.innerText = cal.summary;
            if(cal.id === appConfig.sourceCalendar) opt1.selected = true;
            sourceSelect.appendChild(opt1);
            
            // Populate Target Dropdown
            const opt2 = document.createElement('option');
            opt2.value = cal.id; opt2.innerText = cal.summary;
            if(cal.id === appConfig.targetCalendar) opt2.selected = true;
            targetSelect.appendChild(opt2);
        });
    } catch (e) {
        console.error("Auto Calendar Load Error:", e);
    }
}

function renderScheduleSettings() {
    const container = document.getElementById('scheduleConfigList');
    if (!container) return; // <-- Prevents the crash
    container.innerHTML = '';
    appSchedule.forEach(block => addScheduleRow(block));
}

function formatTimeForInput(decimalHour) {
    let normalized = decimalHour % 24;
    const hrs = Math.floor(normalized).toString().padStart(2, '0');
    const mins = Math.round((normalized % 1) * 60).toString().padStart(2, '0');
    return `${hrs}:${mins}`;
}

function addScheduleRow(block = {title: '', startHour: 14, endHour: 29}) {
    const container = document.getElementById('scheduleConfigList');
    if (!container) return; // <-- Prevents the crash
    
    const div = document.createElement('div');
    div.className = 'schedule-row';
    div.style.display = 'flex'; div.style.gap = '8px'; div.style.marginBottom = '8px';
    div.innerHTML = `
        <input type="text" class="sched-title" value="${block.title}" placeholder="Label" style="flex:2; padding:8px;">
        <input type="time" class="sched-start" value="${formatTimeForInput(block.startHour)}" style="padding:8px;">
        <input type="time" class="sched-end" value="${formatTimeForInput(block.endHour)}" style="padding:8px;">
        <button class="btn btn-outline" style="color:red; padding:8px 12px;" onclick="this.parentElement.remove()">×</button>
    `;
    container.appendChild(div);
}

function formatEditorNodes(editorId) {
    const editor = document.getElementById(editorId);
    if (!editor) return;

    let sel = window.getSelection();
    let hasCaret = false;
    
    // Only insert marker if we are actively editing this specific field
    if (sel.rangeCount > 0 && editor.contains(sel.focusNode)) {
        let r = sel.getRangeAt(0);
        let marker = document.createElement('span');
        marker.id = 'caret-marker';
        r.insertNode(marker);
        hasCaret = true;
    }

    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, null, false);
    let nodesToProcess = [];
    let node;
    
    while (node = walker.nextNode()) {
        let p = node.parentNode;
        if (p.tagName === 'A' || p.classList.contains('hashtag') || p.classList.contains('person-tag') || p.id === 'caret-marker') {
            continue;
        }
        // NEW: Safe boundary check test
        if (/(https?:\/\/[^\s]+)|(^|[\s\(\)\[\]\{\}>;"',\.|])([#@][a-zA-Z0-9_]+)/.test(node.nodeValue)) {
            nodesToProcess.push(node);
        }
    }

    nodesToProcess.forEach(n => {
        let span = document.createElement('span');
        let escaped = escapeHTML(n.nodeValue);
        
        // NEW: Uses $1 to preserve the preceding space/bracket, and $2 for the actual tag
        let formatted = escaped
            .replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" style="color:var(--brand-primary); text-decoration:underline;">$1</a>')
            .replace(/(^|[\s\(\)\[\]\{\}>;"',\.|])(#[a-zA-Z0-9_]+)/g, '$1<span class="hashtag">$2</span>')
            .replace(/(^|[\s\(\)\[\]\{\}>;"',\.|])(@[a-zA-Z0-9_]+)/g, '$1<span class="person-tag">$2</span>');
            
        span.innerHTML = formatted;
        n.parentNode.replaceChild(span, n);
        while (span.firstChild) {
            span.parentNode.insertBefore(span.firstChild, span);
        }
        span.parentNode.removeChild(span);
    });

    if (hasCaret) {
        let marker = document.getElementById('caret-marker');
        if (marker) {
            let newRange = document.createRange();
            newRange.setStartAfter(marker);
            newRange.collapse(true);
            sel.removeAllRanges();
            sel.addRange(newRange);
            marker.parentNode.removeChild(marker);
        }
    }
}

function updateQuickTags() {
    const tagsBar = document.getElementById('quick-tags-bar');
    const searchInput = document.getElementById('searchInput');
    if (!tagsBar || !searchInput) return;
    
    let tagCounts = new Map();
    const hexColorRegex = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/i; 
    
    const dueToggle = document.getElementById('dueFilterToggle');
    const isDueFilterOn = dueToggle && dueToggle.checked;
    
    notes.forEach(note => {
        // FIX 1: Ignore deleted, calendar events, AND CLOSED tasks
        if (note.deleted || note.eventId || note.status === 'closed') return;
        
        if (!isProjectVisible(note)) return; 
        
        if (isDueFilterOn && !note.dueDate && note.quadrant !== 'notes') return;
        
        // Add spaces to line breaks and block elements so tags don't get squashed together
        let tempDiv = document.createElement('div');
        let htmlString = (note.text || '').replace(/<br\s*\/?>/gi, ' ').replace(/<\/div>|<\/li>|<\/p>/gi, ' ');
        tempDiv.innerHTML = htmlString;
        let safePlainText = tempDiv.textContent || tempDiv.innerText || '';
        
        const regex = /(^|[\s\(\)\[\]\{\}>;"',\.|])(#[a-zA-Z0-9_]+|@[a-zA-Z0-9_]+)/g;
        let matches = [];
        let m;
        
        // Grab every tag found in this specific task
        while ((m = regex.exec(safePlainText)) !== null) {
            matches.push(m[2].toLowerCase());
        }
        
        if (matches.length > 0) {
            // FIX 2: Deduplicate tags within the SAME task so they only count once globally
            let uniqueTagsInTask = [...new Set(matches)];
            
            uniqueTagsInTask.forEach(tag => {
                if (hexColorRegex.test(tag)) return; // Ignore hex color codes
                tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
            });
        }
    });
    
    tagsBar.innerHTML = '';
    
    const rawSearchValue = searchInput.value;
    const currentSearch = rawSearchValue.trim();
    
    const words = rawSearchValue.split(/\s+/);
    const lastWord = words[words.length - 1];
    
    let tagFilter = null;
    if (lastWord.startsWith('#') || lastWord.startsWith('@')) {
        tagFilter = lastWord.toLowerCase(); 
    }
    
    if (currentSearch.length > 0) {
        const endsWithOperator = /\b(AND|OR)$/i.test(currentSearch);
        
        if (!endsWithOperator && !tagFilter) {
            ['AND', 'OR'].forEach(op => {
                let opBtn = document.createElement('button');
                opBtn.className = 'filter-tag';
                opBtn.style.backgroundColor = '#E2E8F0'; 
                opBtn.style.color = '#475569';
                opBtn.style.fontWeight = '700';
                opBtn.innerText = op;
                
                opBtn.onclick = () => {
                    searchInput.value = currentSearch + ` ${op} `;
                    searchInput.focus();
                    handleSearch(); 
                };
                tagsBar.appendChild(opBtn);
            });
            
            let divider = document.createElement('div');
            divider.style.width = '1px';
            divider.style.backgroundColor = 'var(--border-color)';
            divider.style.margin = '0 8px';
            tagsBar.appendChild(divider);
        }
    }
    
    // Sort Tags: Highest count first, then alphabetically
    let sortedTags = Array.from(tagCounts.entries()).sort((a, b) => {
        if (b[1] !== a[1]) {
            return b[1] - a[1]; 
        }
        return a[0].localeCompare(b[0]); 
    });
    
    if (tagFilter) {
        sortedTags = sortedTags.filter(([tag, count]) => tag.startsWith(tagFilter));
    }
    
    sortedTags.forEach(([tag, count]) => {
        let btn = document.createElement('button');
        btn.className = 'filter-tag' + (tag.startsWith('@') ? ' person-filter' : '');
        btn.innerText = `${tag} (${count})`;
        
        btn.onclick = () => {
            let currentVal = searchInput.value.replace(/\s+$/, '');
            let words = currentVal ? currentVal.split(/\s+/) : [];
            
            if (words.length > 0 && (words[words.length - 1].startsWith('#') || words[words.length - 1].startsWith('@'))) {
                words.pop();
            }
            
            words.push(tag);
            
            searchInput.value = words.join(' ') + ' ';
            searchInput.focus();
            searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
            
            handleSearch();
        };
        tagsBar.appendChild(btn);
    });
}

function handleSearch() {
    const searchInput = document.getElementById('searchInput');
    if(!searchInput) return;
    const query = searchInput.value;
    
    if (query.trim().length > 0) {
        localStorage.setItem('quadra_search', query);
    } else {
        localStorage.removeItem('quadra_search');
    }

    document.getElementById('clearSearchBtn').style.display = query.length > 0 ? 'block' : 'none';

    // --- NEW: Sync Global Search to Local Palette Search ---
    const paletteSearchInput = document.getElementById('paletteSearchInput');
    // Only sync if the user isn't actively typing inside the palette search box
    if (paletteSearchInput && document.activeElement !== paletteSearchInput) {
        paletteSearchInput.value = query;
        const clearPaletteBtn = document.getElementById('clearPaletteSearchBtn');
        if (clearPaletteBtn) {
            clearPaletteBtn.style.display = query.trim().length > 0 ? 'block' : 'none';
        }
    }

    renderNotes(query);
}

// --- 3. UPDATED: Project Tabs Engine (With Rename/Delete) ---
function renderProjectTabs() {
    const container = document.getElementById('project-tabs-container');
    if (!container) return;
    container.innerHTML = '';
    
    // Only render tabs for projects that are not archived
    appConfig.projects.filter(p => !p.archived).forEach(proj => {
        const tab = document.createElement('div');
        tab.className = `project-tab ${proj.visible ? 'active-view' : ''}`;
        
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = proj.visible !== false;
        
        cb.onclick = (e) => {
            e.stopPropagation();
            proj.visible = cb.checked;
            const unarchived = appConfig.projects.filter(p => !p.archived);
            if (!unarchived.some(p => p.visible)) {
                proj.visible = true; 
                showToast("At least one project must be visible.");
            } else {
                localStorage.setItem('quadra_config', JSON.stringify(appConfig));
                renderProjectTabs();
                handleSearch(); 
            }
        };
        
        const label = document.createElement('span');
        label.innerText = proj.name;
        
        tab.appendChild(cb);
        tab.appendChild(label);
        
        tab.onclick = () => {
            appConfig.projects.forEach(p => p.visible = (p.id === proj.id));
            localStorage.setItem('quadra_config', JSON.stringify(appConfig));
            renderProjectTabs();
            handleSearch();
        };
        
        tab.ondblclick = (e) => {
            e.stopPropagation();
            openProjectModal(proj.id);
        };
        
        container.appendChild(tab);
    });
}

function addNewProject() {
    const name = prompt("Enter new project name:");
    if (name && name.trim()) {
        const newId = 'p_' + Date.now();
        // Make the new project the only visible one immediately
        appConfig.projects.forEach(p => p.visible = false);
        appConfig.projects.push({ id: newId, name: name.trim(), visible: true });
        localStorage.setItem('quadra_config', JSON.stringify(appConfig));
        renderProjectTabs();
        handleSearch();
        saveProjectsToDB();
    }
}

// Global filter check for views
function isProjectVisible(note) {
    if (!note) return false;
    
    let pIds = note.projectIds;
    if (!pIds) {
        pIds = note.projectId ? [note.projectId] : ['p_default'];
    }

    if (pIds.includes('all')) return true;

    return pIds.some(pid => {
        const p = appConfig.projects.find(proj => proj.id === pid);
        return p ? (!p.archived && p.visible !== false) : false;
    });
}


// --- Delta DOM Update Engine (Pipeline Architecture) ---
function renderNotes(searchQuery = '') {
    // 1. Filter and resolve tasks
    let filteredNotes = notes.filter(note => {
        if (note.deleted) return false;
        if (!isProjectVisible(note)) return false;
        
        const isClosed = note.status === 'closed';
        const hasSearch = searchQuery.trim().length > 0;

        // Hide closed tasks to keep the board clean, unless actively searching for them
        if (isClosed && !hasSearch) return false;
        
        const dueToggle = document.getElementById('dueFilterToggle');
        if (dueToggle && dueToggle.checked && !note.dueDate && note.quadrant !== 'notes' && !note.eventId) {
            return false; 
        }
        return matchesSearchQuery(note.text, searchQuery);
    });

    // 2. Group into the 6 Pipeline Bins
    let bins = { q1: [], q2: [], q3: [], q4: [], inbox: [], notes: [] };

    filteredNotes.forEach(note => {
        if (note.eventId) return; // Calendar events render exclusively on the timeline
        
        // If it's closed but matches a search, dump it in the inbox so the user can see it
        let targetQuad = note.status === 'closed' ? 'inbox' : (note.quadrant || 'inbox');
        
        if (bins[targetQuad]) bins[targetQuad].push(note);
        else bins.inbox.push(note); 
    });

    if (!appConfig.sortPrefs) appConfig.sortPrefs = {};

    // 3. Sort & Reconcile each pipeline column instantly
    ['q1', 'q2', 'q3', 'q4', 'inbox', 'notes'].forEach(q => {
        let pref = appConfig.sortPrefs[q] || (q === 'notes' ? 'created_desc' : 'due_asc');
        let [sortBy, sortDir] = pref.split('_');

        bins[q].sort((a, b) => {
            // --- NEW: Force closed tasks to the absolute bottom universally ---
            if (a.status === 'closed' && b.status !== 'closed') return 1;
            if (a.status !== 'closed' && b.status === 'closed') return -1;

            // Standard sort preferences
            if (sortBy === 'title') {
                let valA = cleanHTMLToPlainText(a.text).split('\n')[0].toLowerCase();
                let valB = cleanHTMLToPlainText(b.text).split('\n')[0].toLowerCase();
                return sortDir === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
            } else if (sortBy === 'created') {
                let valA = parseFloat(a.id) || 0;
                let valB = parseFloat(b.id) || 0;
                return sortDir === 'asc' ? valA - valB : valB - valA;
            } else { 
                if (!a.dueDate && !b.dueDate) return 0;
                if (!a.dueDate) return 1; 
                if (!b.dueDate) return -1;
                return sortDir === 'asc' ? a.dueDate.localeCompare(b.dueDate) : b.dueDate.localeCompare(a.dueDate);
            }
        });

        // --- NEW: Inject a visual separator before the first closed task in the Inbox ---
        if (q === 'inbox') {
            const firstClosedIdx = bins[q].findIndex(n => n.status === 'closed');
            if (firstClosedIdx !== -1) {
                bins[q].splice(firstClosedIdx, 0, {
                    id: 'sys-closed-separator',
                    isSeparator: true,
                    quadrant: 'inbox',
                    status: 'system'
                });
            }
        }

        // Run Delta Update on the UI Column
        reconcileList(`list-${q}`, bins[q]);
    });

    updateQuickTags();
    renderTrackerTimeline();
    updateTaskCounters();
}

function reconcileList(containerId, expectedNotes) {
    const container = document.getElementById(containerId);
    if (!container) return;

    // Map existing DOM elements
    const existingNodes = Array.from(container.children);
    const existingMap = new Map();
    existingNodes.forEach(node => {
        if (node.id && node.id.startsWith('note-')) {
            existingMap.set(node.id.replace('note-', ''), node);
        }
    });

    const todayStr = new Date().toLocaleDateString('en-CA').split('T')[0];

    expectedNotes.forEach((note, index) => {
        const noteId = String(note.id);
        let el = existingMap.get(noteId);
        
        let innerHTML = '';
        let cls = '';
        
        // --- NEW: Render Virtual Separator OR standard Task Card ---
        if (note.isSeparator) {
            cls = 'system-separator';
            innerHTML = `
                <div style="text-align: center; margin: 20px 0 12px 0; position: relative;">
                    <hr style="border: none; border-top: 1px dashed var(--border-color); margin: 0; position: absolute; width: 100%; top: 50%; z-index: 1;">
                    <span style="background: #FFF; padding: 0 10px; color: #94A3B8; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; position: relative; z-index: 2;">Completed Matches</span>
                </div>
            `;
        } else {
            let cleanTextTitle = cleanHTMLToPlainText(note.text).split('\n')[0];
            let tagParsed = parseTags(cleanTextTitle);
            
            // Includes the visually softened Overdue badge from the previous UI polish
            let overdueInd = (!note.eventId && note.status === 'active' && note.dueDate && note.dueDate < todayStr) 
                ? `<span style="color: #E11D48; border: 1px solid #FDA4AF; font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 4px; margin-right: 6px; text-transform: uppercase;">Overdue</span>` 
                : '';
                
            let dueDateMeta = note.dueDate 
                ? `<div style="font-size:11px; color:var(--text-muted); margin-top:6px; font-weight:500;">🗓️ ${note.dueDate.split('T')[0]}</div>` 
                : '';
            
            innerHTML = `
                <div class="note-content-wrapper" 
                     ontouchstart="startLongPress(event, '${note.id}')" 
                     ontouchend="cancelLongPress()" 
                     ontouchmove="cancelLongPressMove(event)"
                     onmousedown="startLongPress(event, '${note.id}')"
                     onmouseup="cancelLongPress()"
                     onmouseleave="cancelLongPress()"
                     onclick="handleTaskClick(event, '${note.id}')">
                    
                    <div class="note-text">${overdueInd}${tagParsed}</div>
                    ${dueDateMeta}
                </div>
                
                ${note.status !== 'active' ? `<div class="note-actions"><button class="action-btn restore-btn" onclick="restoreTask('${note.id}')" title="Restore">↺</button><button class="action-btn delete-btn" onclick="deleteTask('${note.id}')" title="Delete">×</button></div>` : ''}
            `;
            
            cls = `note ${note.quadrant} ${note.status === 'closed' ? 'closed-note' : ''}`;
        }

        if (el) {
            // Smart update: Only rewrite the DOM if the data actually changed
            if (el.innerHTML !== innerHTML) el.innerHTML = innerHTML;
            if (el.className !== cls) el.className = cls;
            existingMap.delete(noteId);
        } else {
            // Create new block
            el = document.createElement('div');
            el.id = `note-${noteId}`;
            el.className = cls;
            if (note.status === 'active' && !note.isSeparator) {
                el.draggable = true;
                el.ondragstart = (e) => { e.stopPropagation(); e.dataTransfer.setData('text/plain', note.id); };
            }
            el.innerHTML = innerHTML;
            container.appendChild(el);
        }

        // Ensure visual order matches sorted array without fully remounting the div
        if (container.children[index] !== el) {
            container.insertBefore(el, container.children[index]);
        }
    });

    // Destroy any DOM elements that are no longer in the array
    existingMap.forEach(node => node.remove());
}

function completeTask(id) { const note = notes.find(n => n.id === id); if (note) { note.status = 'closed'; note.quadrant = 'closed'; note.dirty = true; saveNotes(); handleSearch(); } }
function restoreTask(id) { const note = notes.find(n => n.id === id); if (note) { note.status = 'active'; note.quadrant = 'inbox'; note.dirty = true; saveNotes(); handleSearch(); } }
function deleteTask(id) {
    const note = notes.find(n => n.id === id);
    if (note) {
        if (note.timeBlocks && note.timeBlocks.length > 0) {
            note.timeBlocks.forEach(tb => {
                if (tb.targetEventId) queueTargetEventDeletion(tb.targetEventId);
            });
        }
        note.deleted = true;
        note.dirty = true;
        saveNotes();
        handleSearch();
    }
}

function checkConfigState() {
    const authorizeButton = document.getElementById('authorize_button');
    const signoutButton = document.getElementById('signout_button');

    authorizeButton.style.display = 'none';
    signoutButton.style.display = 'none';

    const savedTokenData = JSON.parse(localStorage.getItem('quadra_gapi_token_v2'));
    if (savedTokenData && savedTokenData.expires_at > Date.now()) {
        authorizeButton.style.display = 'none';
        signoutButton.style.display = 'inline-block';
        isGoogleSynced = true;
        if (typeof gapi !== 'undefined' && gapi.client) gapi.client.setToken({ access_token: savedTokenData.token });
        
        loadCalendars(); 
        startTokenHeartbeat();
        downloadDatabaseFromDrive(); // <-- NEW: Pre-fetch Drive file ID and DB in background
    } else {
        authorizeButton.style.display = 'inline-block';
        signoutButton.style.display = 'none';
    }
}

function exportData() { const dataStr = JSON.stringify(notes, null, 2); const blob = new Blob([dataStr], { type: "application/json" }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `quadra_backup_${new Date().toISOString().split('T')[0]}.json`; a.click(); URL.revokeObjectURL(url); }
function triggerImport() { document.getElementById('importFile').click(); }
function importData(event) { const file = event.target.files[0]; if (!file) return; const reader = new FileReader(); reader.onload = function(e) { try { const importedNotes = JSON.parse(e.target.result); if (Array.isArray(importedNotes)) { const noteMap = new Map(notes.map(n => [n.id, n])); importedNotes.forEach(inNote => { inNote.dirty = true; noteMap.set(inNote.id, inNote); }); notes = Array.from(noteMap.values()); saveNotes(); handleSearch(); showToast("Tasks merged!"); closeSettingsPage(); } else showToast("Invalid format."); } catch (err) { showToast("Error reading file."); } event.target.value = ''; }; reader.readAsText(file); }

// --- STICKY NOTEBOOK TOGGLE LOGIC ---
if (appConfig.showStickyNotebook === undefined) {
    appConfig.showStickyNotebook = true; // Default to visible
}

function toggleStickyNotebook() {
    appConfig.showStickyNotebook = !appConfig.showStickyNotebook;
    localStorage.setItem('quadra_config', JSON.stringify(appConfig));
    applyNotebookVisibility();
}

function applyNotebookVisibility() {
    const notesQuad = document.getElementById('notes'); 
    const notebookBtn = document.getElementById('notebook-toggle-btn');

    if (!notesQuad) return;

    if (appConfig.showStickyNotebook) {
        notesQuad.style.display = 'flex'; 
        if (notebookBtn) notebookBtn.classList.add('active');
    } else {
        notesQuad.style.display = 'none'; 
        if (notebookBtn) notebookBtn.classList.remove('active');
    }
}

window.addEventListener('load', () => {
    if (!appConfig.sortPrefs) appConfig.sortPrefs = {};

    if (!db) {
        initSQLite(null).then(() => {
            console.log("SQLite initialized locally.");
        }).catch(err => {
            console.error("Failed to initialize SQLite:", err);
        });
    }

    // Restore saved right pane width
    if (appConfig.rightPaneWidth) {
        const rp = document.getElementById('rightPane');
        if (rp) rp.style.width = appConfig.rightPaneWidth;
    }
    
    renderProjectTabs();
    applyNotebookVisibility();

    // 1. Set the visual tracker date to today if empty
    const trackerDateEl = document.getElementById('trackerDate');
    if (trackerDateEl && !trackerDateEl.value) {
        trackerDateEl.value = new Date().toLocaleDateString('en-CA').split('T')[0];
    }

    // 2. Initialize Google APIs
    if (typeof gapi !== 'undefined' && appConfig.apiKey) {
        gapi.load('client', () => {
            gapi.client.init({ 
                apiKey: appConfig.apiKey, 
                discoveryDocs: [
                    'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest',
                    'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest'
                ] 
            }).catch(() => {});
        });
    }
    
    if (typeof google !== 'undefined' && google.accounts && appConfig.clientId) {
        tokenClient = google.accounts.oauth2.initTokenClient({ 
            client_id: appConfig.clientId, 
            scope: SCOPES, 
            callback: async (resp) => { 
                if (resp.error !== undefined) { throw (resp); } 
                localStorage.setItem('quadra_gapi_token_v2', JSON.stringify({ token: resp.access_token, expires_at: Date.now() + (resp.expires_in * 1000) })); 
                document.getElementById('auth-overlay').style.display = 'none';
                document.getElementById('authorize_button').style.display = 'none'; 
                document.getElementById('signout_button').style.display = 'inline-block'; 
                isGoogleSynced = true;
                if(typeof gapi !== 'undefined' && gapi.client) gapi.client.setToken({ access_token: resp.access_token });
                loadCalendars(); 
                performBackgroundSync(); 
            }, 
        });
    }
    
    checkConfigState();

    // 3. Restore Due Filter Toggle state BEFORE rendering
    const savedDueFilter = localStorage.getItem('quadra_due_filter') !== 'false';
    const dueToggleEl = document.getElementById('dueFilterToggle');
    if (dueToggleEl) {
        dueToggleEl.checked = savedDueFilter;
        if (savedDueFilter && !localStorage.getItem('quadra_due_filter')) {
            localStorage.setItem('quadra_due_filter', 'true');
        }
    }

    // 4. Restore Search State
    const savedSearch = localStorage.getItem('quadra_search') || '';
    const searchInputEl = document.getElementById('searchInput');
    if (searchInputEl && savedSearch) {
        searchInputEl.value = savedSearch;
        const clearSearchBtn = document.getElementById('clearSearchBtn');
        if (clearSearchBtn) clearSearchBtn.style.display = 'block';
    }

    // 5. Trigger the Initial Safe Render
    renderNotes(savedSearch);

    // 6. Bind Search Bar Tag Navigation
    const tagsBar = document.getElementById('quick-tags-bar');
    if (searchInputEl && tagsBar) {
        searchInputEl.addEventListener('keydown', function(e) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                const firstTag = tagsBar.querySelector('.filter-tag');
                if (firstTag) firstTag.focus();
            }
        });

        tagsBar.addEventListener('keydown', function(e) {
            if (e.key === 'ArrowRight') {
                e.preventDefault();
                if (document.activeElement.nextElementSibling) document.activeElement.nextElementSibling.focus();
            } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                if (document.activeElement.previousElementSibling) document.activeElement.previousElementSibling.focus();
            } else if (e.key === 'ArrowUp' || e.key === 'Escape') {
                e.preventDefault();
                searchInputEl.focus();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                document.activeElement.click();
            }
        });
    }
});

function handleAuthClick() { 
    if (!appConfig.clientId) return openSettingsPage(); 
    if (!tokenClient && typeof google !== 'undefined' && google.accounts) { 
        tokenClient = google.accounts.oauth2.initTokenClient({ 
            client_id: appConfig.clientId, 
            scope: SCOPES, 
            callback: async (resp) => { 
                if (resp.error !== undefined) { throw (resp); } 
                localStorage.setItem('quadra_gapi_token_v2', JSON.stringify({ token: resp.access_token, expires_at: Date.now() + (resp.expires_in * 1000) })); 
                document.getElementById('auth-overlay').style.display = 'none'; 
                document.getElementById('authorize_button').style.display = 'none'; 
                document.getElementById('signout_button').style.display = 'inline-block'; 
                isGoogleSynced = true;
                if(typeof gapi !== 'undefined' && gapi.client) gapi.client.setToken({ access_token: resp.access_token });
                loadCalendars(); 
                performBackgroundSync(); 
            }, 
        }); 
    }
    if (!tokenClient) { showToast("Google services are still loading. Please wait a moment and try again."); return; }
    tokenClient.requestAccessToken({prompt: 'consent'}); 
}

function handleSignoutClick() { 
    const savedToken = JSON.parse(localStorage.getItem('quadra_gapi_token_v2'));
    if (savedToken && savedToken.token && typeof google !== 'undefined' && google.accounts && google.accounts.oauth2) { 
        google.accounts.oauth2.revoke(savedToken.token, () => {}); 
    } 
    localStorage.removeItem('quadra_gapi_token_v2'); 
    isGoogleSynced = false; 
    
    if (tokenHeartbeatId) clearInterval(tokenHeartbeatId);
    if (autoSyncTimerId) clearInterval(autoSyncTimerId); // NEW: Kill auto-sync
    
    document.getElementById('auth-overlay').style.display = 'none';
    document.getElementById('authorize_button').style.display = 'inline-block'; 
    document.getElementById('signout_button').style.display = 'none'; 
    showToast("Signed out successfully.");
}

async function importCalendarEvents() {
    const dateStr = document.getElementById('trackerDate').value;
    const ignoreKeywords = (appConfig.ignoreKeywords || 'out of office, ooo, away, vacation, holiday')
        .toLowerCase()
        .split(',')
        .map(k => k.trim())
        .filter(k => k.length > 0);

    let importedCount = 0;
    let updatedCount = 0;
    let ignoredCount = 0;

    try {
        document.getElementById('sync-banner').style.display = 'block';
        
        const savedToken = JSON.parse(localStorage.getItem('quadra_gapi_token_v2'));
        if (!savedToken || !savedToken.token || savedToken.expires_at < Date.now()) {
            document.getElementById('sync-banner').style.display = 'none';
            return showToast("Please sign in to Google first.");
        }
        
        if (!appConfig.sourceCalendar) {
            document.getElementById('sync-banner').style.display = 'none';
            return showToast("Please select a Source Calendar in Settings first.");
        }
        
        const [y, m, day] = dateStr.split('-');
        const timeMin = new Date(y, m-1, day, 0, 0, 0).toISOString();
        const timeMax = new Date(y, m-1, day, 23, 59, 59).toISOString();

        const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(appConfig.sourceCalendar)}/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime`, {
            headers: { 'Authorization': `Bearer ${savedToken.token}` }
        });
        const data = await res.json();
        if(data.error) throw new Error(data.error.message);

        const autoPlot = appConfig.importBehavior !== 'palette';
        const events = data.items || [];
        
        events.forEach(event => {
            if (!event.start.dateTime) return; // Skip all-day events

            const title = (event.summary || '').toLowerCase();
            const shouldIgnore = ignoreKeywords.some(keyword => title.includes(keyword));

            if (shouldIgnore) {
                ignoredCount++;
                return;
            }
            
            const start = new Date(event.start.dateTime);
            const end = new Date(event.end.dateTime);
            
            const rawStartHour = start.getHours() + (start.getMinutes() / 60);
            let rawEndHour = end.getHours() + (end.getMinutes() / 60);
            if (rawEndHour <= rawStartHour) rawEndHour += 24;
            
            const startHour = roundToQuarterHour(rawStartHour);
            const duration = Math.max(0.25, roundToQuarterHour(rawEndHour - rawStartHour));
            
            const existingNote = notes.find(n => n.eventId === event.id);
            
            // --- Determine routing for timeBlocks ---
            let newTimeBlocks = [];
            if (autoPlot) {
                newTimeBlocks = [{ blockId: 'cal', date: dateStr, startHour: startHour, duration: duration }];
            }

            // --- 1. STRIP ANNOYING PREFIXES FROM TITLE ---
            let cleanTitle = (event.summary || 'Meeting');
            // Safely strips any combination of these prefixes (case-insensitive)
            cleanTitle = cleanTitle.replace(/^(?:\[EXT\]:?\s*|Updated invitation:?\s*|Invitation:?\s*|Accepted:?\s*|Declined:?\s*|Tentative:?\s*|Canceled:?\s*|Canceled Event:?\s*)+/ig, '').trim();
            if (!cleanTitle) cleanTitle = 'Meeting';

            // --- 2. EXTRACT METADATA FOR QUADRA DESCRIPTION ---
            let bodyParts = [];
            
            // Grab organizer (Google API provides organizer.displayName and email)
            if (event.organizer) {
                let org = event.organizer.displayName ? `${event.organizer.displayName} (${event.organizer.email})` : event.organizer.email;
                if (org) bodyParts.push(`Organizer: ${org}`);
            }
            
            // Grab location 
            if (event.location) {
                bodyParts.push(`Location: ${event.location.trim()}`);
            }
            
            // Grab existing meeting description (stripping HTML to keep Quadra clean)
            if (event.description) {
                let tempDiv = document.createElement('div');
                tempDiv.innerHTML = event.description;
                let plainDesc = tempDiv.textContent || tempDiv.innerText || "";
                if (plainDesc.trim()) bodyParts.push(`\n${plainDesc.trim()}`);
            }

            // Combine into the Quadra payload format (Line 1: Title, Line 2+: Description)
            const newTextPayload = `${cleanTitle} #meeting` + (bodyParts.length > 0 ? `\n${bodyParts.join('\n')}` : '');
            
            // --- UPDATE EXISTING GOOGLE EVENT ---
            if (existingNote) {
                let changed = false;
                
                if (autoPlot) {
                    if (!existingNote.timeBlocks) existingNote.timeBlocks = [];
                    let calBlock = existingNote.timeBlocks.find(b => b.blockId === 'cal' || b.date === dateStr);
                    
                    if (!calBlock) {
                        existingNote.timeBlocks.push({ blockId: 'cal', date: dateStr, startHour: startHour, duration: duration });
                        changed = true;
                    } else {
                        if (calBlock.startHour !== startHour) { calBlock.startHour = startHour; changed = true; }
                        if (calBlock.duration !== duration) { calBlock.duration = duration; changed = true; }
                    }
                }
                
                // Compare new payload text
                if (existingNote.text !== newTextPayload) { 
                    existingNote.text = newTextPayload; 
                    changed = true; 
                }
                
                if (changed) { 
                    existingNote.dirty = true; 
                    updatedCount++; 
                }
                return;
            }
            
            notes.push({
                id: Date.now().toString() + Math.random(),
                eventId: event.id, 
                text: newTextPayload,
                quadrant: 'q2', 
                status: 'active',
                dirty: false, 
                deleted: false,
                dueDate: dateStr,
                timeBlocks: newTimeBlocks,
                projectId: 'p_default',
                syncFailed: false
            });
            importedCount++;
        });
        
        document.getElementById('sync-banner').style.display = 'none';
        
        if (importedCount > 0 || updatedCount > 0 || ignoredCount > 0) {
            saveNotes();
            renderTrackerTimeline(); 
            showToast(`${importedCount} imported, ${updatedCount} updated, ${ignoredCount} ignored.`);
        } else {
            showToast("No new meetings found or updated for this date.");
        }
        
    } catch(e) {
        console.error("Calendar Sync Error:", e);
        document.getElementById('sync-banner').style.display = 'none';
        showToast("Failed to fetch calendar events.");
    }
}

async function performBackgroundSync() {
    if (isSyncingSingle) return; // Prevent the race condition
    const savedToken = JSON.parse(localStorage.getItem('quadra_gapi_token_v2'));
    if (!savedToken || !savedToken.token) return;
    
    try {
        if (typeof gapi === 'undefined' || !gapi.client || !gapi.client.tasks || !gapi.client.tasks.tasklists) return;
        
        const syncBanner = document.getElementById('sync-banner');
        if (syncBanner) syncBanner.style.display = 'block';

        if (!gapi.client.getToken()) gapi.client.setToken({ access_token: savedToken.token });
        
        const response = await gapi.client.tasks.tasklists.list();
        const remoteLists = response.result.items || [];
        const GAPI_LIST_NAMES = { 'inbox': 'Quadra: Inbox', 'q1': 'Quadra: Do First', 'q2': 'Quadra: Schedule', 'q3': 'Quadra: Delegate', 'q4': 'Quadra: Later', 'notes': 'Quadra: Notes', 'closed': 'Quadra: Completed' };
        let gapiListIds = { inbox: null, q1: null, q2: null, q3: null, q4: null, notes: null, closed: null };
        
        for (const quadKey of Object.keys(GAPI_LIST_NAMES)) { 
            const existingList = remoteLists.find(l => l.title === GAPI_LIST_NAMES[quadKey]); 
            if (existingList) { 
                gapiListIds[quadKey] = existingList.id; 
            } else { 
                const newListReq = await gapi.client.tasks.tasklists.insert({ resource: { title: GAPI_LIST_NAMES[quadKey] } }); 
                gapiListIds[quadKey] = newListReq.result.id; 
            } 
        }
        
        localStorage.setItem('quadra_gapi_lists', JSON.stringify(gapiListIds));
        let remoteTaskMap = {};
        const lastSync = localStorage.getItem('quadra_last_sync');

        for (const quadKey of Object.keys(gapiListIds)) { 
            const listId = gapiListIds[quadKey]; 
            let reqOpts = { tasklist: listId, showHidden: true, showDeleted: true, maxResults: 100 };
            if (lastSync) reqOpts.updatedMin = lastSync; 
            
            const tasksReq = await gapi.client.tasks.tasks.list(reqOpts); 
            const rTasks = tasksReq.result.items || []; 
            rTasks.forEach(t => { remoteTaskMap[t.id] = { task: t, listId: listId, quadKey: quadKey }; }); 
        }
        
        const syncSnapshot = JSON.parse(JSON.stringify(notes));
        
        for (let sn of syncSnapshot) {
            if (sn.eventId) continue; 
            
            const remoteObj = remoteTaskMap[sn.id];
            const isStrandedLocal = !isNaN(sn.id) || sn.id.toString().includes('.');
            
            // --- CONFLICT RESOLUTION: GOOGLE WINS ---
            if (remoteObj && currentEditingId !== sn.id) {
                if (remoteObj.task.deleted) {
                    sn.deleted = true;
                    sn.dirty = false;
                } else {
                    let fullText = remoteObj.task.title || '';
                    if (remoteObj.task.notes) fullText += '\n' + remoteObj.task.notes;
                    
                    fullText = fullText.replace(/^\[x\]\s+(.*)$/gm, '<ul class="todo-list"><li class="todo-item completed">$1</li></ul>')
                                    .replace(/^\[ \]\s+(.*)$/gm, '<ul class="todo-list"><li class="todo-item">$1</li></ul>');
                    fullText = fullText.replace(/<\/ul>\s*<ul class="todo-list">/g, '');
                    if (!/<[a-z][\s\S]*>/i.test(fullText)) fullText = fullText.replace(/\n/g, '<br>');
                    
                    sn.text = fullText; 
                    sn.status = remoteObj.task.status === 'completed' ? 'closed' : 'active'; 
                    sn.quadrant = remoteObj.quadKey; 
                    
                    // STRICT DUE DATE SYNC: Updates the badge on the card, completely ignores timeBlocks
                    sn.dueDate = remoteObj.task.due ? remoteObj.task.due.split('T')[0] : null; 

                    sn.dirty = false; 
                    sn.syncFailed = false;
                }
                delete remoteTaskMap[sn.id];
                if (sn.tempId) delete remoteTaskMap[sn.tempId];
                continue; 
            }

            if (sn.deleted && (sn.dirty || isStrandedLocal)) { 
                if (remoteObj) { 
                    try { 
                        await gapi.client.tasks.tasks.delete({ tasklist: remoteObj.listId, task: sn.id }); 
                    } catch(e){} 
                } 
                sn.syncFailed = false;
                sn.dirty = false; 
                continue; 
            }
            
            if ((sn.dirty || isStrandedLocal) && !sn.deleted) {
                const targetListId = gapiListIds[sn.quadrant]; 
                const gStatus = sn.status === 'closed' ? 'completed' : 'needsAction'; 
                
                let plainTextPayload = cleanHTMLToPlainText(sn.text);
                let lines = plainTextPayload.split('\n');
                let tTitle = lines[0].trim() || 'Untitled Task';
                let tNotes = lines.slice(1).join('\n').trim();

                if (tTitle.length > 1000) tTitle = tTitle.substring(0, 1000) + '...';
                if (tNotes.length > 8100) tNotes = tNotes.substring(0, 8100) + '\n\n[...Truncated for Google Tasks]';

                const resourceBody = { title: tTitle, notes: tNotes, status: gStatus }; 
                
                if (sn.dueDate) {
                    const [y, m, d] = sn.dueDate.split('-');
                    resourceBody.due = new Date(Date.UTC(y, m - 1, d, 0, 0, 0)).toISOString();
                }

                if (remoteObj && currentEditingId === sn.id) { 
                    if (remoteObj.listId !== targetListId) { 
                        try { 
                            await gapi.client.tasks.tasks.delete({ tasklist: remoteObj.listId, task: sn.id }); 
                            const res = await gapi.client.tasks.tasks.insert({ tasklist: targetListId, resource: resourceBody }); 
                            sn.tempId = sn.id; sn.id = res.result.id; sn.syncFailed = false;
                        } catch(e){ sn.syncFailed = true; } 
                    } else { 
                        try { 
                            await gapi.client.tasks.tasks.patch({ tasklist: remoteObj.listId, task: sn.id, resource: resourceBody }); 
                            sn.syncFailed = false;
                        } catch(e){ sn.syncFailed = true; } 
                    } 
                    delete remoteTaskMap[sn.id]; 
                    if (sn.tempId) delete remoteTaskMap[sn.tempId]; 
                } else { 
                    if (!isStrandedLocal) {
                        try { 
                            await gapi.client.tasks.tasks.patch({ tasklist: targetListId, task: sn.id, resource: resourceBody }); 
                            sn.syncFailed = false;
                        } catch(e) {
                            if (e.status === 404 || (e.result && e.result.error && e.result.error.code === 404)) {
                                try { 
                                    const res = await gapi.client.tasks.tasks.insert({ tasklist: targetListId, resource: resourceBody }); 
                                    sn.tempId = sn.id; sn.id = res.result.id; sn.syncFailed = false;
                                } catch(err){ sn.syncFailed = true; }
                            } else {
                                sn.syncFailed = true;
                            }
                        }
                    } else {
                        try { 
                            const res = await gapi.client.tasks.tasks.insert({ tasklist: targetListId, resource: resourceBody }); 
                            sn.tempId = sn.id; sn.id = res.result.id; sn.syncFailed = false;
                        } catch(e){ sn.syncFailed = true; } 
                    }
                }
                sn.dirty = false;
            } 
        }
        
        Object.values(remoteTaskMap).forEach(remoteObj => { 
            if (!remoteObj.task.deleted) {
                let fullText = remoteObj.task.title || '';
                if (remoteObj.task.notes) fullText += '\n' + remoteObj.task.notes;
                
                fullText = fullText.replace(/^\[x\]\s+(.*)$/gm, '<ul class="todo-list"><li class="todo-item completed">$1</li></ul>')
                                .replace(/^\[ \]\s+(.*)$/gm, '<ul class="todo-list"><li class="todo-item">$1</li></ul>');
                fullText = fullText.replace(/<\/ul>\s*<ul class="todo-list">/g, '');
                if (!/<[a-z][\s\S]*>/i.test(fullText)) fullText = fullText.replace(/\n/g, '<br>');
                
                // For brand new tasks from Google, initialize with empty timeBlocks array
                syncSnapshot.push({ 
                    id: remoteObj.task.id, text: fullText, quadrant: remoteObj.quadKey, 
                    status: remoteObj.task.status === 'completed' ? 'closed' : 'active', 
                    dueDate: remoteObj.task.due ? remoteObj.task.due.split('T')[0] : null, 
                    timeBlocks: [], 
                    eventId: null, dirty: false, deleted: false, syncFailed: false
                });
            }
        });
        
        let newNotesArray = []; 
        let syncedIds = new Set();
        syncSnapshot.forEach(sn => { 
            if (sn.deleted && !sn.dirty) return; 
            const liveNote = notes.find(n => n.id === sn.id || (sn.tempId && n.id === sn.tempId)); 
            if (liveNote) { 
                sn.eventId = liveNote.eventId || null; 
                if (liveNote.dirty) { 
                    if (sn.tempId) liveNote.id = sn.id; 
                    newNotesArray.push(liveNote); 
                } else { 
                    newNotesArray.push(sn); 
                } 
                syncedIds.add(liveNote.id); 
                if (sn.tempId) syncedIds.add(sn.tempId); 
            } else { 
                newNotesArray.push(sn); 
            } 
        });

        if (currentEditingId) {
            const liveEditingNote = notes.find(n => n.id === currentEditingId);
            if (liveEditingNote) {
                const newIdx = newNotesArray.findIndex(n => n.id === currentEditingId);
                if (newIdx !== -1) newNotesArray[newIdx] = liveEditingNote;
                else newNotesArray.push(liveEditingNote);
            }
        }
        
        notes = newNotesArray; 
        saveNotes(); // Saves to SQLite
        localStorage.setItem('quadra_last_sync', new Date().toISOString());
        handleSearch();
        
        // --- NEW: Also trigger a SQLite backup to Drive when Tasks sync completes ---
        uploadDatabaseToDrive();
        
        // --- NEW: Also push scheduled blocks to Target Calendar silently ---
        if (appConfig.targetCalendar) {
            await pushWeekToTargetCalendar(true);
        }
        
        if (syncBanner) syncBanner.style.display = 'none';
        showToast("✓ Successfully synced!");
    } catch (e) {
        console.error("Background sync error:", e);
        const syncBanner = document.getElementById('sync-banner');
        if (syncBanner) syncBanner.style.display = 'none';
        showToast("Tasks sync failed. Check your network or API configuration.");
    }
}

// --- Editor Toolbar Logic ---
document.getElementById('editorToolbar')?.addEventListener('click', function(e) {
    let btn = e.target.closest('button');
    if (!btn) return;
    let command = btn.getAttribute('data-command');
    let value = btn.getAttribute('data-value') || null;
    if (command) {
        e.preventDefault();
        document.execCommand(command, false, value);
        document.getElementById('taskInfoInput').focus();
        triggerAutoSaveInterval();
    }
});

function toggleChecklistFormatting() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;

    let container = sel.getRangeAt(0).commonAncestorContainer;
    let el = container.nodeType === 3 ? container.parentNode : container;
    
    // 1. Check if we are already inside a checklist item
    let existingLi = el.closest('li.todo-item');
    if (existingLi) {
        existingLi.classList.toggle('completed');
        triggerAutoSaveInterval();
        return;
    }

    // 2. If not a checklist, safely convert the current line using native commands
    document.execCommand('insertUnorderedList', false, null);
    
    // 3. Immediately upgrade the native list to our custom checklist styles
    setTimeout(() => {
        let currSel = window.getSelection();
        if(!currSel.rangeCount) return;
        let currNode = currSel.getRangeAt(0).commonAncestorContainer;
        let currEl = currNode.nodeType === 3 ? currNode.parentNode : currNode;
        
        let li = currEl.closest('li');
        let ul = currEl.closest('ul');
        
        if (li) li.classList.add('todo-item');
        if (ul) ul.classList.add('todo-list');
        
        triggerAutoSaveInterval();
    }, 10);
}

// --- Live Tag Formatting for Editor ---
// --- Live Tag & Markdown Formatting for Editor ---
['taskTitleInput', 'taskInfoInput'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
        el.addEventListener('keyup', function(e) {
            // Standard tag formatting
            if (e.key === ' ' || e.key === 'Enter') {
                formatEditorNodes(id);
                
                // --- UPDATED: Markdown Auto-formatting (Strict Line Start) ---
                if (e.key === ' ') {
                    const sel = window.getSelection();
                    if (!sel.rangeCount) return;
                    
                    let range = sel.getRangeAt(0);
                    let node = range.startContainer;
                    
                    if (node.nodeType === 3) { 
                        let offset = range.startOffset;
                        let textBeforeCursor = node.textContent.substring(0, offset);
                        
                        // Check if the current text matches our exact triggers
                        if (textBeforeCursor === '* ' || textBeforeCursor === '- ' || textBeforeCursor === '1. ') {
                            
                            // Verify the text node is physically at column 0 of the line
                            let isStartOfLine = false;
                            
                            // Condition 1: It is the very first node in its block container
                            if (!node.previousSibling) {
                                isStartOfLine = true;
                            } 
                            // Condition 2: The element immediately before it is a soft line break
                            else if (node.previousSibling && node.previousSibling.tagName === 'BR') {
                                isStartOfLine = true;
                            }
                            // Condition 3: It's wrapped in a format tag (like a span) that is the first child
                            else if (node.parentNode && node.parentNode !== el && !node.parentNode.previousSibling) {
                                 isStartOfLine = true;
                            }

                            if (isStartOfLine) {
                                range.setStart(node, 0);
                                range.setEnd(node, offset);
                                range.deleteContents(); // Erase the trigger characters
                                
                                if (textBeforeCursor === '1. ') {
                                    document.execCommand('insertOrderedList', false, null);
                                } else {
                                    document.execCommand('insertUnorderedList', false, null);
                                }
                                triggerAutoSaveInterval();
                            }
                        }
                    }
                }
            }
        });
        
        el.addEventListener('paste', function(e) {
            setTimeout(() => {
                formatEditorNodes(id);
            }, 10);
        });
    }
});

// --- Code Block Insertion Engine ---
function insertCodeBlock() {
    const editor = document.getElementById('taskInfoInput');
    if (!editor) return;
    
    editor.focus();
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    
    let range = sel.getRangeAt(0);
    
    // Safety check: ensure the user's cursor is actually inside the rich text editor
    let node = range.commonAncestorContainer;
    while (node && node !== editor) {
        if (node.parentNode === editor) break;
        node = node.parentNode;
    }
    
    // If cursor is outside the editor, force it to the end of the editor
    if (!node || (node !== editor && node.parentNode !== editor)) {
        range.selectNodeContents(editor);
        range.collapse(false);
    }

    // 1. Create the fixed-width code block
    const pre = document.createElement('pre');
    pre.className = 'editor-code-block';
    pre.innerHTML = '<br>'; // Gives the block physical height so it can be clicked

    // 2. Create the "escape" div below it so the user isn't trapped inside the formatting
    const escapeDiv = document.createElement('div');
    escapeDiv.innerHTML = '<br>';

    // 3. Inject both into the editor
    range.deleteContents();
    const frag = document.createDocumentFragment();
    frag.appendChild(pre);
    frag.appendChild(escapeDiv);
    range.insertNode(frag);

    // 4. Force the blinking cursor inside the new code block automatically
    range.setStart(pre, 0);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);

    triggerAutoSaveInterval();
}
// --- Google API Token Heartbeat ---
function startTokenHeartbeat() {
    if (tokenHeartbeatId) clearInterval(tokenHeartbeatId);
    
    // Check the token health every 1 minute
    tokenHeartbeatId = setInterval(() => {
        const savedTokenData = JSON.parse(localStorage.getItem('quadra_gapi_token_v2'));
        
        if (savedTokenData && isGoogleSynced) {
            const timeRemaining = savedTokenData.expires_at - Date.now();
            const fiveMinutes = 5 * 60 * 1000;
            
            // If we have less than 5 minutes left, silently request a new token
            if (timeRemaining > 0 && timeRemaining < fiveMinutes) {
                console.log("Token expiring soon. Attempting silent refresh...");
                attemptSilentTokenRefresh();
            } else if (timeRemaining <= 0) {
                // If it already expired while the computer was asleep, log them out safely
                handleSignoutClick();
                showToast("Google session expired. Please sign in again.");
            }
        }
    }, 60000);
}

function attemptSilentTokenRefresh() {
    if (!tokenClient || typeof google === 'undefined') return;
    
    // prompt: 'none' forces Google to issue the new token without flashing a window
    tokenClient.requestAccessToken({ prompt: 'none' });
}

// --- Cloud Sync Status UI ---
function setCloudSyncIcon(state) {
    const icon = document.getElementById('cloudSyncIcon');
    if (!icon) return;

    if (state === 'saving') {
        icon.innerHTML = '🌧️'; 
        icon.style.color = '#3B82F6'; // Blue
        icon.title = 'Saving to Google Drive...';
    } else if (state === 'saved') {
        icon.innerHTML = '🌤️';
        icon.style.color = '#10B981'; // Green
        icon.title = 'Saved to Google Drive';
    } else if (state === 'unsaved') {
        icon.innerHTML = '☁️';
        icon.style.color = '#F59E0B'; // Orange
        icon.title = 'Unsaved changes (Press Ctrl+S)';
    } else if (state === 'error') {
        icon.innerHTML = '⛈️'; // Added a storm cloud for errors!
        icon.style.color = '#EF4444'; // Red
        icon.title = 'Error saving to Drive';
    }
}

async function pushWeekToTargetCalendar(silent = false) {
    if (!appConfig.targetCalendar) {
        if (!silent) showToast("Please select a Target Calendar in Settings.");
        return;
    }
    
    const savedToken = JSON.parse(localStorage.getItem('quadra_gapi_token_v2'));
    if (!savedToken || !savedToken.token) {
        if (!silent) showToast("Please sign in to Google first.");
        return;
    }

    if (typeof gapi !== 'undefined' && gapi.client) {
        gapi.client.setToken({ access_token: savedToken.token });
    }

    const trackerDateEl = document.getElementById('trackerDate');
    const trackerDate = trackerDateEl ? trackerDateEl.value : new Date().toLocaleDateString('en-CA').split('T')[0];
    const [y, m, d] = trackerDate.split('-');
    
    // Target the specific span ID in the right toolbar
    const btnIcon = document.getElementById('syncTargetIcon') || document.getElementById('btnSyncTargetCal');
    if (btnIcon) btnIcon.innerText = "⏳";

    try {
        let syncedCount = 0;
        let deletedCount = 0;
        let requiresLocalSave = false;

        // --- 1. PROCESS REMOTE DELETIONS FROM QUEUE ---
        let deleteQueue = JSON.parse(localStorage.getItem('quadra_deleted_target_events')) || [];
        if (deleteQueue.length > 0) {
            const remainingDeletions = [];
            for (const targetEventId of deleteQueue) {
                try {
                    await gapi.client.calendar.events.delete({
                        calendarId: appConfig.targetCalendar,
                        eventId: targetEventId
                    });
                    deletedCount++;
                } catch (err) {
                    if (err.status === 404 || err.status === 410 || 
                       (err.result && err.result.error && (err.result.error.code === 404 || err.result.error.code === 410))) {
                        deletedCount++;
                    } else {
                        console.error("Failed to delete event from Target Calendar:", targetEventId, err);
                        remainingDeletions.push(targetEventId);
                    }
                }
            }
            localStorage.setItem('quadra_deleted_target_events', JSON.stringify(remainingDeletions));
        }

        // --- 2. SYNC ACTIVE BLOCKS ---
        for (const note of notes) {
            if (note.deleted) continue; 
            if (!note.timeBlocks || note.timeBlocks.length === 0) continue;

            let pIds = note.projectIds || (note.projectId ? [note.projectId] : ['p_default']);
            let pid = pIds[0];
            let pObj = appConfig.projects.find(p => p.id === pid);
            let pName = pObj ? `${pObj.name} - ` : '';
            
            let plainText = cleanHTMLToPlainText(note.text);
            let lines = plainText.split('\n');
            let cleanTitle = lines[0].trim();
            
            let fullDisplayTitle = pName + cleanTitle; 
            let taskNotes = lines.slice(1).join('\n').trim(); 

            let noteUpdatedLocally = false;

            for (const tb of note.timeBlocks) {
                if (tb.date !== trackerDate) continue; 

                let startHour = Math.floor(tb.startHour);
                let startMin = Math.round((tb.startHour % 1) * 60);
                
                let endDecimal = tb.startHour + tb.duration;
                let endHour = Math.floor(endDecimal);
                let endMin = Math.round((endDecimal % 1) * 60);

                let startDateTime = new Date(y, m - 1, d, startHour, startMin, 0);
                let endDateTime = new Date(y, m - 1, d, endHour, endMin, 0);

                const eventPayload = {
                    summary: fullDisplayTitle,
                    description: taskNotes,
                    status: 'confirmed',
                    start: { dateTime: startDateTime.toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
                    end: { dateTime: endDateTime.toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
                };

                try {
                    if (tb.targetEventId) {
                        await gapi.client.calendar.events.patch({
                            calendarId: appConfig.targetCalendar,
                            eventId: tb.targetEventId,
                            resource: eventPayload
                        });
                    } else {
                        const res = await gapi.client.calendar.events.insert({
                            calendarId: appConfig.targetCalendar,
                            resource: eventPayload
                        });
                        tb.targetEventId = res.result.id; 
                        noteUpdatedLocally = true;
                    }
                    syncedCount++;
                } catch (err) {
                    if (err.status === 404 || (err.result && err.result.error && err.result.error.code === 404)) {
                        const res = await gapi.client.calendar.events.insert({
                            calendarId: appConfig.targetCalendar,
                            resource: eventPayload
                        });
                        tb.targetEventId = res.result.id;
                        noteUpdatedLocally = true;
                        syncedCount++;
                    } else {
                        console.error("Calendar Sync Error on Block:", err);
                    }
                }
            }
            
            if (noteUpdatedLocally) {
                note.dirty = true;
                requiresLocalSave = true;
            }
        }
        
        if (requiresLocalSave) saveNotes();

        let statusMsg = `✓ Mirrored ${syncedCount} blocks to Target Calendar`;
        if (deletedCount > 0) statusMsg += ` (${deletedCount} deleted)`;
        if (!silent) showToast(statusMsg);
    } catch (e) {
        console.error("Mirror to Target Failed:", e);
        if (!silent) showToast("❌ Failed to sync to Target Calendar");
    } finally {
        if (btnIcon) btnIcon.innerText = "💾";
    }
}

function renderArchivedProjects() {
    const container = document.getElementById('archivedProjectsList');
    if (!container) return;
    container.innerHTML = '';
    
    const archived = appConfig.projects.filter(p => p.archived);
    if (archived.length === 0) {
        container.innerHTML = '<p style="font-size: 13px; color: var(--text-muted);">No archived projects.</p>';
        return;
    }
    
    archived.forEach(proj => {
        const div = document.createElement('div');
        div.className = 'form-row-inline';
        div.style.marginBottom = '8px';
        div.innerHTML = `
            <span style="flex:1; font-weight:600; font-size: 13px; color: var(--text-main);">${proj.name}</span>
            <button class="btn btn-outline" style="padding: 4px 10px; font-size: 12px;" onclick="unarchiveProject('${proj.id}')">Restore</button>
        `;
        container.appendChild(div);
    });
}

function unarchiveProject(id) {
    const proj = appConfig.projects.find(p => p.id === id);
    if (proj) {
        proj.archived = false;
        localStorage.setItem('quadra_config', JSON.stringify(appConfig));
        renderProjectTabs();
        renderArchivedProjects();
        handleSearch();
        showToast(`Project '${proj.name}' restored.`);
    }
}

let currentEditingProjectId = null;

function openProjectModal(projectId) {
    const proj = appConfig.projects.find(p => p.id === projectId);
    if (!proj) return;
    
    currentEditingProjectId = projectId;
    const modal = document.getElementById('projectModal');
    const input = document.getElementById('editProjectNameInput');
    const btnDelete = document.getElementById('btnDeleteProject');
    const btnArchive = document.getElementById('btnArchiveProject');
    
    input.value = proj.name;
    
    // Hide dangerous actions for the Default project
    if (proj.id === 'p_default') {
        btnDelete.style.display = 'none';
        btnArchive.style.display = 'none';
    } else {
        btnDelete.style.display = 'inline-block';
        btnArchive.style.display = 'inline-block';
    }
    
    modal.style.display = 'flex';
    setTimeout(() => {
        input.focus();
        input.select();
    }, 100);
}

function closeProjectModal() {
    currentEditingProjectId = null;
    document.getElementById('projectModal').style.display = 'none';
}

function saveProjectModal() {
    if (!currentEditingProjectId) return;
    
    const input = document.getElementById('editProjectNameInput');
    const newName = input.value.trim();
    if (!newName) return showToast("Project name cannot be empty.");
    
    const proj = appConfig.projects.find(p => p.id === currentEditingProjectId);
    if (proj) {
        proj.name = newName;
        localStorage.setItem('quadra_config', JSON.stringify(appConfig));
        renderProjectTabs();
    }
    
    closeProjectModal();
    saveProjectsToDB();
}

function archiveProjectFromModal() {
    if (!currentEditingProjectId || currentEditingProjectId === 'p_default') return;
    
    const proj = appConfig.projects.find(p => p.id === currentEditingProjectId);
    if (proj) {
        proj.archived = true;
        proj.visible = false;
        
        const unarchived = appConfig.projects.filter(p => !p.archived);
        if (!unarchived.some(p => p.visible) && unarchived.length > 0) {
            unarchived[0].visible = true;
        }
        
        localStorage.setItem('quadra_config', JSON.stringify(appConfig));
        renderProjectTabs();
        handleSearch();
        showToast(`Project '${proj.name}' archived.`);
    }
    closeProjectModal();
    saveProjectsToDB();
}

function deleteProjectFromModal() {
    if (!currentEditingProjectId || currentEditingProjectId === 'p_default') return;
    
    const proj = appConfig.projects.find(p => p.id === currentEditingProjectId);
    if (!proj) return;
    
    if (confirm(`Are you sure you want to delete '${proj.name}'? All associated tasks will be moved to your primary project.`)) {
        notes.forEach(n => { 
            if (n.projectId === proj.id || (n.projectIds && n.projectIds.includes(proj.id))) {
                n.projectId = 'p_default';
                n.projectIds = ['p_default'];
                n.dirty = true;
            }
        });
        saveNotes();
        
        appConfig.projects = appConfig.projects.filter(p => p.id !== proj.id);
        const unarchived = appConfig.projects.filter(p => !p.archived);
        if (!unarchived.some(p => p.visible) && unarchived.length > 0) unarchived[0].visible = true;
        
        localStorage.setItem('quadra_config', JSON.stringify(appConfig));
        renderProjectTabs();
        handleSearch();
        closeProjectModal();
        saveProjectsToDB();
    }
}

// --- SORTING ENGINE ---
function toggleSortMenu(quadrant, event) {
    event.stopPropagation();
    
    // Close other open menus
    document.querySelectorAll('.dropdown-content').forEach(menu => {
        if (menu.id !== `sort-menu-${quadrant}`) {
            menu.classList.remove('show');
        }
    });

    const menu = document.getElementById(`sort-menu-${quadrant}`);
    if (menu) {
        menu.classList.toggle('show');
        
        // Highlight active sort option
        let pref = appConfig.sortPrefs[quadrant] || (quadrant === 'notes' ? 'created_desc' : 'due_asc');
        Array.from(menu.children).forEach(child => {
            if (child.getAttribute('onclick').includes(pref)) {
                child.classList.add('active-sort');
            } else {
                child.classList.remove('active-sort');
            }
        });
    }
}

// Close menu when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.custom-dropdown')) {
        document.querySelectorAll('.dropdown-content.show').forEach(m => m.classList.remove('show'));
    }
});

function changeSort(quadrant, val) {
    if (!appConfig.sortPrefs) appConfig.sortPrefs = {};
    appConfig.sortPrefs[quadrant] = val;
    localStorage.setItem('quadra_config', JSON.stringify(appConfig));
    
    const menu = document.getElementById(`sort-menu-${quadrant}`);
    if (menu) menu.classList.remove('show');
    
    handleSearch(); // Trigger re-render with new sort
}

// --- Modal Extensions: Time Tracking & Deletion ---
function toggleTimeTrackPanel() {
    const content = document.getElementById('taskModalContent');
    const rightPane = document.getElementById('taskModalRightPane');
    
    if (content.classList.contains('time-panel-open')) {
        content.classList.remove('time-panel-open');
        setTimeout(() => rightPane.style.display = 'none', 300);
    } else {
        rightPane.style.display = 'flex';
        setTimeout(() => content.classList.add('time-panel-open'), 10);
    }
}

function renderQuickTimeLogs() {
    const tbody = document.getElementById('quickLogTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    
    if (!currentEditingId) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; color:var(--text-muted); padding: 12px;">Save task first</td></tr>';
        return;
    }
    
    const note = notes.find(n => n.id === currentEditingId);
    if (!note || !note.timeBlocks || note.timeBlocks.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; color:var(--text-muted); padding: 12px;">No time logged</td></tr>';
        return;
    }
    
    // Sort blocks by date descending
    let sortedBlocks = [...note.timeBlocks].sort((a,b) => b.date.localeCompare(a.date));
    
    sortedBlocks.forEach(tb => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td style="padding: 8px;">${tb.date}</td>
            <td style="padding: 8px; text-align: center; font-weight: 600;">${tb.duration}</td>
            <td style="padding: 8px; text-align: center;">
                <button class="action-btn delete-btn" style="font-size:16px;" onclick="removeTimeBlock('${tb.blockId}')" title="Delete record">×</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function addManualTimeBlock() {
    if (!currentEditingId) return showToast("Please save the task first to log time.");
    
    const dateVal = document.getElementById('quickLogDate').value;
    const hoursVal = parseFloat(document.getElementById('quickLogHours').value);
    
    if (!dateVal || isNaN(hoursVal) || hoursVal <= 0) {
        return showToast("Please enter a valid date and hours.");
    }
    
    const note = notes.find(n => n.id === currentEditingId);
    if (note) {
        if (!note.timeBlocks) note.timeBlocks = [];
        note.timeBlocks.push({
            blockId: 'b_' + Date.now().toString() + Math.floor(Math.random() * 1000),
            date: dateVal,
            startHour: 9, // Native manual entries default to 9am to avoid overlap issues
            duration: hoursVal
        });
        note.dirty = true;
        saveNotes();
        renderQuickTimeLogs();
        document.getElementById('quickLogHours').value = '';
    }
}

function removeTimeBlock(blockId) {
    if (!currentEditingId) return;
    const note = notes.find(n => n.id === currentEditingId);
    if (note && note.timeBlocks) {
        const tbToRemove = note.timeBlocks.find(b => b.blockId === blockId);
        if (tbToRemove && tbToRemove.targetEventId) {
            queueTargetEventDeletion(tbToRemove.targetEventId);
        }
        note.timeBlocks = note.timeBlocks.filter(b => b.blockId !== blockId);
        note.dirty = true;
        saveNotes();
        renderQuickTimeLogs();
    }
}

function deleteTaskFromModal() {
    if (currentEditingId && confirm("Are you sure you want to delete this task/event?")) {
        deleteTask(currentEditingId);
        closeTaskModal();
        renderTrackerTimeline();
    }
}

// --- PDF EXPORT ENGINE ---
function exportNoteToPDF() {
    if (!currentEditingId) {
        return showToast("Please save the task first before exporting.");
    }

    const note = notes.find(n => n.id === currentEditingId);
    if (!note) return;

    // 1. Extract Data
    let titleText = cleanHTMLToPlainText(note.text).split('\n')[0];
    let bodyHTML = document.getElementById('taskInfoInput').innerHTML;
    let pid = note.projectId || note.projectIds?.[0] || 'p_default';
    let pObj = appConfig.projects.find(p => p.id === pid);
    let projectName = pObj ? pObj.name : 'Default';

    // 2. Build the Print Template (Invisible to the user)
    const printElement = document.createElement('div');
    printElement.style.padding = '30px';
    printElement.style.fontFamily = 'Inter, Helvetica, Arial, sans-serif';
    printElement.style.color = '#0F172A';
    
    printElement.innerHTML = `
        <div style="border-bottom: 3px solid #4F46E5; padding-bottom: 12px; margin-bottom: 24px;">
            <div style="font-size: 10px; font-weight: 700; color: #4F46E5; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px;">Quadra Export</div>
            <h1 style="margin: 0; font-size: 24px; font-weight: 800; color: #1E293B; line-height: 1.3;">${parseTags(titleText)}</h1>
            <div style="display: flex; gap: 16px; font-size: 12px; font-weight: 500; color: #64748B; margin-top: 12px;">
                ${note.dueDate ? `<span><b>Due:</b> ${note.dueDate}</span>` : ''} 
                <span><b>Project:</b> ${projectName}</span>
                <span><b>Status:</b> ${note.status.toUpperCase()}</span>
            </div>
        </div>
        <div style="font-size: 13px; line-height: 1.6; color: #334155;">
            ${bodyHTML !== '<br>' && bodyHTML !== '' ? bodyHTML : '<i>No description provided.</i>'}
        </div>
    `;

    // 3. Configure html2pdf settings
    const opt = {
        margin:       0.5,
        filename:     `${titleText.replace(/[^a-z0-9]/gi, '_').toLowerCase().substring(0, 30)}_export.pdf`,
        image:        { type: 'jpeg', quality: 0.98 },
        html2canvas:  { scale: 2, useCORS: true, letterRendering: true },
        jsPDF:        { unit: 'in', format: 'letter', orientation: 'portrait' }
    };

    // 4. Generate and Download
    showToast("Generating PDF...");
    html2pdf().set(opt).from(printElement).save().then(() => {
        showToast("✓ PDF Downloaded");
    });
}

async function mirrorToTargetCalendar() {
    if (!appConfig.targetCalendar) return showToast("Please select a Target Calendar in Settings.");
    
    const savedToken = JSON.parse(localStorage.getItem('quadra_gapi_token_v2'));
    if (!savedToken || !savedToken.token) return showToast("Please sign in to Google first.");

    // Explicitly set the OAuth token before making API calls
    if (typeof gapi !== 'undefined' && gapi.client) {
        gapi.client.setToken({ access_token: savedToken.token });
    }

    const trackerDate = document.getElementById('trackerDate').value;
    const [y, m, d] = trackerDate.split('-');
    
    const btn = document.getElementById('mirrorTargetBtn'); // Replace with your actual button ID if different
    if (btn) btn.innerText = "Syncing...";

    try {
        let syncedCount = 0;

        for (const note of notes) {
            // Skip deleted tasks or tasks that were imported FROM the calendar
            if (note.deleted) continue; 
            if (!note.timeBlocks || note.timeBlocks.length === 0) continue;

            // 1. Get Project Prefix
            let pid = note.projectId || note.projectIds?.[0] || 'p_default';
            let pObj = appConfig.projects.find(p => p.id === pid);
            let pName = pObj ? `${pObj.name} - ` : '';
            
            // 2. Extract Title and Notes
            let plainText = cleanHTMLToPlainText(note.text);
            let lines = plainText.split('\n');
            let cleanTitle = lines[0].trim();
            
            let fullDisplayTitle = pName + cleanTitle; // The padded title
            let taskNotes = lines.slice(1).join('\n').trim(); // The rest becomes the calendar description

            // 3. Process Time Blocks for the selected day
            for (const tb of note.timeBlocks) {
                if (tb.date !== trackerDate) continue; 

                let startHour = Math.floor(tb.startHour);
                let startMin = Math.round((tb.startHour % 1) * 60);
                
                let endDecimal = tb.startHour + tb.duration;
                let endHour = Math.floor(endDecimal);
                let endMin = Math.round((endDecimal % 1) * 60);

                let startDateTime = new Date(y, m - 1, d, startHour, startMin, 0);
                let endDateTime = new Date(y, m - 1, d, endHour, endMin, 0);

                // 4. Push to Target Calendar
                await gapi.client.calendar.events.insert({
                    calendarId: appConfig.targetCalendar,
                    resource: {
                        summary: fullDisplayTitle, // Pushes padded title
                        description: taskNotes,    // Pushes all task notes
                        start: { 
                            dateTime: startDateTime.toISOString(), 
                            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone 
                        },
                        end: { 
                            dateTime: endDateTime.toISOString(), 
                            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone 
                        }
                    }
                });
                syncedCount++;
            }
        }
        showToast(`✓ Mirrored ${syncedCount} blocks to Target Calendar`);
    } catch (e) {
        console.error("Mirror to Target Failed:", e);
        showToast("❌ Failed to sync to Target Calendar");
    } finally {
        if (btn) btn.innerText = "Mirror to Target";
    }
}

function queueTargetEventDeletion(targetEventId) {
    if (!targetEventId) return;
    let queue = JSON.parse(localStorage.getItem('quadra_deleted_target_events')) || [];
    if (!queue.includes(targetEventId)) {
        queue.push(targetEventId);
        localStorage.setItem('quadra_deleted_target_events', JSON.stringify(queue));
    }
}

// --- SQLite Source of Truth Engine ---
function loadNotesFromSQLite() {
    if (!db) return;
    try {
        const res = db.exec("SELECT id, text, quadrant, status, dueDate, timeBlocks, deleted, projectId FROM tasks");
        if (res.length > 0) {
            notes = res[0].values.map(row => ({
                id: row[0],
                text: row[1] || '',
                quadrant: row[2] || 'inbox',
                status: row[3] || 'active',
                dueDate: row[4] || null,
                timeBlocks: JSON.parse(row[5] || '[]'),
                deleted: row[6] === 1,
                projectIds: JSON.parse(row[7] || '["p_default"]'),
                projectId: row[7] || 'p_default',
                dirty: false,
                syncFailed: false
            }));
            console.log(`✅ Loaded ${notes.length} tasks directly from SQLite!`);
            saveNotes();
            handleSearch(); // Triggers the Delta DOM render
        }
    } catch (e) {
        console.error("SQLite Read Error:", e);
    }
}

async function downloadDatabaseFromDrive() {
    if (typeof gapi === 'undefined' || !gapi.client || !gapi.client.drive) {
        await new Promise(resolve => setTimeout(resolve, 500));
        return await downloadDatabaseFromDrive(); 
    }

    try {
        const response = await gapi.client.drive.files.list({
            q: "name='quadra.sqlite' and trashed=false", 
            fields: 'files(id, name)',
            orderBy: 'createdTime desc'
        });
        
        const files = response.result.files;
        if (files && files.length > 0) {
            driveFileId = files[0].id;
            const fileRes = await fetch(`https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`, {
                headers: { 'Authorization': `Bearer ${gapi.client.getToken().access_token}` }
            });
            const arrayBuffer = await fileRes.arrayBuffer();
            
            await initSQLite(arrayBuffer);
            loadNotesFromSQLite(); // <-- INJECTED HERE: Boot UI from DB
            setCloudSyncIcon('saved');
        } else {
            await initSQLite(null);
        }
    } catch (e) {
        await initSQLite(null);
    }
}

function openSettingsPage() {
    const workspace = document.getElementById('pipeline-workspace');
    const settingsView = document.getElementById('settings-view');
    const projectTabs = document.getElementById('project-tabs-bar');
    const searchContainer = document.getElementById('searchHeaderContainer');
    
    // 1. Hide the V5 workspace safely
    if (workspace) workspace.style.display = 'none';
    
    // 2. Hide any lingering old V4 elements safely (prevents the null error)
    const oldQuad = document.getElementById('quadrant-workspace');
    if (oldQuad) oldQuad.style.display = 'none';
    const oldToolbar = document.getElementById('right-toolbar');
    if (oldToolbar) oldToolbar.style.display = 'none';
    
    // 3. Prevent Settings from hiding if it was nested inside the workspace
    if (settingsView) {
        document.querySelector('.main-wrapper').appendChild(settingsView);
        settingsView.style.display = 'block';
    }

    // 4. Hide top UI elements
    if (projectTabs) projectTabs.style.display = 'none';
    if (searchContainer) searchContainer.style.visibility = 'hidden';

    // 5. Toggle Header Buttons
    const settingsBtn = document.getElementById('settingsNavBtn');
    if (settingsBtn) settingsBtn.style.display = 'none';
    const backBtn = document.getElementById('backNavBtn');
    if (backBtn) backBtn.style.display = 'inline-block';

    // 6. Load data
    if (typeof loadSettings === 'function') loadSettings();
}

function closeSettingsPage() {
    const workspace = document.getElementById('pipeline-workspace');
    const settingsView = document.getElementById('settings-view');
    const projectTabs = document.getElementById('project-tabs-bar');
    const searchContainer = document.getElementById('searchHeaderContainer');
    
    // 1. Restore the V5 workspace (Must be 'flex', not 'block')
    if (workspace) workspace.style.display = 'flex';
    
    // 2. Hide Settings
    if (settingsView) settingsView.style.display = 'none';

    // 3. Restore top UI elements
    if (projectTabs) projectTabs.style.display = 'flex';
    if (searchContainer) searchContainer.style.visibility = 'visible';

    // 4. Toggle Header Buttons
    const settingsBtn = document.getElementById('settingsNavBtn');
    if (settingsBtn) settingsBtn.style.display = 'inline-block';
    const backBtn = document.getElementById('backNavBtn');
    if (backBtn) backBtn.style.display = 'none';
    
    // 5. Force UI refresh
    if (typeof renderTrackerTimeline === 'function') renderTrackerTimeline();
}

function saveSettings() {
    const clientIdEl = document.getElementById('configClientId');
    if (clientIdEl) appConfig.clientId = clientIdEl.value.trim();
    
    const apiKeyEl = document.getElementById('configApiKey');
    if (apiKeyEl) appConfig.apiKey = apiKeyEl.value.trim();
    
    const timesheetUrlEl = document.getElementById('configTimesheetUrl');
    if (timesheetUrlEl) appConfig.timesheetUrl = timesheetUrlEl.value.trim();
    
    const ignoreEl = document.getElementById('configIgnoreKeywords');
    if (ignoreEl) appConfig.ignoreKeywords = ignoreEl.value.trim();
    
    const calSourceEl = document.getElementById('configCalSource');
    if (calSourceEl) appConfig.calSource = calSourceEl.value;
    
    const sourceSelect = document.getElementById('sourceCalendar');
    if (sourceSelect) appConfig.sourceCalendar = sourceSelect.value;
    
    const targetSelect = document.getElementById('targetCalendar');
    if (targetSelect) appConfig.targetCalendar = targetSelect.value;
    
    const importBehavior = document.querySelector('input[name="importBehavior"]:checked');
    if (importBehavior) appConfig.importBehavior = importBehavior.value;
    
    const primTz = document.getElementById('configPrimaryTz');
    if (primTz) appConfig.primaryTz = primTz.value;
    
    const secTz = document.getElementById('configSecondaryTz');
    if (secTz) appConfig.secondaryTz = secTz.value;

    localStorage.setItem('quadra_config', JSON.stringify(appConfig));
    
    const rows = document.querySelectorAll('.schedule-row');
    appSchedule = Array.from(rows).map(row => {
        const startStr = row.querySelector('.sched-start').value.split(':');
        const endStr = row.querySelector('.sched-end').value.split(':');
        let startH = parseInt(startStr[0] || 0) + (parseInt(startStr[1] || 0) / 60);
        let endH = parseInt(endStr[0] || 0) + (parseInt(endStr[1] || 0) / 60);
        if (endH <= startH) endH += 24;

        return {
            title: row.querySelector('.sched-title').value,
            startHour: roundToQuarterHour(startH),
            endHour: roundToQuarterHour(endH)
        };
    });
    localStorage.setItem('quadra_schedule', JSON.stringify(appSchedule));
    
    closeSettingsPage(); 
    showToast("Configuration saved!");
    checkConfigState();
    
    // Safe pipeline render
    const savedSearch = localStorage.getItem('quadra_search') || '';
    renderNotes(savedSearch);
}

document.addEventListener('keydown', (e) => {
    // --- 1. Global Save & Hybrid Backup Shortcut ---
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault(); // Stop default browser "Save Webpage" dialog
        executeFullSave();  // Calls LocalStorage -> FileSystem -> Google Drive
        return;
    }

    const isEditingText = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) || document.activeElement.isContentEditable;
    
    // --- 2. Rich Text Editor Shortcuts ---
    if (isEditingText) {
        // Ctrl+Alt+Shift+S : Code Block
        if ((e.ctrlKey || e.metaKey) && e.altKey && e.shiftKey && e.key.toLowerCase() === 's') {
            e.preventDefault(); insertCodeBlock(); return;
        }
        // Ctrl+Shift+X : Strikethrough
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'x' && !e.altKey) {
            e.preventDefault(); document.execCommand('strikeThrough', false, null); triggerAutoSaveInterval(); return;
        }
        // Ctrl+B : Bold
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b' && !e.shiftKey && !e.altKey) {
            e.preventDefault(); document.execCommand('bold', false, null); triggerAutoSaveInterval(); return;
        }
        // Ctrl+I : Italics
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i' && !e.shiftKey && !e.altKey) {
            e.preventDefault(); document.execCommand('italic', false, null); triggerAutoSaveInterval(); return;
        }
        // Ctrl+1 : Custom Checklist
        if (e.ctrlKey && e.key === '1' && !e.shiftKey && !e.altKey) {
            e.preventDefault(); toggleChecklistFormatting(); return; 
        }
    }

    // --- 3. App Navigation & Modals ---
    if (e.key === 'Escape') {
        const taskModal = document.getElementById('taskModal');
        const shortcutsModal = document.getElementById('shortcutsModal');
        const projectModal = document.getElementById('projectModal');

        if (taskModal && taskModal.style.display === 'flex') closeTaskModal();
        if (shortcutsModal && shortcutsModal.style.display === 'flex') closeShortcutsModal();
        if (projectModal && projectModal.style.display === 'flex') closeProjectModal();
    } else if (!isEditingText) {
        
        // --- V5 PANEL TOGGLES ---
        
        // Alt + B : Toggle Backlog
        if (e.key.toLowerCase() === 'b' && e.altKey) {
            e.preventDefault();
            toggleLeftPane();
            return;
        }
        
        // Alt + T : Toggle Timeline
        if (e.key.toLowerCase() === 't' && e.altKey) {
            e.preventDefault();
            toggleRightPane('todaysPlan');
            return;
        }

        // Alt + N : Toggle Notebook
        if (e.key.toLowerCase() === 'n' && e.altKey) {
            e.preventDefault();
            toggleRightPane('notebook');
            return;
        }

        // Check if Alt and F are pressed simultaneously
        if (e.altKey && e.key.toLowerCase() === 'f') {
            e.preventDefault(); // Prevent native browser menus
            toggleActionBoardMaximize();
        }

        // Alt + Up/Down Arrow for Project Traversal
        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            e.preventDefault();
            const unarchived = appConfig.projects.filter(p => !p.archived);
            
            if (unarchived.length > 1) {
                let currentIndex = unarchived.findIndex(p => p.visible);
                if (currentIndex === -1) currentIndex = 0;
                
                let newIndex;
                if (e.key === 'ArrowDown') {
                    newIndex = (currentIndex + 1) % unarchived.length; // Next project
                } else {
                    newIndex = (currentIndex - 1 + unarchived.length) % unarchived.length; // Previous project
                }
                
                const targetProjectId = unarchived[newIndex].id;
                appConfig.projects.forEach(p => p.visible = (p.id === targetProjectId));
                
                localStorage.setItem('quadra_config', JSON.stringify(appConfig));
                renderProjectTabs();
                handleSearch();
            }
            return;
        }
        // Shift + / : Show Shortcuts Modal
        if (e.shiftKey && (e.key === '?' || e.key === '/')) {
            e.preventDefault();
            openShortcutsModal();
        } 
        // / : Focus Search Bar
        else if (e.key === '/') {
            e.preventDefault();
            const searchInput = document.getElementById('searchInput');
            if (searchInput) {
                searchInput.focus();
                searchInput.select();
            }
        }
    }
});

function closeRightPane() {
    const paneContainer = document.getElementById('rightPane');
    const btnPlan = document.getElementById('nav-btn-todaysPlan');
    const btnNote = document.getElementById('nav-btn-notebook');
    
    paneContainer.style.display = 'none';
    btnPlan.style.background = 'transparent';
    btnPlan.style.color = '#64748b';
    btnNote.style.background = 'transparent';
    btnNote.style.color = '#64748b';

    stopTimeIndicator();
    if (!isMaximizingTransition) {
        localStorage.setItem('quadra_rightPane', 'closed');
    }
}

function initRightPaneResize(event) {
    event.preventDefault();
    event.stopPropagation();
    
    const paneEl = document.getElementById('rightPane');
    if (!paneEl) return;
    
    const startX = event.clientX;
    const startWidth = paneEl.getBoundingClientRect().width;
    document.body.style.cursor = 'col-resize';
    
    function onMouseMove(e) {
        // Since the handle is on the left edge, moving the mouse LEFT (negative deltaX) INCREASES the width
        const deltaX = startX - e.clientX; 
        const newWidth = Math.max(280, Math.min(800, Math.round(startWidth + deltaX)));
        paneEl.style.width = newWidth + 'px';
        appConfig.rightPaneWidth = newWidth + 'px';
    }
    
    function onMouseUp() {
        document.body.style.cursor = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        localStorage.setItem('quadra_config', JSON.stringify(appConfig));
        
        // Redraw timeline canvas to fit new width
        if (activeRightPane === 'todaysPlan' && typeof renderTrackerTimeline === 'function') {
            renderTrackerTimeline();
        }
    }
    
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
}

function toggleRightPane(paneId) {
    if (!isMaximizingTransition) resetActionBoardMaximize();
    const paneContainer = document.getElementById('rightPane');
    const planView = document.getElementById('todaysPlanView');
    const noteView = document.getElementById('notebookView');
    
    const btnPlan = document.getElementById('nav-btn-todaysPlan');
    const btnNote = document.getElementById('nav-btn-notebook');

    // If clicking the button of the pane that is currently open, close it
    if (activeRightPane === paneId && paneContainer.style.display !== 'none') {
        closeRightPane();
        return;
    }

    paneContainer.style.display = 'flex';
    activeRightPane = paneId;

    if (paneId === 'todaysPlan') {
        planView.style.display = 'flex';
        noteView.style.display = 'none';
        btnPlan.style.background = '#e3f2fd';
        btnPlan.style.color = '#1976d2';
        btnNote.style.background = 'transparent';
        btnNote.style.color = '#64748b';
        
        if (typeof renderTrackerTimeline === 'function') {
            setTimelineDateToToday(); // FORCE DATE TO TODAY
            renderTrackerTimeline();
            
            if (typeof startTimeIndicator === 'function') {
                startTimeIndicator();
            }            
            // SCROLL TO MIDDLE (50ms delay lets the DOM render first)
            setTimeout(scrollToCurrentTime, 50); 
        }
    } else {
        planView.style.display = 'none';
        noteView.style.display = 'flex';
        btnNote.style.background = '#e3f2fd';
        btnNote.style.color = '#1976d2';
        btnPlan.style.background = 'transparent';
        btnPlan.style.color = '#64748b';
        
        // ADDED: Stop the timer when switching to the Notebook!
        if (typeof stopTimeIndicator === 'function') {
            stopTimeIndicator(); 
        }
    }
    const rightPane = document.getElementById('rightPane');
    if (rightPane && rightPane.style.display !== 'none' && window.innerWidth <= 768) {
        // Check if backlog is open, and if so, trigger its toggle to close it
        if (typeof isLeftPaneOpen !== 'undefined' && isLeftPaneOpen) {
            toggleLeftPane(); 
        }
    }

    if (!isMaximizingTransition) {
        localStorage.setItem('quadra_rightPane', paneId);
    }
}

// ==========================================
// FILE SYSTEM ACCESS & SQLITE PERSISTENCE
// ==========================================

// --- 1. THE LOAD FUNCTION ---
async function loadLocalDatabase() {
    try {
        // Request a new file handle via picker
        [dbFileHandle] = await window.showOpenFilePicker({
            types: [{
                description: 'SQLite Database',
                accept: { 'application/octet-stream': ['.sqlite', '.db'] }
            }],
            multiple: false
        });

        // Cache the handle for future silent saves
        await saveFileHandleToCache(dbFileHandle);

        const file = await dbFileHandle.getFile();
        const buffer = await file.arrayBuffer();

        if (db) db.close();
        db = new SQL.Database(new Uint8Array(buffer));
        
        loadProjectsFromDB();
        loadNotesFromSQLite(); 
        renderProjectTabs();
        
        console.log("Database successfully loaded from local file.");
        showToast("📂 Database Loaded & Cached Successfully!");

    } catch (error) {
        if (error.name !== 'AbortError') {
            console.error("Failed to load database:", error);
            showToast("Error loading database file.");
        }
    }
}

// --- 2. THE SILENT SAVE FUNCTION ---
async function saveLocalDatabase() {
    if (!db) return;
    
    try {
        saveProjectsToDB();
        syncNotesToSQLite(); 
        
        const data = db.export(); 
        
        // 1. If we don't have an active handle in memory, try fetching it from IndexedDB cache
        if (!dbFileHandle) {
            dbFileHandle = await getCachedFileHandle();
        }

        // 2. If we found a cached handle, verify/request readwrite permission
        if (dbFileHandle) {
            const options = { mode: 'readwrite' };
            if ((await dbFileHandle.queryPermission(options)) !== 'granted') {
                if ((await dbFileHandle.requestPermission(options)) !== 'granted') {
                    // User denied permission, clear handle and force picker fallback
                    dbFileHandle = null;
                }
            }
        }

        // 3. If still no handle available, prompt the user via save picker (triggers only once)
        if (!dbFileHandle) {
            dbFileHandle = await window.showSaveFilePicker({
                suggestedName: 'quadra.sqlite',
                types: [{
                    description: 'SQLite Database',
                    accept: { 'application/octet-stream': ['.sqlite', '.db'] }
                }]
            });
            // Cache the newly picked handle for future silent saves
            await saveFileHandleToCache(dbFileHandle);
        }
        
        // 4. Silently overwrite the file handle
        const writable = await dbFileHandle.createWritable();
        await writable.write(data);
        await writable.close();
        
        console.log("Database saved silently!");
        showToast("✓ Database saved locally!");

    } catch (error) {
        if (error.name !== 'AbortError') {
            console.error("Save failed:", error);
            dbFileHandle = null; 
            showToast("❌ Save failed. Try clicking 'Load' once to re-link.");
        }
    }
}

// --- 3. MASTER SAVE EXECUTION ---
async function executeFullSave() {
    saveNotes(); // Saves UI standard state to LocalStorage
    await saveLocalDatabase(); // Flushes to local SQLite file
    
    if (isGoogleSynced && typeof uploadDatabaseToDrive === 'function') {
        await uploadDatabaseToDrive(); // Flushes to Cloud
    }
}

// --- 4. PROJECT SQLITE SYNC LOGIC ---
function loadProjectsFromDB() {
    if (!db) return;
    try {
        const res = db.exec("SELECT * FROM projects");
        if (res.length > 0) {
            const columns = res[0].columns;
            const values = res[0].values;
            
            // Map rows directly to the appConfig array
            appConfig.projects = values.map(row => {
                let proj = {};
                columns.forEach((col, index) => proj[col] = row[index]);
                proj.archived = (proj.status === 'archived');
                proj.visible = true; // Default to visible when loaded
                return proj;
            });
            localStorage.setItem('quadra_config', JSON.stringify(appConfig));
        }
    } catch (e) {
        console.error("Error loading projects from DB:", e);
    }
}

function saveProjectsToDB() {
    if (!db || !appConfig.projects) return;
    try {
        // Failsafe to ensure table exists before writing
        db.run("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT, status TEXT);");
        db.run("DELETE FROM projects");
        
        appConfig.projects.forEach(proj => {
            db.run(
                `INSERT INTO projects (id, name, status) VALUES (?, ?, ?)`,
                [proj.id, proj.name, proj.archived ? 'archived' : 'active']
            );
        });
    } catch (e) {
        console.error("Error saving projects to DB:", e);
    }
}

function toggleLeftPane() {
    if (!isMaximizingTransition) resetActionBoardMaximize();
    const paneContainer = document.getElementById('leftPane');
    const btnBacklog = document.getElementById('nav-btn-backlog');

    if (isLeftPaneOpen) {
        paneContainer.style.display = 'none';
        btnBacklog.style.background = 'transparent';
        btnBacklog.style.color = '#64748b';
        isLeftPaneOpen = false;
    } else {
        paneContainer.style.display = 'flex';
        btnBacklog.style.background = '#e3f2fd';
        btnBacklog.style.color = '#1976d2';
        isLeftPaneOpen = true;
    }
    if (typeof isLeftPaneOpen !== 'undefined' && isLeftPaneOpen && window.innerWidth <= 768) {
        closeRightPane();
    }
    if (!isMaximizingTransition) {
        localStorage.setItem('quadra_leftPane', isLeftPaneOpen ? 'open' : 'closed');
    }
}

// --- TIMEZONE ENGINE ---
function getLocalNow() {
    // FIXED: Use primaryTz instead of timezone
    let tz = (typeof appConfig !== 'undefined' && appConfig.primaryTz) ? appConfig.primaryTz : 'local';
    
    if (tz === 'local' || tz === 'none') {
        return new Date(); 
    }

    try {
        const tzString = new Date().toLocaleString('en-US', { timeZone: tz });
        return new Date(tzString);
    } catch (e) {
        return new Date(); 
    }
}

function saveTimezone() {
    // Match the exact ID from your new HTML
    const tzSelect = document.getElementById('configPrimaryTz'); 
    if (tzSelect && typeof appConfig !== 'undefined') {
        appConfig.timezone = tzSelect.value;
        if (typeof saveConfig === 'function') saveConfig();
        
        if (document.getElementById('rightPane').classList.contains('open')) {
            if (typeof renderTrackerTimeline === 'function') renderTrackerTimeline(); 
            updateTimeIndicator(); // Instantly jump line to new timezone
        }
    }
}

// Ensure the dropdown shows the correct value when the settings modal opens
function loadSettingsUI() {
    const tzSelect = document.getElementById('timezoneSelect');
    if (tzSelect) {
        tzSelect.value = appConfig.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    }
}

// --- DYNAMIC TIMELINE INDICATOR ---
function updateTimeIndicator() {
    // 1. Target the NATIVE timeline indicator and badge generated by renderTrackerTimeline
    const line = document.querySelector('.current-time-line');
    const badge = document.querySelector('.current-time-badge');

    // If the line doesn't exist (e.g., viewing a past/future date), do nothing
    if (!line) return; 

    // 2. Get times: offset for positioning, real for the text badge
    const offsetNow = getLocalNow(); 
    const realNow = new Date(); 

    const hourPx = (typeof timelineZoom !== 'undefined' ? timelineZoom : 1) * 60; 
    
    // Calculate exact position including seconds for smooth gliding
    const hoursPassed = offsetNow.getHours() + (offsetNow.getMinutes() / 60) + (offsetNow.getSeconds() / 3600);
    
    // 3. Update the UI
    line.style.top = `${hoursPassed * hourPx}px`;

    if (badge && typeof formatCurrentTimeBadge === 'function') {
        badge.innerText = formatCurrentTimeBadge(realNow);
    }
}

function startTimeIndicator() {
    updateTimeIndicator();
    if (timeIndicatorInterval) clearInterval(timeIndicatorInterval);
    
    // TICK EVERY 10 SECONDS: This forces smooth, observable movement
    timeIndicatorInterval = setInterval(updateTimeIndicator, 10000); 
}

function stopTimeIndicator() {
    if (timeIndicatorInterval) {
        clearInterval(timeIndicatorInterval);
        timeIndicatorInterval = null;
    }
}

// --- TIMELINE UTILITIES ---

function setTimelineDateToToday() {
    const planView = document.getElementById('todaysPlanView');
    if (!planView) return;
    
    // Find the date input inside the timeline header
    const dateInput = planView.querySelector('input[type="date"]');
    if (dateInput) {
        const now = getLocalNow();
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');
        
        // Only update if it's not already set to today, to prevent unnecessary re-renders
        const todayStr = `${yyyy}-${mm}-${dd}`;
        if (dateInput.value !== todayStr) {
            dateInput.value = todayStr;
        }
    }
}

function scrollToCurrentTime() {
    // FIXED: Target the scrollable container ID, not the canvas
    const scrollArea = document.getElementById('timelineScrollArea');
    if (!scrollArea) return;
    
    const now = getLocalNow();
    const hourPx = (typeof timelineZoom !== 'undefined' ? timelineZoom : 1) * 60; 
    
    // Calculate the exact pixel distance from the top
    const hoursPassed = now.getHours() + (now.getMinutes() / 60);
    const indicatorTop = hoursPassed * hourPx;
    
    // Calculate half the height of the visible container to center the line
    const containerHalfHeight = scrollArea.clientHeight / 2;
    
    // Scroll to the line, preventing negative scrolling past midnight
    scrollArea.scrollTop = Math.max(0, indicatorTop - containerHalfHeight);
}

// --- INITIALIZATION ---

// --- INITIALIZATION ---
function init() {
    // 1. Load saved config for BOTH timezone dropdowns
    const primTzSelect = document.getElementById('configPrimaryTz');
    if (primTzSelect && typeof appConfig !== 'undefined' && appConfig.primaryTz) {
        primTzSelect.value = appConfig.primaryTz;
    }

    const secTzSelect = document.getElementById('configSecondaryTz');
    if (secTzSelect && typeof appConfig !== 'undefined' && appConfig.secondaryTz) {
        secTzSelect.value = appConfig.secondaryTz;
    }

    // 2. Set the Timeline date picker to today's date immediately
    if (typeof setTimelineDateToToday === 'function') {
        setTimelineDateToToday();
    }

    // 3. Load your tasks/database 
    if (typeof loadNotes === 'function') {
        loadNotes();
    }

    // 4. Handle Right Pane UI state on refresh
    const rightPane = document.getElementById('rightPane');
    
    if (rightPane && rightPane.style.display !== 'none' && activeRightPane === 'todaysPlan') {
        if (typeof renderTrackerTimeline === 'function') {
            renderTrackerTimeline();
        }
        if (typeof startTimeIndicator === 'function') {
            startTimeIndicator();
        }
        
        // Scroll to the current time indicator after a brief delay to allow DOM painting
        setTimeout(() => {
            if (typeof scrollToCurrentTime === 'function') {
                scrollToCurrentTime();
            }
        }, 100);
    }

    // Automatically restore the cached file handle on startup
    getCachedFileHandle().then(handle => {
        if (handle) {
            dbFileHandle = handle;
            console.log("🔗 Cached local SQLite file handle restored.");
        }
    });
}

function openFileHandleDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(IDB_NAME, 1);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) {
                db.createObjectStore(IDB_STORE);
            }
        };
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

async function saveFileHandleToCache(handle) {
    try {
        const db = await openFileHandleDB();
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(handle, 'dbHandle');
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        console.error("Failed to cache file handle:", e);
    }
}

async function getCachedFileHandle() {
    try {
        const db = await openFileHandleDB();
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get('dbHandle');
        return new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    } catch (e) {
        return null;
    }
}

function toggleActionBoardMaximize() {
    const btn = document.getElementById('actionBoardMaxBtn');
    
    if (!isActionBoardMaximized) {
        // 1. We are maximizing. Lock the transition flag.
        isMaximizingTransition = true;
        
        preMaxLeftOpen = typeof isLeftPaneOpen !== 'undefined' ? isLeftPaneOpen : true;
        const rightPane = document.getElementById('rightPane');
        preMaxRightOpen = rightPane && rightPane.style.display !== 'none';
        
        // Hide both side panels (this will natively update their sidebar icons)
        if (preMaxLeftOpen) toggleLeftPane(); 
        if (preMaxRightOpen) closeRightPane(); 
        
        isActionBoardMaximized = true;
        if (btn) {
            btn.innerHTML = '🗗';
            btn.title = "Restore Panels";
            btn.style.background = '#e3f2fd';
            btn.style.color = '#1976d2';
        }
        
        isMaximizingTransition = false; // Unlock
    } else {
        // 2. We are restoring. Lock the transition flag.
        isMaximizingTransition = true;
        
        // Restore panes to their previous states
        if (preMaxLeftOpen && (!typeof isLeftPaneOpen !== 'undefined' || !isLeftPaneOpen)) toggleLeftPane();
        if (preMaxRightOpen && typeof activeRightPane !== 'undefined') toggleRightPane(activeRightPane);
        
        isActionBoardMaximized = false;
        if (btn) {
            btn.innerHTML = '⛶';
            btn.title = "Maximize Action Board";
            btn.style.background = 'transparent';
            btn.style.color = '#64748b';
        }
        
        isMaximizingTransition = false; // Unlock
    }
}

// --- INSERT BLANK TABLE ---
function insertBlankTable() {
    // Focus the editor first to ensure the table drops at the cursor position
    const editor = document.getElementById('taskInfoInput');
    editor.focus();
    
    // Define a basic 3x3 table layout
    const tableHTML = `
        <table style="width: 100%; border-collapse: collapse; margin: 10px 0;">
            <thead>
                <tr>
                    <th><br></th>
                    <th><br></th>
                    <th><br></th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td><br></td>
                    <td><br></td>
                    <td><br></td>
                </tr>
                <tr>
                    <td><br></td>
                    <td><br></td>
                    <td><br></td>
                </tr>
            </tbody>
        </table>
        <p><br></p> <!-- Adds an empty line below the table so you can type after it -->
    `;
    
    // Inject the table
    document.execCommand('insertHTML', false, tableHTML);
    
    // Trigger your existing save functionality
    triggerAutoSaveInterval();
}

// --- GET FOCUSED TABLE ELEMENT HELPER ---
function getFocusedTableElement(tagName) {
    const selection = window.getSelection();
    if (!selection.rangeCount) return null;
    
    let node = selection.anchorNode;
    // If it's a text node, grab its parent element instead
    if (node.nodeType === 3) node = node.parentNode; 
    
    return node.closest(tagName);
}

// --- ADD ROW BELOW ---
function addTableRow() {
    const tr = getFocusedTableElement('tr');
    if (!tr) {
        alert('Please click inside a table row first.');
        return;
    }
    
    const newRow = document.createElement('tr');
    const colCount = tr.cells.length;
    
    // Create the correct number of empty cells
    for (let i = 0; i < colCount; i++) {
        newRow.innerHTML += '<td><br></td>';
    }
    
    // Insert the new row immediately after the currently focused row
    tr.parentNode.insertBefore(newRow, tr.nextSibling);
    triggerAutoSaveInterval();
}

// --- ADD COLUMN TO THE RIGHT ---
function addTableCol() {
    const td = getFocusedTableElement('td') || getFocusedTableElement('th');
    const tr = getFocusedTableElement('tr');
    if (!td || !tr) {
        //alert('Please click inside a table column first.');
        return;
    }
    
    const table = tr.closest('table');
    const targetIndex = td.cellIndex + 1; // Insert to the right of the cursor
    
    // Loop through every row in the table and append a cell at the target index
    Array.from(table.rows).forEach(row => {
        const newCell = row.insertCell(targetIndex);
        newCell.innerHTML = '<br>';
    });
    
    triggerAutoSaveInterval();
}

// --- HELPER: RESET MAXIMIZE STATE ---
function resetActionBoardMaximize() {
    // Only reset if we are maximized AND not actively running the transition
    if (isActionBoardMaximized && !isMaximizingTransition) {
        isActionBoardMaximized = false;
        const btn = document.getElementById('actionBoardMaxBtn');
        if (btn) {
            btn.innerHTML = '⛶';
            btn.title = "Maximize Action Board";
            btn.style.background = 'transparent';
            btn.style.color = '#64748b';
        }
    }
}

// --- MOBILE MENU DRAWER LOGIC ---
function openMobileMenu() {
    document.getElementById('mobileDrawer').classList.add('open');
    document.getElementById('mobileDrawerOverlay').classList.add('open');
}

function closeMobileMenu() {
    document.getElementById('mobileDrawer').classList.remove('open');
    document.getElementById('mobileDrawerOverlay').classList.remove('open');
}

// --- MOBILE QUICK MOVE HANDLER ---
function quickMoveTask(taskId, targetQuadrant) {
    if (!targetQuadrant) return;
    
    const note = notes.find(n => n.id === taskId);
    if (note) {
        note.quadrant = targetQuadrant;
        note.dirty = true;
        saveNotes();
        handleSearch(); // This forces the UI to instantly refresh
        showToast(`Task moved!`);
    }
}

// --- LONG PRESS & QUICK MOVE ENGINE ---
let lpTimer = null;
let lpFired = false;
let lpStartX = 0;
let lpStartY = 0;

function startLongPress(e, noteId) {
    if (window.innerWidth > 768) return;
    lpFired = false;
    const pointer = e.touches ? e.touches[0] : e;
    lpStartX = pointer.clientX;
    lpStartY = pointer.clientY;

    lpTimer = setTimeout(() => {
        lpFired = true;
        // Trigger a tiny physical vibration on mobile phones!
        if (navigator.vibrate) navigator.vibrate(50); 
        openQuickMoveModal(noteId);
    }, 500); // 500 milliseconds = long press
}

function cancelLongPressMove(e) {
    if (!lpTimer) return;
    const pointer = e.touches ? e.touches[0] : e;
    // Cancel the long-press if the user is just scrolling the page
    if (Math.abs(pointer.clientX - lpStartX) > 10 || Math.abs(pointer.clientY - lpStartY) > 10) {
        clearTimeout(lpTimer);
        lpTimer = null;
    }
}

function cancelLongPress() {
    if (lpTimer) {
        clearTimeout(lpTimer);
        lpTimer = null;
    }
}

// Intercepts the click so the Task Modal doesn't open if you just long-pressed
function handleTaskClick(e, noteId) {
    if (lpFired) {
        e.preventDefault();
        e.stopPropagation();
        return;
    }
    openTaskModal(null, noteId, e);
}

function openQuickMoveModal(taskId) {
    document.getElementById('quickMoveTaskId').value = taskId;
    document.getElementById('quickMoveOverlay').classList.add('open');
    document.getElementById('quickMoveSheet').classList.add('open');
}

function closeQuickMoveModal() {
    document.getElementById('quickMoveOverlay').classList.remove('open');
    document.getElementById('quickMoveSheet').classList.remove('open');
}

function executeQuickMove(targetQuadrant) {
    const taskId = document.getElementById('quickMoveTaskId').value;
    const note = notes.find(n => n.id === taskId);
    
    if (note) {
        note.quadrant = targetQuadrant;
        note.dirty = true;
        saveNotes();
        handleSearch(); // Forces UI to refresh instantly
        updateTaskCounters(); // Update the numbering badges
        showToast(`Task moved!`);
    }
    closeQuickMoveModal();
}

// --- DYNAMIC TASK COUNTERS ---
function updateTaskCounters() {
    const columns = ['inbox', 'q1', 'q2', 'q3', 'q4', 'notes'];
    
    columns.forEach(col => {
        const list = document.getElementById(`list-${col}`);
        const countBadge = document.getElementById(`count-${col}`);
        
        if (list && countBadge) {
            // Count actual tasks, ignoring the "Completed" system separator
            const taskCount = Array.from(list.children).filter(child => !child.classList.contains('system-separator')).length;
            
            countBadge.textContent = taskCount;
            countBadge.style.display = taskCount === 0 ? 'none' : 'inline-flex';
        }
    });
}

// Trigger the init function as soon as the DOM is fully constructed
document.addEventListener('DOMContentLoaded', init);