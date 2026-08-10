// =====================================================================
//  SDT Admin — CDBS Balance Notes
//
//  Reads a CDBS checking report (with the balances filled in from PRODA),
//  shows you exactly what will be written, and then — once you approve —
//  writes one note into each patient's file in Principle.
//
//  Everything stays on this machine: the spreadsheet, the progress log and
//  the results file. Nothing is sent to the cloud.
// =====================================================================

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const telegram = require('./telegram.js');
// (proda engine journal wiring happens after app ready)
const path = require('path');
const fs = require('fs');
const engine = require('./principle-engine.js');
const proda = require('./proda-engine.js');
const principleCapture = require('./principle-capture.js');
const principleReport = require('./principle-report.js');

const CLINIC_SLUG = 'southside-dental-toowoomba';
const BALANCE_COLUMN = 'CDBS Available';

let mainWindow = null;
let runState = { running: false, stopRequested: false };

engine.configure({ partition: 'persist:principle-admin', slug: CLINIC_SLUG });

// ---------------------------------------------------------------------
// WINDOW
// ---------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1250,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    icon: path.join(__dirname, 'sdt-icon.png'),
    title: 'SDT Admin — CDBS Balance Notes',
    backgroundColor: '#f8fafc',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  startupFocusPatrol();
  setTimeout(() => {
    const q = loadNoteQueue();
    if (q.length) { appJournal('sending ' + q.length + ' queued note(s) from before the restart'); noteWorker(); }
  }, 20 * 1000);
  // First-boot / every-boot cloud self-test: the shared list connection
  // is verified and journalled, so an island machine names itself day one.
  setTimeout(async () => {
    try {
      const items = await fsPull(true);
      appJournal('startup shared-list check: OK - ' + items.length + ' item(s) visible');
    } catch (e) {
      appJournal('startup shared-list check: FAILED - ' + (fsHealth.lastError || String(e).slice(0, 120)) + ' - this computer cannot see or update the shared list');
    }
  }, 8000);
  // Quietly get Principle logged in shortly after boot, so the first job
  // of the day never has to rescue itself.
  setTimeout(async () => {
    try {
      const ok = await ensurePrincipleQuiet();
      appJournal('startup Principle ensure: ' + (ok ? 'ready' : 'not ready (no credentials or login failed) - pill stays amber'));
      sendStatus(ok ? 'connected' : 'needs-login');
      pillEpisode.principle = ok ? 'connected' : 'needs-login';
    } catch (e) { /* ignore */ }
  }, 25 * 1000);

  // As soon as the app is on screen, quietly find out whether Principle is
  // still logged in — so you're told now rather than halfway through a run.
  mainWindow.webContents.once('did-finish-load', () => { checkPrincipleLogin(true); });

  mainWindow.on('close', (ev) => {
    try {
      if (engineBusy()) {
        const { dialog } = require('electron');
        const pick = dialog.showMessageBoxSync(mainWindow, {
          type: 'warning', buttons: ['Keep running', 'Quit and lose the run'],
          defaultId: 0, cancelId: 0,
          message: 'A balance check or run is still working.',
          detail: 'Closing the app kills it - nothing partial is written, but the run starts over next time.',
        });
        if (pick === 0) { ev.preventDefault(); return; }
        appJournal('app closed mid-run by choice');
      }
    } catch (e) { /* let it close */ }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    // The hidden Principle/PRODA helper windows must not keep a ghost of
    // the app alive after the main window is closed — that ghost is what
    // made re-opening fail until it was end-tasked.
    appJournal('app quit (window closed)');
    try { const { BrowserWindow } = require('electron'); for (const w of BrowserWindow.getAllWindows()) { try { w.destroy(); } catch (e2) { /* going down anyway */ } } } catch (e) { /* ignore */ }
    app.quit();
  });

  // The capture windows sit in front while you work, so their menus drive the
  // recording — these keep the app window's display in step with that.
  principleCapture.setNotifier((msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('preport-event', msg);
  });
  proda.setNotifier((msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('proda-event', msg);
  });
  principleReport.setNotifier((msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('genreport-event', msg);
  });
}

// ---------------------------------------------------------------------
// RUN JOURNAL — every run writes a plain-text log beside the results so
// what actually happened is never a guess.
// ---------------------------------------------------------------------
// ---------- APP JOURNAL: the app's between-runs life ----------
function appJournal(line) {
  try {
    const f = path.join(principleCapture.reportsFolder(), 'journal__' + localToday() + '.txt');
    fs.appendFileSync(f, new Date().toTimeString().slice(0, 8) + '  ' + String(line) + '\n', 'utf8');
  } catch (e) { /* never */ }
}

// ---------- HEARTBEAT + RUN STATUS ----------
let lastBeat = { t: Date.now(), stage: 'idle' };
function beat(stage) { lastBeat = { t: Date.now(), stage: String(stage || '').slice(0, 80) }; }
let runStatus = {};    // { cdbs: {state, when, detail} }
function setRunStatus(key, state, detail) {
  runStatus[key] = { state, when: new Date().toISOString(), detail: String(detail || '').slice(0, 120) };
  sendUi('run-status', runStatus);
}
ipcMain.handle('status-get', () => runStatus);

ipcMain.handle('errors-get', () => {
  const errs = [];
  try {
    const today = localToday();
    for (const [k, v] of Object.entries(runStatus)) {
      if (v.state === 'failed' || v.state === 'jammed') {
        errs.push({ when: v.when, text: (k === 'cdbs' ? 'CDBS check' : k) + ' ' + v.state + (v.detail ? ' — ' + v.detail : '') });
      }
    }
    if (pillEpisode.principle === 'needs-login') errs.push({ when: new Date().toISOString(), text: 'Principle is signed out — auto reports are paused. Click the amber Principle pill.' });
    for (const job of loadAutoJobs().jobs) {
      if (!job.lastRun) continue;
      if (localDateOf(job.lastRun.when || '') !== today) continue;
      if (/^(failed|skipped|crashed)/.test(job.lastRun.outcome || '')) {
        errs.push({ when: job.lastRun.when, text: job.name + ': ' + job.lastRun.outcome });
      }
    }
  } catch (e) { /* partial list is fine */ }
  errs.sort((x, y) => String(y.when).localeCompare(String(x.when)));
  return { errors: errs };
});

// Everything currently wrong, in one list for the Home alerts box.
ipcMain.handle('alerts-get', () => {
  const alerts = [];
  const today = localToday();
  try {
    for (const [k, v] of Object.entries(runStatus)) {
      if (v.state === 'failed' || v.state === 'jammed') {
        alerts.push({ level: 'red', text: (k === 'cdbs' ? 'CDBS check' : k) + ' ' + v.state + (v.detail ? ' — ' + v.detail : ''), when: v.when });
      }
    }
    const jobs = loadAutoJobs().jobs;
    for (const j of jobs) {
      if (!j.enabled || !j.lastRun) continue;
      const isToday = localDateOf(j.lastRun.when || '') === today;
      if (isToday && /^(failed|skipped|crashed)/.test(j.lastRun.outcome || '')) {
        alerts.push({ level: /^failed|^crashed/.test(j.lastRun.outcome) ? 'red' : 'amber', text: j.name + ': ' + j.lastRun.outcome, when: j.lastRun.when });
      }
    }
    if (pillEpisode.principle === 'needs-login') alerts.push({ level: 'amber', text: 'Principle needs a login (click the pill)', when: new Date().toISOString() });
    // today's alarm pings from the journal
    const jf = path.join(principleCapture.reportsFolder(), 'journal__' + today + '.txt');
    if (fs.existsSync(jf)) {
      const lines = fs.readFileSync(jf, 'utf8').split('\n').filter(l => /alarm ping sent|JAM detected/.test(l));
      for (const l of lines.slice(-5)) alerts.push({ level: 'red', text: l.slice(10).trim(), when: null });
    }
  } catch (e) { /* ignore */ }
  return { alerts };
});

let runLogFile = null;
// ---- Brisbane (local) time helpers: every "what day is it" question in
// this app is answered in local time, never UTC. The PCs run Brisbane
// time, so local getters are Brisbane by construction.
function pad2(n) { return String(n).padStart(2, '0'); }
function localToday() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function localDateOf(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function localStamp() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' +
    pad2(d.getHours()) + '-' + pad2(d.getMinutes()) + '-' + pad2(d.getSeconds());
}

function runlogStart(kind) {
  const stamp = localStamp();
  runLogFile = path.join(principleCapture.reportsFolder(), `runlog__${stamp}__${kind}.txt`);
  if (kind === 'cdbs-check') {
    try {
      fs.writeFileSync(runLogFile, [
        '================= TO CLAUDE: DAILY SYSTEM AUDIT =================',
        'This is the run journal of the SDT Reception CDBS check. Please',
        'audit it and report anything unhealthy. Check specifically:',
        ' 1. SERVICE DOOR lines (the PRODA auto-login failed)',
        ' 2. TIMED OUT lines (Principle pages struggling / watchdog fires)',
        ' 3. healing attempts whose find result is NOT "1 match(es)"',
        ' 4. pin attempt groups that never reach clicked:1',
        ' 5. "action sync push failed" lines, or an "item(s) pushed" count',
        '    that looks too small for the failures in the run',
        ' 6. "code field readback" showing a wrong length (code typing drift)',
        ' 7. the download needing more than 1 "download csv press" attempt',
        ' 8. any patient failing the same way as in previous days (chronic)',
        ' 9. any error text that looks new or unusual',
        '10. auto-report sections below: each should end with "N item(s)',
        '    added" and no "failed"/"skipped" outcomes',
        'Report: what is healthy, what needs watching, what needs fixing.',
        '=================================================================',
        '',
      ].join('\n'), 'utf8');
    } catch (e) { /* ignore */ }
  }
  runlog('=== run started: ' + kind + ' ===');
}

// ---- Daily health packet: summary message + the log file to Telegram ----
function healthStatePath() { return path.join(app.getPath('userData'), 'health-state.json'); }
function loadHealthState() {
  try { return JSON.parse(fs.readFileSync(healthStatePath(), 'utf8')); } catch (e) { return {}; }
}
function saveHealthState(s) { try { fs.writeFileSync(healthStatePath(), JSON.stringify(s), 'utf8'); } catch (e) { /* ignore */ } }

function healthSummaryFromLog() {
  try {
    const t = fs.readFileSync(runLogFile, 'utf8');
    const n = (re) => (t.match(re) || []).length;
    const patients = n(/^\d\d:\d\d:\d\d  patient \d+ /gm);
    const written = n(/note write .*: WRITTEN/g);
    const retries = n(/\(attempt [23]\): WRITTEN/g);
    const healed = n(/find result: 1 match/g);
    const wFailed = n(/write-by-hand item created/g);
    const pinGroups = new Set((t.match(/pin attempt 1:/g) || [])).size ? n(/pin attempt 1:/g) : 0;
    const pinned = n(/pin attempt \d: \{"clicked":1/g);
    const doorsN = n(/SERVICE DOOR/g);
    const timeouts = n(/TIMED OUT/g);
    const pushes = (t.match(/action list: (\d+) new/) || [])[1] || '0';
    const dlExtra = n(/download csv press attempt [2-9]/g);
    return 'Health: ' + patients + ' patients · ' + written + ' notes written' +
      (retries ? ' (' + retries + ' on retry)' : '') +
      ' · ' + healed + ' healed · ' + (wFailed ? wFailed + ' write(s) failed → action list · ' : '') +
      'pins ' + pinned + '/' + pinGroups + ' · ' + pushes + ' action item(s) pushed' +
      (doorsN ? ' · SERVICE DOOR x' + doorsN : '') +
      (timeouts ? ' · TIMEOUTS x' + timeouts : '') +
      (dlExtra ? ' · download needed extra presses' : ' · download self-served');
  } catch (e) { return 'Health summary could not be computed.'; }
}

let lastAlarmAt = 0;
function alarmPing(message) {
  try {
    // One ping per distinct problem per day: repeats live in the error
    // box on Home instead, so a Telegram buzz always means something new.
    const sig = String(message).slice(0, 60);
    const today = localToday();
    const hs = loadHealthState();
    hs.alarmsSent = hs.alarmsSent || {};
    if (hs.alarmsSent[sig] === today) return;
    hs.alarmsSent[sig] = today;
    for (const k of Object.keys(hs.alarmsSent)) { if (hs.alarmsSent[k] !== today) delete hs.alarmsSent[k]; }
    saveHealthState(hs);
    if (Date.now() - lastAlarmAt < 10 * 60 * 1000) return;   // no alarm storms
    const s = loadMorningSettings();
    if (!s.telegramToken || !s.telegramChatId) return;
    lastAlarmAt = Date.now();
    telegram.send(s.telegramToken, s.telegramChatId, '⚠ ' + message);
    if (runLogFile && fs.existsSync(runLogFile)) {
      telegram.sendDocument(s.telegramToken, s.telegramChatId, runLogFile, 'Log of the run in question.');
    }
    appJournal('alarm ping sent: ' + message);
  } catch (e) { /* ignore */ }
}

async function sendHealthPacket() {
  try {
    const s = loadMorningSettings();
    if (!s.telegramToken || !s.telegramChatId || !runLogFile || !fs.existsSync(runLogFile)) return;
    const today = localToday();
    const hs = loadHealthState();
    if (hs.lastSent === today) return;                 // one packet per day
    let summary = healthSummaryFromLog();
    try {
      const jobs = loadAutoJobs().jobs.filter(j => j.lastRun && String(j.lastRun.when).slice(0, 10) === today);
      if (jobs.length) summary += '\nAuto reports: ' + jobs.map(j => j.name + ' - ' + j.lastRun.outcome).join(' · ');
    } catch (e) { /* ignore */ }
    // The dossier: every one of today's run logs in one file.
    let sendFile = runLogFile;
    try {
      const folder = principleCapture.reportsFolder();
      const todays = fs.readdirSync(folder).filter(f => (f.startsWith('runlog__' + today) || f === 'journal__' + today + '.txt')).sort();
      if (todays.length > 1) {
        const dossier = path.join(folder, 'daily-dossier__' + today + '.txt');
        fs.writeFileSync(dossier, todays.map(f =>
          '\n\n########## ' + f + ' ##########\n' + fs.readFileSync(path.join(folder, f), 'utf8')
        ).join(''), 'utf8');
        sendFile = dossier;
      }
    } catch (e) { /* single log is fine */ }
    await telegram.send(s.telegramToken, s.telegramChatId, summary);
    await telegram.sendDocument(s.telegramToken, s.telegramChatId, sendFile, 'Daily dossier - forward this file to Claude to audit the system.');
    hs.lastSent = today;
    saveHealthState(hs);
    runlog('health packet sent to Telegram');
  } catch (e) { runlog('health packet failed: ' + String(e).slice(0, 100)); }
}
function runlog(line) {
  try {
    if (!runLogFile) runlogStart('untitled');
    fs.appendFileSync(runLogFile, new Date().toTimeString().slice(0, 8) + '  ' + String(line) + '\n', 'utf8');
  } catch (e) { /* never let logging break a run */ }
}
ipcMain.handle('open-run-log', () => {
  if (runLogFile && fs.existsSync(runLogFile)) { shell.openPath(runLogFile); return { ok: true }; }
  return { ok: false, error: 'No run log yet this session.' };
});

function sendUi(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---------------------------------------------------------------------
// THE DESK CODE RACE
//
// When PRODA wants its 6-digit code during a desk-triggered run, nothing
// mechanical is shown: a code box appears in the app AND (if Telegram is
// set up) the phone gets a ping — whichever supplies the code first wins.
// ---------------------------------------------------------------------
let deskCode = { resolve: null };

ipcMain.handle('supply-code', (e, code) => {
  if (String(code) === '__cancel__') {
    if (deskCode.settle) deskCode.settle({ ok: false, reason: 'cancelled' });
    else if (deskCode.resolve) { const r = deskCode.resolve; deskCode.resolve = null; r({ ok: false, reason: 'cancelled' }); }
    return { ok: true };
  }
  const m = String(code || '').replace(/\D/g, '').match(/\d{6}/);
  if (!m) return { ok: false, error: 'Six digits are needed.' };
  if (deskCode.resolve) {
    // Through settle ALWAYS: it clears the watchers and un-freezes the
    // automation windows - the direct-resolve shortcut here left PRODA
    // unfocusable after a desk-typed code, wedging every check after it.
    if (deskCode.settle) deskCode.settle({ ok: true, code: m[0] });
    else { const r = deskCode.resolve; deskCode.resolve = null; r({ ok: true, code: m[0] }); }
    return { ok: true };
  }
  return { ok: false, error: 'Nothing is waiting for a code right now.' };
});

function reclaimTyping() {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const fw = BrowserWindow.getFocusedWindow();
    // fw === null means another APP has focus - leave the user alone.
    // fw === one of our hidden/offscreen windows means the keyboard has
    // been stolen by a window nobody can see - take it back.
    if (fw && fw !== mainWindow && mainWindow.isVisible()) {
      mainWindow.focus();
      mainWindow.webContents.focus();
    } else if (fw === mainWindow) {
      mainWindow.webContents.focus();
    }
  } catch (e) { /* ignore */ }
}

// Boot patrol: window creation during startup routinely steals the
// keyboard - keep taking it back through the settling period.
function startupFocusPatrol() {
  for (const ms of [1500, 4000, 8000, 15000, 25000, 40000]) {
    setTimeout(reclaimTyping, ms);
  }
}

function sirenOn() {
  try {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.flashFrame(true);
  } catch (e) { /* ignore */ }
}
function sirenOff() { try { if (mainWindow) mainWindow.flashFrame(false); } catch (e) {} }

function askDeskForCode() {
  sirenOn();
  sendUi('proda-light', { state: 'code' });
  // Keyboard back to the human: the auto-login was just typing into the
  // off-screen PRODA window, which holds OS focus - without this, the box
  // shows but keystrokes vanish into the hidden window.
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.focus();
    }
  } catch (eF) { /* focus is best-effort */ }
  const s = loadMorningSettings();
  const phone = !!(s.telegramToken && s.telegramChatId);
  if (phone) {
    telegram.send(s.telegramToken, s.telegramChatId, 'PRODA code? Reply with the 6 digits (or type it into the app at the desk).');
  }
  // Disarm the focus thieves: every window except the app itself becomes
  // unfocusable for the duration of the wait (PRODA's page transitions were
  // grabbing the keyboard for ~30s after the box appeared).
  const frozenWins = [];
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w !== mainWindow && !w.isDestroyed()) {
        try { w.setFocusable(false); frozenWins.push(w); } catch (e1) { /* skip */ }
      }
    }
  } catch (e0) { /* best effort */ }
  return new Promise((resolve) => {
    deskCode.resolve = resolve;
    let stopWatch = null;
    let focusGuard = null;
    const settle = (r) => {
      if (deskCode.resolve) {
        deskCode.resolve = null;
        deskCode.settle = null;
        if (stopWatch) clearInterval(stopWatch);
        if (focusGuard) clearInterval(focusGuard);
        for (const w of frozenWins) { try { if (!w.isDestroyed()) w.setFocusable(true); } catch (e2) { /* gone */ } }
        sirenOff();
        resolve(r);
      }
    };
    deskCode.settle = settle;
    // Belt: if the keyboard still wanders to one of our windows, pull it
    // back every 2s (never steals from other apps the human switched to).
    focusGuard = setInterval(() => {
      try {
        const f = BrowserWindow.getFocusedWindow();
        if (f && f !== mainWindow && deskCode.resolve) mainWindow.focus();
      } catch (e3) { /* next beat */ }
    }, 2000);
    // Stop safely must reach even this wait: watch the stop flags and
    // abandon the code ask the moment anyone pulls the cord.
    stopWatch = setInterval(() => {
      if (runAllState.stopRequested || runState.stopRequested || collectState.stopRequested ||
          balanceState.stopRequested || morningState.stopRequested) {
        runlog('code ask abandoned: stop was pressed');
        sendUi('proda-light', { state: 'down' });
        settle({ ok: false, cancelled: true });
      }
    }, 1000);
    if (phone) {
      telegram.waitForCode(s.telegramToken, s.telegramChatId, 10 * 60 * 1000, () => !deskCode.resolve)
        .then((r) => { if (r.ok) settle(r); });
    }
    // No timeout otherwise: a human is at the desk, and Cancel or Stop
    // are the escape hatches.
  });
}

function sendStatus(status, detail) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('login-status', { status, detail });
  }
}

// Checks the Principle login. If we're signed out and openIfNeeded is true,
// the login page is brought up straight away and watched until it succeeds.
async function checkPrincipleLogin(openIfNeeded) {
  sendStatus('checking');
  const res = await engine.checkLoggedIn();
  if (res.ok) {
    sendStatus('connected');
    return true;
  }
  sendStatus('needs-login');
  if (openIfNeeded) {
    await engine.promptLogin();
    sendStatus('logging-in');
    engine.watchForLogin((success) => {
      sendStatus(success ? 'connected' : 'needs-login');
    });
  }
  return false;
}

// ---------------------------------------------------------------------
// CSV PARSING (handles quoted fields, commas inside quotes, CRLF, BOM)
// ---------------------------------------------------------------------
function csvToRows(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);  // strip Excel's BOM
  const rows = [];
  let row = [], cell = '', inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (ch === '"') {
      if (inQuotes && next === '"') { cell += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      row.push(cell); cell = '';
    } else if ((ch === '\n' || (ch === '\r' && next === '\n')) && !inQuotes) {
      if (ch === '\r') i++;
      row.push(cell); cell = '';
      if (row.some(c => c.trim() !== '')) rows.push(row);
      row = [];
    } else if (ch !== '\r' || inQuotes) {
      cell += ch;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    if (row.some(c => c.trim() !== '')) rows.push(row);
  }
  return rows;
}

function rowsToObjects(rows) {
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim().replace(/^"|"$/g, ''));
  return rows.slice(1).map(r => {
    const o = {};
    headers.forEach((h, i) => { o[h] = (r[i] || '').trim(); });
    return o;
  });
}

// Pull the patient ID out of the Appointment Link column.
// e.g. /southside-dental-toowoomba/patients/ABC123/appointments/XYZ/treatment-planning
function patientIdFromLink(link) {
  if (!link) return null;
  const m = String(link).match(/\/patients\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

function appointmentIdFromLink(link) {
  if (!link) return null;
  const m = String(link).match(/\/appointments\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

// Numbers are tidied to $0.00 form; anything else passes through word for word.
function formatBalance(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const numeric = text.replace(/[$,\s]/g, '');
  if (numeric !== '' && !isNaN(Number(numeric))) {
    return '$' + Number(numeric).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return text;
}

function todayAU() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// The note keeps the "CDBS balance:" prefix so every one of them can be
// found later by searching, then reproduces the cell EXACTLY as entered —
// including anything pasted straight out of PRODA (card number, name, date),
// which is deliberate: it leaves a full record of what was actually checked.
//
// The "(checked in PRODA ...)" stamp is only added when the cell doesn't
// already contain a date of its own, so a pasted PRODA line doesn't end up
// with two dates on it.
function buildNote(balanceText, who) {
  // House format when the ingredients are all present:
  //   "2581501043 5, Allira, has an available balance of $1158.00 as at 24/07/2026."
  const m = String(balanceText).match(/available balance of \$?\s?([\d,]+(?:\.\d{1,2})?)(?:\s+as at\s+(\d{1,2}\/\d{1,2}\/\d{4}))?/i);
  if (who && who.number && who.first && m) {
    const amt = Number(String(m[1]).replace(/,/g, '')).toFixed(2);
    const when = m[2] || todayAU();
    return `${who.number}${who.irn ? ' ' + who.irn : ''}, ${who.first}, has an available balance of $${amt} as at ${when}.`;
  }
  const hasOwnDate = /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(String(balanceText));
  return hasOwnDate
    ? `CDBS balance: ${balanceText}`
    : `CDBS balance: ${balanceText} (checked in PRODA ${todayAU()}).`;
}
function firstNameOf(fullName) {
  const nick = String(fullName).match(/\(([^)]+)\)/);
  if (nick && nick[1].trim()) return nick[1].trim();
  return (String(fullName).trim().split(/\s+/)[0] || '').replace(/,$/, '');
}

// ---------------------------------------------------------------------
// SORTING PRODA'S ANSWERS
//
// PRODA says one of three things, and each is handled differently:
//   - "...available balance of $X as at date"  -> the normal balance note
//   - "...not eligible..."                     -> a short clean note
//   - "invalid entry..."                       -> NO note; the details were
//     rejected, so it goes in the not-successful pile to be fixed by hand
// Anything else is unrecognised and never becomes a note by itself.
// The scraped text always drags form labels along ("Individual reference
// number *" and friends) — classification looks through the debris.
// ---------------------------------------------------------------------
function classifyProda(raw) {
  const text = String(raw || '').trim();
  if (!text) return { kind: 'empty' };
  // Live PRODA says "...has an available balance of $777." — no date.
  // Older wording carried "as at DD/MM/YYYY", so the date is optional.
  const bal = text.match(/available balance of \$?\s?([\d,]+(?:\.\d{1,2})?)(?:\s+as at\s+(\d{1,2}\/\d{1,2}\/\d{4}))?/i);
  if (bal) {
    const amount = '$' + Number(bal[1].replace(/,/g, '')).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return { kind: 'balance', value: bal[2] ? amount + ' as at ' + bal[2] : amount };
  }
  if (/not eligible/i.test(text)) return { kind: 'not-eligible' };
  if (/invalid entry/i.test(text)) return { kind: 'invalid' };
  const numeric = text.replace(/[$,\s]/g, '');
  if (numeric !== '' && !isNaN(Number(numeric))) {
    return { kind: 'balance', value: '$' + Number(numeric).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) };
  }
  return { kind: 'other', text };
}

function notEligibleNote() {
  return `Patient not eligible for CDBS (checked ${todayAU()}).`;
}

const INVALID_SKIP = 'PRODA rejected the details — check the Medicare number, IRN and name against the card';

// ---------------------------------------------------------------------
// THE SORTED SUMMARY (print-ready PDF)
//
// After every finished run, the patients get sorted into the piles the
// front desk actually works from, soonest appointment first:
//   1. Low balance (under $100, including $0) — fee conversation needed
//   2. Not eligible — same conversation, different reason
//   3. To fix — no result came back; each row carries its exact reason
//   4. Fine — healthy balances, listed for completeness
// ---------------------------------------------------------------------
const LOW_BALANCE_DOLLARS = 100;

// Failures are remembered so the "to fix" list can show how long each one
// has been outstanding — and so the day a patient comes good, their row can
// say so. Success clears the failure memory automatically.
function updateFailureMemory(items) {
  const st = loadPatientState();
  const now = new Date().toISOString();
  for (const it of items) {
    if (!it.patientId) continue;
    const e = st[it.patientId] || {};
    e.name = it.name || e.name;
    if (it.balance) {
      if (e.firstFailedAt) e.wasFixed = true;      // graduated today
      delete e.firstFailedAt;
      delete e.lastFailReason;
      delete e.failCount;
      delete e.lastAttemptAt;
    } else if (it.skip && !/unchanged/i.test(it.skip)) {
      if (!e.firstFailedAt) e.firstFailedAt = now;
      e.lastFailReason = it.skip;
      if (!/chronic fail/i.test(it.skip)) { e.failCount = (e.failCount || 0) + 1; e.lastAttemptAt = now; }
    }
    st[it.patientId] = e;
  }
  savePatientState(st);
  return st;
}

function clearWasFixedFlags(st) {
  let touched = false;
  for (const id of Object.keys(st)) {
    if (st[id] && st[id].wasFixed) { delete st[id].wasFixed; touched = true; }
  }
  if (touched) savePatientState(st);
}

function amountOfBalance(balance) {
  const m = String(balance || '').match(/\$\s?([\d,]+(?:\.\d{1,2})?)/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

function buildSortedBuckets(items, st) {
  st = st || {};
  const low = [], notEligible = [], fix = [], fine = [], unaccounted = [];
  let unchanged = 0;
  for (const it of items) {
    const amt = amountOfBalance(it.balance);
    const isNews = !it.skip;                       // a note goes in this run
    const wasFixed = !!(it.patientId && st[it.patientId] && st[it.patientId].wasFixed);
    const tagged = wasFixed ? { ...it, fixedTag: true } : it;

    if (it.skip && /unchanged/i.test(it.skip)) { unchanged++; continue; }   // old news
    if (isNews && it.balance === 'Not eligible') notEligible.push(tagged);
    else if (isNews && amt != null && amt < LOW_BALANCE_DOLLARS) low.push(tagged);
    else if (isNews && amt != null) fine.push(tagged);
    else if (it.skip) {
      const e = it.patientId ? st[it.patientId] : null;
      const age = e && e.firstFailedAt ? Math.max(0, Math.round(daysSince(e.firstFailedAt))) : null;
      fix.push({ ...it, failAge: age });
    }
    // The safety net: NOBODY falls through unseen. A row landing in no
    // bucket above is a patient the pipeline lost track of - flagged.
    else unaccounted.push(tagged);
  }
  const key = it => { const d = parseReportDate(it.appointmentDate); return d ? d.getTime() : 9e15; };
  const update = items.filter(it => it.healed && it.foundNumber);
  for (const arr of [low, notEligible, fix, fine, update, unaccounted]) arr.sort((a, b) => key(a) - key(b));
  return { low, notEligible, fix, fine, unchanged, update, unaccounted };
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sortedReportHtml(buckets) {
  const tag = r => r.fixedTag ? ' <span class="fixed">was in to-fix</span>' : '';
  const ageOf = r => r.failAge == null ? '—'
    : r.failAge === 0 ? 'today' : r.failAge === 1 ? 'yesterday' : r.failAge + ' days ago';
  const section = (title, rows, third, note, extraCol) => `
    <h2>${title} <span class="count">${rows.length}</span></h2>
    ${note ? `<p class="note">${note}</p>` : ''}
    ${rows.length ? `<table>
      <tr><th>Patient</th><th>Appointment</th><th>${third}</th>${extraCol ? '<th>First flagged</th>' : ''}</tr>
      ${rows.map(r => `<tr>
        <td>${escapeHtml(r.name)}${tag(r)}</td>
        <td>${escapeHtml(r.appointmentDate || '—')}</td>
        <td>${escapeHtml(third === 'Reason' ? (r.skip || '—') : (r.balance || '—'))}</td>
        ${extraCol ? `<td>${ageOf(r)}</td>` : ''}
      </tr>`).join('')}
    </table>` : '<p class="none">None today.</p>'}`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font-family: 'Segoe UI', Arial, sans-serif; color: #1a1a1a; margin: 28px 34px; font-size: 12px; }
    h1 { color: #2F6B4F; font-size: 20px; margin-bottom: 2px; }
    .sub { color: #666; margin-bottom: 6px; }
    .quiet { color: #666; margin-bottom: 16px; font-size: 11px; }
    h2 { color: #2F6B4F; font-size: 14px; border-bottom: 2px solid #2F6B4F; padding-bottom: 3px; margin: 22px 0 6px; }
    .count { float: right; background: #2F6B4F; color: #fff; border-radius: 10px; padding: 1px 9px; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; color: #555; font-weight: 600; padding: 4px 6px; border-bottom: 1px solid #ccc; }
    td { padding: 4px 6px; border-bottom: 1px solid #eee; }
    .note { color: #666; margin: 2px 0 6px; font-size: 11px; }
    .none { color: #888; }
    .fixed { background: #e8f2ed; color: #2F6B4F; border-radius: 4px; padding: 0 5px; font-size: 10px; }
    tr { page-break-inside: avoid; }
  </style></head><body>
    <h1>CDBS Summary — ${todayAU()}</h1>
    <div class="sub">Southside Dental Toowoomba · new items only, soonest appointment first</div>
    <div class="quiet">${buckets.unchanged} patient${buckets.unchanged === 1 ? '' : 's'} unchanged since their last note — not listed, nothing to do.</div>
    ${section('New — low balance (under $' + LOW_BALANCE_DOLLARS + ')', buckets.low, 'Balance', 'A conversation about fees may be needed before the visit. Once a patient is rung, they will not reappear unless their balance changes (or after the 14-day refresh).')}
    ${(buckets.unaccounted && buckets.unaccounted.length) ? section('⚠ NOT ACCOUNTED FOR — the safety net caught these', buckets.unaccounted, 'Reason', 'The morning run could not place these patients in any outcome. Each is flagged on the action list — investigate today.') : ''}
    ${section('New — not eligible for CDBS', buckets.notEligible, 'Balance')}
    ${(buckets.update && buckets.update.length) ? `
      <h2>Card details found in PRODA — please update Principle <span class="count">${buckets.update.length}</span></h2>
      <p class="note">Their balance was checked fine using the found details, but Principle's Medicare tab still holds the old ones.</p>
      <table><tr><th>Patient</th><th>Medicare number</th><th>IRN</th><th>Expiry</th></tr>
      ${buckets.update.map(r => `<tr><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.foundNumber)}</td><td>${escapeHtml(r.foundIrn)}</td><td>${escapeHtml(r.foundExpiry)}</td></tr>`).join('')}
      </table>` : ''}
    ${section('Still to fix — repeats daily until sorted', buckets.fix, 'Reason', 'Check these in Principle against the physical Medicare card. Fixed patients graduate off this list by themselves on the next run.', true)}
    ${section('Newly checked — fine', buckets.fine, 'Balance')}
  </body></html>`;
}

async function writeSortedPdf(items, st) {
  const buckets = buildSortedBuckets(items, st);
  const html = sortedReportHtml(buckets);
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const pdf = await w.webContents.printToPDF({ pageSize: 'A4', printBackground: true });
    const stamp = localStamp();
    const file = path.join(principleCapture.reportsFolder(), `sorted-summary__${stamp}.pdf`);
    fs.writeFileSync(file, pdf);
    return { file, buckets, counts: { low: buckets.low.length, notEligible: buckets.notEligible.length, fix: buckets.fix.length, fine: buckets.fine.length, unchanged: buckets.unchanged, unaccounted: (buckets.unaccounted || []).length } };
  } finally {
    try { w.destroy(); } catch (e) { /* ignore */ }
  }
}


// ---------------------------------------------------------------------
// REPORT WINDOW FILTER
//
// The CDBS checking report is saved in Principle with its dates on "This
// Year" (typing into Angular's date boxes proved unreliable), so the app
// trims the rows down to today + the next 14 days here instead. A row
// whose date can't be read is KEPT — an unnecessary check is a small
// price; silently missing a patient before their visit is not.
// ---------------------------------------------------------------------
const REPORT_WINDOW_DAYS = 14;

function parseReportDate(dateStr) {
  const m = String(dateStr || '').match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (!m) return null;
  let y = Number(m[3]); if (y < 100) y += 2000;
  const d = new Date(y, Number(m[2]) - 1, Number(m[1]));
  return isNaN(d.getTime()) ? null : d;
}

function filterToWindow(objects, days) {
  if (!objects.length) return objects;
  const headers = Object.keys(objects[0]);
  const dateKey = headers.find(h => /appointment date/i.test(h))
    || headers.find(h => /date/i.test(h));
  if (!dateKey) return objects;                    // no date column — keep all

  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime()); end.setDate(end.getDate() + (Number(days) || REPORT_WINDOW_DAYS));
  end.setHours(23, 59, 59, 999);

  return objects.filter(o => {
    const d = parseReportDate(o[dateKey]);
    if (!d) return true;                           // unreadable date — keep
    return d >= start && d <= end;
  });
}

// ---------------------------------------------------------------------
// PREVIEW: work out exactly what would happen, without doing anything
// ---------------------------------------------------------------------
function buildPreview(objects) {
  const headers = objects.length ? Object.keys(objects[0]) : [];

  const balanceKey = headers.find(h => h.toLowerCase() === BALANCE_COLUMN.toLowerCase())
    || headers.find(h => /avail|balance|cdbs/i.test(h));

  // Different Principle reports name the link column differently
  // ("Appointment Link" on the CDBS checking report, "Patient Link" on the
  // Medicare card report), so accept any column that holds a patient link.
  const linkKey = headers.find(h => /link/i.test(h) && objects.some(o => /\/patients\//.test(o[h] || '')))
    || headers.find(h => /link/i.test(h));

  // Same for the name and date columns, which also vary between reports.
  const nameKey = headers.find(h => /^patient name$/i.test(h))
    || headers.find(h => /name/i.test(h) && !/practitioner|clinician|provider/i.test(h));
  const dateKey = headers.find(h => /appointment date/i.test(h))
    || headers.find(h => /date/i.test(h));

  const numKey = headers.find(h => /medicare card number|medicare number/i.test(h));
  const irnKey = headers.find(h => /^irn$/i.test(h));
  const items = objects.map((o, idx) => {
    const name = (nameKey ? o[nameKey] : '') || '';
    const who = { number: numKey ? String(o[numKey] || '').replace(/\D/g, '') : '', irn: irnKey ? String(o[irnKey] || '').trim() : '', first: firstNameOf(name) };
    const link = (linkKey ? o[linkKey] : '') || '';
    const patientId = patientIdFromLink(link);
    const dobKey = headers.find(h => /birth|dob/i.test(h));
    const rawBalance = balanceKey ? o[balanceKey] : '';
    const cls = classifyProda(rawBalance);

    let balance = null;
    let note = '';
    if (cls.kind === 'balance') { balance = cls.value; note = buildNote(balance, who); }
    else if (cls.kind === 'not-eligible') { balance = 'Not eligible'; note = notEligibleNote(); }
    else if (cls.kind === 'other') {
      // A hand-filled cell that isn't a recognised PRODA answer — kept
      // exactly as entered, the original behaviour for manual sheets.
      balance = cls.text; note = buildNote(cls.text, who);
    }

    let skip = null;
    if (!patientId) skip = linkKey
      ? `The "${linkKey}" cell has no patient link in it`
      : 'No link column found in this file — cannot identify the patient';
    else if (cls.kind === 'invalid') skip = INVALID_SKIP;
    else if (cls.kind === 'empty') skip = 'Balance cell is empty';

    return {
      rowNumber: idx + 2,               // +2 so it matches the spreadsheet row
      name,
      dob: (dobKey ? o[dobKey] : '') || '',
      appointmentDate: (dateKey ? o[dateKey] : '') || '',
      patientId,
      appointmentId: appointmentIdFromLink(link),
      balanceRaw: rawBalance,
      balance,
      note,
      skip,
      status: skip ? 'skipped' : 'ready',
    };
  });

  return {
    balanceColumnFound: !!balanceKey,
    balanceColumnName: balanceKey || null,
    expectedColumnName: BALANCE_COLUMN,
    linkColumnName: linkKey || null,
    nameColumnName: nameKey || null,
    dateColumnName: dateKey || null,
    headers,
    items,
    readyCount: items.filter(i => !i.skip).length,
    skipCount: items.filter(i => i.skip).length,
  };
}

// ---------------------------------------------------------------------
// RESUME LOG: remembers which rows already had a note written, so a crash
// or a stop never causes a note to be written twice.
// ---------------------------------------------------------------------
function logPath() {
  return path.join(app.getPath('userData'), 'cdbs-completed.json');
}

function clearCompletedHistory() {
  try { if (fs.existsSync(completedPath())) fs.unlinkSync(completedPath()); } catch (e) { /* ignore */ }
}

function loadCompleted() {
  try {
    if (fs.existsSync(logPath())) return JSON.parse(fs.readFileSync(logPath(), 'utf8'));
  } catch (e) { /* ignore */ }
  return {};
}

function markCompleted(key, entry) {
  const all = loadCompleted();
  all[key] = entry;
  try { fs.writeFileSync(logPath(), JSON.stringify(all, null, 2), 'utf8'); } catch (e) { /* ignore */ }
}

// A row is identified by patient + the exact note, so re-running the same
// sheet skips what's done, but a genuinely new balance is still written.
function rowKey(item) {
  return `${item.patientId}::${item.note}`;
}

// ---------------------------------------------------------------------
// RESULTS FILE: a plain record of what was written, for your own audit
// ---------------------------------------------------------------------
function writeResultsCsv(results) {
  const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = [
    ['Row', 'Patient Name', 'Patient ID', 'Appointment Date', 'Balance', 'Note Written', 'Result', 'Detail', 'When']
      .map(esc).join(','),
    ...results.map(r => [
      r.rowNumber, r.name, r.patientId, r.appointmentDate, r.balance,
      r.status === 'done' ? r.note : '', r.status, r.detail || '', r.when || ''
    ].map(esc).join(',')),
  ];
  const p = new Date();
  const stamp = `${p.getFullYear()}-${String(p.getMonth() + 1).padStart(2, '0')}-${String(p.getDate()).padStart(2, '0')}_${String(p.getHours()).padStart(2, '0')}${String(p.getMinutes()).padStart(2, '0')}`;
  const file = path.join(app.getPath('documents'), `CDBS-notes-results-${stamp}.csv`);
  fs.writeFileSync(file, lines.join('\r\n'), 'utf8');
  return file;
}

// Plain-English reasons, so a failure is actionable rather than cryptic.
function reasonText(reason, detail) {
  switch (reason) {
    case 'not-logged-in': return 'Not logged in to Principle';
    case 'name-mismatch': return `Name on the patient file does not match the sheet (${(detail && detail.expected) || ''})`;
    case 'page-not-ready': return 'Principle did not finish loading in time';
    case 'automation-failed': return `Could not write the note (${(detail && detail.step) || 'unknown step'})`;
    case 'automation-error': return 'Something went wrong driving Principle';
    case 'no-save-confirmation': return 'Note typed but the save was not confirmed';
    case 'load-failed': return 'Could not open the patient file';
    case 'no-window': return 'Principle window could not be opened';
    default: return reason || 'Unknown problem';
  }
}

// ---------------------------------------------------------------------
// THE RUN
// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// PIN THE FRESH NOTE, UNPIN THE OLD ONE
//
// From the 29 Jul recording: every note card carries a button.pinned-icon
// whose icon text is the state — bookmark_border (unpinned) / bookmark
// (pinned). Only notes matching our own CDBS wording are ever unpinned.
// ---------------------------------------------------------------------
function pinScript(noteSnippet, mode) {
  return `(() => {
    const snippet = ${JSON.stringify(String(noteSnippet))};
    const isCdbs = t => /CDBS balance:|not eligible for CDBS/i.test(t || '');
    const out = { clicked: 0, seen: 0, census: [] };
    for (const btn of document.querySelectorAll('button.pinned-icon')) {
      out.seen++;
      const icon = (btn.textContent || '').trim();
      // Climb to the real note card: the nearest ancestor whose text is
      // note-sized (not a button strip, not the whole page).
      let card = null, node = btn;
      for (let d = 0; d < 8 && node; d++) {
        node = node.parentElement;
        const t = node ? (node.innerText || '') : '';
        if (t.length > 30 && t.length < 1600) card = { el: node, text: t };
        if (t.length >= 1600) break;
      }
      const text = card ? card.text : '';
      const mine = text.includes(snippet);
      out.census.push({ icon: icon.slice(0, 24), mine, cdbs: isCdbs(text) });
      if (${mode === 'pin' ? 'true' : 'false'}) {
        // Always-pin rule: our fresh note is the newest CDBS note on the
        // timeline. Any unpinned (border) bookmark on a CDBS note gets
        // clicked — preferring the one whose text matches, but never
        // letting the match veto the pin.
        if (/border/.test(icon) && (mine || isCdbs(text))) { btn.click(); out.clicked++; return out; }
      } else {
        if (icon === 'bookmark' && isCdbs(text) && !mine) { btn.click(); out.clicked++; return out; }
      }
    }
    return out;
  })()`;
}

let pinAudit = { written: 0, pinned: 0, failed: [] };

async function pinFreshNote(patientId, noteText, patientName) {
  pinAudit.written++;
  try {
    const win = BrowserWindow.getAllWindows().find(w =>
      !w.isDestroyed() && w.webContents.getURL().includes(patientId));
    if (!win) { runlog('  pin: patient window not found — PIN FAILED'); pinAudit.failed.push(patientName || patientId); return; }
    const snippet = String(noteText).slice(0, 40);
    // Patience: slow timelines can take 15-20s to render the fresh note.
    for (let attempt = 1; attempt <= 12; attempt++) {
      const pin = await win.webContents.executeJavaScript(pinScript(snippet, 'pin'), true);
      runlog('  pin attempt ' + attempt + ': ' + JSON.stringify(pin).slice(0, 220));
      if (pin && pin.clicked) {
        // Verify it actually went solid.
        await new Promise(r => setTimeout(r, 900));
        const after = await win.webContents.executeJavaScript(pinScript(snippet, 'verify'), true);
        const solid = after && after.census && after.census.some(c => c.icon === 'bookmark' && (c.mine || c.cdbs));
        if (solid) { pinAudit.pinned++; runlog('  pin verified solid'); return; }
        runlog('  pin click did not stick - trying again');
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    runlog('  PIN FAILED after 12 attempts for "' + (patientName || patientId) + '"');
    pinAudit.failed.push(patientName || patientId);
  } catch (e) {
    runlog('  pin failed (non-fatal): ' + String(e).slice(0, 120));
    pinAudit.failed.push(patientName || patientId);
  }
}

// Every write that fails all its attempts becomes an Action item carrying
// the ready-made note text — and clears itself the day a write succeeds.
function actionWriteFailed(item) {
  try {
    const a = loadActions();
    const exists = a.items.some(x => !x.doneAt && x.kind === 'write-note' && x.patientId === item.patientId);
    if (exists) return;
    const it = {
      id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6),
      patientId: item.patientId, name: item.name, kind: 'write-note', section: 'CDBS',
      text: 'Write note by hand - automation failed', context: item.note || '',
      token: 'write', createdAt: new Date().toISOString(),
    };
    a.items.push(it);
    saveActions(a);
    fsPush(it);
    runlog('  action: write-by-hand item created for "' + item.name + '"');
  } catch (e) { /* never break the run */ }
}
function actionWriteSucceeded(patientId) {
  try {
    const a = loadActions();
    let hit = false;
    for (const it of a.items) {
      if (!it.doneAt && it.kind === 'write-note' && it.patientId === patientId) {
        it.doneAt = new Date().toISOString();
        it.doneNote = 'cleared automatically: note written';
        it.auto = true; hit = true;
        fsPush(it);
      }
    }
    if (hit) saveActions(a);
  } catch (e) { /* ignore */ }
}

async function runNotes(items) {
  runState = { running: true, stopRequested: false };
  const completed = loadCompleted();
  const results = [];
  // Transient failures get ONE automatic second attempt — queued at the
  // back, so Principle has time to compose itself before the retry.
  const attempts = {};
  const queue = [...items];

  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };

  // Confirm the login BEFORE touching the first patient, so a signed-out
  // session doesn't produce a screen full of identical failures.
  const login = await engine.checkLoggedIn();
  if (!login.ok) {
    runState.running = false;
    sendStatus('needs-login');
    await engine.promptLogin();
    sendStatus('logging-in');
    engine.watchForLogin((success) => sendStatus(success ? 'connected' : 'needs-login'));
    send('run-finished', {
      stopped: true,
      message: 'You are not logged in to Principle. The login page has been opened — sign in, then press "Write these notes" again. Nothing was written.',
      results: [],
    });
    return;
  }
  sendStatus('connected');

  for (let i = 0; i < queue.length; i++) {
    if (runState.stopRequested) break;
    const item = queue[i];
    const attemptNo = (attempts[item.rowNumber] = (attempts[item.rowNumber] || 0) + 1);

    send('run-progress', { index: i, total: queue.length, rowNumber: item.rowNumber, status: 'working' });

    // Already written earlier? Don't write it twice.
    const key = rowKey(item);
    if (completed[key]) {
      const r = { ...item, status: 'already-done', detail: `Written earlier on ${completed[key].when}`, when: completed[key].when };
      results.push(r);
      send('run-progress', { index: i, total: items.length, rowNumber: item.rowNumber, status: 'already-done', detail: r.detail });
      continue;
    }

    const res = await engine.addNoteToPatient(item.patientId, item.note, item.name);
    const when = new Date().toLocaleString('en-AU');

    runlog('note write "' + item.name + '" (attempt ' + attemptNo + '): ' + (res.ok ? 'WRITTEN' : ('failed: ' + (res.reason || 'unknown'))));
    if (!res.ok && attemptNo < 3) {
      queue.push(item);                       // more goes, from the back
      send('run-progress', { index: i, total: queue.length, rowNumber: item.rowNumber, status: 'failed', detail: 'Will retry at the end' });
      await new Promise(r => setTimeout(r, 800));
      continue;
    }
    if (res.ok && attemptNo > 1) {
      // Replace the earlier failed narrative cleanly in the results.
      const prior = results.findIndex(r => r.rowNumber === item.rowNumber && r.status === 'failed');
      if (prior !== -1) results.splice(prior, 1);
    }
    if (!res.ok && attemptNo >= 3) actionWriteFailed(item);
    if (res.ok) {
      markCompleted(key, { when, patientId: item.patientId, note: item.note });
      try { recordNoteWritten(item.patientId, item.balance); } catch (err) { /* ignore */ }
      actionWriteSucceeded(item.patientId);
      await pinFreshNote(item.patientId, item.note, item.name);
      const r = { ...item, status: 'done', detail: attemptNo > 1 ? 'done on retry' : '', when };
      results.push(r);
      send('run-progress', { index: i, total: items.length, rowNumber: item.rowNumber, status: 'done' });
    } else {
      const detail = reasonText(res.reason, res.detail);
      results.push({ ...item, status: 'failed', detail, when });
      send('run-progress', { index: i, total: items.length, rowNumber: item.rowNumber, status: 'failed', detail });

      // A login problem will affect every remaining row, so stop rather than
      // grinding through 40 guaranteed failures.
      if (res.reason === 'not-logged-in') {
        engine.openVisible();
        break;
      }
    }

    // A brief pause between patients — kinder to Principle than hammering it.
    await new Promise(r => setTimeout(r, 800));
  }

  runState.running = false;
  let resultsFile = null;
  try { resultsFile = writeResultsCsv(results); } catch (e) { /* ignore */ }
  sendHealthPacket();                       // the day's story is complete

  send('run-finished', {
    stopped: runState.stopRequested,
    results,
    resultsFile,
    doneCount: results.filter(r => r.status === 'done').length,
    failedCount: results.filter(r => r.status === 'failed').length,
    skippedEarlier: results.filter(r => r.status === 'already-done').length,
  });
  return results;
}

// ---------------------------------------------------------------------
// COLLECTING MEDICARE DETAILS
//
// Works down the report reading each patient's Medicare number, sub numerate
// and expiry from their file, plus their date of birth from Principle's
// search. Writes an enriched spreadsheet so the PRODA checks can all be done
// from one list instead of opening fifty patient files.
// ---------------------------------------------------------------------
let collectState = { running: false, stopRequested: false };

function writeEnrichedCsv(rows, sourceName) {
  const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const header = ['Patient Name', 'Medicare Card Number', 'IRN', 'Expiry', 'Date of Birth',
                  'CDBS Available', 'Patient Link', 'Lookup Result'];
  const lines = [header.map(esc).join(',')];
  rows.forEach(r => {
    lines.push([
      r.name, r.number || '', r.irn || '', r.expiry || '', r.dob || '',
      '',                                   // left blank for the PRODA balance
      r.patientId ? `/${CLINIC_SLUG}/patients/${r.patientId}` : '',
      r.resultText || '',
    ].map(esc).join(','));
  });

  const d = new Date();
  const p2 = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`;
  const base = (sourceName || 'report').replace(/\.csv$/i, '').slice(0, 40);
  const file = path.join(app.getPath('documents'), `${base}-with-medicare-${stamp}.csv`);
  fs.writeFileSync(file, lines.join('\r\n'), 'utf8');
  return file;
}

// Works out whether a card has already expired, or is about to. Expiry is
// shown as MM/YYYY and a card is valid to the end of that month.
function expiryStatus(expiry) {
  const m = String(expiry || '').match(/^(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const month = Number(m[1]), year = Number(m[2]);
  if (!month || month > 12) return null;

  const endOfMonth = new Date(year, month, 0, 23, 59, 59);
  const now = new Date();
  const label = `${String(month).padStart(2, '0')}/${year}`;

  if (endOfMonth < now) return { expired: true, text: `CARD EXPIRED ${label}` };
  const daysLeft = Math.round((endOfMonth - now) / 86400000);
  if (daysLeft <= 60) return { expired: false, soon: true, text: `Card expires soon (${label})` };
  return { expired: false, text: '' };
}

function medicareReasonText(reason) {
  if (reason === 'timed-out') return 'Principle did not answer in time (45s)';
  switch (reason) {
    case 'no-card-on-file': return 'No Medicare card on file in Principle';
    case 'no-medicare-tab': return 'No Medicare tab on this patient file';
    case 'cannot-confirm-medicare-tab': return 'Could not confirm the Medicare tab was open — nothing read, to avoid picking up a DVA number';
    case 'wrong-panel': return 'The open tab looked like DVA or a health fund, not Medicare — nothing read';
    case 'not-confirmed-medicare': return 'Found a number but could not confirm it was the Medicare card — nothing recorded';
    case 'no-medicare-panel': return 'Could not find the Medicare section on the patient file';
    case 'not-found': return 'Medicare section found but no card number in it';
    case 'name-mismatch': return 'The name on the patient file does not match the sheet';
    case 'page-not-ready': return 'Principle did not finish loading in time';
    case 'not-logged-in': return 'Not logged in to Principle';
    case 'load-failed': return 'Could not open the patient file';
    default: return reason || 'Unknown problem';
  }
}

// The collect loop itself, shared by the standalone button and Run the lot.
// A promise that gives up politely: resolves the fallback after ms rather
// than letting one unanswered page hold the whole run hostage.
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}

async function collectMedicareCore(items, onProgress, shouldStop) {
  const rows = [];
  let lastPoke = Date.now();
  for (let i = 0; i < items.length; i++) {
    if (shouldStop()) break;
    // Long collects (50+ patients) outlive PRODA's idle timeout. A quiet
    // reload every 4 minutes keeps the session warm for the balances
    // phase - the 14:45 "no HPOS link" failure was an expired session.
    if (Date.now() - lastPoke > 4 * 60 * 1000) {
      lastPoke = Date.now();
      try {
        const ka = await proda.keepAlive();
        runlog('  proda keep-alive between patients: ' + (ka.ok ? 'ok' : 'window not open'));
      } catch (e) { /* ignore */ }
    }
    const item = items[i];
    onProgress(i, items.length, item, 'working', '');

    // WATCHDOG: 45s per patient — one page that never answers must cost
    // one patient, never the run (the 06:39 arlo hang).
    const res = await withTimeout(
      engine.readMedicareDetails(item.patientId, item.name),
      45000,
      { ok: false, reason: 'timed-out' }
    );
    if (res.reason === 'timed-out') {
      runlog('collect "' + item.name + '": TIMED OUT after 45s - marked failed, moving on');
      await new Promise(r => setTimeout(r, 2000));   // let the window settle
    }
    let row;
    if (res.ok) {
      const dob = (item.dob && dob8Of(item.dob)) ? item.dob
        : await withTimeout(engine.lookupDateOfBirth(item.name), 30000, '');
      const exp = expiryStatus(res.expiry);
      const resultText = exp && exp.text ? exp.text : 'OK';
      row = {
        ...item, number: res.number, irn: res.irn, expiry: res.expiry, dob,
        resultText, expired: !!(exp && exp.expired), status: 'done',
      };
      onProgress(i, items.length, item, 'done', (exp && exp.text) ? exp.text : '');
      runlog('collect "' + item.name + '": ok');
    } else {
      const detail = medicareReasonText(res.reason);
      // Keep the report's DOB on the row — the no-card healer needs it.
      row = { ...item, number: '', irn: '', expiry: '', dob: item.dob || '', resultText: detail, status: 'failed' };
      onProgress(i, items.length, item, 'failed', detail);
      runlog('collect "' + item.name + '": failed - ' + detail);
      if (res.reason === 'not-logged-in') { engine.openVisible(); rows.push(row); return { rows, aborted: 'not-logged-in' }; }
    }
    rows.push(row);
    await new Promise(r => setTimeout(r, 600));
  }
  return { rows };
}

async function collectMedicare(items, sourceName) {
  collectState = { running: true, stopRequested: false };
  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };

  const login = await engine.checkLoggedIn();
  if (!login.ok) {
    collectState.running = false;
    sendStatus('needs-login');
    await engine.promptLogin();
    engine.watchForLogin((ok) => sendStatus(ok ? 'connected' : 'needs-login'));
    send('collect-finished', { stopped: true, message: 'You are not logged in to Principle. The login page has been opened — sign in, then press Collect again.', rows: [] });
    return;
  }
  sendStatus('connected');

  const { rows } = await collectMedicareCore(
    items,
    (i, total, item, status, detail) => {
      if (status === 'working') send('collect-progress', { index: i, total, rowNumber: item.rowNumber, status: 'working' });
      else if (status === 'done') send('collect-progress', { index: i, total, rowNumber: item.rowNumber, status: 'done', warn: detail });
      else send('collect-progress', { index: i, total, rowNumber: item.rowNumber, status: 'failed', detail });
    },
    () => collectState.stopRequested
  );

  collectState.running = false;
  let file = null;
  try { file = writeEnrichedCsv(rows, sourceName); } catch (e) { /* ignore */ }

  send('collect-finished', {
    stopped: collectState.stopRequested,
    rows,
    file,
    okCount: rows.filter(r => r.status === 'done').length,
    failCount: rows.filter(r => r.status === 'failed').length,
  });
}

// ---------------------------------------------------------------------
// CHECKING BALANCES IN PRODA
//
// You log into PRODA and stop there. The app clicks through to HPOS, opens
// the CDBS form, and checks each patient in turn, recording PRODA's answer
// word for word. If it gets signed out it pauses and waits for you.
// ---------------------------------------------------------------------
let balanceState = { running: false, stopRequested: false, waitingForLogin: false };

function balanceReasonText(reason, detail) {
  if (reason === 'form-kept-failing') return 'the CDBS form kept failing — the run was stopped to protect PRODA';
  switch (reason) {
    case 'missing-details': return 'No Medicare number on file — nothing to check';
    case 'signed-out': return 'Signed out of PRODA';
    case 'no-hpos-link': return 'Could not find the link into HPOS on the PRODA page';
    case 'hpos-did-not-open': return 'HPOS did not open';
    case 'no-cdbs-form': return 'Could not open the CDBS search form';
    case 'could-not-submit': return 'Could not fill in the search form';
    case 'name-mismatch': return `PRODA answered about a different name (expected ${(detail && detail.expected) || ''})`;
    case 'proda-said': return 'PRODA returned a message rather than a balance';
    case 'nothing-returned': return 'No answer came back from PRODA';
    default: return reason || 'Unknown problem';
  }
}

// The balance-check loop itself, shared by the standalone button and Run the
// lot. waitState carries the pause flags so a PRODA sign-out mid-run pauses
// and resumes rather than failing.
async function balanceCore(items, onProgress, waitState, recoverLogin) {
  let consecutiveFormFails = 0;
  // Get into HPOS once, then every patient is a straight trip to the form.
  onProgress(-1, items.length, null, 'entering', '');
  let entered = await proda.enterHpos();
  if (!entered.ok) return { rows: [], aborted: entered.reason || 'could-not-enter-hpos' };
  proda.parkOffscreen();

  const rows = [];
  for (let i = 0; i < items.length; i++) {
    if (waitState.stopRequested) break;
    const item = items[i];
    onProgress(i, items.length, item, 'working', '');

    // Nicknames in brackets — "Jessica Anne (Jessi) Gwynne" — never belong
    // in the form. Medicare often registers compound first names, so if
    // "Jessica" is rejected as an invalid entry, "Jessica Anne" is tried
    // before giving up.
    const nameParts = String(item.name || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim().split(' ');
    const firstNameOf = (n) => nameParts.slice(0, n).join(' ');

    let res = await withTimeout(
      proda.checkBalance({ cardNumber: item.number, irn: item.irn, firstName: firstNameOf(1) }),
      90000,
      { ok: false, reason: 'timed-out-hard', text: '' }
    );
    if (res && res.reason === 'timed-out-hard') runlog('  HARD TIMEOUT (90s) - this patient\'s check wedged; moving on');

    if (/invalid entry/i.test((res && res.text) || '') && nameParts.length >= 3) {
      onProgress(i, items.length, item, 'working', '');
      res = await proda.checkBalance({
        cardNumber: item.number,
        irn: item.irn,
        firstName: firstNameOf(2),
      });
    }

    // Signed out mid-run? Pause, let you log back in, then carry on from here.
    if (!res.ok && res.reason === 'signed-out') {
      waitState.waitingForLogin = true;
      proda.openVisible();
      onProgress(i, items.length, item, 'paused', '');

      const waitedFrom = Date.now();
      while (waitState.waitingForLogin && !waitState.stopRequested) {
        await new Promise(r => setTimeout(r, 2000));
        const stillOut = await proda.checkSignedOut();
        if (!stillOut) { waitState.waitingForLogin = false; break; }
        if (Date.now() - waitedFrom > 15 * 60 * 1000) break;   // give up after 15 min
      }
      if (waitState.stopRequested || waitState.waitingForLogin) {
        rows.push({ ...item, balanceText: '', resultText: 'Signed out of PRODA', status: 'failed' });
        break;
      }
      // Back in — re-enter HPOS and retry this same patient.
      entered = await proda.enterHpos();
      proda.parkOffscreen();
      onProgress(i, items.length, item, 'working', '');
      res = await proda.checkBalance({
        cardNumber: item.number,
        irn: item.irn,
        firstName: firstNameOf(1),
      });
      if (/invalid entry/i.test((res && res.text) || '') && nameParts.length >= 3) {
        res = await proda.checkBalance({
          cardNumber: item.number,
          irn: item.irn,
          firstName: firstNameOf(2),
        });
      }
    }

    // Self-healing: a form that won't open usually means the HPOS session
    // wobbled or died mid-run (they expire on a timer). Rung 1: re-enter
    // HPOS and retry this patient. Rung 2: full fresh login (recoverLogin),
    // re-enter, retry. Three consecutive unhealed failures stop the run
    // cleanly instead of burning the rest of the list.
    // Crime-scene photographer: when the form bounces, record what the
    // PRODA window was actually showing - address, masked page text, and
    // which inputs/buttons existed. Digits are masked (###) so card
    // numbers and dates of birth never land in a log.
    const logFormForensics = async (tag) => {
      try {
        const fx = await proda.formForensics();
        if (!fx.ok) { runlog('  [' + tag + '] form forensics unavailable: ' + fx.error); return; }
        const mask = (s) => String(s || '').replace(/\d{3,}/g, '###').replace(/\s+/g, ' ').trim();
        runlog('  [' + tag + '] page: ' + mask(fx.url) + ' | title: ' + mask(fx.title));
        runlog('  [' + tag + '] page text (masked): "' + mask(fx.text).slice(0, 700) + '"');
        const ins = (fx.inputs || []).map(x => (x.visible ? '' : '~') + (x.id || x.name || x.type || x.tag) + (x.value === '(filled)' ? '*' : '')).join(', ');
        const btns = (fx.buttons || []).filter(b => b.text).map(b => (b.visible ? '' : '~') + (b.disabled ? '!' : '') + b.text).join(', ');
        runlog('  [' + tag + '] inputs (~hidden, *filled): ' + ins.slice(0, 500));
        runlog('  [' + tag + '] buttons (~hidden, !disabled): ' + mask(btns).slice(0, 500));
      } catch (e) { runlog('  [' + tag + '] form forensics failed: ' + String(e).slice(0, 80)); }
    };

    // A reply that is the search form itself means the CDBS form never
    // really submitted - caught HERE (before the rungs) since 2026-08-08.4,
    // so the re-enter-HPOS heal below fires instead of three instant
    // strikes aborting the run (the 20:15 desk-run failure).
    if (res && res.ok && /known only by one name|date of birth\s*dd\/mm\/yyyy/i.test(res.text || '')) {
      res.ok = false; res.reason = 'form-boilerplate'; res.text = '';
      runlog('  the reply was the search form itself - re-opening the CDBS form and retrying this patient');
      await logFormForensics('before heal');
    }
    if (res && res.ok) global.__lastOkReplyAt = Date.now();
    const sessionLooksAlive = (Date.now() - (global.__lastOkReplyAt || 0)) < 90 * 1000;
    if (!res.ok && res.reason === 'nothing-returned' && sessionLooksAlive) {
      runlog('  empty reply with a healthy session - the patient, not the session; session rungs skipped');
    } else if (!res.ok && res.reason !== 'signed-out' && !res.text) {
      onProgress(i, items.length, item, 'working', '');
      await proda.enterHpos();
      proda.parkOffscreen();
      res = await proda.checkBalance({ cardNumber: item.number, irn: item.irn, firstName: firstNameOf(1) });
      if (!res.ok && !res.text && typeof recoverLogin === 'function') {
        const back = await recoverLogin('The PRODA session looks dead partway through — logging in again.');
        if (back) {
          await proda.enterHpos();
          proda.parkOffscreen();
          res = await proda.checkBalance({ cardNumber: item.number, irn: item.irn, firstName: firstNameOf(1) });
        }
      }
    }

    // Rung 3 — self-healing: the details were rejected outright, but the
    // name + date of birth are known, so the correct card number gets
    // hunted in Find a patient and the check retried with what's found.
    if (res && res.ok && /known only by one name|date of birth\s*dd\/mm\/yyyy/i.test(res.text || '')) {
      res.ok = false; res.reason = 'form-boilerplate'; res.text = '';
      runlog('  the reply looked like the search form, not a balance - treated as failed and retried next run');
      await logFormForensics('after heal');
    }
    runlog('patient ' + (i + 1) + ' "' + item.name + '": reply=' + (res.ok ? 'ok' : (res.reason || 'fail')) + ' text="' + String(res.text || '').slice(0, 60) + '"');
    if (!(!res.ok && res.text && /invalid entry|matched using the submitted data/i.test(res.text))) {
      if (!res.ok && !item.dob) runlog('  healing skipped: no date of birth on the row');
    }
    if (!res.ok && res.text && /invalid entry|matched using the submitted data/i.test(res.text) && !item.dob) {
      runlog('  healing skipped: invalid entry but no date of birth on the row');
    }
    if (!res.ok && res.text && /invalid entry|matched using the submitted data/i.test(res.text) && item.dob) {
      runlog('  healing attempt: dob=' + item.dob);
      const dob8 = dob8Of(item.dob);
      const nm = splitName(item.name);
      if (dob8 && nm.first && nm.last) {
        onProgress(i, items.length, item, 'working', '');
        const found = await proda.findMedicareNumber({ firstName: nm.first, surname: nm.last, dob8 });
        runlog('  find result: ' + (found.ok ? (found.matches.length + ' match(es)') : ('failed: ' + found.reason)));
        if (found.ok && found.matches && found.matches.length === 1) {
          const fm = found.matches[0];
          res = await proda.checkBalance({ cardNumber: fm.cardNumber, irn: fm.irn, firstName: nm.first });
          if (res.ok) {
            item.healed = true;
            item.foundNumber = fm.cardNumber; item.foundIrn = fm.irn; item.foundExpiry = fm.expiry;
            try { queueNote({ patientId: item.patientId, name: item.name, note: 'Medicare card located via HPOS: ' + fm.cardNumber + ' IRN ' + (fm.irn || '?') + ', exp ' + (fm.expiry || '?') + ' - please add to card details in Principle.', pin: true }); } catch (eN) { /* note is decoration */ }
            const stH = loadPatientState();
            const e = stH[item.patientId] || {};
            Object.assign(e, { name: item.name, number: fm.cardNumber, irn: fm.irn, expiry: fm.expiry, dob: item.dob || e.dob, detailsAt: new Date().toISOString(), healed: true });
            stH[item.patientId] = e;
            savePatientState(stH);
          }
        }
        // 0 or 2+ matches: leave the original failure standing — a human call.
      }
    }

    if (res.ok) {
      consecutiveFormFails = 0;
      rows.push({ ...item, balanceText: res.text, resultText: item.healed ? 'OK (card details found in PRODA)' : 'OK', status: 'done' });
      onProgress(i, items.length, item, 'done', '');
    } else {
      const detail = res.text || balanceReasonText(res.reason, res.detail);
      rows.push({ ...item, balanceText: res.text || '', resultText: detail, status: 'failed' });
      onProgress(i, items.length, item, 'failed', detail);
      if (!res.text) {
        consecutiveFormFails++;
        if (consecutiveFormFails >= 3) {
          return { rows, aborted: 'form-kept-failing', stoppedAt: i + 1, total: items.length };
        }
      }
    }

    await new Promise(r => setTimeout(r, 700));
  }
  return { rows };
}

async function runBalanceChecks(items) {
  balanceState = { running: true, stopRequested: false, waitingForLogin: false };
  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };

  const result = await balanceCore(
    items,
    (i, total, item, status, detail) => {
      if (status === 'entering') send('balance-progress', { index: -1, total, status: 'entering' });
      else if (status === 'paused') send('balance-paused', { index: i, total, rowNumber: item.rowNumber });
      else send('balance-progress', { index: i, total, rowNumber: item.rowNumber, status, detail: detail || undefined });
    },
    balanceState
  );

  if (result.aborted) {
    balanceState.running = false;
    proda.openVisible();
    send('balance-finished', {
      stopped: true,
      message: result.aborted === 'signed-out'
        ? 'You are not logged into PRODA. Log in, then press Check balances again.'
        : `Could not get into HPOS (${balanceReasonText(result.aborted)}). PRODA has been opened so you can click through to the Child Dental Benefits Schedule yourself, then try again.`,
      rows: [],
    });
    return;
  }

  const rows = result.rows;
  balanceState.running = false;
  let file = null;
  try { file = writeBalancesCsv(rows); } catch (e) { /* ignore */ }

  send('balance-finished', {
    stopped: balanceState.stopRequested,
    rows,
    file,
    okCount: rows.filter(r => r.status === 'done').length,
    failCount: rows.filter(r => r.status === 'failed').length,
  });
}

// Writes the sheet with the balances filled in, ready to review and then use
// for the notes.
function writeBalancesCsv(rows) {
  const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const header = ['Patient Name', 'Medicare Card Number', 'IRN', 'Expiry', 'Date of Birth',
                  'CDBS Available', 'Patient Link', 'Lookup Result', 'Status'];
  const lines = [header.map(esc).join(',')];
  const statusOf = (r) => {
    if (r.healed) return 'healed - card found in HPOS (update Principle)';
    if (r.status === 'done') return 'checked';
    if (/no medicare card/i.test(r.resultText || '')) return r.dob ? 'no HPOS match - confirm details with family' : 'no card and no DOB on row';
    return 'not checked - ' + (r.resultText || 'unknown');
  };
  rows.forEach(r => {
    lines.push([
      r.name, r.number || '', r.irn || '', r.expiry || '', r.dob || '',
      r.balanceText || '',
      r.patientId ? `/${CLINIC_SLUG}/patients/${r.patientId}` : '',
      r.resultText || '',
      statusOf(r),
    ].map(esc).join(','));
  });

  const d = new Date();
  const p2 = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`;
  const file = path.join(app.getPath('documents'), `cdbs-balances-${stamp}.csv`);
  fs.writeFileSync(file, lines.join('\r\n'), 'utf8');
  return file;
}

// ---------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------
ipcMain.handle('pick-csv', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose the CDBS checking report',
    filters: [
      { name: 'CSV files', extensions: ['csv', 'txt'] },
      { name: 'Excel files', extensions: ['xlsx', 'xls'] },
      { name: 'All files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths.length) return { ok: false };
  const file = res.filePaths[0];

  try {
    const buf = fs.readFileSync(file);

    // Excel workbooks are zip files starting with "PK" — readable text they
    // are not, so say so plainly instead of showing gibberish.
    if (buf.length > 2 && buf[0] === 0x50 && buf[1] === 0x4B) {
      return {
        ok: false,
        error: 'This is an Excel workbook (.xlsx), which this program cannot read.\n\n' +
               'In Excel: File > Save As, and choose "CSV UTF-8 (Comma delimited)" from the file type list. ' +
               'Then choose that .csv file here.',
      };
    }

    const text = buf.toString('utf8');
    const rows = csvToRows(text);
    if (rows.length < 2) {
      return { ok: false, error: 'That file has no rows in it that I can read. Is it the exported report?' };
    }

    const preview = buildPreview(rowsToObjects(rows));
    return { ok: true, file: path.basename(file), preview };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// Generates the under-18 Medicare report in Principle for today + 14 days,
// catches the CSV, and returns the same preview a hand-picked file would.
let genState = { running: false };
ipcMain.handle('generate-report', async () => {
  if (genState.running) return { ok: false, error: 'Already generating.' };
  genState.running = true;

  const say = (text) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('genreport-progress', { text });
  };

  try {
    // Confirm the login first, exactly like every other run.
    const login = await engine.checkLoggedIn();
    if (!login.ok) {
      sendStatus('needs-login');
      await engine.promptLogin();
      engine.watchForLogin((ok) => sendStatus(ok ? 'connected' : 'needs-login'));
      return { ok: false, error: 'You are not logged in to Principle. The login page has been opened — sign in, then press Generate again.' };
    }
    sendStatus('connected');

    const res = await principleReport.generateReport(14, say);
    if (!res.ok) {
      engine.openVisible();
      const why = {
        'no-window': 'The Principle window could not be opened.',
        'not-logged-in': 'Principle sent us away from the report page — you may have been signed out. Log in and try again.',
        'report-page-not-ready': 'The report screen did not finish loading in time.',
        'could-not-run': 'The Run Report button could not be pressed.',
        'report-did-not-finish': 'The report did not finish within two minutes.',
        'no-download': 'The report ran but no file was downloaded.',
        'downloaded-an-image': 'A chart image came down instead of the report CSV.',
      }[res.reason] || ('Could not generate the report (' + (res.reason || 'unknown') + ').');
      return { ok: false, error: why };
    }

    engine.hide();

    const buf = fs.readFileSync(res.file);
    const text = buf.toString('utf8');
    const rows = csvToRows(text);
    if (rows.length < 2) {
      return { ok: false, error: 'The report downloaded but has no rows in it. It was saved to:\n' + res.file };
    }
    const preview = buildPreview(filterToWindow(rowsToObjects(rows), REPORT_WINDOW_DAYS));
    return { ok: true, file: path.basename(res.file), fullPath: res.file, preview };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    genState.running = false;
  }
});

ipcMain.handle('start-run', async (event, items) => {
  if (runState.running) return { ok: false, error: 'A run is already in progress.' };
  if (lastRunWasFile) return { ok: false, error: 'File runs are sheet-only - notes are never written from an uploaded list.' };
  runNotes(items || []);
  return { ok: true };
});

ipcMain.handle('collect-medicare', async (event, payload) => {
  if (collectState.running) return { ok: false, error: 'Already collecting.' };
  collectMedicare((payload && payload.items) || [], payload && payload.sourceName);
  return { ok: true };
});

ipcMain.handle('stop-collect', () => {
  collectState.stopRequested = true;
  return { ok: true };
});

ipcMain.handle('stop-run', () => {
  runState.stopRequested = true;
  return { ok: true };
});

ipcMain.handle('open-principle', () => { engine.openVisible(); return { ok: true }; });

// Diagnostic: find out which fields Principle keeps about a patient, so we
// can see whether Medicare details are available from the search index
// instead of having to open every patient's file. Field names only.
ipcMain.handle('inspect-fields', async () => {
  if (!engine.hasLearnedSearch()) {
    // Principle has to run one search of its own before we can see how its
    // search works, so bring the window up and wait for you to do one.
    await engine.promptLogin();
    for (let i = 0; i < 120 && !engine.hasLearnedSearch(); i++) {
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!engine.hasLearnedSearch()) {
      return { ok: false, reason: 'no-search-seen' };
    }
    engine.hide();
  }
  return await engine.inspectPatientFields();
});

// Diagnostic: look at the Medicare tab on one patient's file and write down
// its STRUCTURE only — labels and the shape of each value (e.g. "10 digits"),
// never the values themselves. Safe to send to Claude.
ipcMain.handle('snapshot-medicare', async (event, payload) => {
  const patientId = payload && payload.patientId;
  const expectedName = payload && payload.name;
  if (!patientId) return { ok: false, reason: 'no-patient-id' };
  const res = await engine.snapshotMedicareTab(patientId, expectedName);
  if (res.ok) {
    const file = path.join(app.getPath('documents'), 'principle-medicare-structure.json');
    try {
      fs.writeFileSync(file, JSON.stringify(res.report, null, 2), 'utf8');
      return { ok: true, file, report: res.report };
    } catch (e) {
      return { ok: true, report: res.report, saveError: String(e) };
    }
  }
  return res;
});

// ---------------------------------------------------------------------
// PRINCIPLE REPORT CAPTURE
// Records how the custom report screen works, so the app can eventually
// generate the report itself. Watching only.
// ---------------------------------------------------------------------
ipcMain.handle('preport-start', () => {
  engine.openVisible();
  return principleCapture.start();
});

ipcMain.handle('preport-mark', async (event, label) => {
  const snap = await principleCapture.snapshot(label || 'marked');
  return { ok: !!snap, title: snap && snap.title };
});

ipcMain.handle('preport-stop', async () => await principleCapture.stop());

ipcMain.handle('preport-open-folder', () => {
  shell.openPath(principleCapture.reportsFolder());
  return { ok: true };
});

// ---------------------------------------------------------------------
// PRODA CAPTURE
// Watching only — nothing is automated or submitted. You log in and drive;
// this records the structure of the screens and the requests behind them,
// with all digits masked.
// ---------------------------------------------------------------------
ipcMain.handle('proda-open', () => {
  proda.openVisible();
  return { ok: true };
});

ipcMain.handle('proda-start-capture', () => {
  if (!proda.isOpen()) proda.openVisible();
  return proda.startCapture();
});

ipcMain.handle('proda-mark', async (event, label) => {
  const snap = await proda.snapshotCurrentPage(label || 'marked');
  return { ok: !!snap, title: snap && snap.title };
});

ipcMain.handle('proda-stop-capture', async () => {
  return await proda.stopCapture();
});

// ---------------------------------------------------------------------
// RUN THE LOT
//
// One press: make sure Principle and PRODA are logged in (bringing up the
// login windows and waiting if not), then generate the report, read the
// Medicare details, and check every balance. Ends at the review table with
// nothing written — "Write these notes" stays a separate, deliberate press.
// ---------------------------------------------------------------------
let runAllState = { running: false, stopRequested: false, waitingForLogin: false };

function waitForPrincipleLogin() {
  return new Promise(resolve => engine.watchForLogin(ok => resolve(ok)));
}

// If PRODA is signed out, its window is brought up and this waits patiently
// for the login to be finished. No errors — just waiting.
// Rows that came out of collect with NO usable card details, but with a
// name + DOB, get the card hunted in Find a patient before balances run.
// Missing cards heal the same way wrong ones do.
async function healNoCardRows(rows) {
  const needing = rows.filter(r => !(r.number && r.irn)).length;
  let hn = 0;
  for (const r of rows) {
    if (r.number && r.irn) continue;
    hn++;
    beat('Finding missing Medicare cards — ' + hn + ' of ' + needing);
    if (!r.patientId) { if (r.name) runlog('no-card healing skipped "' + r.name + '": no patient link'); continue; }
    if (!r.dob) { runlog('no-card healing skipped "' + r.name + '": no date of birth available'); continue; }
    const dob8 = dob8Of(r.dob);
    const nm = splitName(r.name);
    if (!dob8 || !nm.first || !nm.last) { runlog('no-card healing skipped "' + r.name + '": unusable dob/name'); continue; }
    runlog('no-card healing attempt "' + r.name + '": dob=' + r.dob);
    try {
      const found = await withTimeout(
        proda.findMedicareNumber({ firstName: nm.first, surname: nm.last, dob8 }),
        90000,
        { ok: false, reason: 'timed-out' }
      );
      runlog('  find result: ' + (found.ok ? ((found.matches || []).length + ' match(es)') : ('failed: ' + found.reason)));
      if (!found.ok && /no-window|no-hpos-link|timed-out/.test(found.reason || '')) {
        fsTell('no-card lookup could not run for "' + r.name + '" (' + found.reason + ') - the search machinery needs eyes, patient stays flagged');
      }
      if (found.ok && found.matches && found.matches.length === 1) {
        const m = found.matches[0];
        r.number = m.cardNumber; r.irn = m.irn; r.expiry = m.expiry;
        r.status = 'done'; r.healed = true;
        r.foundNumber = m.cardNumber; r.foundIrn = m.irn; r.foundExpiry = m.expiry;
        const stH = loadPatientState();
        const e = stH[r.patientId] || {};
        Object.assign(e, { name: r.name, number: m.cardNumber, irn: m.irn, expiry: m.expiry, dob: r.dob || e.dob, detailsAt: new Date().toISOString(), healed: true });
        stH[r.patientId] = e;
        savePatientState(stH);
        queueNote({ patientId: r.patientId, name: r.name, note: 'Medicare card located via HPOS: ' + m.cardNumber + ' IRN ' + (m.irn || '?') + ', exp ' + (m.expiry || '?') + ' - please add to card details in Principle.', pin: true });
      }
    } catch (e) { runlog('  no-card healing error: ' + String(e).slice(0, 100)); }
  }
}

async function ensureProdaLoggedIn(say) {
  if (!proda.isOpen()) {
    runlog('proda window created (parked off-screen)');
    proda.openVisible();
    proda.parkOffscreen();
    await new Promise(r => setTimeout(r, 5000));    // let the page load
  }
  let signedOut = await proda.checkSignedOut();
  if (!signedOut) { sendUi('proda-light', { state: 'ready' }); return true; }

  // Saved credentials? Use them — same auto-login as the morning run, except
  // the code gets typed straight into the PRODA window since you're at the
  // desk. Any stumble falls back to a fully-manual login below.
  const sM = loadMorningSettings();
  if (sM.prodaUsername && sM.prodaPassword) {
    say('Signing into PRODA with the saved details...');
    sendUi('proda-light', { state: 'connecting' });
    let res = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      res = await proda.autoLogin(
        { username: sM.prodaUsername, password: sM.prodaPassword },
        async () => {
          say(attempt === 1
            ? 'PRODA needs the 6-digit code — type it into the box in the app (or reply on Telegram).'
            : 'That code did not take — a fresh one, please (they expire fast).');
          return await askDeskForCode();
        },
        say
      );
      if (res.ok) { proda.parkOffscreen(); sendUi('proda-light', { state: 'ready' }); return true; }
      runlog('desk PRODA login attempt ' + attempt + ' failed: ' + (res.reason || '?') + (res.stuckOn ? ' stuckOn=' + res.stuckOn : ''));
      const codeProblem = (res.reason === 'login-did-not-complete' && res.stuckOn === 'code');
      if (!codeProblem) break;                 // only code rejections earn retries
    }
    sendUi('proda-light', { state: 'down' });
    say('The automatic PRODA login did not work (' + (res.reason || 'unknown') + ') — PRODA needs a hand in the window that just opened.');
  }

  runlog('SERVICE DOOR: proda window shown for manual login');
  proda.openVisible();
  say('PRODA needs you — log in in the window that just opened. I will carry on the moment you are in.');
  const from = Date.now();
  while (Date.now() - from < 15 * 60 * 1000) {
    if (runAllState.stopRequested) return false;
    await new Promise(r => setTimeout(r, 2000));
    signedOut = await proda.checkSignedOut();
    if (!signedOut) { sendUi('proda-light', { state: 'ready' }); return true; }
  }
  sendUi('proda-light', { state: 'down' });
  return false;
}

// Turns the combined rows into the same preview shape the file-picker makes,
// so the review table and Write these notes work unchanged.
function buildPreviewFromRows(rows) {
  const items = rows.map((r, idx) => {
    const cls = r.status === 'done' ? classifyProda(r.balanceText) : { kind: 'failed' };
    const who = { number: String(r.number || '').replace(/\D/g, ''), irn: String(r.irn || '').trim(), first: firstNameOf(r.name || '') };
    let balance = null;
    let note = '';
    let skip = null;
    if (cls.kind === 'balance') { balance = cls.value; note = buildNote(balance, who); }
    else if (cls.kind === 'not-eligible') { balance = 'Not eligible'; note = notEligibleNote(); }
    else if (cls.kind === 'invalid') skip = INVALID_SKIP;
    else if (cls.kind === 'failed') {
      skip = /invalid entry/i.test(r.resultText || '') ? INVALID_SKIP : (r.resultText || 'No balance came back');
    }
    else if (cls.kind === 'empty') skip = r.resultText || 'No balance came back';
    else skip = 'PRODA\'s reply was not understood: "' + String(cls.text || '').slice(0, 80) + '"';
    return {
      rowNumber: r.rowNumber || (idx + 2),
      healed: !!r.healed,
      foundNumber: r.foundNumber || '', foundIrn: r.foundIrn || '', foundExpiry: r.foundExpiry || '',
      name: r.name,
      appointmentDate: r.appointmentDate || '',
      patientId: r.patientId,
      appointmentId: r.appointmentId || null,
      balanceRaw: r.balanceText || '',
      balance,
      note,
      skip,
      status: skip ? 'skipped' : 'ready',
    };
  });

  // The no-duplicate rules apply to EVERY path that reaches this table:
  // an unchanged balance already noted within the fortnight becomes a skip.
  {
    const stN = loadPatientState();
    for (const it of items) {
      if (!it.skip && it.balance && it.patientId) {
        const reason = noteSkipReason(stN, it.patientId, it.balance);
        if (reason) { it.skip = reason; it.status = 'skipped'; }
      }
    }
  }
  return {
    balanceColumnFound: true,
    balanceColumnName: BALANCE_COLUMN,
    expectedColumnName: BALANCE_COLUMN,
    linkColumnName: 'Patient Link',
    nameColumnName: 'Patient Name',
    dateColumnName: null,
    headers: [],
    items,
    readyCount: items.filter(i => !i.skip).length,
    skipCount: items.filter(i => i.skip).length,
  };
}

async function runAll() {
  lastRunWasFile = false;
  pinAudit = { written: 0, pinned: 0, failed: [] };
  setRunStatus('cdbs', 'running', 'started');
  beat('run starting');
  runlogStart('cdbs-check');
  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };
  const say = (text) => { beat(text); send('runall-progress', { text }); };
  const fail = (message) => {
    runAllState.running = false;
    setRunStatus('cdbs', 'failed', message);
    try { const hsx = loadHealthState(); hsx.cdbsLastRun = { when: new Date().toISOString(), outcome: 'failed: ' + message }; saveHealthState(hsx); } catch (e2) {}
    appJournal('RUN FAILED: ' + message);
    send('runall-finished', { ok: false, message });
    alarmPing('CDBS run problem: ' + message);
  };

  // --- both logins first, waiting rather than erroring ---
  say('Checking Principle login...');
  const login = await engine.checkLoggedIn();
  if (!login.ok) {
    sendStatus('needs-login');
    await engine.promptLogin();
    say('Principle needs you — log in in the window that just opened. I will carry on the moment you are in.');
    const ok = await waitForPrincipleLogin();
    if (!ok || runAllState.stopRequested) return fail('Principle login was not completed, so nothing was run.');
  }
  sendStatus('connected');

  say('Checking PRODA login...');
  const prodaOk = await ensureProdaLoggedIn(say);
  if (!prodaOk || runAllState.stopRequested) return fail('PRODA login was not completed, so nothing was run.');

  // --- stage 1: generate the report ---
  const gen = await principleReport.generateReport(14, (t) => say('Stage 1 of 3 — ' + t));
    if (gen.empty) {
    say('The report came back with no patients at all — nothing to check today.');
    runAllState.running = false;
    setRunStatus('cdbs', 'ok', 'report empty - no patients today');
    send('runall-finished', { ok: true, preview: { items: [], readyCount: 0, skipCount: 0 }, emptyDay: true });
    return;
  }
if (!gen.ok) {
    engine.openVisible();
    return fail('Stage 1 (generating the report) did not finish: ' + (gen.reason || 'unknown') + '. Principle has been brought on screen.');
  }
  engine.hide();

  let preview;
  try {
    const rows = csvToRows(fs.readFileSync(gen.file).toString('utf8'));
    if (rows.length < 2) return fail('The report downloaded but had no rows in it. It was saved to: ' + gen.file);
    preview = buildPreview(filterToWindow(rowsToObjects(rows), REPORT_WINDOW_DAYS));
  } catch (e) {
    return fail('The report downloaded but could not be read: ' + String(e));
  }

  let linked = preview.items.filter(i => i.patientId);
  const unlinked = preview.items.filter(i => !i.patientId)
    .map(i => ({ ...i, resultText: 'No patient link in the report row', status: 'failed' }));
  if (!linked.length) return fail('The report has no rows with patient links in it, so no patients could be identified.');


  // --- stage 2: Medicare details ---
  say(`Stage 2 of 3 — reading Medicare details for ${linked.length} patient${linked.length === 1 ? '' : 's'}...`);
  const col = await collectMedicareCore(
    linked,
    (i, total, item, status, detail) => {
      if (status === 'working') say(`Stage 2 of 3 — patient ${i + 1} of ${total}...`);
      else if (status === 'failed') say(`Stage 2 of 3 — patient ${i + 1} of ${total} (last one: ${detail})`);
    },
    () => runAllState.stopRequested
  );
  if (col.aborted === 'not-logged-in') {
    return fail('Principle signed out partway through reading Medicare details. Log back in and press Run the lot again — nothing has been written.');
  }
  if (runAllState.stopRequested) return fail('Stopped. Nothing has been written.');

  // --- stage 3: balances, for everyone whose details were read ---
  {
    const needHeal = col.rows.some(r => !(r.status === 'done' && r.number && r.irn) && r.dob);
    if (needHeal) {
      const pw = await ensureProdaLoggedIn((t) => runlog('card lookup prep: ' + t));
      if (pw) await healNoCardRows(col.rows);
      else fsTell('no-card lookups SKIPPED - PRODA not available; affected patients are flagged on the action list');
    }
  }

  { const stC = loadPatientState();
    for (const r of col.rows) {
      if (r.status === 'done' && r.number && r.irn) {
        const ch = chronicSkip(stC, r.patientId);
        if (ch) { r.status = 'skipped'; r.skip = ch; }
      }
    } }
  const checkable = col.rows.filter(r => r.status === 'done' && r.number && r.irn);
  const uncheckable = col.rows.filter(r => !(r.status === 'done' && r.number && r.irn));
  say(`Stage 3 of 3 — checking ${checkable.length} balance${checkable.length === 1 ? '' : 's'} in PRODA...`);

  let balRows = [];
  if (checkable.length) {
    const deskRecover = async (why) => { say(why); return await ensureProdaLoggedIn(say); };
    let bal = await balanceCore(
      checkable,
      (i, total, item, status, detail) => {
        if (status === 'entering') say('Stage 3 of 3 — going into HPOS...');
        else if (status === 'paused') say(`Stage 3 of 3 — paused: PRODA signed you out. Log back in in the window that opened and I will carry on from patient ${i + 1}.`);
        else if (status === 'working') say(`Stage 3 of 3 — patient ${i + 1} of ${total}...`);
        else if (status === 'failed') say(`Stage 3 of 3 — patient ${i + 1} of ${total} (last one: ${detail})`);
      },
      runAllState,
      deskRecover
    );
    // Signed out right at the door despite the pre-flight (a long stage 2 can
    // outlast the PRODA timeout): wait for the login and go again, once.
    if (bal.aborted === 'signed-out' && !runAllState.stopRequested) {
      const back = await ensureProdaLoggedIn(say);
      if (back) {
        bal = await balanceCore(checkable, (i, total, item, status, detail) => {
          if (status === 'working') say(`Stage 3 of 3 — patient ${i + 1} of ${total}...`);
          else if (status === 'failed') say(`Stage 3 of 3 — patient ${i + 1} of ${total} (last one: ${detail})`);
        }, runAllState, deskRecover);
      }
    }
    if (bal.aborted) {
      proda.openVisible();
      return fail('Stage 3 (PRODA balances) could not get into HPOS: ' + balanceReasonText(bal.aborted) + '. Nothing has been written.');
    }
    balRows = bal.rows;
  }

  // --- combine and finish at the review table ---
  for (const u of uncheckable) if (!u.skip) u.skip = u.reason ? medicareReasonText(u.reason) : 'could not be checked';
  const merged = [...balRows, ...uncheckable, ...unlinked];
  let file = null;
  try { file = writeBalancesCsv(merged); } catch (e) { /* ignore */ }

  // Remember today's checks, so tomorrow's morning run skips the fresh ones.
  {
    const stR = loadPatientState();
    for (const r of balRows) {
      if (r.status === 'done') {
        const e = stR[r.patientId] || {};
        e.name = r.name;
        e.lastChecked = new Date().toISOString();
        e.lastBalanceText = r.balanceText;
        stR[r.patientId] = e;
        mirrorBalanceToItem(r.patientId, r.balanceText);
      }
    }
    savePatientState(stR);
  }

  const finalPreview = buildPreviewFromRows(merged);
  let sortedPdf = null;
  try {
    const stF = updateFailureMemory(finalPreview.items);
    sortedPdf = await writeSortedPdf(finalPreview.items, stF);
    if (sortedPdf && sortedPdf.buckets) { await updateActionList(sortedPdf.buckets); sendUi('actions-changed', {}); }
    clearWasFixedFlags(stF);
  } catch (e) { /* the run still counts */ }
  runAllState.running = false;
  send('runall-finished', {
    ok: true,
    stopped: runAllState.stopRequested,
    preview: finalPreview,
    file,
    sortedPdf: sortedPdf ? sortedPdf.file : null,
    readyCount: finalPreview.readyCount,
    failCount: finalPreview.skipCount,
  });
}

ipcMain.handle('run-all', async () => {
  if (runAllState.running || runState.running || collectState.running || balanceState.running || genState.running) {
    return { ok: false, error: 'Something is already running.' };
  }
  runAllState = { running: true, stopRequested: false, waitingForLogin: false };
  runAll();
  return { ok: true };
});

ipcMain.handle('stop-all', () => {
  runAllState.stopRequested = true;
  return { ok: true };
});

ipcMain.handle('check-balances', async (event, payload) => {
  if (balanceState.running) return { ok: false, error: 'Already checking.' };
  runBalanceChecks((payload && payload.items) || []);
  return { ok: true };
});

ipcMain.handle('stop-balances', () => {
  balanceState.stopRequested = true;
  return { ok: true };
});

ipcMain.handle('proda-status', () => ({
  open: proda.isOpen(),
  capturing: proda.isCapturing(),
}));

// Used by the "Log in" button and by a manual re-check.
ipcMain.handle('check-login', async (event, openIfNeeded) => {
  const ok = await checkPrincipleLogin(!!openIfNeeded);
  return { ok };
});

ipcMain.handle('open-file', (event, file) => {
  if (file) shell.showItemInFolder(file);
  return { ok: true };
});

// =====================================================================
// THE MORNING RUN
//
// Weekday mornings (6am if the PC is on, otherwise the moment it's first
// turned on), the app quietly does everything that needs no PRODA: it
// generates the report and reads Medicare details. Then it messages the
// phone and WAITS - nothing touches PRODA until a YES comes back. On YES
// it signs into PRODA itself (credentials live encrypted on this PC and
// never leave it), which makes PRODA produce the 2FA code; the phone is
// asked for the code; balances run; a summary goes to the phone with
// counts only - never patient names. Notes are written only from the desk
// or by an explicit WRITE reply, and the same never-write-twice protection
// covers both paths.
// =====================================================================

// ---------- encrypted settings vault (this PC only) ----------
function vaultPath() { return path.join(app.getPath('userData'), 'morning-settings.json'); }

function vaultEncrypt(v) {
  if (!v) return '';
  return safeStorage.encryptString(String(v)).toString('base64');
}
function vaultDecrypt(v) {
  if (!v) return '';
  try { return safeStorage.decryptString(Buffer.from(v, 'base64')); } catch (e) { return ''; }
}

function loadMorningSettings() {
  let raw = {};
  try {
    if (fs.existsSync(vaultPath())) raw = JSON.parse(fs.readFileSync(vaultPath(), 'utf8'));
  } catch (e) { /* ignore */ }
  return {
    prodaUsername: vaultDecrypt(raw.prodaUsername),
    principleEmail: vaultDecrypt(raw.principleEmail),
    cellcastKey: vaultDecrypt(raw.cellcastKey),
    principlePassword: vaultDecrypt(raw.principlePassword),
    prodaPassword: vaultDecrypt(raw.prodaPassword),
    telegramToken: vaultDecrypt(raw.telegramToken),
    telegramChatId: raw.telegramChatId || '',
    enabled: !!raw.enabled,
    morningTime: /^\d{1,2}:\d{2}$/.test(raw.morningTime || '') ? raw.morningTime : '08:30',
    mDays: Array.isArray(raw.mDays) ? raw.mDays : [1, 2, 3, 4, 5],
    mWorker: raw.mWorker !== false,
    lastMorningRun: raw.lastMorningRun || null,
    fbEmail: raw.fbEmail || '',
    fbPassword: vaultDecrypt(raw.fbPassword),
  };
}

function saveMorningSettings(updates) {
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: 'Windows would not provide encryption, so nothing was saved. Credentials are never stored unencrypted.' };
  }
  const current = loadMorningSettings();
  const next = {
    prodaUsername: vaultEncrypt(updates.prodaUsername != null && updates.prodaUsername !== '' ? updates.prodaUsername : current.prodaUsername),
    principleEmail: vaultEncrypt(updates.principleEmail != null && updates.principleEmail !== '' ? updates.principleEmail : current.principleEmail),
    cellcastKey: vaultEncrypt(updates.cellcastKey != null && updates.cellcastKey !== '' ? updates.cellcastKey : current.cellcastKey),
    principlePassword: vaultEncrypt(updates.principlePassword != null && updates.principlePassword !== '' ? updates.principlePassword : current.principlePassword),
    prodaPassword: vaultEncrypt(updates.prodaPassword != null && updates.prodaPassword !== '' ? updates.prodaPassword : current.prodaPassword),
    telegramToken: vaultEncrypt(updates.telegramToken != null && updates.telegramToken !== '' ? updates.telegramToken : current.telegramToken),
    telegramChatId: updates.telegramChatId != null && updates.telegramChatId !== '' ? String(updates.telegramChatId) : current.telegramChatId,
    enabled: updates.enabled != null ? !!updates.enabled : current.enabled,
    morningTime: /^\d{1,2}:\d{2}$/.test(updates.morningTime || '') ? updates.morningTime : current.morningTime,
    mDays: Array.isArray(updates.mDays) ? updates.mDays : current.mDays,
    mWorker: updates.mWorker != null ? !!updates.mWorker : current.mWorker,
    lastMorningRun: updates.lastMorningRun != null ? updates.lastMorningRun : current.lastMorningRun,
    fbEmail: updates.fbEmail != null && updates.fbEmail !== '' ? String(updates.fbEmail).trim() : current.fbEmail,
    fbPassword: vaultEncrypt(updates.fbPassword != null && updates.fbPassword !== '' ? updates.fbPassword : current.fbPassword),
    savedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(vaultPath(), JSON.stringify(next), 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ---------- per-patient memory (checking + note rules) ----------
function patientStatePath() { return path.join(app.getPath('userData'), 'cdbs-patient-state.json'); }

function loadPatientState() {
  try {
    if (fs.existsSync(patientStatePath())) return JSON.parse(fs.readFileSync(patientStatePath(), 'utf8'));
  } catch (e) { /* ignore */ }
  return {};
}
function savePatientState(st) {
  try { fs.writeFileSync(patientStatePath(), JSON.stringify(st, null, 2), 'utf8'); } catch (e) { /* ignore */ }
}

function daysSince(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (isNaN(t)) return null;
  return (Date.now() - t) / 86400000;
}

// Appointment dates in the report are d/m/y - parsed defensively; anything
// unreadable counts as "soon", which errs on the side of a fresh check.
function daysUntilAppt(dateStr) {
  const m = String(dateStr || '').match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (!m) return null;
  let y = Number(m[3]); if (y < 100) y += 2000;
  const d = new Date(y, Number(m[2]) - 1, Number(m[1]));
  if (isNaN(d.getTime())) return null;
  return (d.getTime() - Date.now()) / 86400000;
}

const CHECK_REFRESH_DAYS = 7;      // re-check a balance older than this
const CHECK_NEAR_APPT_DAYS = 3;    // always re-check this close to the visit
const DETAILS_REFRESH_DAYS = 30;   // re-read Medicare details older than this
const NOTE_REFRESH_DAYS = 14;      // matches the report window - an unchanged
                                   // balance is re-noted at most once per cycle

function needsBalanceCheck(st, item) {
  const e = st[item.patientId];
  if (!e || !e.lastChecked || !e.lastBalanceText) return true;
  const age = daysSince(e.lastChecked);
  if (age == null || age > CHECK_REFRESH_DAYS) return true;
  const until = daysUntilAppt(item.appointmentDate);
  if (until == null || until <= CHECK_NEAR_APPT_DAYS) return true;
  return false;
}

function hasFreshDetails(st, patientId) {
  const e = st[patientId];
  if (!e || !e.number || !e.irn) return false;
  const age = daysSince(e.detailsAt);
  return age != null && age <= DETAILS_REFRESH_DAYS;
}

// Decides whether a patient gets a note today. Returns null to write, or a
// plain-English reason to skip.
function balanceToken(balance) {
  return String(balance || '').split(' as at ')[0].trim();
}

function noteSkipReason(st, patientId, balance) {
  const e = st[patientId];
  if (!e || !e.lastNoteDate || !e.lastNoteBalance) return null;      // first note
  if (balanceToken(e.lastNoteBalance) !== balanceToken(balance)) return null;   // balance moved
  const age = daysSince(e.lastNoteDate);
  if (age == null || age >= NOTE_REFRESH_DAYS) return null;          // stale note
  const when = new Date(e.lastNoteDate).toLocaleDateString('en-AU');
  return 'Balance unchanged - already noted ' + when;
}

function recordNoteWritten(patientId, balance) {
  const st = loadPatientState();
  const e = st[patientId] || {};
  e.lastNoteDate = new Date().toISOString();
  e.lastNoteBalance = balance;
  st[patientId] = e;
  savePatientState(st);
}

// ---------- once-per-day guard ----------
function morningStatePath() { return path.join(app.getPath('userData'), 'morning-state.json'); }
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function alreadyRanToday() {
  try {
    if (fs.existsSync(morningStatePath())) {
      return JSON.parse(fs.readFileSync(morningStatePath(), 'utf8')).lastRun === todayStr();
    }
  } catch (e) { /* ignore */ }
  return false;
}
function markRanToday() {
  try { fs.writeFileSync(morningStatePath(), JSON.stringify({ lastRun: todayStr() }), 'utf8'); } catch (e) { /* ignore */ }
}

function midnightTonight() {
  const d = new Date();
  d.setHours(23, 59, 30, 0);
  return d;
}

// The PRODA login loop the morning run uses: types the saved credentials,
// then asks BOTH doors for the code - the box in the app and Telegram -
// first answer wins (this was Telegram-only until 08/26, which is why the
// desk box never appeared for solo morning runs).
async function morningProdaLogin(s, say, tg, why) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await proda.autoLogin(
      { username: s.prodaUsername, password: s.prodaPassword },
      async () => {
        if (attempt > 1) { try { await tg('That code did not work - send a fresh one (or type it into the box at the desk).'); } catch (eT) { /* box still asks */ } }
        say(attempt === 1
          ? 'PRODA needs the 6-digit code - type it into the box in the app (or reply on Telegram).'
          : 'That code did not take - a fresh one, please (they expire fast).');
        return await askDeskForCode();
      },
      say
    );
    if (res.ok) return { ok: true };
    if (res.reason === 'no-code') return { ok: false, why: 'No code arrived in time.' };
    if (res.reason === 'login-page-not-recognised' || res.reason === 'could-not-fill-login') {
      return { ok: false, why: 'PRODA\'s login page did not look how it was expected to.' };
    }
    if (res.reason === 'login-did-not-complete' && res.stuckOn !== 'code') {
      return { ok: false, why: 'The PRODA login did not complete (stuck on: ' + (res.stuckOn || 'unknown') + ').' };
    }
  }
  return { ok: false, why: 'Three codes did not work.' };
}

// ---------- the run itself ----------
let morningState = { running: false, stopRequested: false };

async function morningRun(trigger) {
  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };
  const say = (text) => send('runall-progress', { text: '[Morning run] ' + text });
  const s = loadMorningSettings();
  const canPhone = !!(s.telegramToken && s.telegramChatId);
  const tg = async (text) => { if (canPhone) await telegram.send(s.telegramToken, s.telegramChatId, text); };
  const finishFail = async (message, alsoPhone) => {
    morningState.running = false;
    try { saveMorningSettings({ lastMorningRun: { when: new Date().toISOString(), outcome: 'stopped: ' + String(message).slice(0, 120) } }); } catch (e2) { /* cosmetic */ }
    ledgerReport('cdbs-14day', '14-day CDBS morning run', 'stopped: ' + String(message).slice(0, 100)).catch(() => {});
    say(message);
    send('runall-finished', { ok: false, message });
    if (alsoPhone !== false) await tg('CDBS morning run: ' + message);
  };

  if (!canPhone || !s.prodaUsername || !s.prodaPassword) {
    return finishFail('Morning run is not set up yet - fill in the Morning run settings first.', false);
  }

  markRanToday();
  await telegram.drainOld(s.telegramToken);

  // --- one YES starts the whole train (desk runs skip the phone: the
  // button press IS the yes) ---
  if (trigger === 'desk') {
    say('Desk run - phone gate skipped (you pressed the button).');
    appJournal('morning run: desk mode - Telegram YES gate skipped');
  } else {
    await tg('Morning - run today\'s CDBS check? Reply YES when you are ready, or SKIP to leave it. This offer expires at midnight.');
    say('Asked the phone whether to run today. Waiting for YES (expires at midnight).');
    const bk1 = beatKeeper('waiting for the morning YES on Telegram');
    const goFirst = await telegram.waitForKeyword(s.telegramToken, s.telegramChatId, ['yes', 'y', 'ok', 'skip'], midnightTonight(), () => morningState.stopRequested);
    clearInterval(bk1);
    if (!goFirst.ok || goFirst.word === 'skip') {
      if (goFirst.ok) await tg('Righto - skipped for today.');
      return finishFail('No YES came before midnight, so nothing was run today.', false);
    }
    await tg('On it. The report and Medicare details take about 10 minutes - the PRODA code request will follow.');
  }

  // --- Principle half: no PRODA, no credentials, just the saved session ---
  try { saveMorningSettings({ lastMorningRun: { when: new Date().toISOString(), outcome: 'running - started ' + new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' }) + ' (' + trigger + ')' } }); } catch (eS) { /* cosmetic */ }
  say('Checking Principle login...');
  const login = await ensurePrincipleForJobs();   // heal ladder: go home, re-probe, credential fallback
  if (!login.ok) {
    return finishFail('Principle needs a login at the desk today, so the morning run stopped before doing anything.');
  }
  sendStatus('connected');

  const gen = await principleReport.generateReport(14, (t) => say('Report - ' + t));
  if (!gen.ok) {
    return finishFail('The report could not be generated (' + (gen.reason || 'unknown') + '). Run it at the desk today.');
  }
  engine.hide();

  let preview;
  try {
    const rows = csvToRows(fs.readFileSync(gen.file).toString('utf8'));
    if (rows.length < 2) return finishFail('The report came back with no rows in it.');
    preview = buildPreview(filterToWindow(rowsToObjects(rows), REPORT_WINDOW_DAYS));
  } catch (e) {
    return finishFail('The report downloaded but could not be read.');
  }

  const linked = preview.items.filter(i => i.patientId);
  const unlinked = preview.items.filter(i => !i.patientId)
    .map(i => ({ ...i, resultText: 'No patient link in the report row', status: 'failed' }));
  if (!linked.length) return finishFail('The report has no rows with patient links in it.');

  // --- smart split: who actually needs checking today ---
  let st = loadPatientState();
  const toCheck = linked.filter(i => needsBalanceCheck(st, i));
  const restedRows = linked.filter(i => !needsBalanceCheck(st, i)).map(i => {
    const e = st[i.patientId];
    const age = Math.round(daysSince(e.lastChecked) || 0);
    return {
      ...i,
      number: e.number, irn: e.irn, expiry: e.expiry, dob: e.dob,
      balanceText: e.lastBalanceText,
      resultText: 'Checked ' + (age === 0 ? 'today' : age === 1 ? 'yesterday' : age + ' days ago'),
      status: 'done',
    };
  });

  for (const i of toCheck) {
    const ch = chronicSkip(st, i.patientId);
    if (ch && !hasFreshDetails(st, i.patientId)) { i.status = 'skipped'; i.skip = ch; }
  }
  const needDetails = toCheck.filter(i => !hasFreshDetails(st, i.patientId) && !i.skip);
  const cachedDetails = toCheck.filter(i => hasFreshDetails(st, i.patientId));

  // --- collect only what's missing ---
  let colRows = [];
  if (needDetails.length) {
    say('Reading Medicare details for ' + needDetails.length + ' patient' + (needDetails.length === 1 ? '' : 's') + '...');
    const col = await collectMedicareCore(
      needDetails,
      (i, total, item, status, detail) => say('Medicare details - patient ' + (i + 1) + ' of ' + total + (status === 'failed' ? ' (last: ' + detail + ')' : '')),
      () => morningState.stopRequested
    );
    if (col.aborted === 'not-logged-in') {
      return finishFail('Principle signed out partway through. Run it at the desk today.');
    }
    colRows = col.rows;
    // Remember the details that were read, so tomorrow skips these files.
    st = loadPatientState();
    for (const r of colRows) {
      if (r.status === 'done' && r.number && r.irn) {
        const e = st[r.patientId] || {};
        Object.assign(e, { name: r.name, number: r.number, irn: r.irn, expiry: r.expiry, dob: r.dob, detailsAt: new Date().toISOString() });
        st[r.patientId] = e;
      }
    }
    savePatientState(st);
  }
  const cachedRows = cachedDetails.map(i => {
    const e = st[i.patientId];
    return { ...i, number: e.number, irn: e.irn, expiry: e.expiry, dob: e.dob, resultText: 'OK', status: 'done' };
  });

  {
    const needHeal = colRows.some(r => !(r.status === 'done' && r.number && r.irn) && r.dob);
    if (needHeal) {
      const pw = await ensureProdaLoggedIn((t) => runlog('card lookup prep: ' + t));
      if (pw) await healNoCardRows(colRows);
      else fsTell('no-card lookups SKIPPED - PRODA not available; affected patients are flagged on the action list');
    }
  }

  const checkable = colRows.filter(r => r.status === 'done' && r.number && r.irn).concat(cachedRows);
  const uncheckable = colRows.filter(r => !(r.status === 'done' && r.number && r.irn));

  // --- idle here until YES (all day; the prompt dies at midnight) ---
  if (!checkable.length) {
    for (const u of uncheckable) if (!u.skip) u.skip = u.reason ? medicareReasonText(u.reason) : 'could not be checked';
    const merged = [...restedRows, ...uncheckable, ...unlinked];
    await finishMorning(merged, st, s, send, say, tg, trigger);
    return;
  }

  await tg('Report done: ' + checkable.length + ' of ' + linked.length + ' need a balance check' +
    (restedRows.length ? ' (' + restedRows.length + ' checked recently, skipped)' : '') + '. Signing into PRODA now...');

  const pLogin = await morningProdaLogin(s, say, tg, '');
  if (!pLogin.ok) {
    return finishFail(pLogin.why + ' PRODA was left alone - run the balances at the desk today.');
  }
  proda.parkOffscreen();
  await tg('In. Checking ' + checkable.length + ' balance' + (checkable.length === 1 ? '' : 's') + ' - I\'ll message when done.');

  // --- balances ---
  const bal = await balanceCore(
    checkable,
    (i, total, item, status, detail) => {
      if (status === 'working') say('Balances - patient ' + (i + 1) + ' of ' + total + '...');
      else if (status === 'failed') say('Balances - patient ' + (i + 1) + ' of ' + total + ' (last: ' + detail + ')');
    },
    morningState,
    async (why) => {
      const again = await morningProdaLogin(s, say, tg, why);
      return again.ok;
    }
  );
  if (bal.aborted) {
    return finishFail('Could not get into HPOS (' + balanceReasonText(bal.aborted) + '). Run the balances at the desk today.');
  }

  // Remember today's balances.
  st = loadPatientState();
  for (const r of bal.rows) {
    if (r.status === 'done') {
      const e = st[r.patientId] || {};
      e.name = r.name;
      e.lastChecked = new Date().toISOString();
      e.lastBalanceText = r.balanceText;
      st[r.patientId] = e;
      mirrorBalanceToItem(r.patientId, r.balanceText);
    }
  }
  savePatientState(st);

  for (const u of uncheckable) if (!u.skip) u.skip = u.reason ? medicareReasonText(u.reason) : 'could not be checked';
  const merged = [...bal.rows, ...restedRows, ...uncheckable, ...unlinked];
  await finishMorning(merged, st, s, send, say, tg, trigger);
}

// Shared tail: build the review table (with the note rules applied), show it
// at the desk, message the numbers, and offer WRITE if the run looks clean.
async function finishMorning(mergedRows, st, s, send, say, tg, trigger) {
  trigger = trigger || 'desk';
  let file = null;
  try { file = writeBalancesCsv(mergedRows); } catch (e) { /* ignore */ }

  const previewOut = buildPreviewFromRows(mergedRows);
  // Apply the note rules on top: unchanged balances become skips.
  for (const it of previewOut.items) {
    if (!it.skip && it.balance) {
      const reason = noteSkipReason(st, it.patientId, it.balance);
      if (reason) { it.skip = reason; it.status = 'skipped'; }
    }
  }
  previewOut.readyCount = previewOut.items.filter(i => !i.skip).length;
  previewOut.skipCount = previewOut.items.filter(i => i.skip).length;

  let sortedPdf = null;
  try {
    runlog('tail: saving check memory...');
    const stF = updateFailureMemory(previewOut.items);
    runlog('tail: building the sorted sheet...');
    sortedPdf = await withTimeout(writeSortedPdf(previewOut.items, stF), 90000, null);
    if (sortedPdf === null) runlog('tail: sorted sheet TIMED OUT (90s) - skipped, the run continues');
    if (sortedPdf && sortedPdf.buckets) {
      runlog('tail: syncing the action list...');
      const synced = await withTimeout(updateActionList(sortedPdf.buckets).then(() => true), 120000, false);
      if (!synced) runlog('tail: action-list sync TIMED OUT (120s) - the next run completes it');
      sendUi('actions-changed', {});
    }
    clearWasFixedFlags(stF);
    runlog('tail: done - stamping the run complete');
  } catch (e) { runlog('tail: step failed (' + String(e).slice(0, 80) + ') - the run still counts'); }

  morningState.running = false;
  try {
    saveMorningSettings({ lastMorningRun: { when: new Date().toISOString(), outcome: 'completed (' + trigger + ') - see the sorted sheet / debrief for numbers' } });
    ledgerReport('cdbs-14day', '14-day CDBS morning run', 'completed (' + trigger + ')').catch(() => {});
  } catch (e2) { runlog('history stamp failed (run still completed): ' + String(e2).slice(0, 80)); }
  send('runall-finished', {
    ok: true,
    preview: previewOut,
    file,
    sortedPdf: sortedPdf ? sortedPdf.file : null,
    readyCount: previewOut.readyCount,
    failCount: previewOut.items.filter(i => i.skip && !/unchanged/i.test(i.skip)).length,
  });

  const ready = previewOut.readyCount;
  const unchanged = previewOut.items.filter(i => i.skip && /unchanged/i.test(i.skip)).length;
  const failed = previewOut.items.length - ready - unchanged;
  const total = previewOut.items.length;

  // Tripwires: a weird-looking run gets no remote WRITE offer.
  const weird = total === 0 || failed > Math.max(3, Math.round(total * 0.3));
  let msg = 'CDBS morning run done: ' + ready + ' note' + (ready === 1 ? '' : 's') + ' ready to write, ' + unchanged + ' unchanged (no note needed), ' + failed + ' not successful.';
  if (sortedPdf && sortedPdf.counts) {
    const c = sortedPdf.counts;
    msg += ' Today: ' + c.low + ' new low balance, ' + c.notEligible + ' new not eligible, ' + c.fix + ' still to fix, ' + c.fine + ' newly fine, ' + c.unchanged + ' unchanged.' + (c.unaccounted ? ' ⚠ ' + c.unaccounted + ' NOT ACCOUNTED FOR - flagged on the action list.' : '') + ' The printable summary is waiting at the desk.';
  }
  if (weird) {
    msg += ' This run looks unusual, so notes can only be written from the desk today after reading the table.';
    await tg(msg);
    return;
  }
  if (ready === 0) {
    await tg(msg + ' Nothing to write today.');
    return;
  }
  if (trigger === 'desk') {
    say('Desk run finished - the review table is open. Press "Write these notes" when checked.');
    await tg(msg + ' (Desk run - write the notes from the review table at the desk.)');
    return;
  }
  msg += ' Reply WRITE to write them now, or leave it for the desk. The review table is open there either way. This offer expires at midnight.';
  await tg(msg);

  const bk2 = beatKeeper('waiting for the WRITE go-ahead on Telegram');
  const w = await telegram.waitForKeyword(s.telegramToken, s.telegramChatId, ['write'], midnightTonight(), () => morningState.stopRequested);
  clearInterval(bk2);
  if (!w.ok) return;
  if (runState.running) {
    await tg('Notes are already being written at the desk - leaving it alone.');
    return;
  }
  const items = previewOut.items.filter(i => !i.skip);
  await tg('Writing ' + items.length + ' note' + (items.length === 1 ? '' : 's') + ' now...');
  const results = await runNotes(items);
  const done = (results || []).filter(r => r.status === 'done').length;
  const fail2 = (results || []).filter(r => r.status === 'failed').length;
  const already = (results || []).filter(r => r.status === 'already-done').length;
  await tg('Done: ' + done + ' written' + (already ? ', ' + already + ' were already written earlier' : '') + (fail2 ? ', ' + fail2 + ' failed - see the table at the desk' : '') + '.');
}

// ---------------------------------------------------------------------
// MANUAL RUN FROM A FILE (recall lists)
//
// Same engine as CDBS check minus the report generation: the loaded file
// supplies the patients (Patient Name + Patient Link is enough). Ends at
// the review table with the note rules applied, and writes a call-list
// CSV — Name, Link, Balance — sorted biggest balance first, because on a
// recall list the high balances are the calls worth making.
// ---------------------------------------------------------------------
function dob8Of(dateStr) {
  const m = String(dateStr || '').match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) {
    let y = m[3]; if (y.length === 2) y = '20' + y;
    return m[1].padStart(2, '0') + m[2].padStart(2, '0') + y;
  }
  const digits = String(dateStr || '').replace(/\D/g, '');
  return digits.length === 8 ? digits : null;
}

function splitName(name) {
  const parts = String(name || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim().split(' ');
  return { first: parts[0] || '', last: parts.length > 1 ? parts[parts.length - 1] : '' };
}

function patientProfileUrl(patientId) {
  return 'https://app.principle.dental/southside-dental-toowoomba/patients/' + patientId + '/profile';
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function writeCallListCsv(items) {
  const amt = it => amountOfBalance(it.balance);
  const rank = it => amt(it) != null ? 0 : it.balance === 'Not eligible' ? 1 : 2;
  const sorted = [...items].sort((a, b) => rank(a) - rank(b) || (amt(b) || 0) - (amt(a) || 0));
  const lines = ['Patient Name,Patient Link,Balance'];
  for (const it of sorted) {
    const c = it.balance || it.skip || '';
    lines.push([csvCell(it.name), csvCell(it.patientId ? patientProfileUrl(it.patientId) : ''), csvCell(c)].join(','));
  }
  const stamp = localStamp();
  const file = path.join(principleCapture.reportsFolder(), `checked-patients__${stamp}.csv`);
  fs.writeFileSync(file, '\ufeff' + lines.join('\r\n'), 'utf8');
  return file;
}

let lastRunWasFile = false;

async function runManual(itemsIn) {
  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };
  const say = (text) => { beat(text); send('runall-progress', { text }); };
  const fail = (message) => {
    runAllState.running = false;
    setRunStatus('cdbs', 'failed', message);
    try { const hsx = loadHealthState(); hsx.cdbsLastRun = { when: new Date().toISOString(), outcome: 'failed: ' + message }; saveHealthState(hsx); } catch (e2) {}
    appJournal('RUN FAILED: ' + message);
    send('runall-finished', { ok: false, message });
    alarmPing('CDBS run problem: ' + message);
  };

  say('Checking Principle login...');
  const login = await engine.checkLoggedIn();
  if (!login.ok) {
    sendStatus('needs-login');
    await engine.promptLogin();
    say('Principle needs you — log in in the window that just opened.');
    const ok = await waitForPrincipleLogin();
    if (!ok || runAllState.stopRequested) return fail('Principle login was not completed, so nothing was run.');
  }
  sendStatus('connected');

  say('Checking PRODA login...');
  const prodaOk = await ensureProdaLoggedIn(say);
  if (!prodaOk || runAllState.stopRequested) return fail('PRODA login was not completed, so nothing was run.');

  const linked = itemsIn.filter(i => i.patientId);
  if (!linked.length) return fail('No rows with patient links were found in the loaded file.');

  say(`Reading Medicare details for ${linked.length} patient${linked.length === 1 ? '' : 's'}...`);
  const col = await collectMedicareCore(
    linked,
    (i, total, item, status, detail) => {
      if (status === 'working') say(`Medicare details — patient ${i + 1} of ${total}...`);
      else if (status === 'failed') say(`Medicare details — patient ${i + 1} of ${total} (last: ${detail})`);
    },
    () => runAllState.stopRequested
  );
  if (col.aborted === 'not-logged-in') return fail('Principle signed out partway through. Log back in and run again — nothing has been written.');
  if (runAllState.stopRequested) return fail('Stopped. Nothing has been written.');

  {
    const needHeal = col.rows.some(r => !(r.status === 'done' && r.number && r.irn) && r.dob);
    if (needHeal) {
      const pw = await ensureProdaLoggedIn((t) => runlog('card lookup prep: ' + t));
      if (pw) await healNoCardRows(col.rows);
      else fsTell('no-card lookups SKIPPED - PRODA not available; affected patients are flagged on the action list');
    }
  }

  { const stC = loadPatientState();
    for (const r of col.rows) {
      if (r.status === 'done' && r.number && r.irn) {
        const ch = chronicSkip(stC, r.patientId);
        if (ch) { r.status = 'skipped'; r.skip = ch; }
      }
    } }
  const checkable = col.rows.filter(r => r.status === 'done' && r.number && r.irn);
  const uncheckable = col.rows.filter(r => !(r.status === 'done' && r.number && r.irn));

  let balRows = [];
  if (checkable.length) {
    const deskRecover = async (why) => { say(why); return await ensureProdaLoggedIn(say); };
    const bal = await balanceCore(
      checkable,
      (i, total, item, status, detail) => {
        if (status === 'entering') say('Going into HPOS...');
        else if (status === 'paused') say(`Paused: PRODA signed you out. Log back in and I will carry on from patient ${i + 1}.`);
        else if (status === 'working') say(`Balances — patient ${i + 1} of ${total}...`);
        else if (status === 'failed') say(`Balances — patient ${i + 1} of ${total} (last: ${detail})`);
      },
      runAllState,
      deskRecover
    );
    if (bal.aborted) {
      proda.openVisible();
      return fail('PRODA balances could not run: ' + balanceReasonText(bal.aborted) + '. Nothing has been written.');
    }
    balRows = bal.rows;

    const stR = loadPatientState();
    for (const r of balRows) {
      if (r.status === 'done') {
        const e = stR[r.patientId] || {};
        e.name = r.name;
        e.lastChecked = new Date().toISOString();
        e.lastBalanceText = r.balanceText;
        stR[r.patientId] = e;
        mirrorBalanceToItem(r.patientId, r.balanceText);
      }
    }
    savePatientState(stR);
  }

  for (const u of uncheckable) if (!u.skip) u.skip = u.reason ? medicareReasonText(u.reason) : 'could not be checked';
  const merged = [...balRows, ...uncheckable];
  let file = null;
  try { file = writeBalancesCsv(merged); } catch (e) { /* ignore */ }

  const finalPreview = buildPreviewFromRows(merged);
  let callList = null;
  let sortedPdf = null;
  try {
    const stF = updateFailureMemory(finalPreview.items);
    sortedPdf = await writeSortedPdf(finalPreview.items, stF);
    if (sortedPdf && sortedPdf.buckets && !lastRunWasFile) { await updateActionList(sortedPdf.buckets); sendUi('actions-changed', {}); }
    clearWasFixedFlags(stF);
    callList = writeCallListCsv(finalPreview.items);
  } catch (e) { /* the run still counts */ }

  runAllState.running = false;
  {
    const pa = pinAudit;
    const pinLine = pa.written
      ? pa.written + ' notes written, ' + pa.pinned + ' pinned' + (pa.failed.length ? ', ' + pa.failed.length + ' PIN FAILED (' + pa.failed.join(', ') + ')' : '')
      : 'no notes written';
    runlog('pin summary: ' + pinLine);
    if (pa.failed.length) alarmPing('Pin check: ' + pa.failed.length + ' note(s) written but NOT pinned: ' + pa.failed.join(', ') + '. Pin them by hand in Principle.');
  }
  setRunStatus('cdbs', 'ok', finalPreview.readyCount + ' ready, ' + finalPreview.skipCount + ' skipped');
  send('runall-finished', {
    ok: true,
    preview: finalPreview,
    file,
    callList,
    sortedPdf: sortedPdf && sortedPdf.file,
    readyCount: finalPreview.readyCount,
    failCount: finalPreview.skipCount,
  });
}

// ---------------------------------------------------------------------
// FIND A MEDICARE NUMBER — single search and bulk file run
// ---------------------------------------------------------------------
ipcMain.handle('find-number', async (event, p) => {
  if (runAllState.running || runState.running || collectState.running || balanceState.running || genState.running || morningState.running) {
    return { ok: false, error: 'Something is already running.' };
  }
  runAllState = { running: true, stopRequested: false, waitingForLogin: false };
  const say = (t) => sendUi('checkone-progress', { text: t });
  try {
    const dob8 = dob8Of(p.dob);
    if (!dob8) return { ok: false, error: 'The date of birth could not be read — use dd/mm/yyyy.' };
    say('Connecting to PRODA...');
    const okP = await ensureProdaLoggedIn(say);
    if (!okP) return { ok: false, error: 'PRODA login was not completed.' };
    say('Searching... usually about 20 seconds.');
    const res = await proda.findMedicareNumber({ firstName: String(p.firstName || '').trim(), surname: String(p.surname || '').trim(), dob8 });
    if (!res.ok) return { ok: false, error: 'The search did not work (' + (res.reason || 'unknown') + ').' };
    return { ok: true, matches: res.matches };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    runAllState.running = false;
  }
});

ipcMain.handle('pick-find-csv', async () => {
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose the patient list',
    filters: [{ name: 'CSV files', extensions: ['csv'] }],
    properties: ['openFile'],
  });
  if (picked.canceled || !picked.filePaths.length) return { ok: false, cancelled: true };
  try {
    const rows = csvToRows(fs.readFileSync(picked.filePaths[0]).toString('utf8'));
    if (rows.length < 2) return { ok: false, error: 'The file has no rows in it.' };
    const objects = rowsToObjects(rows);
    const headers = Object.keys(objects[0]);
    const nameKey = headers.find(h => /patient name|^name$/i.test(h));
    const linkKey = headers.find(h => /link/i.test(h));
    const dobKey = headers.find(h => /birth|dob/i.test(h));
    if (!nameKey) return { ok: false, error: 'No "Patient Name" column was found.' };
    const items = [];
    let skippedNoName = 0;
    for (const o of objects) {
      const name = (o[nameKey] || '').trim();
      if (!name) { skippedNoName++; continue; }
      items.push({
        name,
        patientId: linkKey ? patientIdFromLink(o[linkKey] || '') : null,
        dob: dobKey ? (o[dobKey] || '').trim() : '',
      });
    }
    const withDob = items.filter(i => i.dob && dob8Of(i.dob)).length;
    const fetchable = items.filter(i => !(i.dob && dob8Of(i.dob)) && i.patientId).length;
    const unsearchable = items.length - withDob - fetchable;
    return { ok: true, file: path.basename(picked.filePaths[0]), items, count: items.length, withDob, fetchable, unsearchable, skippedNoName };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

async function runFindFile(items) {
  const say = (t) => sendUi('find-progress', { text: t });
  const done = (payload) => sendUi('find-finished', payload);
  const results = [];
  let principleChecked = false;

  say('Connecting to PRODA...');
  const okP = await ensureProdaLoggedIn(say);
  if (!okP) { runAllState.running = false; return done({ ok: false, message: 'PRODA login was not completed.' }); }

  for (let i = 0; i < items.length; i++) {
    if (runAllState.stopRequested) break;
    const it = items[i];
    say('Patient ' + (i + 1) + ' of ' + items.length + '...');
    let dob8 = dob8Of(it.dob);

    if (!dob8 && it.patientId) {
      if (!principleChecked) {
        const login = await engine.checkLoggedIn();
        if (!login.ok) { results.push({ ...it, status: 'Needs checking', detail: 'DOB needed but Principle is not logged in' }); continue; }
        principleChecked = true;
      }
      const dob = await engine.lookupDateOfBirth(it.name);
      dob8 = dob8Of(dob);
      if (dob8) it.dob = dob;
    }
    if (!dob8) { results.push({ ...it, status: 'Needs checking', detail: 'No usable date of birth' }); continue; }

    const nm = splitName(it.name);
    const res = await proda.findMedicareNumber({ firstName: nm.first, surname: nm.last, dob8 });
    if (!res.ok) { results.push({ ...it, status: 'Needs checking', detail: 'Search failed (' + (res.reason || 'unknown') + ')' }); continue; }
    if (!res.matches.length) { results.push({ ...it, status: 'No match', detail: 'PRODA found nobody with that name and date of birth' }); continue; }
    if (res.matches.length > 1) { results.push({ ...it, status: 'Needs checking', detail: res.matches.length + ' matches — pick by hand' }); continue; }
    const m = res.matches[0];
    results.push({ ...it, status: 'Found', number: m.cardNumber, irn: m.irn, expiry: m.expiry });
    if (it.patientId) {
      const stF = loadPatientState();
      const e = stF[it.patientId] || {};
      Object.assign(e, { name: it.name, number: m.cardNumber, irn: m.irn, expiry: m.expiry, dob: it.dob || e.dob, detailsAt: new Date().toISOString() });
      stF[it.patientId] = e;
      savePatientState(stF);
    }
    await new Promise(r => setTimeout(r, 800));
  }

  const lines = ['Patient Name,Patient Link,Medicare card number,IRN,Card expiry,Status,Detail'];
  for (const r of results) {
    lines.push([csvCell(r.name), csvCell(r.patientId ? patientProfileUrl(r.patientId) : ''), csvCell(r.number || ''), csvCell(r.irn || ''), csvCell(r.expiry || ''), csvCell(r.status), csvCell(r.detail || '')].join(','));
  }
  let file = null;
  try {
    const stamp = localStamp();
    file = path.join(principleCapture.reportsFolder(), `found-numbers__${stamp}.csv`);
    fs.writeFileSync(file, '\ufeff' + lines.join('\r\n'), 'utf8');
  } catch (e) { /* still report */ }

  runAllState.running = false;
  done({
    ok: true,
    file,
    found: results.filter(r => r.status === 'Found').length,
    noMatch: results.filter(r => r.status === 'No match').length,
    check: results.filter(r => r.status === 'Needs checking').length,
  });
}

ipcMain.handle('find-file', async (event, items) => {
  if (runAllState.running || runState.running || collectState.running || balanceState.running || genState.running || morningState.running) {
    return { ok: false, error: 'Something is already running.' };
  }
  runAllState = { running: true, stopRequested: false, waitingForLogin: false };
  runFindFile(items || []);
  return { ok: true };
});

// Single-patient lookup for the "parent on the phone" moments. Display
// only — nothing is written, but the check is remembered like any other.
ipcMain.handle('check-one', async (event, p) => {
  if (runAllState.running || runState.running || collectState.running || balanceState.running || genState.running || morningState.running) {
    return { ok: false, error: 'Something is already running.' };
  }
  runAllState = { running: true, stopRequested: false, waitingForLogin: false };
  const say = (text) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('checkone-progress', { text });
  };
  try {
    say('Connecting to PRODA...');
    const okP = await ensureProdaLoggedIn(say);
    if (!okP) return { ok: false, error: 'PRODA login was not completed.' };
    say('Checking... usually about 30 seconds.');
    const ent = await proda.enterHpos();
    if (!ent.ok) return { ok: false, error: 'Could not reach the CDBS check (' + balanceReasonText(ent.reason) + ').' };
    proda.parkOffscreen();
    const res = await proda.checkBalance({
      cardNumber: String(p.number || '').replace(/\s+/g, ''),
      irn: String(p.irn || '').trim(),
      firstName: String(p.firstName || '').trim(),
    });
    const cls = classifyProda(res.text || '');
    if (cls.kind === 'balance') return { ok: true, kind: 'balance', value: cls.value, raw: res.text || '' };
    if (cls.kind === 'not-eligible') return { ok: true, kind: 'not-eligible', raw: res.text || '' };
    if (cls.kind === 'invalid') return { ok: true, kind: 'invalid', raw: res.text || '' };
    return { ok: false, error: res.text ? ('PRODA said something unrecognised: ' + String(res.text).slice(0, 120)) : ('No answer came back (' + balanceReasonText(res.reason, res.detail) + ').') };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    runAllState.running = false;
  }
});

ipcMain.handle('run-file', async (event, items) => {
  if (runAllState.running || runState.running || collectState.running || balanceState.running || genState.running || morningState.running) {
    return { ok: false, error: 'Something is already running.' };
  }
  runAllState = { running: true, stopRequested: false, waitingForLogin: false };
  lastRunWasFile = true;
  runlogStart('file-check');
  runManual(items || []);
  return { ok: true };
});

// ---------------------------------------------------------------------
// ACTION LIST — the human to-do list. Items arrive from runs and STAY
// until a person ticks them, however many days that takes. Ticked items
// rest in "done" for a fortnight as the audit trail.
// (Stored locally for now; two-machine sync is the flagged next step.)
// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// ACTION LIST SYNC — Firestore (REST, no SDK needed) so every machine
// and the nurse's browser page share ONE live list. Local file remains
// the offline cache. Collection: cdbsActions in inv-c20f7.
// ---------------------------------------------------------------------
const FB_API_KEY = 'AIzaSyBFrr_cvA4j2RA_Ern6z6AJk-pahPv2qHU';
const FB_PROJECT = 'inv-c20f7';
// Every cloud call gets a hard 20-second ceiling: a hung socket can no
// longer stall the sync loop, the note worker, or a guard check.
async function fetchT(url, opts) {
  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), 20 * 1000);
  try { return await fetch(url, { ...(opts || {}), signal: ac.signal }); }
  finally { clearTimeout(tm); }
}
let lastNetTold = 0;
function netTell(what) {
  if (Date.now() - lastNetTold < 10 * 60 * 1000) return;   // one shout per 10 min
  lastNetTold = Date.now();
  appJournal('cloud trouble: ' + String(what).slice(0, 120));
}
const FS_BASE = 'https://firestore.googleapis.com/v1/projects/' + FB_PROJECT + '/databases/(default)/documents/cdbsActions';
let fbTok = { token: null, exp: 0 };

let fbTokInFlight = null;
// Cloud-pipe health: remembered for the UI banner and the journal.
// Failures are throttled to one journal line per 10 minutes per kind.
const fsHealth = { ok: null, lastError: '', lastTold: {} };
function fsTell(line) {
  const kind = line.slice(0, 24);
  const now = Date.now();
  if (fsHealth.lastTold[kind] && now - fsHealth.lastTold[kind] < 10 * 60 * 1000) return;
  fsHealth.lastTold[kind] = now;
  appJournal(line);
}

async function fbToken() {
  if (fbTok.token && Date.now() < fbTok.exp) return fbTok.token;
  if (fbTokInFlight) return fbTokInFlight;
  fbTokInFlight = (async () => {
    try {
  // Named app account first (desktop@...) - the anonymous door is only a
  // fallback for the transition, and dies when the final rules publish.
  const ms = loadMorningSettings();
  let r, j = null;
  if (ms.fbEmail && ms.fbPassword) {
    r = await fetchT('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + FB_API_KEY, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ms.fbEmail, password: ms.fbPassword, returnSecureToken: true }),
    });
    j = await r.json();
    if (!j.idToken) {
      fsTell('app cloud sign-in FAILED for ' + ms.fbEmail + ' (' + ((j.error && j.error.message) || r.status) + ') - falling back to anonymous until the password is fixed in settings');
      j = null;
    }
  }
  if (!j) {
  r = await fetchT('https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + FB_API_KEY, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }),
  });
  j = await r.json();
  }
  if (!j.idToken) {
    const why = (j.error && (j.error.message || JSON.stringify(j.error))) || ('HTTP ' + r.status);
    fsHealth.lastError = 'auth: ' + String(why).slice(0, 140);
    fsTell('firestore AUTH FAILED: ' + fsHealth.lastError);
    throw new Error('anonymous auth failed: ' + why);
  }
  fbTok = { token: j.idToken, exp: Date.now() + 50 * 60 * 1000 };
  return fbTok.token;
    } finally { fbTokInFlight = null; }
  })();
  return fbTokInFlight;
}

const ACTION_KEYS = ['patientId', 'name', 'kind', 'text', 'context', 'token', 'createdAt', 'doneAt', 'doneNote', 'updatedAt', 'section', 'due', 'assignee', 'repeat', 'stageDentist', 'stageReception', 'noteText', 'howTo', 'escalated', 'outcome', 'attempts', 'principleWritten', 'plink', 'mobile', 'feeSched', 'lastVisit', 'notesLog', 'dob', 'deleted', 'balanceText', 'balanceChecked', 'parked', 'parkedAt', 'chaseFlag', 'viewsTag', 'viewsList', 'viewsRules'];
function itemToFields(it) {
  const f = {};
  for (const k of ACTION_KEYS) if (it[k] != null && it[k] !== '') f[k] = { stringValue: String(it[k]) };
  if (it.auto) f.auto = { booleanValue: true };
  if (!f.updatedAt) f.updatedAt = { stringValue: new Date().toISOString() };
  return f;
}
function fieldsToItem(id, f) {
  const it = { id };
  for (const k of ACTION_KEYS) if (f[k] && f[k].stringValue != null) it[k] = f[k].stringValue;
  if (f.auto && f.auto.booleanValue) it.auto = true;
  return it;
}
// Incremental sync: the full list downloads once per boot; afterwards
// only items CHANGED since the last look are fetched (updatedAt is ISO,
// so string order is time order). Cuts reads ~100x — the quota lesson.
const itemsStore = { byId: null, since: '' };

async function fsFullPull(t) {
  let items = [], pageToken = '';
  do {
    const r = await fetchT(FS_BASE + '?pageSize=300' + (pageToken ? '&pageToken=' + pageToken : ''), { headers: { Authorization: 'Bearer ' + t } });
    const j = await r.json();
    if (j.error) throw Object.assign(new Error(j.error.message || 'firestore error'), { fsErr: (j.error.status || '') + ' ' + (j.error.message || '') });
    for (const d of (j.documents || [])) items.push(fieldsToItem(d.name.split('/').pop(), d.fields || {}));
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return items;
}

async function fsChangedSince(t, sinceIso) {
  const parent = 'https://firestore.googleapis.com/v1/projects/' + FB_PROJECT + '/databases/(default)/documents';
  const r = await fetchT(parent + ':runQuery', {
    method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: 'cdbsActions' }],
      where: { fieldFilter: { field: { fieldPath: 'updatedAt' }, op: 'GREATER_THAN', value: { stringValue: sinceIso } } },
    } }),
  });
  const rows = await r.json();
  if (rows.error) throw Object.assign(new Error(rows.error.message || 'firestore error'), { fsErr: (rows.error.status || '') + ' ' + (rows.error.message || '') });
  const out = [];
  for (const row of rows) if (row.document) out.push(fieldsToItem(row.document.name.split('/').pop(), row.document.fields || {}));
  return out;
}

// Duplicate sweep: items sharing a (kind, token) identity are the same
// real-world thing minted twice (the island-machine accident). The richest
// copy survives - human work (outcomes, notes, stages) is sacred; ties go
// to the oldest. Losers get tombstones.
// Balance results mirror onto the matching Reactivation CDBS card in the
// shared list, so the work-from-home page can wear the same chips.
function mirrorBalanceToItem(patientId, balanceText) {
  try {
    if (!itemsStore.byId) return;
    const it = Object.values(itemsStore.byId).find(x => x.kind === 'reactcdbs' && x.patientId === patientId && !x.deleted);
    if (!it) return;
    it.balanceText = String(balanceText || '').slice(0, 200);
    it.balanceChecked = new Date().toISOString();
    fsPush(it);
  } catch (e) { /* mirror is best-effort */ }
}

function dedupeSweep() {
  if (!itemsStore.byId) return 0;
  const groups = {};
  for (const it of Object.values(itemsStore.byId)) {
    if (it.deleted || !it.token || !it.kind) continue;
    const key = it.kind + '|' + (it.patientId || '') + '|' + it.token;
    (groups[key] = groups[key] || []).push(it);
  }
  let cleaned = 0;
  for (const g of Object.values(groups)) {
    if (g.length < 2) continue;
    const rich = (it) => (it.outcome ? 4 : 0) + (it.doneAt ? 2 : 0) + (it.notesLog ? 2 : 0)
      + (it.principleWritten ? 1 : 0) + (it.stageDentist || it.stageReception ? 1 : 0) + (it.noteText ? 1 : 0);
    g.sort((a, b) => (rich(b) - rich(a)) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    for (const loser of g.slice(1)) {
      loser.deleted = '1';
      fsDelete(loser.id);
      cleaned++;
    }
  }
  // Resurrection pass: earlier sweeps grouped rebook items too loosely and
  // tombstoned real patients. Any deleted item with no LIVING member of its
  // true identity group was wrongly killed - restore it.
  const living = new Set();
  for (const it of Object.values(itemsStore.byId)) {
    if (!it.deleted && it.token && it.kind) living.add(it.kind + '|' + (it.patientId || '') + '|' + it.token);
  }
  let revived = 0;
  for (const it of Object.values(itemsStore.byId)) {
    if (it.deleted !== '1' || !it.token || !it.kind) continue;
    const key = it.kind + '|' + (it.patientId || '') + '|' + it.token;
    if (!living.has(key)) {
      delete it.deleted;
      fsPush(it);
      living.add(key);
      revived++;
    }
  }
  if (revived) appJournal('resurrection: restored ' + revived + ' item(s) wrongly removed by the earlier sweep');
  if (cleaned) appJournal('duplicate sweep: cleaned ' + cleaned + ' duplicate item(s) - richest copy kept');
  return cleaned;
}

async function fsPull(full) {
  try {
    const t = await fbToken();
    if (full || !itemsStore.byId) {
      const items = await fsFullPull(t);
      itemsStore.byId = {};
      let hi = '';
      for (const it of items) { itemsStore.byId[it.id] = it; if ((it.updatedAt || '') > hi) hi = it.updatedAt || ''; }
      itemsStore.since = hi || new Date().toISOString();
      dedupeSweep();
      if (fsHealth.ok !== true) appJournal('shared list: connected (' + items.length + ' items, full sync)');
    } else {
      // 2-minute overlap absorbs clock skew between machines; the merge
      // is idempotent so re-seeing an item is free.
      const cushion = new Date(Date.parse(itemsStore.since) - 2 * 60 * 1000).toISOString();
      const changed = await fsChangedSince(t, cushion);
      for (const it of changed) {
        itemsStore.byId[it.id] = it;
        if ((it.updatedAt || '') > itemsStore.since) itemsStore.since = it.updatedAt;
      }
    }
    fsHealth.ok = true;
    return Object.values(itemsStore.byId).filter(it => !it.deleted);
  } catch (e) {
    fsHealth.ok = false;
    fsHealth.lastError = 'pull: ' + (e.fsErr || String(e).slice(0, 140));
    fsTell('firestore PULL FAILED: ' + fsHealth.lastError.slice(0, 160));
    throw e;
  }
}

// Tombstones older than a week are purged for real (once daily, worker
// only) so the staff page's live snapshot never bloats.
let lastPurgeDay = '';
setInterval(async () => {
  try {
    if (!isWorker() || lastPurgeDay === localToday()) return;
    lastPurgeDay = localToday();
    if (!itemsStore.byId) return;
    const t = await fbToken();
    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
    let purged = 0;
    for (const it of Object.values(itemsStore.byId)) {
      if (it.deleted === '1' && (it.updatedAt || '') < cutoff) {
        await fetchT(FS_BASE + '/' + encodeURIComponent(it.id), { method: 'DELETE', headers: { Authorization: 'Bearer ' + t } });
        delete itemsStore.byId[it.id];
        purged++;
      }
    }
    // Done for over a year: removed from the cloud too. The drawers only
    // ever show 14-180 days, so nothing visible changes - the collection
    // just stops growing without bound.
    const doneCut = new Date(Date.now() - 365 * 86400000).toISOString();
    let aged = 0;
    for (const it of Object.values(itemsStore.byId)) {
      if (it.doneAt && it.doneAt < doneCut) {
        await fetchT(FS_BASE + '/' + encodeURIComponent(it.id), { method: 'DELETE', headers: { Authorization: 'Bearer ' + t } });
        delete itemsStore.byId[it.id];
        aged++;
      }
    }
    if (aged) appJournal('year-old done items aged out of the cloud: ' + aged);
    try {
      const runs = await fleetRuns();
      const rcut = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
      let rpurged = 0;
      for (const r2 of runs) {
        if (r2.day && r2.day < rcut) {
          await fetchT(FS_ROOT + '/runLedger/' + encodeURIComponent(r2.jobId + '_' + r2.day), { method: 'DELETE', headers: { Authorization: 'Bearer ' + t } });
          rpurged++;
        }
      }
      if (rpurged) appJournal('run-history: ' + rpurged + ' entries older than 45 days purged');
    } catch (e6) { /* next sweep */ }
    if (purged) appJournal('tombstone purge: ' + purged + ' old deleted item(s) removed for good');
  } catch (e) { /* tomorrow */ }
}, 3600 * 1000);

// A full resync every 6 hours heals anything the increments missed.
setInterval(() => { fsPull(true).catch(() => { /* told already */ }); }, 6 * 3600 * 1000);
function fsPush(it) {
  it.updatedAt = new Date().toISOString();
  if (itemsStore.byId) itemsStore.byId[it.id] = { ...it };
  return fbToken().then(t => fetch(FS_BASE + '/' + encodeURIComponent(it.id), {
    method: 'PATCH', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: itemToFields(it) }),
  })).then(async (r) => {
    if (!r.ok) {
      let why = 'HTTP ' + r.status;
      try { const j = await r.json(); why = (j.error && (j.error.status + ' ' + j.error.message)) || why; } catch (e2) { /* keep */ }
      fsHealth.ok = false; fsHealth.lastError = 'push: ' + String(why).slice(0, 140);
      fsTell('firestore PUSH FAILED: ' + fsHealth.lastError);
    }
    return r;
  }).catch(e => { fsHealth.ok = false; fsTell('firestore PUSH FAILED: ' + String(e).slice(0, 120)); });
}
function fsDelete(id) {
  // Soft delete: a tombstone other machines' incremental syncs can see.
  return fbToken().then(t => fetch(FS_BASE + '/' + encodeURIComponent(id) + '?updateMask.fieldPaths=deleted&updateMask.fieldPaths=updatedAt', {
    method: 'PATCH', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { deleted: { stringValue: '1' }, updatedAt: { stringValue: new Date().toISOString() } } }),
  })).catch(e => runlog('action sync delete failed: ' + String(e).slice(0, 80)));
}

// ---- Shared run-ledger: both computers coordinate through Firestore so
// a job runs once per day clinic-wide. First claimant wins atomically
// (create-only write fails if the day is already claimed).
const FS_ROOT = 'https://firestore.googleapis.com/v1/projects/' + FB_PROJECT + '/databases/(default)/documents';
const MACHINE = (() => { try { return require('os').hostname(); } catch (e) { return 'this-pc'; } })();
const APP_BUILD = '2026-08-10.4';

// ---------------------------------------------------------------------
// LIVE DEBUG FEED: today's journal + runlogs, patient names reduced to
// initials, published to a Firestore doc behind an unguessable secret -
// one stable link per machine that always shows NOW. Nothing here can
// hurt a run: every failure is swallowed and merely journaled.
function debugFeedSecret() {
  const s = loadAutoJobs();
  if (!s.debugSecret) {
    s.debugSecret = require('crypto').randomBytes(18).toString('hex');
    saveAutoJobs(s);
  }
  return s.debugSecret;
}
function debugFeedUrl() {
  return FS_ROOT + '/debugLogs/' + debugFeedSecret() + '_' + encodeURIComponent(MACHINE) + '_log';
}
function redactNames(text) {
  try {
    const names = new Set();
    const st = loadPatientState();
    for (const k of Object.keys(st)) if (st[k] && st[k].name) names.add(String(st[k].name).trim());
    try { for (const it of (loadActions().items || [])) if (it.name) names.add(String(it.name).trim()); } catch (e) { /* actions optional */ }
    for (const full of names) {
      if (full.length < 6 || !full.includes(' ')) continue;
      const parts = full.split(/\s+/);
      const initials = parts.map((p) => p[0] + '.').join(' ');
      // Whitespace-insensitive so "Demi  Schneider" (double space in the
      // report) still masks; each part regex-escaped so names containing
      // brackets like "((dental))" are safe.
      const rx = new RegExp(parts.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'g');
      text = text.replace(rx, initials);
    }
  } catch (e) { /* redaction is best-effort; the secret link still protects */ }
  return text;
}
let debugFeedLastPush = 0;
async function uploadDebugFeed(force) {
  try {
    if (!force && Date.now() - debugFeedLastPush < 60 * 1000) return;
    debugFeedLastPush = Date.now();
    const today = localToday();
    const folder = principleCapture.reportsFolder();
    let blob = '';
    try {
      const todays = fs.readdirSync(folder)
        .filter(f => (f.startsWith('runlog__' + today) || f === 'journal__' + today + '.txt') && !f.includes('app-log'))
        .sort();
      blob = todays.map(f => '\n\n########## ' + f + ' ##########\n' + fs.readFileSync(path.join(folder, f), 'utf8')).join('');
    } catch (e) { blob = '(no logs found for today)'; }
    if (blob.length > 750 * 1024) blob = '...(older lines trimmed)...\n' + blob.slice(-750 * 1024);
    blob = redactNames(blob);
    let stats = [];
    try {
      const runs = await fleetRuns();
      stats = runs.filter(r => r.machine === MACHINE && r.day === today)
        .map(r => ({ job: r.jobId, at: r.at, name: r.name, outcome: String(r.outcome || '').slice(0, 300) }));
    } catch (e) { /* stats optional */ }
    const t = await fbToken();
    const fields = {
      log: { stringValue: blob },
      stats: { stringValue: JSON.stringify({ build: APP_BUILD, machine: MACHINE, day: today, updatedAt: new Date().toISOString(), runs: stats }) },
      machine: { stringValue: MACHINE },
      day: { stringValue: today },
      build: { stringValue: APP_BUILD },
      updatedAt: { stringValue: new Date().toISOString() },
    };
    const mask = Object.keys(fields).map(f => 'updateMask.fieldPaths=' + f).join('&');
    const r = await fetchT(debugFeedUrl() + '?' + mask, {
      method: 'PATCH', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    if (!r.ok) appJournal('debug feed: upload failed HTTP ' + r.status);
  } catch (e) { appJournal('debug feed: ' + String(e).slice(0, 90)); }
}
setInterval(() => { uploadDebugFeed(false).catch(() => {}); }, 60 * 60 * 1000);
ipcMain.handle('app-build', () => ({ build: APP_BUILD, machine: MACHINE }));

ipcMain.handle('debug-feed-link', async () => {
  await uploadDebugFeed(true).catch(() => {});
  return { url: debugFeedUrl(), machine: MACHINE, build: APP_BUILD };
});

// One-click, AI-agnostic debug prompt: the full audit procedure with THIS
// machine's live log link, build and name baked in - paste into any AI.
const DEFAULT_DEBUG_PROMPT = [
'AUDIT LAUNCHER - SDT Reception',
'',
'Adopt the role and follow the FULL procedure in AUDIT-PROMPT.md at the root of my private GitHub repo ipuvan86-netizen/sdt-reception (branch main). Fetch that file FIRST and follow it exactly, including its Step 0 intake interview. If you cannot access the repo, say so and I will attach the files - never analyse from assumptions.',
'',
'THIS MACHINE: {{MACHINE}} on build {{BUILD}}.',
'THIS MACHINE\'S LIVE LOG: {{LOG_URL}}',
'(DEBUGGING.md in the repo lists every machine\'s log link - the procedure tells you when to fetch the others. If any feed\'s build differs from {{BUILD}}, STOP and tell me before analysing.)',
'',
'=== MY BUG (fill what you can; the procedure\'s Step 0 interview asks for the rest) ===',
'FEATURE:',
'SYMPTOM (or "full audit"):',
'WHEN IT STARTED / HOW OFTEN:',
'ANYTHING RECENT THAT CHANGED:',
].join('\n');

// Forceful once-off (2026-08-08.1): any custom debug template saved before
// this build is cleared ONCE, so every machine picks up the new default.
// A template the user saves AFTER this build stamps the version and is
// never touched again.
const DEBUG_TPL_VERSION = 3;
function wipeOldDebugTemplate(s) {
  if (s.debugTplVersion === DEBUG_TPL_VERSION) return;
  if (s.debugPromptTemplate) {
    delete s.debugPromptTemplate;
    appJournal('debug template: old custom template cleared - the new default (build ' + APP_BUILD + ') is now in use');
  }
  s.debugTplVersion = DEBUG_TPL_VERSION;
  saveAutoJobs(s);
}

function renderDebugPrompt() {
  const s = loadAutoJobs();
  wipeOldDebugTemplate(s);
  const tpl = (s.debugPromptTemplate && String(s.debugPromptTemplate).trim()) ? s.debugPromptTemplate : DEFAULT_DEBUG_PROMPT;
  return String(tpl)
    .split('{{LOG_URL}}').join(debugFeedUrl())
    .split('{{MACHINE}}').join(MACHINE)
    .split('{{BUILD}}').join(APP_BUILD);
}

ipcMain.handle('debug-prompt', async () => {
  await uploadDebugFeed(true).catch(() => {});
  return { prompt: renderDebugPrompt(), machine: MACHINE, build: APP_BUILD };
});

ipcMain.handle('debug-template-get', () => {
  const s = loadAutoJobs();
  wipeOldDebugTemplate(s);
  const custom = !!(s.debugPromptTemplate && String(s.debugPromptTemplate).trim());
  return { template: custom ? s.debugPromptTemplate : DEFAULT_DEBUG_PROMPT, isCustom: custom };
});

ipcMain.handle('debug-template-save', (e, p) => {
  const s = loadAutoJobs();
  s.debugTplVersion = DEBUG_TPL_VERSION;
  if (p && p.reset) { delete s.debugPromptTemplate; saveAutoJobs(s); return { ok: true, reset: true }; }
  s.debugPromptTemplate = String((p && p.template) || '').slice(0, 20000);
  saveAutoJobs(s);
  appJournal('debug prompt template edited');
  return { ok: true };
});

// ---------------------------------------------------------------------
// FLEET SELF-UPDATE
//
// Reception (the computer with the .git folder beside the app) is the
// publisher: after a Pull + restart, the "Publish build to fleet" button
// uploads its own program files to the builds collection in Firestore.
// Every other computer checks that collection at startup: a newer build
// is downloaded, EVERY file integrity-checked against the manifest, the
// old files backed up beside the app, the new ones swapped in, and the
// app restarts itself. The manifest is written LAST, so the fleet can
// never act on a half-finished publish. node_modules, credentials and
// all per-machine settings are never touched. A build whose
// package.json changed is HELD (new components need the setup bat).
// One attempt per published build per day - a failed swap cannot loop.
// ---------------------------------------------------------------------
const FLEET_FILES = ['main.js', 'renderer.js', 'preload.js', 'index.html', 'proda-engine.js', 'principle-engine.js', 'principle-capture.js', 'principle-report.js', 'telegram.js', 'package.json'];
function sha256Of(buf) { return require('crypto').createHash('sha256').update(buf).digest('hex'); }
function isPublisher() { try { return fs.existsSync(path.join(__dirname, '.git')); } catch (e) { return false; } }

// True only when candidate is strictly NEWER than current (YYYY-MM-DD.N).
// Anything unparseable is never installed - the fleet must not downgrade
// or install a build it cannot reason about.
function buildNewerThan(candidate, current) {
  const parse = (s) => { const m = /^(\d{4}-\d{2}-\d{2})\.(\d+)$/.exec(String(s || '').trim()); return m ? [m[1], parseInt(m[2], 10)] : null; };
  const a = parse(candidate), b = parse(current);
  if (!a || !b) return false;
  return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
}

async function fleetPublish() {
  if (!isPublisher()) return { ok: false, error: 'This computer is not the publisher (no .git folder beside the app).' };
  const failed = (error) => { appJournal('fleet publish FAILED: ' + error); return { ok: false, error }; };
  try {
    const manifest = { build: APP_BUILD, machine: MACHINE, publishedAt: new Date().toISOString(), files: {} };
    for (const name of FLEET_FILES) {
      const p = path.join(__dirname, name);
      if (!fs.existsSync(p)) return failed(name + ' is missing beside the app - publish aborted, nothing was uploaded.');
      const content = fs.readFileSync(p, 'utf8');
      const hash = sha256Of(Buffer.from(content, 'utf8'));
      manifest.files[name] = { sha256: hash, size: Buffer.byteLength(content, 'utf8') };
      const fields = { name: { stringValue: name }, build: { stringValue: APP_BUILD }, sha256: { stringValue: hash }, content: { stringValue: content }, updatedAt: { stringValue: new Date().toISOString() } };
      const mask = Object.keys(fields).map(f => 'updateMask.fieldPaths=' + f).join('&');
      const r = await fetchT(FS_ROOT + '/builds/f_' + encodeURIComponent(name) + '?' + mask, {
        method: 'PATCH', headers: { Authorization: 'Bearer ' + (await fbToken()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields }),
      });
      if (!r.ok) return failed('upload of ' + name + ' failed (HTTP ' + r.status + ') - publish aborted; the fleet keeps the previous build.');
    }
    // Manifest LAST: the fleet only ever acts on a complete publish.
    const mf = { build: { stringValue: APP_BUILD }, machine: { stringValue: MACHINE }, publishedAt: { stringValue: manifest.publishedAt }, manifest: { stringValue: JSON.stringify(manifest) } };
    const mmask = Object.keys(mf).map(f => 'updateMask.fieldPaths=' + f).join('&');
    const r2 = await fetchT(FS_ROOT + '/builds/manifest?' + mmask, {
      method: 'PATCH', headers: { Authorization: 'Bearer ' + (await fbToken()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: mf }),
    });
    if (!r2.ok) return failed('manifest write failed (HTTP ' + r2.status + ') - the fleet keeps the previous build.');
    appJournal('fleet publish: build ' + APP_BUILD + ' uploaded (' + FLEET_FILES.length + ' files)');
    return { ok: true, build: APP_BUILD, files: FLEET_FILES.length };
  } catch (e) { return failed(String(e).slice(0, 140)); }
}
ipcMain.handle('fleet-publish', async () => await fleetPublish());
ipcMain.handle('fleet-role', () => ({ publisher: isPublisher(), build: APP_BUILD }));

function updateStatePath() { return path.join(app.getPath('userData'), 'fleet-update-state.json'); }

async function fleetSelfUpdate() {
  if (isPublisher()) return { acted: false };   // the publisher IS the source
  try {
    const t = await fbToken();
    const r = await fetchT(FS_ROOT + '/builds/manifest', { headers: { Authorization: 'Bearer ' + t } });
    if (!r.ok) return { acted: false };
    const j = await r.json();
    const manifest = JSON.parse((((j.fields || {}).manifest) || {}).stringValue || 'null');
    if (!manifest || !manifest.build || manifest.build === APP_BUILD) return { acted: false };
    if (!buildNewerThan(manifest.build, APP_BUILD)) {
      appJournal('fleet update: cloud holds build ' + manifest.build + ' which is not newer than this machine (' + APP_BUILD + ') - standing down');
      return { acted: false };
    }
    let st = {};
    try { st = JSON.parse(fs.readFileSync(updateStatePath(), 'utf8')); } catch (e) { /* first time */ }
    if (st.tried === manifest.build && Date.now() - (st.at || 0) < 20 * 3600 * 1000) {
      appJournal('fleet update: build ' + manifest.build + ' already attempted today - standing down (this machine still on ' + APP_BUILD + ')');
      return { acted: false };
    }
    fs.writeFileSync(updateStatePath(), JSON.stringify({ tried: manifest.build, at: Date.now() }), 'utf8');
    appJournal('fleet update: ' + APP_BUILD + ' -> ' + manifest.build + ' - downloading');
    // Everything to memory first; every hash verified before disk is touched.
    const incoming = {};
    for (const name of Object.keys(manifest.files)) {
      const fr = await fetchT(FS_ROOT + '/builds/f_' + encodeURIComponent(name), { headers: { Authorization: 'Bearer ' + (await fbToken()) } });
      if (!fr.ok) { appJournal('fleet update ABORTED: could not download ' + name + ' (HTTP ' + fr.status + ') - next start retries'); return { acted: false }; }
      const f = ((await fr.json()).fields) || {};
      const content = (f.content || {}).stringValue;
      if ((f.build || {}).stringValue !== manifest.build) { appJournal('fleet update ABORTED: ' + name + ' belongs to a different build - a publish may be mid-flight; next start retries'); return { acted: false }; }
      if (content == null || sha256Of(Buffer.from(content, 'utf8')) !== manifest.files[name].sha256) { appJournal('fleet update ABORTED: ' + name + ' failed its integrity check - nothing was changed'); return { acted: false }; }
      incoming[name] = content;
    }
    // A changed package.json means new components: hot-swapping would half-install.
    try {
      const localPkg = fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8');
      if (incoming['package.json'] != null && sha256Of(Buffer.from(localPkg, 'utf8')) !== manifest.files['package.json'].sha256) {
        appJournal('fleet update HELD: package.json changed in build ' + manifest.build + ' - run the setup bat once on this machine (new components are needed)');
        return { acted: false, held: true };
      }
    } catch (e) { /* unreadable local package.json - proceed */ }
    // Backup beside the app, then swap, then restart.
    const bdir = path.join(__dirname, 'backup-' + APP_BUILD + '-' + localStamp());
    try {
      fs.mkdirSync(bdir, { recursive: true });
      for (const name of Object.keys(incoming)) { const p = path.join(__dirname, name); if (fs.existsSync(p)) fs.copyFileSync(p, path.join(bdir, name)); }
    } catch (e) { appJournal('fleet update: backup failed (' + String(e).slice(0, 80) + ') - continuing; the cloud still holds every published build'); }
    for (const name of Object.keys(incoming)) fs.writeFileSync(path.join(__dirname, name), incoming[name], 'utf8');
    appJournal('fleet update: build ' + manifest.build + ' installed - restarting now');
    app.relaunch();
    app.exit(0);
    return { acted: true };
  } catch (e) { appJournal('fleet update: check failed (' + String(e).slice(0, 90) + ') - starting normally'); return { acted: false }; }
}

async function ledgerClaim(jobId) {
  const day = localToday();
  const docId = jobId + '_' + day;
  try {
    const t = await fbToken();
    const r = await fetchT(FS_ROOT + '/runLedger?documentId=' + encodeURIComponent(docId), {
      method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { machine: { stringValue: MACHINE }, at: { stringValue: new Date().toISOString() } } }),
    });
    if (r.ok) return { mine: true };
    if (r.status === 409) {
      const g = await fetchT(FS_ROOT + '/runLedger/' + encodeURIComponent(docId), { headers: { Authorization: 'Bearer ' + (await fbToken()) } });
      const j = g.ok ? await g.json() : null;
      const who = j && j.fields && j.fields.machine ? j.fields.machine.stringValue : 'the other computer';
      return { mine: false, who };
    }
    return { mine: true, unsure: true };   // ledger unreachable: run rather than silently skip
  } catch (e) { return { mine: true, unsure: true }; }
}

// Fleet run-memory: every run (per-job or RUN ALL) upserts its outcome
// into the ledger doc for the day, so every machine can show the true
// "last run" and a 20-day history.
async function ledgerReport(jobId, name, outcome) {
  try {
    const day = localToday();
    const docId = jobId + '_' + day;
    const t = await fbToken();
    const fields = {
      machine: { stringValue: MACHINE },
      at: { stringValue: new Date().toISOString() },
      name: { stringValue: String(name).slice(0, 80) },
      outcome: { stringValue: String(outcome).slice(0, 1400) },
    };
    const mask = Object.keys(fields).map(f => 'updateMask.fieldPaths=' + f).join('&');
    const r = await fetchT(FS_ROOT + '/runLedger/' + encodeURIComponent(docId) + '?' + mask, {
      method: 'PATCH', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
    if (!r.ok) netTell('run-history write failed: HTTP ' + r.status);
  } catch (e) { netTell('run-history write failed: ' + String(e).slice(0, 80)); }
  uploadDebugFeed(false).catch(() => {});
}

let fleetCache = { at: 0, data: null };
async function fleetRuns() {
  if (Date.now() - fleetCache.at < 60 * 1000 && fleetCache.data) return fleetCache.data;
  const out = [];
  try {
    const t = await fbToken();
    let pageToken = '';
    for (let p = 0; p < 4; p++) {
      const r = await fetchT(FS_ROOT + '/runLedger?pageSize=300' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''), {
        headers: { Authorization: 'Bearer ' + t },
      });
      if (!r.ok) break;
      const j = await r.json();
      for (const d of (j.documents || [])) {
        const id = d.name.split('/').pop();
        const us = id.lastIndexOf('_');
        if (us < 1) continue;
        const f = d.fields || {};
        out.push({
          jobId: id.slice(0, us),
          day: id.slice(us + 1),
          machine: f.machine ? f.machine.stringValue : '?',
          at: f.at ? f.at.stringValue : '',
          name: f.name ? f.name.stringValue : '',
          outcome: f.outcome ? f.outcome.stringValue : '',
        });
      }
      pageToken = j.nextPageToken || '';
      if (!pageToken) break;
    }
  } catch (e) { /* callers fall back to local */ }
  fleetCache = { at: Date.now(), data: out };
  return out;
}

ipcMain.handle('fleet-lastruns', async () => {
  const runs = await fleetRuns();
  const byJob = {};
  for (const r of runs) {
    if (!byJob[r.jobId] || (r.at || r.day) > (byJob[r.jobId].at || byJob[r.jobId].day)) byJob[r.jobId] = r;
  }
  return { byJob, today: localToday() };
});

ipcMain.handle('run-history', async () => {
  const runs = await fleetRuns();
  const cut = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
  const hist = runs.filter(r => (r.jobId === 'runall' || r.jobId === 'runall-sms') && r.day >= cut)
    .sort((a, b) => (b.at || b.day).localeCompare(a.at || a.day));
  return { hist };
});

// Cloud birthday memory: one doc per year, numbers as fields, so the
// one-text-per-year promise holds across machines.
async function cloudBirthdaySent(number) {
  try {
    const t = await fbToken();
    const r = await fetchT(FS_ROOT + '/sentBirthdays/' + new Date().getFullYear(), { headers: { Authorization: 'Bearer ' + t } });
    if (!r.ok) return false;
    const j = await r.json();
    return !!(j.fields && j.fields['n' + String(number).replace(/\D/g, '')]);
  } catch (e) { return false; }
}
async function cloudBirthdayMark(number) {
  try {
    const t = await fbToken();
    const f = 'n' + String(number).replace(/\D/g, '');
    const r = await fetchT(FS_ROOT + '/sentBirthdays/' + new Date().getFullYear() + '?updateMask.fieldPaths=' + f, {
      method: 'PATCH', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { [f]: { stringValue: localToday() } } }),
    });
    if (!r.ok) fsTell('birthday guard: cloud mark FAILED (HTTP ' + r.status + ') - the local file still protects this machine, but fix the Firestore rules for sentBirthdays');
  } catch (e) { /* local memory still guards */ }
}

function actionListPath() { return path.join(app.getPath('userData'), 'action-list.json'); }
function loadActions() {
  try { if (fs.existsSync(actionListPath())) return JSON.parse(fs.readFileSync(actionListPath(), 'utf8')); } catch (e) { /* ignore */ }
  return { items: [] };
}
function saveActions(a) {
  try { fs.writeFileSync(actionListPath(), JSON.stringify(a, null, 2), 'utf8'); } catch (e) { /* ignore */ }
}

async function updateActionList(buckets) {
  let a;
  try { a = { items: await fsPull() }; } catch (e) { a = loadActions(); }
  const changed = [];
  const now = new Date().toISOString();
  // age out done items past a fortnight — except unpaid invoices, whose
  // done records ARE the permanent "investigated" memory (shown 60 days,
  // kept forever for dedupe).
  a.items = a.items.filter(it => !it.doneAt || it.kind === 'unpaid' || it.kind === 'confirm-appt' || daysSince(it.doneAt) < 14);
  const openExists = (patientId, kind, token) => a.items.some(it =>
    !it.doneAt && it.patientId === patientId && it.kind === kind && (token == null || it.token === token));
  const recentlyDone = (patientId, kind, token) => a.items.some(it =>
    it.doneAt && it.patientId === patientId && it.kind === kind && it.token === token);

  for (const r of (buckets.low || [])) {
    const token = balanceToken(r.balance);
    if (r.patientId && !openExists(r.patientId, 'ring-low', token) && !recentlyDone(r.patientId, 'ring-low', token)) {
      a.items.push({ id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6), patientId: r.patientId, name: r.name,
        kind: 'ring-low', section: 'CDBS', text: 'Low balance (' + (r.balance || '') + ') - ring re fees before visit', context: 'appt ' + (r.appointmentDate || '—'), token, createdAt: now });
    }
  }
  for (const r of (buckets.notEligible || [])) {
    if (r.patientId && !openExists(r.patientId, 'ring-inel', 'Not eligible') && !recentlyDone(r.patientId, 'ring-inel', 'Not eligible')) {
      a.items.push({ id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6), patientId: r.patientId, name: r.name,
        kind: 'ring-inel', section: 'CDBS', text: 'Check account - privately billed for C/C before? If not, ring re not eligible', context: 'appt ' + (r.appointmentDate || '—'), token: 'Not eligible', createdAt: now });
    }
  }
  for (const r of (buckets.update || [])) {
    if (r.patientId && !openExists(r.patientId, 'update-card', r.foundNumber)) {
      a.items.push({ id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6), patientId: r.patientId, name: r.name,
        kind: 'update-card', section: 'CDBS', text: 'Update Medicare card in Principle', context: r.foundNumber + ' · IRN ' + (r.foundIrn || '?') + ' · exp ' + (r.foundExpiry || '?'), token: r.foundNumber, createdAt: now });
    }
  }
  for (const r of (buckets.unaccounted || [])) {
    if (!r.patientId && r.name) r.patientId = 'name:' + r.name;
    if (r.patientId && !openExists(r.patientId, 'investigate', null)) {
      a.items.push({ id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6), patientId: r.patientId, name: r.name,
        kind: 'investigate', section: 'CDBS',
        text: '⚠ CDBS check incomplete - this patient was not accounted for (' + String(r.skip || r.reason || 'unknown reason').slice(0, 60) + ')',
        context: 'appt ' + (r.appointmentDate || '—'), token: 'unaccounted', createdAt: now });
      fsTell('CDBS safety net: "' + r.name + '" was not accounted for by the morning run - flagged on the action list');
    }
  }
  for (const r of (buckets.fix || [])) {
    if (!r.patientId && r.name) r.patientId = 'name:' + r.name;   // no-link rows still tracked
    if (r.patientId && !openExists(r.patientId, 'investigate', null)) {
      a.items.push({ id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6), patientId: r.patientId, name: r.name,
        kind: 'investigate', section: 'CDBS',
        text: /no medicare card|rejected the details|invalid/i.test(r.skip || '')
          ? 'Check first name spelling & DOB in Principle (usual fix) - or ring family for the Medicare card'
          : 'Investigate - ' + (r.skip || 'check failed'),
        context: 'appt ' + (r.appointmentDate || '—') + (r.skip ? ' · ' + String(r.skip).slice(0, 70) : ''), token: 'fix', createdAt: now });
    }
  }
  // auto-clear: an investigate item whose patient's check now succeeds
  for (const it of a.items) {
    if (!it.doneAt && it.kind === 'investigate') {
      const fixedNow = (buckets.low || []).concat(buckets.fine || [], buckets.notEligible || [], buckets.update || []).some(r => r.patientId === it.patientId);
      if (fixedNow) { it.doneAt = now; it.doneNote = 'cleared automatically: check succeeded'; it.auto = true; }
    }
  }
  // auto-clear: an open "not eligible" ring whose patient now has a balance
  for (const it of a.items) {
    if (!it.doneAt && it.kind === 'ring-inel') {
      const nowEligible = (buckets.low || []).concat(buckets.fine || []).some(r => r.patientId === it.patientId);
      if (nowEligible) { it.doneAt = now; it.doneNote = 'cleared automatically: now eligible'; it.auto = true; }
    }
  }
  // Reword existing open items to the current phrasing (one-off migration,
  // harmless to repeat — only items whose text actually changes get pushed).
  for (const it of a.items) {
    if (it.doneAt) continue;
    let t = it.text;
    if (it.kind === 'ring-inel') t = 'Check account - privately billed for C/C before? If not, ring re not eligible';
    else if (it.kind === 'ring-low') t = it.text.replace(/^Ring re low balance \((.*)\)$/, 'Low balance ($1) - ring re fees before visit');
    else if (it.kind === 'rebook') t = 'No next visit booked';
    else if (it.kind === 'investigate' && /no medicare card|rejected the details|invalid/i.test(it.text)) {
      t = 'Check first name spelling & DOB in Principle (usual fix) - or ring family for the Medicare card';
    }
    if (t !== it.text) { it.text = t; changed.push(it); }
  }
  for (const it of a.items) {
    if ((it.createdAt === now || it.doneAt === now) && !changed.includes(it)) changed.push(it);
  }
  saveActions(a);
  for (const it of changed) { await fsPush(it); }
  runlog('action list: ' + changed.length + ' new/updated item(s) pushed to the shared list');
  return a;
}

const NURSE_PAGE_HTML = '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">\n<title>SDT Reception — Action List</title>\n<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"></script>\n<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js"></script>\n<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js"></script>\n<style>\nbody{font-family:-apple-system,\'Segoe UI\',system-ui,sans-serif;background:#f5f5f7;color:#1d1d1f;margin:0;padding:20px;max-width:680px;margin:0 auto;}\nh1{font-size:24px;letter-spacing:-.4px;} .card{background:#fff;border-radius:16px;padding:18px;margin-top:14px;box-shadow:0 1px 3px rgba(0,0,0,.06);}\n.row{display:flex;gap:8px;align-items:flex-start;padding:10px 0;border-bottom:1px solid #f0f0f3;flex-wrap:wrap;}\n.muted{color:#6e6e73;font-size:13px;} input[type=checkbox]{width:20px;height:20px;margin-top:2px;}\ninput[type=text],input[type=date],select{font:inherit;border:1px solid #d2d2d7;border-radius:10px;padding:7px 10px;font-size:13px;}\nbutton{font:inherit;border:none;border-radius:99px;padding:8px 16px;font-weight:600;cursor:pointer;background:#2F6B4F;color:#fff;}\n.pill{display:inline-block;border-radius:99px;padding:5px 12px;font-size:12px;font-weight:600;}\n.good{background:#e6f4ec;color:#1d7a46;} .warn{background:#fff4e0;color:#9a6b00;} .bad{background:#fdecec;color:#c0392b;}\n.chip{display:inline-block;background:#ececf0;border-radius:99px;padding:2px 10px;font-size:11px;font-weight:600;margin-left:6px;}\n.over{color:#c0392b;font-weight:600;} s{color:#a0a0a5;} details{margin-top:8px;} summary{cursor:pointer;font-weight:650;padding:6px 0;list-style:none;}\ndetails.dept>summary .ci::before{content:\'+\';}details.dept[open]>summary .ci::before{content:\'\\2212\';}.row{padding:11px 0;}</style></head><body>\n<h1>SDT Lists <span id="st" class="pill warn">connecting…</span></h1>\n<div id="tabs" style="display:none; gap:8px; margin:10px 0;">\n  <button onclick="setTab(\'list\')" id="tabList" style="border:none; border-radius:99px; padding:7px 16px; font-weight:700; cursor:pointer; background:#2F6B4F; color:#fff;">Action list</button>\n  <button onclick="setTab(\'react\')" id="tabReact" style="border:none; border-radius:99px; padding:7px 16px; font-weight:700; cursor:pointer; background:#f2f2f5; color:#3c3c43;">Reactivation calls</button>\n  <select id="vw" onchange="vwSel(this.value)" style="font:inherit;border:1px solid #d2d2d7;border-radius:9px;padding:6px 8px;max-width:170px;"></select>\n  <input type="text" id="rq" placeholder="search patients…" oninput="window._tab===\'react\'&&renderReactPage(window._all)" style="margin-left:auto; font:inherit; border:1px solid #d2d2d7; border-radius:9px; padding:6px 10px; width:210px;">\n</div>\n<div id="reactPage" style="display:none;"></div>\n<div id="gate" style="display:block; text-align:center; margin-top:40px;">\n  <div class="card" style="display:block;">\n    <div style="font-weight:700; font-size:17px;">Staff sign-in</div>\n    <div class="muted" id="gateMsg" style="margin:8px 0 14px;">Sign in with your clinic Google account to open the Action List.</div>\n    <button onclick="doSignIn()" style="font-size:14px;">Sign in with Google</button>\n  </div>\n</div>\n<div class="card" id="mainCard" style="display:none;">\n  \n  <div id="open" class="muted" style="margin-top:10px;">Loading…</div>\n  <details><summary class="muted">Done this fortnight (<span id="dc">0</span>)</summary><div id="done"></div></details>\n</div>\n<script>\nfirebase.initializeApp({apiKey:"AIzaSyBFrr_cvA4j2RA_Ern6z6AJk-pahPv2qHU",authDomain:"inv-c20f7.firebaseapp.com",projectId:"inv-c20f7"});\nconst db=firebase.firestore(); const esc=s=>String(s||\'\').replace(/[&<>"]/g,c=>({\'&\':\'&amp;\',\'<\':\'&lt;\',\'>\':\'&gt;\',\'"\':\'&quot;\'}[c]));\nconst age=iso=>{const d=Math.floor((Date.now()-Date.parse(iso))/86400000);return d<=0?\'today\':d===1?\'yesterday\':d+\' days\';};\nconst signedInUI=ok=>{document.getElementById(\'gate\').style.display=ok?\'none\':\'block\';document.getElementById(\'mainCard\').style.display=ok?\'block\':\'none\';};\nfunction doSignIn(){firebase.auth().signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch(e=>{document.getElementById(\'st\').className=\'pill bad\';document.getElementById(\'st\').textContent=\'sign-in failed\';});}\nvar _rt=null,_pend=null;\nfunction paintSoon(fn){_pend=fn;if(_rt)return;_rt=setTimeout(function(){_rt=null;var f=_pend;_pend=null;if(document.hidden){_pend=f;return;}f();},220);}\ndocument.addEventListener(\'visibilitychange\',function(){if(!document.hidden&&_pend){var f=_pend;_pend=null;f();}});\nfunction startData(){\n  db.collection(\'cdbsActions\').onSnapshot(function(snap){window._snapLast=snap;paintSoon(function(){paintSnap(snap);});});\n}\nfunction paintSnap(snap){\n    document.getElementById(\'st\').className=\'pill good\'; document.getElementById(\'st\').textContent=\'live\';\n    let items=[]; snap.forEach(d=>items.push({id:d.id,...d.data()}));\n    const tod=(()=>{const d=new Date();return d.getFullYear()+\'-\'+String(d.getMonth()+1).padStart(2,\'0\')+\'-\'+String(d.getDate()).padStart(2,\'0\');})();window._sch=window._sch||{};items=items.filter(function(i){return !i.deleted;});var _vc=items.find(function(i){return i.id===\'_viewsConfig\';})||{};window._vcfg={views:[],rules:{}};try{window._vcfg.views=JSON.parse(_vc.viewsList||\'[]\');}catch(e){}try{window._vcfg.rules=JSON.parse(_vc.viewsRules||\'{}\');}catch(e){}items=items.filter(function(i){return i.id!==\'_viewsConfig\'&&i.kind!==\'viewscfg\';});vwFill(items);window._all=items.slice();document.getElementById(\'tabs\').style.display=\'flex\';if(window._tab===\'react\'){renderReactPage(items);return;}document.getElementById(\'reactPage\').style.display=\'none\';document.getElementById(\'open\').style.display=\'\';document.getElementById(\'dc\')&&(document.getElementById(\'dc\').parentElement.style.display=\'\');items=items.filter(i=>i.kind!==\'reactivation\'&&i.kind!==\'reactcdbs\');items=items.filter(vwPass);const sched=items.filter(i=>!i.doneAt&&i.due&&i.due>tod).sort((a,b)=>String(a.due).localeCompare(String(b.due)));const parked=items.filter(i=>!i.doneAt&&i.parked);const open=items.filter(i=>!i.doneAt&&!(i.due&&i.due>tod)&&!i.parked), done=items.filter(i=>i.doneAt&&(Date.now()-Date.parse(i.doneAt))<((i.kind===\'unpaid\'?60:14)*86400000));\n    const today=new Date().toISOString().slice(0,10);\n    const row=i=>{const od=i.due&&i.due<today;const ov=i.kind===\'unpaid\'&&i.escalated&&!i.doneAt;\n      if(i.kind===\'checkout\'||i.kind===\'rebook\'||i.kind===\'recall\'){\n        return `<div class="row" style="${(i.stageDentist||i.stageReception)?\'background:#fafdfb;border-radius:10px;\':\'\'}">\n        <span style="display:inline-flex;gap:6px;">\n          <label style="display:inline-flex;align-items:center;gap:4px;background:${i.stageDentist?\'#e6f4ec\':\'#f2f2f5\'};border-radius:99px;padding:4px 10px;font-size:12px;font-weight:600;color:${i.stageDentist?\'#1d7a46\':\'#6e6e73\'};"><input type="checkbox" ${i.stageDentist?\'checked\':\'\'} onchange="stage(\'${i.id}\',\'stageDentist\',this.checked)">Dentist</label>\n          <label style="display:inline-flex;align-items:center;gap:4px;background:${i.stageReception?\'#e6f4ec\':\'#f2f2f5\'};border-radius:99px;padding:4px 10px;font-size:12px;font-weight:600;color:${i.stageReception?\'#1d7a46\':\'#6e6e73\'};"><input type="checkbox" ${i.stageReception?\'checked\':\'\'} onchange="stage(\'${i.id}\',\'stageReception\',this.checked)">Reception</label>\n        </span>\n        <div style="flex:1;"><div><strong>${esc(i.name)}</strong> — ${esc(i.text)}${i.assignee?`<span class="chip">${esc(i.assignee)}</span>`:\'\'}${vwChipW(i)}${!i.stageDentist?\'<span class="chip" style="background:#fff4e0;color:#9a6b00;">needs dentist</span>\':\'\'}</div>\n        <div class="muted">${esc(i.context||\'\')}</div></div>\n        <input type="text" value="${esc(i.noteText||\'\')}" placeholder="note…" style="width:110px;" onchange="noteSave(\'${i.id}\',this.value)"><button onclick="delItem(\'${i.id}\')" title="Delete completely" style="background:#f2f2f5;color:#6e6e73;border:none;border-radius:9px;padding:6px 11px;cursor:pointer;">✕</button></div>`;\n      }\n      return `<div class="row" style="${ov?\'background:#fdf5f5;border-left:3px solid #c0392b;border-radius:10px;\':\'\'}"><input type="checkbox" onchange="tick(\'${i.id}\')">\n      <div style="flex:1;"><div><strong>${esc(i.name)}</strong>${i.text?\' — \'+esc(i.text):\'\'}${i.assignee?`<span class="chip">${esc(i.assignee)}</span>`:\'\'}${vwChipW(i)}${i.repeat?\'<span class="chip">↻</span>\':\'\'}</div>\n      <div class="muted">${esc(i.context||\'\')}${i.context?\' · \':\'\'}${i.due?`<span class="${od?\'over\':\'\'}">due ${i.due===today?\'today\':i.due}${od?\' — overdue\':\'\'}</span>`:\'waiting \'+age(i.createdAt)}</div></div>\n      <input type="text" id="n-${i.id}" value="${esc(i.noteText||\'\')}" placeholder="note…" style="width:120px;" onchange="noteSave(\'${i.id}\',this.value)"><button onclick="delItem(\'${i.id}\')" title="Delete completely" style="background:#f2f2f5;color:#6e6e73;border:none;border-radius:9px;padding:6px 11px;cursor:pointer;">✕</button></div>`;};\n    const pref=[\'Urgent\',\'CDBS\',\'Confirm appts\',\'Reception attention\',\'Unpaid invoices\',\'General\',\'Routine\',\'Checkouts\',\'Rebook\',\'Recalls\',\'Complete notes\',\'Huddle tags\'];const found=[...new Set([...open,...sched].map(i=>i.section||\'CDBS\'))];const secs=[...pref.filter(s=>found.includes(s)),...found.filter(s=>!pref.includes(s))];\n    const upRows=sched.map(i=>{const d=new Date(i.due+\'T00:00\');const w=d.toLocaleDateString(\'en-AU\',{weekday:\'short\',day:\'2-digit\',month:\'2-digit\'});const c2={\'Urgent\':\'#ff3b30\',\'CDBS\':\'#2F6B4F\',\'Confirm appts\':\'#e2a93b\',\'Checkouts\':\'#3478f6\',\'Reception attention\':\'#af52de\',\'Rebook\':\'#30b0c7\',\'Unpaid invoices\':\'#bf5af2\',\'Routine\':\'#5e5ce6\',\'General\':\'#8e8e93\',\'Recalls\':\'#ff9f0a\',\'Complete notes\':\'#7a5af5\',\'Huddle tags\':\'#0d9488\'}[i.section||\'General\']||\'#8e8e93\';return `<div class="row"><input type="checkbox" onchange="tick(\'${i.id}\')" title="Tick early - the schedule stays anchored"><span class="muted" style="min-width:82px;">${w}</span><div style="flex:1;"><strong>${esc(i.name)}</strong> <span class="chip" style="background:${c2}1c;color:${c2};">${esc(i.section||\'General\')}</span>${i.repeat?`<span class="chip">↻ ${esc(i.repeat)}</span>`:\'\'}</div><button onclick="delItem(\'${i.id}\')" style="background:#f2f2f5;color:#6e6e73;border:none;border-radius:9px;padding:6px 11px;cursor:pointer;">✕</button></div>`;}).join(\'\');const upcomingHtml=sched.length?`<details class="dept"><summary style="font-size:17px;font-weight:700;letter-spacing:-.2px;padding:12px 0;"><span class="ci" style="display:inline-block;width:18px;color:#8e8e93;font-weight:600;"></span>Upcoming <span class="chip" style="background:#f2f2f5;color:#6e6e73;">${sched.length}</span></summary>${upRows}</details>`:\'\';document.getElementById(\'open\').innerHTML=open.length?secs.map(s=>{\n      const its=open.filter(i=>(i.section||\'CDBS\')===s); if(!its.length)return \'\';\n      const col={\'Urgent\':\'#ff3b30\',\'CDBS\':\'#2F6B4F\',\'Confirm appts\':\'#e2a93b\',\'Checkouts\':\'#3478f6\',\'Reception attention\':\'#af52de\',\'Rebook\':\'#30b0c7\',\'Unpaid invoices\':\'#bf5af2\',\'General\':\'#8e8e93\',\'Recalls\':\'#ff9f0a\',\'Complete notes\':\'#7a5af5\',\'Huddle tags\':\'#0d9488\'}[s]||\'#8e8e93\';\n      const nd=its.filter(i=>(i.kind===\'checkout\'||i.kind===\'rebook\'||i.kind===\'recall\')&&!i.stageDentist).length;const sits=sched.filter(i=>(i.section||\'CDBS\')===s);const srows=sits.length?(\'<div class="schwrap" style="display:none;">\'+sits.map(i=>{const d=new Date(i.due+\'T00:00\');const w=d.toLocaleDateString(\'en-AU\',{weekday:\'short\',day:\'2-digit\',month:\'2-digit\'});return `<div class="row" style="opacity:.55;"><span class="muted" style="min-width:80px;">${w}</span><div style="flex:1;"><strong>${esc(i.name)}</strong>${i.repeat?`<span class="chip">↻ ${esc(i.repeat)}</span>`:\'\'}</div></div>`;}).join(\'\')+\'</div>\'):\'\';const ovn=its.filter(i=>i.kind===\'unpaid\'&&i.escalated).length;\n      return `<details class="dept" ${s===\'Urgent\'?\'open\':\'\'}><summary style="font-size:17px;font-weight:700;letter-spacing:-.2px;padding:12px 0;"><span class="ci" style="display:inline-block;width:18px;color:#8e8e93;font-weight:600;"></span>${s} <span class="chip" style="background:${its.length?\'#fdecec\':\'#e6f4ec\'};color:${its.length?\'#c0392b\':\'#1d7a46\'};">${its.length}</span>${nd?`<span class="chip" style="background:#fff4e0;color:#9a6b00;">${nd} need dentist</span>`:\'\'}${ovn?`<span class="chip" style="background:#fdecec;color:#c0392b;">${ovn} overdue 50d+</span>`:\'\'}${sits.length?`<span class="chip" style="background:#f2f2f5;color:#6e6e73;cursor:pointer;" onclick="event.preventDefault();event.stopPropagation();const w=this.closest(\'details\').querySelector(\'.schwrap\');const on=w.style.display===\'none\';w.style.display=on?\'block\':\'none\';this.textContent=\'${sits.length} scheduled \'+(on?\'▾\':\'▸\');">${sits.length} scheduled ▸</span>`:\'\'}</summary>${its.map(row).join(\'\')}${srows}${(function(){if(s!==\'Unpaid invoices\')return \'\';const pk=parked.filter(p=>(p.section||\'CDBS\')===s);if(!pk.length)return \'\';const dys=p=>p.parkedAt?Math.floor((Date.now()-Date.parse(p.parkedAt))/86400000):0;const hot=pk.some(p=>dys(p)>=30);return `<details style="margin-top:6px;"><summary class="muted" style="cursor:pointer;${hot?\'color:#c0392b;font-weight:700;\':\'\'}">Pending claims (${pk.length})${hot?\' — some 30+ days\':\'\'}</summary>`+pk.sort((a,b)=>String(a.parkedAt||\'\').localeCompare(String(b.parkedAt||\'\'))).map(p=>{const d=dys(p);return `<div class="row"><div style="flex:1;"><strong>${esc(p.name)}</strong> <span class="chip" style="background:${d>=30?\'#fdecec\':\'#f2f2f5\'};color:${d>=30?\'#c0392b\':\'#6e6e73\'};">${esc(p.parked)} since ${new Date(p.parkedAt).toLocaleDateString(\'en-AU\',{day:\'2-digit\',month:\'2-digit\'})}${d>=30?\' — \'+d+\' days\':\'\'}</span></div></div>`;}).join(\'\')+`</details>`;})()}</details>`;\n    }).join(\'\')+upcomingHtml:(upcomingHtml||\'<div class="muted">Nothing waiting — all sorted ✓</div>\');\n    document.getElementById(\'dc\').textContent=done.length;\n    document.getElementById(\'done\').innerHTML=done.map(i=>\n      `<div class="muted" style="padding:6px 0;"><s>${esc(i.name)}</s> ${i.doneNote?\'· "\'+esc(i.doneNote)+\'"\':\'\'}\n       <a href="#" onclick="untick(\'${i.id}\');return false;" style="float:right;font-size:11px;">undo</a></div>`).join(\'\')||\'<div class="muted">None yet.</div>\';\n}\nfirebase.auth().onAuthStateChanged(u=>{\n  if(!u){signedInUI(false);document.getElementById(\'st\').className=\'pill warn\';document.getElementById(\'st\').textContent=\'sign in\';return;}\n  const okDomain=(u.email||\'\').toLowerCase().endsWith(\'@sdtoowoomba.com.au\');\n  if(!okDomain){document.getElementById(\'gateMsg\').textContent=\'That account is not a clinic account (\'+(u.email||\'\')+\'). Sign in with your @sdtoowoomba.com.au Google account.\';firebase.auth().signOut();signedInUI(false);return;}\n  signedInUI(true);startData();\n});\nfunction vwEff(i){var m=String(i.viewsTag||\'\').trim();if(m===\'*\')return[];var kn=window._vKnown||{};if(m){return m.split(\',\').map(function(s){return s.trim();}).filter(function(s){return kn[s];});}return ((window._vcfg&&window._vcfg.rules[i.section||\'CDBS\'])||[]).filter(function(s){return kn[s];});}\nfunction vwPass(i){var v=window._vsel||\'\';if(!v)return true;var n=v.slice(2),t=vwEff(i);if(v.indexOf(\'a:\')===0)return (i.assignee||\'\')===n||t.indexOf(n)>=0;return t.length===0||t.indexOf(n)>=0||(i.assignee||\'\')===n;}\nfunction vwLabel(i){var t=vwEff(i);if(!t.length)return \'Everyone\';return esc(t[0])+(t.length>1?\' +\'+(t.length-1):\'\');}\nfunction vwChipW(i){var man=String(i.viewsTag||\'\').trim();return \'<span class="chip" style="cursor:pointer;\'+(man?\'border:1px solid #b6b6bb;\':\'\')+\'" onclick="vwEdit(\\\'\'+i.id+\'\\\')" title="Who sees this item — tap to change">👁 \'+vwLabel(i)+\'</span>\';}\nfunction vwSel(v){window._vsel=v;try{localStorage.setItem(\'sdtView\',v);}catch(e){}if(window._snapLast)paintSnap(window._snapLast);}\nfunction vwFill(items){var sel=document.getElementById(\'vw\');if(!sel)return;var vs=(window._vcfg&&window._vcfg.views)||[];var names=[];items.forEach(function(i){if(i.assignee&&names.indexOf(i.assignee)<0)names.push(i.assignee);});names.sort();var kn={};vs.forEach(function(v){kn[v]=1;});names.forEach(function(n){kn[n]=1;});window._vKnown=kn;if(window._vsel===undefined){try{window._vsel=localStorage.getItem(\'sdtView\')||\'\';}catch(e){window._vsel=\'\';}}var h=\'<option value="">View: Everyone</option>\';vs.forEach(function(v){h+=\'<option value="v:\'+esc(v)+\'">\'+esc(v)+\'</option>\';});names.forEach(function(n){h+=\'<option value="a:\'+esc(n)+\'">\'+esc(n)+\'</option>\';});sel.innerHTML=h;sel.value=window._vsel||\'\';if(sel.value!==(window._vsel||\'\')){window._vsel=\'\';sel.value=\'\';}}\nfunction vwEdit(id){var i=(window._all||[]).find(function(x){return x.id===id;});if(!i)return;var vs=((window._vcfg&&window._vcfg.views)||[]).slice();(window._all||[]).forEach(function(x){if(x.assignee&&vs.indexOf(x.assignee)<0)vs.push(x.assignee);});var cur=String(i.viewsTag||\'\').trim();var man=cur&&cur!==\'*\'?cur.split(\',\').map(function(s){return s.trim();}):[];var sel=cur?man:((window._vcfg&&window._vcfg.rules[i.section||\'CDBS\'])||[]);var old=document.getElementById(\'vwOv\');if(old)old.remove();var od=document.createElement(\'div\');od.id=\'vwOv\';od.style.cssText=\'position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:99;display:flex;align-items:center;justify-content:center;\';var h=\'<div style="background:#fff;border-radius:16px;padding:16px;max-width:330px;width:92%;max-height:72%;overflow:auto;"><div style="font-weight:700;margin-bottom:4px;">Who sees this item</div><div class="muted" style="font-size:12px;margin-bottom:8px;">\'+esc(i.name)+(cur?\'\':\' — following the section rule\')+\'</div>\';vs.forEach(function(o){h+=\'<label style="display:flex;gap:8px;align-items:center;padding:6px 0;font-size:14px;"><input type="checkbox" data-vwo="\'+esc(o)+\'" \'+(sel.indexOf(o)>=0?\'checked\':\'\')+\' style="width:18px;height:18px;"> \'+esc(o)+\'</label>\';});if(!vs.length)h+=\'<div class="muted">No views yet — add them in the desk app (Advanced tools → Views).</div>\';h+=\'<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;"><button onclick="vwSave(\\\'\'+id+\'\\\',0)">Save</button><button onclick="vwSave(\\\'\'+id+\'\\\',1)" style="background:#f2f2f5;color:#3c3c43;">Use section rule</button><button onclick="document.getElementById(\\\'vwOv\\\').remove()" style="background:#f2f2f5;color:#3c3c43;">Cancel</button></div><div class="muted" style="margin-top:8px;font-size:11.5px;">No boxes ticked = Everyone. The assigned dentist always sees their items.</div></div>\';od.innerHTML=h;od.addEventListener(\'click\',function(e){if(e.target===od)od.remove();});document.body.appendChild(od);}\nfunction vwSave(id,useRule){var od=document.getElementById(\'vwOv\');if(!od)return;if(useRule){db.collection(\'cdbsActions\').doc(id).update({viewsTag:firebase.firestore.FieldValue.delete(),updatedAt:new Date().toISOString()});}else{var picked=[];od.querySelectorAll(\'input[data-vwo]\').forEach(function(c){if(c.checked)picked.push(c.getAttribute(\'data-vwo\'));});db.collection(\'cdbsActions\').doc(id).update({viewsTag:picked.length?picked.join(\',\'):\'*\',updatedAt:new Date().toISOString()});}od.remove();}\nfunction tick(id){const cb=event&&event.target;if(cb){cb.disabled=true;const r=cb.closest(\'.row\');if(r)r.style.opacity=\'.45\';}\nconst n=document.getElementById(\'n-\'+id);\n  db.collection(\'cdbsActions\').doc(id).get().then(d=>{const it=d.data()||{};\n    db.collection(\'cdbsActions\').doc(id).update({doneAt:new Date().toISOString(),doneNote:(n&&n.value||\'\').slice(0,200),updatedAt:new Date().toISOString()});\n    if(it.repeat){const nd=new Date((it.due||new Date().toISOString().slice(0,10))+\'T00:00:00\');\n      if(it.repeat===\'daily\')nd.setDate(nd.getDate()+1);else if(it.repeat===\'weekly\')nd.setDate(nd.getDate()+7);\n      else if(it.repeat===\'fortnightly\')nd.setDate(nd.getDate()+14);else if(it.repeat===\'sixmonthly\')nd.setMonth(nd.getMonth()+6);else if(it.repeat===\'yearly\')nd.setFullYear(nd.getFullYear()+1);else nd.setMonth(nd.getMonth()+1);\n      const id2=\'a\'+Date.now()+Math.random().toString(36).slice(2,6);\n      const clone={...it};delete clone.doneAt;delete clone.doneNote;\n      db.collection(\'cdbsActions\').doc(id2).set({...clone,createdAt:new Date().toISOString(),due:nd.toISOString().slice(0,10),updatedAt:new Date().toISOString()});\n    }});}\nfunction stage(id,field,on){\n  const u={updatedAt:new Date().toISOString()};\n  u[field]=on?new Date().toISOString():firebase.firestore.FieldValue.delete();\n  db.collection(\'cdbsActions\').doc(id).get().then(d=>{const it=d.data()||{};\n    const dOn=field===\'stageDentist\'?on:!!it.stageDentist;\n    const rOn=field===\'stageReception\'?on:!!it.stageReception;\n    if(dOn&&rOn){u.doneAt=new Date().toISOString();u.doneNote=it.noteText||\'\';}\n    else{u.doneAt=firebase.firestore.FieldValue.delete();}\n    db.collection(\'cdbsActions\').doc(id).update(u);});\n}\nfunction delItem(id){if(!confirm(\'Delete this item completely?\'))return;db.collection(\'cdbsActions\').doc(id).update({deleted:\'1\',updatedAt:new Date().toISOString()});}\nfunction noteSave(id,v){db.collection(\'cdbsActions\').doc(id).update({noteText:String(v||\'\').slice(0,200),updatedAt:new Date().toISOString()});}\nfunction untick(id){db.collection(\'cdbsActions\').doc(id).update({doneAt:firebase.firestore.FieldValue.delete(),doneNote:firebase.firestore.FieldValue.delete(),updatedAt:new Date().toISOString()});}\n\n\nfunction setTab(t){window._tab=t;document.getElementById(\'tabList\').style.background=t===\'list\'?\'#2F6B4F\':\'#f2f2f5\';document.getElementById(\'tabList\').style.color=t===\'list\'?\'#fff\':\'#3c3c43\';document.getElementById(\'tabReact\').style.background=t===\'react\'?\'#2F6B4F\':\'#f2f2f5\';document.getElementById(\'tabReact\').style.color=t===\'react\'?\'#fff\':\'#3c3c43\';if(window._all)renderSnapshotAgain();}\nfunction renderSnapshotAgain(){var ev=window._all||[];if(window._tab===\'react\'){document.getElementById(\'open\').style.display=\'none\';var dcp=document.getElementById(\'dc\');if(dcp)dcp.parentElement.style.display=\'none\';renderReactPage(ev);}else{document.getElementById(\'reactPage\').style.display=\'none\';document.getElementById(\'open\').style.display=\'\';var dcp2=document.getElementById(\'dc\');if(dcp2)dcp2.parentElement.style.display=\'\';}}\nfunction rOut(id,oc,extra){var upd={outcome:oc,updatedAt:new Date().toISOString()};if(oc===\'booked\'||oc===\'texted\'||oc===\'offlist\'){upd.doneAt=new Date().toISOString();}if(oc===\'offlist-pending\'){}if(oc===\'__clear\'){upd={outcome:firebase.firestore.FieldValue.delete(),updatedAt:new Date().toISOString()};}if(oc===\'followup\'){if(!extra){alert(\'Pick the follow-up date first.\');return;}upd.due=extra;}db.collection(\'cdbsActions\').doc(id).update(upd);}\nfunction rNote(id,val){if(!val.trim())return;var it=(window._all||[]).find(function(x){return x.id===id;});var log=[];try{log=JSON.parse((it&&it.notesLog)||\'[]\');}catch(e){log=[];}if(!log.length&&it&&it.noteText)log.push({t:it.noteText,d:it.updatedAt||it.createdAt,dest:\'local\'});log.push({t:val.trim().slice(0,300),d:new Date().toISOString(),dest:\'local\'});db.collection(\'cdbsActions\').doc(id).update({notesLog:JSON.stringify(log),noteText:\'\',updatedAt:new Date().toISOString()});}\nfunction rCard(i,tod){var done=!!i.doneAt;var lab={offlist:\'off list — inactivated ✓\',texted:\'no answer — texted\',booked:\'booked in\'};var bal=\'\';if(i.kind===\'reactcdbs\'){if(i.balanceText){var w2=i.balanceChecked?new Date(i.balanceChecked).toLocaleDateString(\'en-AU\',{day:\'2-digit\',month:\'2-digit\'}):\'\';if(/not eligible/i.test(i.balanceText)){bal=\'<span class="chip" style="background:#fdecec;color:#c0392b;font-weight:700;">Not eligible · \'+w2+\'</span>\';}else{var m2=String(i.balanceText).match(/\\$\\s?([\\d,]+(?:\\.\\d+)?)/);if(m2&&Number(m2[1].replace(/,/g,\'\'))<100){bal=\'<span class="chip" style="background:#fdecec;color:#c0392b;font-weight:700;">$\'+m2[1]+\' left · \'+w2+\'</span>\';}else{bal=m2?\'<span class="chip" style="background:#e6f4ec;color:#1d7a46;font-weight:700;">$\'+m2[1]+\' available · \'+w2+\'</span>\':\'<span class="chip">checked \'+w2+\'</span>\';}}}else{bal=\'<span class="chip" style="background:#f2f2f5;color:#6e6e73;">balance not checked</span>\';}}\nvar st=\'\';if(done){st=\'<span class="chip" style="background:#e6f4ec;color:#1d7a46;">\'+(lab[i.outcome]||\'done\')+\'</span>\';}else if(i.due&&i.due>tod){st=\'<span class="chip" style="background:#eef2ff;color:#5e5ce6;">follow-up \'+i.due.slice(8,10)+\'/\'+i.due.slice(5,7)+\'</span>\';}\nvar log=[];try{log=JSON.parse(i.notesLog||\'[]\');}catch(e){}if(!log.length&&i.noteText)log=[{t:i.noteText,d:i.updatedAt||i.createdAt,dest:\'local\'}];\nvar logH=log.map(function(n){var w=new Date(n.d).toLocaleDateString(\'en-AU\',{day:\'2-digit\',month:\'2-digit\'});return n.dest===\'principle\'?\'<div style="background:#e6f4ec;color:#1d7a46;border-radius:8px;padding:5px 10px;font-size:12px;margin-top:4px;">✓ \'+w+\' sent to Principle: \'+esc(n.t)+\'</div>\':\'<div style="background:#f2f2f5;color:#3c3c43;border-radius:8px;padding:5px 10px;font-size:12px;margin-top:4px;">\'+w+\' saved: \'+esc(n.t)+\'</div>\';}).join(\'\');\nvar pend=!done&&i.outcome===\'offlist-pending\';\nvar pills=pend?(\'<div class="row" style="margin-top:7px;background:#fff4e0;border-radius:9px;padding:8px 10px;"><span style="color:#9a6b00;font-size:12px;font-weight:600;">⚠ Make them inactive in Principle, then:</span> \'+(i.plink?\'<a href="https://app.principle.dental\'+esc(i.plink)+\'" target="_blank" style="font-size:12px;">open file ↗</a> \':\'\')+\'<button onclick="rOut(\\\'\'+i.id+\'\\\',\\\'offlist\\\')" style="border:none;border-radius:99px;padding:4px 11px;background:#1d7a4622;color:#1d7a46;font-weight:600;cursor:pointer;font-size:12px;">Done — made inactive</button><button onclick="rOut(\\\'\'+i.id+\'\\\',\\\'__clear\\\')" style="border:none;border-radius:99px;padding:4px 11px;background:#f2f2f5;color:#6e6e73;cursor:pointer;font-size:12px;">Cancel</button></div>\')\n:(\'<div class="row" style="margin-top:7px;flex-wrap:wrap;gap:5px;">\'\n+\'<button onclick="rOut(\\\'\'+i.id+\'\\\',\\\'booked\\\')" style="border:none;border-radius:99px;padding:5px 11px;background:\'+(i.outcome===\'booked\'?\'#1d7a4622\':\'#f2f2f5\')+\';color:\'+(i.outcome===\'booked\'?\'#1d7a46\':\'#6e6e73\')+\';font-weight:600;cursor:pointer;font-size:12px;">Booked in</button>\'\n+\'<button onclick="rOut(\\\'\'+i.id+\'\\\',\\\'texted\\\')" style="border:none;border-radius:99px;padding:5px 11px;background:\'+(i.outcome===\'texted\'?\'#9a6b0022\':\'#f2f2f5\')+\';color:\'+(i.outcome===\'texted\'?\'#9a6b00\':\'#6e6e73\')+\';font-weight:600;cursor:pointer;font-size:12px;">No answer — text pt</button>\'\n+\'<button onclick="rOut(\\\'\'+i.id+\'\\\',\\\'offlist-pending\\\')" style="border:none;border-radius:99px;padding:5px 11px;background:#f2f2f5;color:#6e6e73;font-weight:600;cursor:pointer;font-size:12px;">Take off list</button>\'\n+\'<button onclick="var d=this.nextElementSibling.value;rOut(\\\'\'+i.id+\'\\\',\\\'followup\\\',d)" style="border:none;border-radius:99px;padding:5px 11px;background:\'+(i.outcome===\'followup\'?\'#5e5ce622\':\'#f2f2f5\')+\';color:\'+(i.outcome===\'followup\'?\'#5e5ce6\':\'#6e6e73\')+\';font-weight:600;cursor:pointer;font-size:12px;">Follow-up ▸</button><input type="date" value="\'+(i.outcome===\'followup\'&&i.due?i.due:\'\')+\'" style="font:inherit;border:1px solid #d2d2d7;border-radius:7px;padding:3px;font-size:12px;">\'\n+\'</div>\');\nreturn \'<div style="padding:11px 0;border-bottom:1px solid #f0f0f3;"><div><strong>\'+esc(i.name)+\'</strong> \'+(i.mobile?\'<a href="tel:\'+esc(i.mobile).replace(/\\s+/g,\'\')+\'" style="color:#2F6B4F;font-weight:600;text-decoration:none;">\'+esc(i.mobile)+\'</a>\':\'\')+\' \'+(i.feeSched?\'<span class="chip">\'+esc(i.feeSched)+\'</span>\':\'\')+(i.lastVisit?\'<span class="chip">seen \'+esc(i.lastVisit)+\'</span>\':\'\')+(i.dob?\'<span class="chip">DOB \'+esc(i.dob)+\'</span>\':\'\')+\' \'+bal+\' \'+st+\'</div>\'+pills+logH\n+\'<div class="row" style="margin-top:6px;"><input type="text" placeholder="new note…" style="flex:1;min-width:170px;font:inherit;font-size:12px;border:1px solid #d2d2d7;border-radius:8px;padding:5px 9px;"><button onclick="rNote(\\\'\'+i.id+\'\\\',this.previousElementSibling.value);this.previousElementSibling.value=\\\'\\\'" style="border:none;border-radius:99px;padding:5px 12px;background:#f2f2f5;color:#3c3c43;cursor:pointer;font-size:12px;">Save here</button><button disabled title="Send from the clinic app — this page cannot drive Principle" style="border:none;border-radius:99px;padding:5px 12px;background:#f7f7f9;color:#b6b6bb;font-size:12px;">→ Principle & pin</button></div></div>\';}\nfunction renderReactPage(items){window._tab=\'react\';document.getElementById(\'open\').style.display=\'none\';var dcp=document.getElementById(\'dc\');if(dcp)dcp.parentElement.style.display=\'none\';var box=document.getElementById(\'reactPage\');box.style.display=\'block\';var tod=(function(){var d=new Date();return d.getFullYear()+\'-\'+String(d.getMonth()+1).padStart(2,\'0\')+\'-\'+String(d.getDate()).padStart(2,\'0\');})();\nvar q=(document.getElementById(\'rq\').value||\'\').trim().toLowerCase();var kinds=[[\'reactivation\',\'Reactivation Health funds/DVA\'],[\'reactcdbs\',\'Reactivation CDBS — under 18\']];var h=\'\';\nkinds.forEach(function(kk){var kind=kk[0],title=kk[1];var all=items.filter(function(i){return i.kind===kind;});var show;\nif(q){show=all.filter(function(i){return (i.name||\'\').toLowerCase().indexOf(q)>=0;});}\nelse{show=all.filter(function(i){return !i.doneAt&&!(i.due&&i.due>tod);});}\nvar notE=[];if(kind===\'reactcdbs\'&&!q){var prk=function(i){var t=i.balanceText||\'\';if(/not eligible/i.test(t))return true;var m=String(t).match(/\\$\\s?([\\d,]+(?:\\.\\d+)?)/);return !!(m&&Number(m[1].replace(/,/g,\'\'))<100);};notE=show.filter(prk);show=show.filter(function(i){return !prk(i);});}\nshow.sort(function(a,b){return String(a.name).localeCompare(String(b.name));});\nvar doneN=all.filter(function(i){return i.doneAt&&(Date.now()-Date.parse(i.doneAt))<180*86400000;});\ndoneN.sort(function(a,b){return String(b.doneAt).localeCompare(String(a.doneAt));});\nh+=\'<details class="dept" open><summary style="font-size:17px;font-weight:700;padding:12px 0;">\'+title+\' <span class="chip" style="background:\'+(show.length?\'#fdecec\':\'#e6f4ec\')+\';color:\'+(show.length?\'#c0392b\':\'#1d7a46\')+\';">\'+show.length+\'</span></summary>\'+(show.map(function(i){return rCard(i,tod);}).join(\'\')||\'<div class="muted">\'+(q?\'No match here.\':\'Nobody waiting — all clear.\')+\'</div>\')+(notE.length?\'<details style="margin-top:8px;"><summary class="muted" style="cursor:pointer;">Not eligible / under $100 (\'+notE.length+\') — parked; new CDBS years refill these</summary>\'+notE.map(function(i){return rCard(i,tod);}).join(\'\')+\'</details>\':\'\')+(!q&&doneN.length?\'<details style="margin-top:8px;"><summary class="muted" style="cursor:pointer;">Done (\'+doneN.length+\') — shown 180 days</summary>\'+doneN.map(function(i){return rCard(i,tod);}).join(\'\')+\'</details>\':\'\')+\'</details>\';});\nbox.innerHTML=h;}\n\n</script></body></html>';
ipcMain.handle('share-html-get', () => NURSE_PAGE_HTML);
ipcMain.handle('share-html-save', async () => {
  const picked = await dialog.showSaveDialog(mainWindow, { title: 'Save the Action List page', defaultPath: 'SDT-Action-List.html', filters: [{ name: 'Web page', extensions: ['html'] }] });
  if (picked.canceled || !picked.filePath) return { ok: false };
  fs.writeFileSync(picked.filePath, NURSE_PAGE_HTML, 'utf8');
  return { ok: true, file: picked.filePath };
});

ipcMain.handle('action-get', async () => {
  try {
    const items = await fsPull();
    // Self-heal old wordings whenever the list is read.
    for (const it of items) {
      if (it.kind === 'rebook' && / - ring to rebook/i.test(it.text || '')) {
        it.text = 'No next visit booked';
        it.updatedAt = new Date().toISOString();
        fsPush(it);
      }
    }
    saveActions({ items });
    return { items, synced: true };
  } catch (e) {
    const a = loadActions();
    a.synced = false;
    return a;
  }
});
ipcMain.handle('action-delete', (e, p) => {
  const a = loadActions();
  const before = a.items.length;
  a.items = a.items.filter(x => x.id !== p.id);
  saveActions(a);
  fsDelete(p.id);
  return { ok: a.items.length < before };
});

ipcMain.handle('action-add', (e, p) => {
  if (!p || !String(p.title || '').trim()) return { ok: false, error: 'A task needs a title.' };
  const a = loadActions();
  const it = {
    id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6),
    name: String(p.title).trim().slice(0, 120),
    kind: 'manual',
    section: ['General', 'CDBS', 'Routine'].includes(p.section) ? p.section : 'General',
    text: String(p.note || '').slice(0, 200),
    context: '',
    createdAt: new Date().toISOString(),
  };
  if (p.due) it.due = String(p.due).slice(0, 10);
  if (p.assignee) it.assignee = String(p.assignee).trim().slice(0, 40);
  if (p.howTo && /^https?:\/\//.test(p.howTo)) it.howTo = String(p.howTo).slice(0, 300);
  if (['daily', 'weekly', 'fortnightly', 'monthly', 'sixmonthly', 'yearly'].includes(p.repeat)) it.repeat = p.repeat;
  a.items.push(it);
  saveActions(a);
  fsPush(it);
  return { ok: true };
});

function nextDue(fromIso, repeat) {
  const d = fromIso ? new Date(fromIso + 'T00:00:00') : new Date();
  if (repeat === 'daily') d.setDate(d.getDate() + 1);
  else if (repeat === 'weekly') d.setDate(d.getDate() + 7);
  else if (repeat === 'fortnightly') d.setDate(d.getDate() + 14);
  else if (repeat === 'monthly') d.setMonth(d.getMonth() + 1);
  else if (repeat === 'sixmonthly') d.setMonth(d.getMonth() + 6);
  else if (repeat === 'yearly') d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

ipcMain.handle('action-stage', (e, p) => {
  const a = loadActions();
  const it = a.items.find(x => x.id === p.id);
  if (!it) return { ok: false };
  const field = p.stage === 'dentist' ? 'stageDentist' : 'stageReception';
  if (p.on) it[field] = new Date().toISOString(); else delete it[field];
  if (it.stageDentist && it.stageReception) {
    it.doneAt = new Date().toISOString();
    it.doneNote = it.noteText || '';
  } else {
    delete it.doneAt;
  }
  saveActions(a);
  fsPush(it);
  return { ok: true };
});

// Worker/viewer: only computers with the switch ON run scheduled work.
// Everything manual still works everywhere. Undefined = ON, so existing
// machines keep their mornings until someone deliberately flips them.
function isWorker() {
  try { return loadMorningSettings().mWorker !== false; } catch (e) { return true; }
}
ipcMain.handle('worker-get', () => ({ worker: isWorker() }));
ipcMain.handle('worker-set', (e, p) => {
  const s = loadMorningSettings();
  s.mWorker = !!p.worker;
  saveMorningSettings(s);
  appJournal('daily schedule switch: ' + (s.mWorker ? 'ON (worker)' : 'OFF (viewer)'));
  return { ok: true, worker: s.mWorker };
});

function engineBusy() {
  // autoRunning / autoRunAllBusy included since 2026-08-08.4: the note
  // worker was writing patient notes in the SAME Principle window while
  // an auto report was running, navigating it away mid-download.
  return !!(runAllState.running || runState.running || collectState.running ||
            balanceState.running || genState.running || morningState.running ||
            autoRunning || autoRunAllBusy);
}

ipcMain.handle('cloud-health', () => ({ ok: fsHealth.ok, error: fsHealth.lastError }));

ipcMain.handle('engine-busy', () => ({
  busy: engineBusy(),
  stage: (typeof lastBeat === 'object' && lastBeat && lastBeat.stage) || '',
  needsCode: !!deskCode.resolve,
}));

ipcMain.handle('stop-everything', () => {
  runAllState.stopRequested = true; runState.stopRequested = true;
  collectState.stopRequested = true; balanceState.stopRequested = true;
  morningState.stopRequested = true;
  appJournal('stop pressed from the run banner');
  return { ok: true };
});

ipcMain.handle('reactcdbs-check', async (e, p) => {
  if (noteWorkerBusy) return { ok: false, error: 'A note is being written to Principle - try again in a few seconds.' };
  if (runAllState.running || runState.running || collectState.running || balanceState.running || genState.running || morningState.running) {
    return { ok: false, error: 'Something is already running - let it finish first.' };
  }
  let items;
  try { items = await fsPull(); } catch (err) { return { ok: false, error: 'Cannot reach the shared list - check the connection and try again.' }; }
  const todayIso = localToday();
  const st = loadPatientState();
  const cards = items.filter(i => i.kind === 'reactcdbs' && !i.doneAt && !(i.due && i.due > todayIso) && i.patientId && !String(i.patientId).startsWith('name:'));
  const balOf = (i) => {
    const loc = st[i.patientId] && st[i.patientId].lastBalanceText
      ? { t: st[i.patientId].lastBalanceText, w: st[i.patientId].lastChecked || '' } : null;
    const mir = i.balanceText ? { t: i.balanceText, w: i.balanceChecked || '' } : null;
    if (loc && mir) return (loc.w || '') >= (mir.w || '') ? loc : mir;
    return loc || mir;
  };
  const fresh = (i) => { const b = balOf(i); return !!(b && b.w && localDateOf(b.w) === todayIso); };
  const notElig = (i) => {
    const b = balOf(i);
    if (!b) return false;
    if (/not eligible/i.test(b.t)) return true;
    const m = String(b.t).match(/\$\s?([\d,]+(?:\.\d{1,2})?)/);
    return !!(m && Number(m[1].replace(/,/g, '')) < 100);   // under $100: not worth a ring
  };
  let toCheck;
  if (p.scope === 'noteligible') {
    // The monthly ritual: re-check everyone Medicare previously said no
    // to - eligibility resets with new entitlement years.
    toCheck = cards.filter(i => notElig(i) && !fresh(i));
  } else {
    toCheck = cards.filter(i => !fresh(i) && !notElig(i));
  }
  toCheck.sort((x, y) => String(x.name).localeCompare(String(y.name)));
  if (p.scope !== 'all' && p.scope !== 'noteligible') toCheck = toCheck.slice(0, 20);
  if (!toCheck.length) return { ok: false, error: 'Nothing to check - every linked patient on the list was already checked today.' };
  runAllState = { running: true, stopRequested: false, waitingForLogin: false };
  lastRunWasFile = true;   // sheet-only mode: no notes, no action-list feeding
  runlogStart('cdbs-balance-check');
  runManual(toCheck.map(i => ({ patientId: i.patientId, name: i.name, dob: i.dob || '' })));
  return { ok: true, count: toCheck.length };
});

ipcMain.handle('patient-state-map', () => {
  try {
    const st = loadPatientState();
    const out = {};
    for (const [pid, e] of Object.entries(st)) out[pid] = { lastChecked: e.lastChecked || '', balance: e.lastBalanceText || '' };
    return out;
  } catch (e) { return {}; }
});

let reactViewer = null;
ipcMain.handle('react-open-patient', (e, p) => {
  const a = loadActions();
  const it = a.items.find(x => x.id === p.id);
  if (!it || !it.plink) return { ok: false, error: 'No Principle link on this patient (add the Patient Link column to the report).' };
  const url = it.plink.startsWith('http') ? it.plink : 'https://app.principle.dental' + it.plink;
  if (!reactViewer || reactViewer.isDestroyed()) {
    reactViewer = new BrowserWindow({ width: 1280, height: 860, webPreferences: { partition: 'persist:principle' } });
    reactViewer.on('closed', () => { reactViewer = null; });
  }
  reactViewer.loadURL(url);
  reactViewer.show();
  return { ok: true };
});

ipcMain.handle('react-outcome', (e, p) => {
  const a = loadActions();
  const it = a.items.find(x => x.id === p.id);
  if (!it) return { ok: false };
  const now = new Date().toISOString();
  if (p.outcome === 'texted') {
    // One-attempt policy: no answer -> text them -> done. No callbacks.
    it.outcome = 'texted'; it.doneAt = now; it.doneNote = it.noteText || '';
  } else if (p.outcome === 'offlist-pending') {
    it.outcome = 'offlist-pending';                       // two-step: awaiting inactivation
  } else if (p.outcome === 'offlist-cancel') {
    delete it.outcome;
  } else if (p.outcome === 'followup') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date || '')) return { ok: false, error: 'Pick a date first.' };
    it.due = p.date; it.outcome = 'followup';
  } else if (p.outcome === 'offlist') {
    it.outcome = 'offlist'; it.doneAt = now; it.doneNote = it.noteText || '';   // confirmed inactivated
  } else if (p.outcome === 'booked') {
    it.outcome = 'booked'; it.doneAt = now; it.doneNote = it.noteText || '';
  } else return { ok: false };
  it.updatedAt = now;
  saveActions(a);
  fsPush(it);
  return { ok: true };
});

function reactLog(it) {
  try { return JSON.parse(it.notesLog || '[]'); } catch (e) { return []; }
}
// Fold a legacy single note into the ledger once.
function reactMigrate(it) {
  const log = reactLog(it);
  if (it.noteText && !log.length) {
    log.push({ t: it.noteText, d: it.updatedAt || it.createdAt, dest: 'local' });
    it.noteText = '';
  }
  return log;
}

ipcMain.handle('react-note-commit', (e, p) => {
  const a = loadActions();
  const it = a.items.find(x => x.id === p.id);
  if (!it) return { ok: false };
  const text = String(p.text || '').trim().slice(0, 300);
  if (!text) return { ok: false, error: 'Write the note first.' };
  const log = reactMigrate(it);
  log.push({ t: text, d: new Date().toISOString(), dest: 'local' });
  it.notesLog = JSON.stringify(log);
  it.updatedAt = new Date().toISOString();
  saveActions(a);
  fsPush(it);
  return { ok: true };
});

ipcMain.handle('react-note-del', (e, p) => {
  const a = loadActions();
  const it = a.items.find(x => x.id === p.id);
  if (!it) return { ok: false };
  const log = reactMigrate(it);
  const k = Number(p.idx);
  if (!(k >= 0 && k < log.length) || log[k].dest !== 'local') return { ok: false };   // green is forever
  log.splice(k, 1);
  it.notesLog = JSON.stringify(log);
  saveActions(a);
  fsPush(it);
  return { ok: true };
});

// ---------------------------------------------------------------------
// THE NOTE-SEND QUEUE
// Every note bound for Principle goes through here: press = queued in a
// heartbeat, a single background worker drives the engine one note at a
// time, the queue lives on disk so a written note survives restarts, and
// ledger entries flip amber -> green (or red with Retry) wherever the
// card lives now.
function noteQueuePath() { return path.join(app.getPath('userData'), 'note-queue.json'); }
function loadNoteQueue() {
  try { if (fs.existsSync(noteQueuePath())) return JSON.parse(fs.readFileSync(noteQueuePath(), 'utf8')); } catch (e) { /* fresh */ }
  return [];
}
function saveNoteQueue(q) {
  try { fs.writeFileSync(noteQueuePath(), JSON.stringify(q, null, 2), 'utf8'); } catch (e) { /* ignore */ }
}
let noteWorkerBusy = false;

function queueNote(entry) {
  const q = loadNoteQueue();
  entry.qid = 'q' + Date.now() + Math.random().toString(36).slice(2, 6);
  entry.addedAt = new Date().toISOString();
  entry.tries = 0;
  q.push(entry);
  saveNoteQueue(q);
  setTimeout(noteWorker, 400);
  return entry.qid;
}

async function markLedger(itemId, qid, dest, err) {
  if (!itemId) return;
  try {
    const a = loadActions();
    const it = a.items.find(x => x.id === itemId);
    if (!it) return;
    let log = [];
    try { log = JSON.parse(it.notesLog || '[]'); } catch (e) { log = []; }
    const en = log.find(x => x.q === qid);
    if (en) { en.dest = dest; if (err) en.err = String(err).slice(0, 90); }
    it.notesLog = JSON.stringify(log);
    if (dest === 'principle') it.principleWritten = new Date().toISOString();
    it.updatedAt = new Date().toISOString();
    saveActions(a); await fsPush(it); sendUi('actions-changed', {});
  } catch (e) { netTell('note ledger push failed: ' + String(e).slice(0, 80)); }
}

async function noteWorker() {
  if (noteWorkerBusy) return;
  noteWorkerBusy = true;
  try {
    for (;;) {
      const q = loadNoteQueue();
      if (!q.length) break;
      if (engineBusy()) { setTimeout(noteWorker, 20 * 1000); break; }   // runs own the engine; come back after
      const en = q[0];
      const login = await ensurePrincipleForJobs();
      if (!login.ok) {
        en.tries++; saveNoteQueue(q);
        if (en.tries >= 8) { q.shift(); saveNoteQueue(q); markLedger(en.itemId, en.qid, 'failed', 'Principle login never came good'); appJournal('queued note DROPPED for ' + en.name + ': Principle login never came good'); continue; }
        setTimeout(noteWorker, 60 * 1000); break;
      }
      const res = await engine.addNoteToPatient(en.patientId, en.note, en.name);
      if (res.ok) {
        if (en.pin) { try { await pinFreshNote(en.patientId, en.note, en.name); } catch (e) { /* note landed; pin is decoration */ } }
        q.shift(); saveNoteQueue(q);
        markLedger(en.itemId, en.qid, 'principle');
        appJournal('note sent to Principle for ' + en.name + (en.pin ? ' (pinned)' : ''));
      } else {
        en.tries++; saveNoteQueue(q);
        if (en.tries >= 5) {
          q.shift(); saveNoteQueue(q);
          markLedger(en.itemId, en.qid, 'failed', res.reason || 'rejected');
          appJournal('queued note FAILED for ' + en.name + ': ' + (res.reason || 'rejected'));
        } else {
          setTimeout(noteWorker, 45 * 1000); break;
        }
      }
    }
  } catch (e) {
    appJournal('note worker error: ' + String(e).slice(0, 120));
  }
  noteWorkerBusy = false;
}

ipcMain.handle('note-retry', (e, p) => {
  try {
    const a = loadActions();
    const it = a.items.find(x => x.id === p.itemId);
    if (!it) return { ok: false };
    let log = [];
    try { log = JSON.parse(it.notesLog || '[]'); } catch (e2) { log = []; }
    const en = log.find(x => x.q === p.qid);
    if (!en) return { ok: false };
    en.dest = 'queued'; delete en.err;
    it.notesLog = JSON.stringify(log);
    saveActions(a); fsPush(it);
    queueNote({ patientId: it.patientId, name: it.name, note: en.full || en.t, pin: true, itemId: it.id });
    // point the fresh qid at the same ledger entry
    const q = loadNoteQueue(); en.q = q[q.length - 1].qid;
    it.notesLog = JSON.stringify(log); saveActions(a); fsPush(it);
    sendUi('actions-changed', {});
    return { ok: true };
  } catch (e2) { return { ok: false }; }
});

ipcMain.handle('react-write-note', async (e, p) => {
  const a = loadActions();
  const it = a.items.find(x => x.id === p.id);
  if (!it) return { ok: false, error: 'Item not found.' };
  if (!it.plink && String(it.patientId).startsWith('name:')) return { ok: false, error: 'No Principle link for this patient - add the Patient Link column to the report.' };
  const draft = String(p.text || '').trim().slice(0, 300);
  const labels = { texted: 'no answer, sent text', followup: 'follow-up call requested', offlist: 'patient asked not to be contacted about reactivation - set to inactive', 'offlist-pending': 'patient asked not to be contacted about reactivation - set to inactive', booked: 'booked in' };
  const note = 'Reactivation call ' + new Date().toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ': ' +
    (labels[it.outcome] || 'called') + (draft ? ' - ' + draft : '');
  const qid = queueNote({ patientId: it.patientId, name: it.name, note, pin: true, itemId: it.id });
  const log = reactMigrate(it);
  log.push({ t: draft || '(outcome only)', full: note, d: new Date().toISOString(), dest: 'queued', q: qid });
  it.notesLog = JSON.stringify(log);
  it.updatedAt = new Date().toISOString();
  saveActions(a);
  fsPush(it);
  return { ok: true, queued: true };
});

ipcMain.handle('action-park', async (e, p) => {
  const a = loadActions();
  const it = a.items.find(x => x.id === p.id);
  if (!it) return { ok: false };
  if (p.label) {
    it.parked = String(p.label).slice(0, 40);
    it.parkedAt = new Date().toISOString();
    delete it.chaseFlag;
  } else {
    delete it.parked; delete it.parkedAt;
  }
  it.updatedAt = new Date().toISOString();
  saveActions(a); await fsPush(it);
  return { ok: true };
});

ipcMain.handle('action-pin-note', async (e, p) => {
  const a = loadActions();
  const it = a.items.find(x => x.id === p.id);
  if (!it) return { ok: false, error: 'Item not found.' };
  if (!it.patientId || String(it.patientId).startsWith('name:')) return { ok: false, error: 'No Principle link on this item.' };
  const draft = String(p.text || '').trim().slice(0, 300);
  if (!draft) return { ok: false, error: 'Type the note first, then press the button.' };
  const note = (it.section || 'Action') + ' ' + new Date().toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ': ' + draft;
  queueNote({ patientId: it.patientId, name: it.name, note, pin: true, itemId: it.id });
  return { ok: true, queued: true };
});

ipcMain.handle('action-due', (e, p) => {
  const a = loadActions();
  const it = a.items.find(x => x.id === p.id);
  if (!it) return { ok: false };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.due || '')) return { ok: false, error: 'bad date' };
  it.due = p.due;
  it.updatedAt = new Date().toISOString();
  saveActions(a);
  fsPush(it);
  return { ok: true };
});

ipcMain.handle('action-note', (e, p) => {
  const a = loadActions();
  const it = a.items.find(x => x.id === p.id);
  if (!it) return { ok: false };
  it.noteText = String(p.note || '').slice(0, 200);
  saveActions(a);
  fsPush(it);
  return { ok: true };
});

// Views: hand-set audience tag on one item. '' clears it (falls back to
// the section rule), '*' is an explicit Everyone, otherwise a comma list
// of view names. The whole-doc push drops the field cleanly on clear.
ipcMain.handle('action-views-tag', (e, p) => {
  const a = loadActions();
  const it = a.items.find(x => x.id === p.id);
  if (!it) return { ok: false };
  const t = String(p.tag || '').slice(0, 300);
  if (t) it.viewsTag = t; else delete it.viewsTag;
  saveActions(a);
  fsPush(it);
  return { ok: true };
});

// Views: the shared config (view names + section rules) lives as one
// reserved doc in the same collection, so every machine and the staff
// web page receive it through the sync they already have.
ipcMain.handle('views-config-set', (e, p) => {
  const a = loadActions();
  let it = a.items.find(x => x.id === '_viewsConfig');
  if (!it) {
    it = { id: '_viewsConfig', kind: 'viewscfg', name: 'Views configuration', createdAt: new Date().toISOString() };
    a.items.push(it);
  }
  const views = Array.isArray(p.views) ? p.views.map(v => String(v).trim().slice(0, 40)).filter(Boolean).slice(0, 30) : [];
  const rules = {};
  if (p.rules && typeof p.rules === 'object') {
    for (const s of Object.keys(p.rules).slice(0, 60)) {
      const list = Array.isArray(p.rules[s]) ? p.rules[s].map(v => String(v).trim().slice(0, 40)).filter(Boolean).slice(0, 30) : [];
      if (list.length) rules[String(s).slice(0, 60)] = list;
    }
  }
  it.viewsList = JSON.stringify(views);
  it.viewsRules = JSON.stringify(rules);
  saveActions(a);
  fsPush(it);
  appJournal('views config saved: ' + views.length + ' view(s), rules on ' + Object.keys(rules).length + ' section(s)');
  return { ok: true };
});

ipcMain.handle('action-tick', (e, p) => {
  const a = loadActions();
  const it = a.items.find(x => x.id === p.id);
  if (!it) return { ok: false };
  if (it.doneAt) { delete it.doneAt; delete it.doneNote; delete it.auto; }   // untick
  else {
    it.doneAt = new Date().toISOString(); it.doneNote = String(p.note || '').slice(0, 200);
    // A repeating task respawns itself the moment it's ticked.
    if (it.repeat) {
      const spawn = { ...it, id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6),
        createdAt: new Date().toISOString(), due: nextDue(it.due, it.repeat) };
      delete spawn.doneAt; delete spawn.doneNote; delete spawn.auto;
      a.items.push(spawn);
      fsPush(spawn);
    }
  }
  saveActions(a);
  fsPush(it);
  return { ok: true };
});

// ---------------------------------------------------------------------
// AUTO REPORTS — scheduled Principle-report jobs feeding the Action list.
// No PRODA anywhere in this machinery, by design.
// ---------------------------------------------------------------------
function autoJobsPath() { return path.join(app.getPath('userData'), 'auto-reports.json'); }
function loadAutoJobs() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(autoJobsPath(), 'utf8')); } catch (e) { s = {}; }
  if (!Array.isArray(s.jobs)) s.jobs = [];
  if (!s.jobs.find(j => j.id === 'phone-confirm')) {
    s.jobs.push({
      id: 'phone-confirm',
      name: 'Phone confirmations',
      desc: 'Finds patients with no mobile number who have an appointment coming up, and adds a "confirm appointment manually" item for each to the Confirm appts section. (TEMP: currently takes every patient on the report regardless of visit date, for testing.)',
      url: 'https://app.principle.dental/reporting/custom-reports/2VON7F8xHuej0nJ5NbEu',
      days: [1, 2, 3, 4, 5],
      time: '08:35',
      enabled: true,
      lastRun: null,
    });
  }
  if (!s.jobs.find(j => j.id === 'checkout')) {
    s.jobs.push({
      id: 'checkout',
      name: 'Incomplete checkouts',
      desc: 'Appointments from the last 7 days that were never fully checked out. Each needs the dentist to check out their part, then reception to complete theirs - two ticks per item, auto-assigned to the practitioner.',
      url: 'https://app.principle.dental/reporting/custom-reports/DiwPeXCCZhVufRARmgwl',
      days: [1, 2, 3, 4, 5],
      time: '08:40',
      enabled: true,
      lastRun: null,
    });
  }
  if (!s.jobs.find(j => j.id === 'reception-attn')) {
    s.jobs.push({
      id: 'reception-attn',
      name: 'Reception attention',
      desc: 'Appointments the dentists have flagged for reception to adjust. Each becomes a Reception attention item showing the patient and appointment date.',
      url: 'https://app.principle.dental/reporting/custom-reports/VEiy2Iwl0xkB8g8AKxNk',
      days: [1, 2, 3, 4, 5],
      time: '08:45',
      enabled: true,
      lastRun: null,
    });
  }
  if (!s.jobs.find(j => j.id === 'no-next-visit')) {
    s.jobs.push({
      id: 'no-next-visit',
      name: 'No next visit booked',
      desc: 'Patients seen in the last 30 days (by actual visit date) who have no next visit booked. Each becomes a Rebook item with their mobile number ready, assigned to the treating dentist for context.',
      url: 'https://app.principle.dental/reporting/custom-reports/tiOFgRwc0ioSTA6YIsgU',
      days: [1, 2, 3, 4, 5],
      time: '08:50',
      enabled: true,
      lastRun: null,
    });
  }
  s.jobs = s.jobs.filter(j => j.id !== 'cdbs-14day' && j.special !== 'cdbs' && !/14[- ]?day CDBS/i.test(j.name || '') && !/see Morning run in Advanced tools/i.test(j.desc || ''));
  if (!s.jobs.find(j => j.id === 'reactivation')) {
    s.jobs.push({
      id: 'reactivation',
      name: 'Reactivation calls',
      desc: 'Health fund / DVA patients 8-24 months inactive. Each becomes a card on the Reactivation screen (left sidebar) where staff ring them, pick the outcome, and can send the note to Principle. A rung patient stays off the list for 180 days.',
      url: 'https://app.principle.dental/reporting/custom-reports/XGbateKVQKnBz54uuFrA',
      days: [1, 2, 3, 4, 5],
      time: '09:05',
      enabled: true,
      lastRun: null,
    });
  }
  if (!s.jobs.find(j => j.id === 'react-cdbs')) {
    s.jobs.push({
      id: 'react-cdbs',
      name: 'Reactivation CDBS — under 18',
      desc: 'Under-18 CDBS patients to reactivate. Cards land on the Reactivation CDBS screen (left sidebar) with their last-known CDBS balance; the buttons there refresh balances in batches of 20. Rung patients stay off for 180 days.',
      url: 'https://app.principle.dental/reporting/custom-reports/fLdwQjpblBcgpZZKLT0r',
      days: [1, 2, 3, 4, 5],
      time: '09:10',
      enabled: true,
      lastRun: null,
    });
  }
  if (!s.jobs.find(j => j.id === 'recall')) {
    s.jobs.push({
      id: 'recall',
      name: 'Recall patients not booked back in',
      desc: 'Patients whose recall is due but who have no recall appointment booked. Two ticks per item like the checkouts: the dentist confirms their part, reception books them in - both ticked moves it to Done, where it stays for good (the next visit-cycle makes a fresh item).',
      url: 'https://app.principle.dental/reporting/custom-reports/eNyYzynaqoeRlhRAMQv9',
      days: [1, 2, 3, 4, 5],
      time: '08:45',
      enabled: true,
      lastRun: null,
    });
  }
  if (!s.jobs.find(j => j.id === 'notes-done')) {
    s.jobs.push({
      id: 'notes-done',
      name: 'Complete notes',
      desc: 'Appointments still tagged as notes-not-completed. Each becomes a single-tick Complete notes item assigned to the practitioner, keyed to the exact appointment (a patient with two appointments gets two items). The list mirrors the report: once the notes are written in Principle the appointment drops off the report and the item ticks itself off automatically on the next run.',
      url: 'https://app.principle.dental/reporting/custom-reports/Xi1G2UQyISxdbNwd1fSI',
      days: [1, 2, 3, 4, 5],
      time: '08:55',
      enabled: true,
      lastRun: null,
    });
  }
  if (!s.jobs.find(j => j.id === 'huddle-tags')) {
    s.jobs.push({
      id: 'huddle-tags',
      name: 'Huddle tags',
      desc: 'Upcoming appointments still missing a huddle tag. Each becomes a single-tick item assigned to the practitioner, keyed to the exact appointment. The list mirrors the report: once the tag is added in Principle the appointment drops off the report and the item ticks itself off automatically on the next run. Shown in practitioner views only by default (changeable with the audience picker).',
      url: 'https://app.principle.dental/reporting/custom-reports/2mkONQTzwBbpfidccBPf',
      days: [1, 2, 3, 4, 5],
      time: '09:00',
      enabled: true,
      lastRun: null,
    });
  }
  if (!s.jobs.find(j => j.id === 'unpaid')) {
    s.jobs.push({
      id: 'unpaid',
      name: 'Unpaid invoices',
      desc: 'Patients with money owing. Each becomes an Unpaid item to investigate; park items as Denticare/CDBS/DVA/Gov-voucher pending and the daily report auto-moves them to Done when the money arrives (reconciled). 45 days pending brings them back flagged for chasing.',
      url: 'https://app.principle.dental/reporting/custom-reports/K7vdS83BN6pmHZWyt23s',
      days: [1, 2, 3, 4, 5],
      time: '08:35',
      enabled: true,
      lastRun: null,
    });
  }
  if (!s.jobs.find(j => j.id === 'birthday')) {
    s.jobs.push({
      id: 'birthday',
      name: 'Birthday texts',
      template: 'Happy birthday from all of us at Southside Dental Toowoomba.',
      desc: 'Texts a happy birthday to every patient on the birthday report each morning. A per-year memory (local file + shared cloud) makes sure nobody is ever texted twice for the same birthday, and anything over 30 sends in one day asks your phone before going out.',
      url: 'https://app.principle.dental/reporting/custom-reports/PDto3BKXvfYc4yYGQWG9',
      days: [0, 1, 2, 3, 4, 5, 6],
      time: '10:45',
      enabled: true,
      lastRun: null,
    });
  }
  // Keep the URL current on machines that already carry the row.
  const bj = s.jobs.find(j => j.id === 'birthday');
  if (bj && !bj.url) bj.url = 'https://app.principle.dental/reporting/custom-reports/PDto3BKXvfYc4yYGQWG9';
  if (bj && !(bj.template || '').trim()) bj.template = 'Happy birthday from all of us at Southside Dental Toowoomba.';
  if (!s.jobs.find(j => j.id === 'thankyou-cc')) {
    s.jobs.push({
      id: 'thankyou-cc',
      name: 'Checkup day after thankyou texts',
      desc: 'Texts everyone who came in for their check-up and clean on the last business day: a thank-you, a note that their next 6-month visit is already booked, and the Google review link. Runs every day (weekends too, so Saturday visits are caught) and a cloud memory guarantees nobody is ever texted twice for the same visit.',
      url: 'https://app.principle.dental/reporting/custom-reports/8veMJ9wjrDWUagRPxSN7',
      days: [0, 1, 2, 3, 4, 5, 6],
      time: '15:00',
      enabled: true,
      lastRun: null,
    });
  }
  if (!s.jobs.find(j => j.id === 'noteligible-monthly')) {
    s.jobs.push({
      id: 'noteligible-monthly',
      name: 'Not-eligible CDBS re-check (monthly)',
      desc: 'Once a month, reminds you to re-check patients Medicare previously said no to - eligibility resets with new CDBS entitlement years. The check itself is the \'Re-check all ineligible patients\' button at the top of the Reactivation CDBS screen (needs a PRODA code). Anyone who comes back eligible moves onto the main list automatically.',
      url: '',
      days: [1, 2, 3, 4, 5],
      time: '09:15',
      enabled: true,
      lastRun: null,
    });
  }
  // Keep built-in descriptions current on old installs.
  const ra = s.jobs.find(j => j.id === 'reception-attn');
  if (ra && !ra.url) ra.url = 'https://app.principle.dental/reporting/custom-reports/VEiy2Iwl0xkB8g8AKxNk';
  const ty = s.jobs.find(j => j.id === 'thankyou-cc');
  if (ty) ty.name = 'Checkup day after thankyou texts';
  const nn = s.jobs.find(j => j.id === 'no-next-visit');
  if (nn) nn.desc = 'Patients seen in the last 30 days (by actual visit date) who have no next visit booked. Each becomes a Rebook item with their mobile number ready, assigned to the treating dentist for context.';
  const ne = s.jobs.find(j => j.id === 'noteligible-monthly');
  if (ne) ne.desc = 'Once a month, reminds you to re-check patients Medicare previously said no to - eligibility resets with new CDBS entitlement years. The check itself is the \'Re-check all ineligible patients\' button at the top of the Reactivation CDBS screen (needs a PRODA code). Anyone who comes back eligible moves onto the main list automatically.';
  const pj = s.jobs.find(j => j.id === 'phone-confirm');
  if (pj) pj.desc = 'Finds patients with no mobile number who have an appointment in the next 14 days, and adds a "confirm appointment manually" item for each to the Confirm appts section.';
  // Two families: 'reports' feed the action list, 'sms' jobs text patients.
  // Anything with SMS capability lives in the sms group and runs on its own
  // clock, so texts land at a civilised hour rather than first thing with
  // the morning reports.
  const SMS_JOB_IDS = ['birthday', 'thankyou-cc'];
  for (const j of s.jobs) {
    if (SMS_JOB_IDS.includes(j.id)) j.group = 'sms';
    else if (!j.group) j.group = 'reports';
  }
  if (!s.smsRunAllTime) s.smsRunAllTime = '10:45';
  // First migration only: the SMS clock inherits the main clock's on/off,
  // so birthday/thankyou texts never silently stop on the day of the update.
  if (s.smsRunAllEnabled == null) s.smsRunAllEnabled = !!s.runAllEnabled;
  return s;
}
function saveAutoJobs(s) {
  try {
    const clean = { ...s, jobs: (s.jobs || []).filter(j => j.id !== 'cdbs-14day' && j.special !== 'cdbs' && !/14[- ]?day CDBS/i.test(j.name || '') && !/see Morning run in Advanced tools/i.test(j.desc || '')) };
    fs.writeFileSync(autoJobsPath(), JSON.stringify(clean, null, 2), 'utf8');
  } catch (e) { /* ignore */ }
}

let autoRunning = false;

async function runPhoneConfirmJob(job) {
  runlogStart('auto-phone-confirm');
  runlog('=== auto report: ' + job.name + ' ===');
  const login = await ensurePrincipleForJobs();
  if (!login.ok) {
    runlog('Principle not available - job skipped (reason: ' + (login.reason || 'unknown') + ')');
    return { outcome: 'skipped: Principle needs a login (window opened)' };
  }
  const gen = await principleReport.generateReport(null, (t) => runlog('  ' + t), job.url);
  if (gen.empty) { runlog('report returned 0 rows - nothing to add today'); return { outcome: '0 item(s) added - report empty', added: 0 }; }
  if (!gen.ok) { runlog('report failed: ' + (gen.reason || '?')); return { outcome: 'failed: report did not generate (' + (gen.reason || '?') + ')' }; }
  const rows = rowsToObjects(csvToRows(fs.readFileSync(gen.file).toString('utf8')));
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const nameKey = headers.find(h => /patient name|^name$/i.test(h));
  const linkKey = headers.find(h => /link/i.test(h));
  const emailKey = headers.find(h => /email/i.test(h));
  const visitKey = headers.find(h => /next visit|visit date|appointment date/i.test(h));
  if (!nameKey) { runlog('no Patient Name column'); return { outcome: 'failed: no Patient Name column' }; }
  runlog('report rows parsed: ' + rows.length);

  let a;
  try { a = { items: await fsPull() }; } catch (err) {
    runlog('shared list unreachable - job skipped (nothing added, so no duplicates can be minted)');
    return { outcome: 'skipped: shared list unreachable - fix the connection and Run now' };
  }
  const now = new Date().toISOString();
  let added = 0;
  for (const o of rows) {
    const name = (o[nameKey] || '').trim();
    if (!name) continue;
    const patientId = linkKey ? patientIdFromLink(o[linkKey] || '') : null;
    const pid = patientId || ('name:' + name);
    const visit = visitKey ? (o[visitKey] || '').trim() : '';
    // Only visits inside the next 14 days (inclusive both ends).
    if (!visit) continue;                                   // no upcoming visit
    const dm = visit.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!dm) { runlog('phone confirm: unreadable visit date "' + visit + '" for "' + name + '" - skipped'); continue; }
    const vd = new Date(Number(dm[3]), Number(dm[2]) - 1, Number(dm[1]));
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    const t14 = new Date(t0); t14.setDate(t14.getDate() + 14); t14.setHours(23, 59, 59, 999);
    if (vd < t0 || vd > t14) continue;
    const token = 'confirm:' + visit;
    const dup = a.items.some(it => it.patientId === pid && it.kind === 'confirm-appt' && it.token === token);   // forever: a ticked confirmation never returns
    if (dup) { runlog('  "' + name + '" skipped: already on the list'); continue; }
    const email = emailKey ? (o[emailKey] || '').trim() : '';
    const it = {
      id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6),
      patientId: pid, name, kind: 'confirm-appt', section: 'Confirm appts',
      text: 'No mobile noted - make sure appt confirmed manually',
      context: 'appt ' + visit + (email ? ' · has email: ' + email : ''),
      token, createdAt: now,
    };
    a.items.push(it);
    await fsPush(it);
    added++;
  }
  saveActions(a);
  runlog('phone confirmations: ' + added + ' item(s) added');
  sendUi('actions-changed', {});
  return { outcome: added + ' item(s) added', added };
}

// Principle auto-login: fill the login form with saved credentials.
async function principleAutoLogin() {
  const s = loadMorningSettings();
  // Any window on the Principle domain will do — after a report run the
  // only one is parked on the /reporting/ screen, which is exactly the
  // situation that makes the login probe cry wolf.
  const win = findDiagWindow('principle') || findDiagWindow('report');
  if (!win) return { ok: false, reason: 'no-window' };
  try {
    runlog('Principle heal: sending the window back to the home screen');
    await win.loadURL('https://app.principle.dental');
    await new Promise(r => setTimeout(r, 5000));
    // Very often that navigation alone fixes everything: the session was
    // alive the whole time, the probe was just staring at the wrong page.
    const healed = await engine.checkLoggedIn();
    if (healed.ok) { runlog('Principle heal: logged in all along - report screen had confused the probe'); return { ok: true }; }
    if (!s.principleEmail || !s.principlePassword) return { ok: false, reason: 'no-credentials' };
    runlog('Principle auto-login: filling the login form');
    const filled = await win.webContents.executeJavaScript(`(() => {
      const vis = el => el && el.offsetParent !== null;
      const setV = (el, v) => {
        const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        d.set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const email = [...document.querySelectorAll('input[type=email], input[type=text]')].find(vis);
      const pass = [...document.querySelectorAll('input[type=password]')].find(vis);
      if (!email || !pass) return { ok: false, step: 'no-form', inputs: document.querySelectorAll('input').length };
      setV(email, ${JSON.stringify(s.principleEmail)});
      setV(pass, ${JSON.stringify(s.principlePassword)});
      const btn = [...document.querySelectorAll('button, input[type=submit]')].find(b =>
        vis(b) && /sign in|log ?in|continue|submit/i.test((b.innerText || b.value || '')));
      if (!btn) return { ok: false, step: 'no-button' };
      btn.click();
      return { ok: true };
    })()`, true);
    runlog('Principle auto-login fill: ' + JSON.stringify(filled));
    if (!filled || !filled.ok) return { ok: false, reason: filled && filled.step || 'fill-failed' };
    await new Promise(r => setTimeout(r, 8000));
    const probe = await engine.checkLoggedIn();
    runlog('Principle auto-login probe after submit: ' + JSON.stringify(probe));
    return probe.ok ? { ok: true } : { ok: false, reason: 'login-did-not-take' };
  } catch (e) {
    return { ok: false, reason: String(e).slice(0, 80) };
  }
}

// Quiet ladder: heal and self-login without ever bothering a human.
async function ensurePrincipleQuiet() {
  try { return (await ensurePrincipleForJobs()).ok; } catch (e) { return false; }
}

// Full ladder for jobs: patient probe -> auto-login -> show the window.
// A patient who has failed identically 3+ runs is retried every 3rd day
// instead of daily - their investigate flag stands the whole time, so
// nothing hides; the run just stops re-grinding known failures (60-80s
// each) every single morning.
function chronicSkip(st, patientId) {
  const e = patientId ? st[patientId] : null;
  if (!e || !e.failCount || e.failCount < 3 || !e.lastAttemptAt) return null;
  const since = daysSince(e.lastAttemptAt);
  if (since >= 3) return null;                  // due for a fresh attempt
  const left = Math.max(1, Math.ceil(3 - since));
  return 'chronic fail (' + (e.lastFailReason || 'same failure') + ') - next retry in ' + left + ' day(s), flag standing';
}

let lastEnsureOk = 0;
let ensureInFlight = null;
async function ensurePrincipleForJobs() {
  // Trust window: a login that checked out in the last 3 minutes is not
  // re-litigated - RUN ALL pays the check once, not once per job.
  if (Date.now() - lastEnsureOk < 3 * 60 * 1000) return { ok: true };
  // ONE ensure at a time: a second caller (startup ensure vs Run-now, or
  // any pair) waits for the first instead of fighting it on the same
  // login page - the duel was wedging runs started shortly after boot.
  if (ensureInFlight) return await ensureInFlight;
  ensureInFlight = (async () => {
    try {
      return await ensureLadder();
    } finally { ensureInFlight = null; }
  })();
  return await ensureInFlight;
}
async function ensureLadder() {
  let login = await engine.checkLoggedIn();    // one quick probe
  if (login.ok) { lastEnsureOk = Date.now(); return { ok: true }; }
  const auto = await principleAutoLogin();     // navigate-home heal FIRST, credential login only if truly out
  reclaimTyping();
  if (auto.ok) { lastEnsureOk = Date.now(); appJournal('Principle ready for a job (home-heal or login)'); return { ok: true }; }
  // Last resort: put the window in front of a human.
  const win = findDiagWindow('principle');
  if (win) { win.setPosition(80, 80); win.showInactive(); }
  reclaimTyping();
  sendStatus('needs-login');
  alarmPing('Principle needs a login and the auto-login could not do it (' + (auto.reason || '?') + '). The Principle window is on screen - log in and the jobs will retry.');
  return { ok: false, reason: auto.reason || 'needs-login' };
}

// The login probe can false-negative for a few seconds right after the
// report window has been busy — so ask three times before believing "no".
async function checkLoggedInPatiently() {
  let last = { ok: false, reason: 'unknown' };
  for (let t = 1; t <= 3; t++) {
    last = await engine.checkLoggedIn();
    if (last.ok) return last;
    runlog('login probe said no (attempt ' + t + ', reason: ' + (last.reason || '?') + ') - waiting to re-check');
    await new Promise(r => setTimeout(r, 4000));
  }
  return last;
}

// Pull the ID-looking segment from a Principle link — the last segment is
// often a page name (e.g. /treatment-planning), not the ID.
function idFromLink(link) {
  const parts = String(link || '').split('/').filter(Boolean);
  for (let k = parts.length - 1; k >= 0; k--) {
    if (/^[A-Za-z0-9]{15,}$/.test(parts[k])) return parts[k].slice(0, 40);
  }
  return (parts[parts.length - 1] || '').slice(0, 40);
}

async function runRecallJob(job) {
  runlogStart('auto-recall');
  runlog('=== auto report: ' + job.name + ' ===');
  const login = await ensurePrincipleForJobs();
  if (!login.ok) {
    runlog('Principle not available - job skipped (reason: ' + (login.reason || 'unknown') + ')');
    return { outcome: 'skipped: Principle needs a login (window opened)' };
  }
  const gen = await principleReport.generateReport(null, (t) => runlog('  ' + t), job.url);
  if (gen.empty) { runlog('report returned 0 rows - nothing to add today'); return { outcome: '0 item(s) added - report empty', added: 0 }; }
  if (!gen.ok) { runlog('report failed: ' + (gen.reason || '?')); return { outcome: 'failed: report did not generate (' + (gen.reason || '?') + ')' }; }
  const rows = rowsToObjects(csvToRows(fs.readFileSync(gen.file).toString('utf8')));
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const key = (re) => headers.find(h => re.test(h));
  const nameKey = key(/patient name/i), dateKey = key(/appointment date/i);
  const pracKey = key(/^practitioner name/i), prac2Key = key(/last visit practitioner/i);
  const linkKey = key(/patient link/i), bookedKey = key(/has any recall/i);
  if (!nameKey) { runlog('no Patient Name column'); return { outcome: 'failed: no Patient Name column' }; }
  runlog('report rows parsed: ' + rows.length);

  let a;
  try { a = { items: await fsPull() }; } catch (err) {
    runlog('shared list unreachable - job skipped (nothing added, so no duplicates can be minted)');
    return { outcome: 'skipped: shared list unreachable - fix the connection and Run now' };
  }
  const now = new Date().toISOString();
  let added = 0;
  for (const o of rows) {
    const name = (o[nameKey] || '').trim();
    if (!name) { runlog('  row skipped: blank patient name'); continue; }
    if (bookedKey && /^y/i.test((o[bookedKey] || '').trim())) { runlog('  "' + name + '" skipped: recall already booked'); continue; }
    const token = 'recall:' + ((o[dateKey] || '') + ':' + name);
    // Once handled, handled forever: a ticked recall never comes back for
    // this visit-cycle. The patient's NEXT visit (new date) makes a fresh
    // item, which is the correct next task.
    const dup = a.items.some(it => it.kind === 'recall' && it.token === token);
    if (dup) { runlog('  "' + name + '" skipped: already on the list (' + token + ')'); continue; }
    const it = {
      id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6),
      patientId: 'recall:' + token, name, kind: 'recall', section: 'Recalls',
      text: 'No recall appointment booked',
      context: 'seen ' + (o[dateKey] || '—'),
      token, createdAt: now,
    };
    const prac = ((pracKey && o[pracKey]) || (prac2Key && o[prac2Key]) || '').trim();
    if (prac) it.assignee = prac.slice(0, 40);
    const pl = linkKey ? (o[linkKey] || '').trim() : '';
    if (pl && pl.length > 12) it.plink = pl;
    a.items.push(it);
    await fsPush(it);
    added++;
  }
  saveActions(a);
  runlog('recalls not booked: ' + added + ' item(s) added');
  sendUi('actions-changed', {});
  return { outcome: added + ' item(s) added', added };
}

async function runNotesDoneJob(job) {
  runlogStart('auto-notes-done');
  runlog('=== auto report: ' + job.name + ' ===');
  const login = await ensurePrincipleForJobs();
  if (!login.ok) {
    runlog('Principle not available - job skipped (reason: ' + (login.reason || 'unknown') + ')');
    return { outcome: 'skipped: Principle needs a login (window opened)' };
  }
  const gen = await principleReport.generateReport(null, (t) => runlog('  ' + t), job.url);
  if (!gen.ok && !gen.empty) { runlog('report failed: ' + (gen.reason || '?')); return { outcome: 'failed: report did not generate (' + (gen.reason || '?') + ')' }; }
  // The tag report is the COMPLETE set of appointments still missing notes,
  // so an empty report is a SUCCESS (every note is written) - carry on with
  // zero rows so the mirror pass below can tick everything off.
  const rows = gen.empty ? [] : rowsToObjects(csvToRows(fs.readFileSync(gen.file).toString('utf8')));
  if (gen.empty) runlog('report returned 0 rows - every note is complete');
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const key = (re) => headers.find(h => re.test(h));
  const nameKey = key(/patient name/i), dateKey = key(/appointment date/i);
  const pracKey = key(/practitioner/i), linkKey = key(/appointment link/i);
  if (rows.length && !nameKey) { runlog('no Patient Name column'); return { outcome: 'failed: no Patient Name column' }; }
  runlog('report rows parsed: ' + rows.length);

  let a;
  try { a = { items: await fsPull() }; } catch (err) {
    runlog('shared list unreachable - job skipped (nothing added or cleared, so the list cannot drift)');
    return { outcome: 'skipped: shared list unreachable - fix the connection and Run now' };
  }
  const now = new Date().toISOString();
  // Sort by practitioner then date so each dentist's block reads together.
  rows.sort((x, y) => {
    const px = ((pracKey && x[pracKey]) || '').trim(), py = ((pracKey && y[pracKey]) || '').trim();
    if (px !== py) return px.localeCompare(py);
    const dx = parseReportDate((dateKey && x[dateKey]) || ''), dy = parseReportDate((dateKey && y[dateKey]) || '');
    return (dx ? dx.getTime() : 0) - (dy ? dy.getTime() : 0);
  });
  let added = 0;
  const seenTokens = new Set();
  for (const o of rows) {
    const name = (o[nameKey] || '').trim();
    if (!name) { runlog('  row skipped: blank patient name'); continue; }
    const link = linkKey ? (o[linkKey] || '').trim() : '';
    const apptId = idFromLink(link);
    const token = 'notes:' + (apptId || ((o[dateKey] || '') + ':' + name));
    seenTokens.add(token);
    // Ticked stays ticked: a manually completed appointment never
    // resurrects while its row is still working its way off the report.
    const dup = a.items.some(it => it.kind === 'notes' && it.token === token);
    if (dup) continue;
    const it = {
      id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6),
      patientId: 'appt:' + (apptId || token), name, kind: 'notes', section: 'Complete notes',
      text: 'Complete notes',
      context: 'appt ' + ((dateKey && o[dateKey]) || '—'),
      token, createdAt: now,
    };
    const prac = pracKey ? (o[pracKey] || '').trim() : '';
    if (prac) it.assignee = prac.slice(0, 40);
    if (link && link.length > 12) it.plink = link;
    a.items.push(it);
    await fsPush(it);
    added++;
  }
  runlog('new appointments needing notes: ' + added);
  // ---- mirror pass ----
  // An open Complete-notes item whose appointment is no longer on the
  // report means the notes have since been written in Principle. Tick it
  // off automatically with an audit note (recoverable via undo in Done).
  let cleared = 0;
  for (const it of a.items) {
    if (it.doneAt || it.kind !== 'notes') continue;
    if (seenTokens.has(it.token)) continue;                      // still on the report - genuinely open
    it.doneAt = now; it.doneNote = 'auto-cleared: notes completed in Principle (off the report)'; it.auto = true;
    await fsPush(it);
    cleared++;
    runlog('  "' + it.name + '" auto-cleared: notes completed in Principle');
  }
  if (cleared > 40) appJournal('Complete notes: unusually large auto-clear (' + cleared + ' items) - if that looks wrong, check the report and use undo in Done');
  saveActions(a);
  runlog('complete notes: ' + added + ' item(s) added' + (cleared ? ', ' + cleared + ' auto-cleared' : ''));
  sendUi('actions-changed', {});
  return { outcome: added + ' item(s) added' + (cleared ? ', ' + cleared + ' auto-cleared' : ''), added };
}

async function runHuddleTagJob(job) {
  runlogStart('auto-huddle-tags');
  runlog('=== auto report: ' + job.name + ' ===');
  const login = await ensurePrincipleForJobs();
  if (!login.ok) {
    runlog('Principle not available - job skipped (reason: ' + (login.reason || 'unknown') + ')');
    return { outcome: 'skipped: Principle needs a login (window opened)' };
  }
  const gen = await principleReport.generateReport(null, (t) => runlog('  ' + t), job.url);
  if (!gen.ok && !gen.empty) { runlog('report failed: ' + (gen.reason || '?')); return { outcome: 'failed: report did not generate (' + (gen.reason || '?') + ')' }; }
  // The report is the COMPLETE set of upcoming appointments still missing
  // a huddle tag, so an empty report is a SUCCESS (everything tagged) -
  // carry on with zero rows so the mirror pass can tick everything off.
  const rows = gen.empty ? [] : rowsToObjects(csvToRows(fs.readFileSync(gen.file).toString('utf8')));
  if (gen.empty) runlog('report returned 0 rows - every appointment is tagged');
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const key = (re) => headers.find(h => re.test(h));
  const nameKey = key(/patient name/i), dateKey = key(/appointment date/i);
  const pracKey = key(/practitioner/i), linkKey = key(/appointment link/i);
  if (rows.length && !nameKey) { runlog('no Patient Name column'); return { outcome: 'failed: no Patient Name column' }; }
  runlog('report rows parsed: ' + rows.length);

  let a;
  try { a = { items: await fsPull() }; } catch (err) {
    runlog('shared list unreachable - job skipped (nothing added or cleared, so the list cannot drift)');
    return { outcome: 'skipped: shared list unreachable - fix the connection and Run now' };
  }
  const now = new Date().toISOString();
  // Sort by practitioner then date so each practitioner's block reads together.
  rows.sort((x, y) => {
    const px = ((pracKey && x[pracKey]) || '').trim(), py = ((pracKey && y[pracKey]) || '').trim();
    if (px !== py) return px.localeCompare(py);
    const dx = parseReportDate((dateKey && x[dateKey]) || ''), dy = parseReportDate((dateKey && y[dateKey]) || '');
    return (dx ? dx.getTime() : 0) - (dy ? dy.getTime() : 0);
  });
  let added = 0;
  const seenTokens = new Set();
  for (const o of rows) {
    const name = (o[nameKey] || '').trim();
    if (!name) { runlog('  row skipped: blank patient name'); continue; }
    const link = linkKey ? (o[linkKey] || '').trim() : '';
    const apptId = idFromLink(link);
    const token = 'huddle:' + (apptId || ((o[dateKey] || '') + ':' + name));
    seenTokens.add(token);
    // Ticked stays ticked: a manually completed item never resurrects
    // while its row is still working its way off the report.
    const dup = a.items.some(it => it.kind === 'huddle' && it.token === token);
    if (dup) continue;
    const it = {
      id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6),
      patientId: 'appt:' + (apptId || token), name, kind: 'huddle', section: 'Huddle tags',
      text: 'Needs huddle tag',
      context: 'appt ' + ((dateKey && o[dateKey]) || '\u2014'),
      token, createdAt: now,
    };
    const prac = pracKey ? (o[pracKey] || '').trim() : '';
    if (prac) it.assignee = prac.slice(0, 40);
    if (link && link.length > 12) it.plink = link;
    a.items.push(it);
    await fsPush(it);
    added++;
  }
  runlog('new appointments needing a huddle tag: ' + added);
  // ---- mirror pass ----
  // An open Huddle-tags item whose appointment is no longer on the report
  // means the tag has since been added in Principle (or the appointment
  // has passed and is moot). Tick it off automatically with an audit note
  // (recoverable via undo in Done).
  let cleared = 0;
  for (const it of a.items) {
    if (it.doneAt || it.kind !== 'huddle') continue;
    if (seenTokens.has(it.token)) continue;                      // still on the report - genuinely open
    it.doneAt = now; it.doneNote = 'auto-cleared: huddle tag added in Principle (off the report)'; it.auto = true;
    await fsPush(it);
    cleared++;
    runlog('  "' + it.name + '" auto-cleared: huddle tag added in Principle');
  }
  if (cleared > 60) appJournal('Huddle tags: unusually large auto-clear (' + cleared + ' items) - if that looks wrong, check the report and use undo in Done');
  // First-run default audience: this is practitioners' work, so seed the
  // section rule to practitioner views only (Reception's view stays clean).
  // Seeds ONLY while no rule exists - the audience picker stays the boss.
  try {
    let cfg = a.items.find(x => x.id === '_viewsConfig');
    const rules = cfg && cfg.viewsRules ? JSON.parse(cfg.viewsRules) : {};
    if (!rules['Huddle tags']) {
      const pracs = [...new Set(rows.map(o => ((pracKey && o[pracKey]) || '').trim()).filter(Boolean))].slice(0, 30);
      if (pracs.length) {
        if (!cfg) { cfg = { id: '_viewsConfig', kind: 'viewscfg', name: 'Views configuration', createdAt: now, viewsList: '[]' }; a.items.push(cfg); }
        rules['Huddle tags'] = pracs;
        cfg.viewsRules = JSON.stringify(rules);
        await fsPush(cfg);
        runlog('views: seeded "Huddle tags" audience -> ' + pracs.join(', '));
      }
    }
  } catch (eV) { runlog('views seed skipped: ' + ((eV && eV.message) || eV)); }
  saveActions(a);
  runlog('huddle tags: ' + added + ' item(s) added' + (cleared ? ', ' + cleared + ' auto-cleared' : ''));
  sendUi('actions-changed', {});
  return { outcome: added + ' item(s) added' + (cleared ? ', ' + cleared + ' auto-cleared' : ''), added };
}

async function runCheckoutJob(job) {
  runlogStart('auto-checkout');
  runlog('=== auto report: ' + job.name + ' ===');
  const login = await ensurePrincipleForJobs();
  if (!login.ok) {
    runlog('Principle not available - job skipped (reason: ' + (login.reason || 'unknown') + ')');
    return { outcome: 'skipped: Principle needs a login (window opened)' };
  }
  const gen = await principleReport.generateReport(null, (t) => runlog('  ' + t), job.url);
  if (!gen.ok) { runlog('report failed: ' + (gen.reason || '?')); return { outcome: 'failed: report did not generate (' + (gen.reason || '?') + ')' }; }
  // An empty report is a SUCCESS (nobody incomplete) - carry on with zero
  // rows so the auto-clear pass below can tick off cards it vouches for.
  const rows = gen.empty ? [] : rowsToObjects(csvToRows(fs.readFileSync(gen.file).toString('utf8')));
  if (gen.empty) runlog('report returned 0 rows - nothing to add today');
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const key = (re) => headers.find(h => re.test(h));
  const nameKey = key(/patient name/i), dateKey = key(/appointment date/i), pracKey = key(/practitioner/i);
  const catKey = key(/treatment category/i), amtKey = key(/treatment amount/i), linkKey = key(/appointment link/i);
  if (rows.length && !nameKey) { runlog('no Patient Name column'); return { outcome: 'failed: no Patient Name column' }; }
  runlog('report rows parsed: ' + rows.length);

  let a;
  try { a = { items: await fsPull() }; } catch (err) {
    runlog('shared list unreachable - job skipped (nothing added, so no duplicates can be minted)');
    return { outcome: 'skipped: shared list unreachable - fix the connection and Run now' };
  }
  const now = new Date().toISOString();
  let added = 0;
  for (const o of rows) {
    const name = (o[nameKey] || '').trim();
    if (!name) { runlog('  row skipped: blank patient name'); continue; }
    const link = linkKey ? (o[linkKey] || '').trim() : '';
    const apptId = idFromLink(link);
    const token = 'checkout:' + (apptId || ((o[dateKey] || '') + ':' + name));
    const dup = a.items.some(it => it.kind === 'checkout' && it.token === token && (!it.doneAt || daysSince(it.doneAt) < 14));
    if (dup) { runlog('  "' + name + '" skipped: already on the list (' + token + ')'); continue; }
    const it = {
      id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6),
      patientId: 'appt:' + (apptId || token), name, kind: 'checkout', section: 'Checkouts',
      text: 'Not fully checked out',
      context: 'appt ' + (o[dateKey] || '—'),
      token, createdAt: now,
    };
    const prac = pracKey ? (o[pracKey] || '').trim() : '';
    if (prac) it.assignee = prac.slice(0, 40);
    a.items.push(it);
    await fsPush(it);
    added++;
  }
  // ---- auto-clear (report succeeded, so it can vouch for its window) ----
  // A checkout card whose appointment sits inside the report's saved
  // 30-day range (2-day safety margin -> 28) but whose token is no longer
  // among today's rows means the checkout has since been completed in
  // Principle. Tick it off automatically, with an audit note. Cards older
  // than the window can't be judged by this report and are left alone.
  const seenTokens = new Set();
  for (const o of rows) {
    const nm = (o[nameKey] || '').trim();
    if (!nm) continue;
    const lk = linkKey ? (o[linkKey] || '').trim() : '';
    const aid = idFromLink(lk);
    seenTokens.add('checkout:' + (aid || ((o[dateKey] || '') + ':' + nm)));
  }
  let cleared = 0;
  for (const it of a.items) {
    if (it.doneAt || it.kind !== 'checkout') continue;
    const apptD = parseReportDate(String(it.context || '').replace(/^appt\s+/, ''));
    if (!apptD) continue;                                        // unreadable date - a human decides
    const ageDays = Math.floor((Date.now() - apptD.getTime()) / 86400000);
    if (ageDays < 0 || ageDays > 28) continue;                   // outside the report window - can't verify
    if (seenTokens.has(it.token)) continue;                      // still on the report - genuinely open
    it.doneAt = now; it.doneNote = 'auto-cleared: no longer on the Principle checkout report'; it.auto = true;
    await fsPush(it);
    cleared++;
    runlog('  "' + it.name + '" auto-cleared: no longer on the report (checked out in Principle)');
  }
  saveActions(a);
  runlog('incomplete checkouts: ' + added + ' item(s) added' + (cleared ? ', ' + cleared + ' auto-cleared' : ''));
  sendUi('actions-changed', {});
  return { outcome: added + ' item(s) added' + (cleared ? ', ' + cleared + ' auto-cleared' : ''), added };
}

async function runReceptionAttnJob(job) {
  runlogStart('auto-reception-attn');
  runlog('=== auto report: ' + job.name + ' ===');
  if (!job.url) { runlog('no report URL configured yet'); return { outcome: 'skipped: no report URL configured yet' }; }
  const login = await ensurePrincipleForJobs();
  if (!login.ok) {
    runlog('Principle not available - job skipped (reason: ' + (login.reason || 'unknown') + ')');
    return { outcome: 'skipped: Principle needs a login (window opened)' };
  }
  const gen = await principleReport.generateReport(null, (t) => runlog('  ' + t), job.url);
  if (gen.empty) { runlog('report returned 0 rows - nothing to add today'); return { outcome: '0 item(s) added - report empty', added: 0 }; }
  if (!gen.ok) { runlog('report failed: ' + (gen.reason || '?')); return { outcome: 'failed: report did not generate (' + (gen.reason || '?') + ')' }; }
  const rows = rowsToObjects(csvToRows(fs.readFileSync(gen.file).toString('utf8')));
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const key = (re) => headers.find(h => re.test(h));
  const nameKey = key(/patient name/i), dateKey = key(/appointment date/i), linkKey = key(/link/i);
  if (!nameKey) { runlog('no Patient Name column'); return { outcome: 'failed: no Patient Name column' }; }
  runlog('report rows parsed: ' + rows.length);

  let a;
  try { a = { items: await fsPull() }; } catch (err) {
    runlog('shared list unreachable - job skipped (nothing added, so no duplicates can be minted)');
    return { outcome: 'skipped: shared list unreachable - fix the connection and Run now' };
  }
  const now = new Date().toISOString();
  let added = 0;
  for (const o of rows) {
    const name = (o[nameKey] || '').trim();
    if (!name) { runlog('  row skipped: blank patient name'); continue; }
    const link = linkKey ? (o[linkKey] || '').trim() : '';
    const apptDate = dateKey ? (o[dateKey] || '').trim() : '';
    const idBit = idFromLink(link);
    const token = 'rattn:' + (idBit ? idBit + ':' : '') + apptDate;
    const dup = a.items.some(it => it.kind === 'reception-attn' && it.token === token && (!it.doneAt || daysSince(it.doneAt) < 14));
    if (dup) { runlog('  "' + name + '" skipped: already on the list'); continue; }
    const it = {
      id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6),
      patientId: idBit ? 'p:' + idBit : 'name:' + name,
      name, kind: 'reception-attn', section: 'Reception attention',
      text: 'Flagged by dentist - adjust appointment',
      context: 'appt ' + (apptDate || '—'),
      token, createdAt: now,
    };
    a.items.push(it);
    await fsPush(it);
    added++;
  }
  saveActions(a);
  runlog('reception attention: ' + added + ' item(s) added');
  sendUi('actions-changed', {});
  return { outcome: added + ' item(s) added', added };
}

async function runNoNextVisitJob(job) {
  runlogStart('auto-no-next-visit');
  runlog('=== auto report: ' + job.name + ' ===');
  const login = await ensurePrincipleForJobs();
  if (!login.ok) { runlog('Principle not available - job skipped'); return { outcome: 'skipped: Principle needs a login (window opened)' }; }
  const gen = await principleReport.generateReport(null, (t) => runlog('  ' + t), job.url);
  if (gen.empty) { runlog('report returned 0 rows - nothing to add today'); return { outcome: '0 item(s) added - report empty', added: 0 }; }
  if (!gen.ok) { runlog('report failed: ' + (gen.reason || '?')); return { outcome: 'failed: report did not generate (' + (gen.reason || '?') + ')' }; }
  const rows = rowsToObjects(csvToRows(fs.readFileSync(gen.file).toString('utf8')));
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const key = (re) => headers.find(h => re.test(h));
  const nameKey = key(/patient name/i), pracKey = key(/practitioner/i), lastKey = key(/last visit/i);
  const mobKey = key(/mobile/i), linkKey = key(/patient link/i);
  if (!nameKey) { runlog('no Patient Name column'); return { outcome: 'failed: no Patient Name column' }; }
  runlog('report rows parsed: ' + rows.length);

  let a;
  try { a = { items: await fsPull() }; } catch (err) {
    runlog('shared list unreachable - job skipped (nothing added, so no duplicates can be minted)');
    return { outcome: 'skipped: shared list unreachable - fix the connection and Run now' };
  }
  const now = new Date().toISOString();
  let added = 0;
  for (const o of rows) {
    const name = (o[nameKey] || '').trim();
    if (!name) { runlog('  row skipped: blank patient name'); continue; }
    const pid = (linkKey && patientIdFromLink(o[linkKey] || '')) || ('name:' + name);
    const lastVisit = lastKey ? (o[lastKey] || '').trim() : '';
    const token = 'rebook:' + lastVisit;
    const dup = a.items.some(it => it.patientId === pid && it.kind === 'rebook' && it.token === token && (!it.doneAt || daysSince(it.doneAt) < 14));
    if (dup) { runlog('  "' + name + '" skipped: already on the list'); continue; }
    const mob = mobKey ? (o[mobKey] || '').trim() : '';
    const it = {
      id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6),
      patientId: pid, name, kind: 'rebook', section: 'Rebook',
      text: 'No next visit booked',
      context: ['last visit ' + (lastVisit || '—'), mob].filter(Boolean).join(' · '),
      token, createdAt: now,
    };
    const prac = pracKey ? (o[pracKey] || '').trim() : '';
    if (prac) it.assignee = prac.slice(0, 40);
    a.items.push(it);
    await fsPush(it);
    added++;
  }
  saveActions(a);
  runlog('no next visit: ' + added + ' item(s) added');
  sendUi('actions-changed', {});
  return { outcome: added + ' item(s) added', added };
}

async function runUnpaidJob(job) {
  runlogStart('auto-unpaid');
  runlog('=== auto report: ' + job.name + ' ===');
  const login = await ensurePrincipleForJobs();
  if (!login.ok) { runlog('Principle not available - job skipped'); return { outcome: 'skipped: Principle needs a login (window opened)' }; }
  const gen = await principleReport.generateReport(null, (t) => runlog('  ' + t), job.url);
  if (gen.empty) { runlog('report returned 0 rows - nothing to add today'); return { outcome: '0 item(s) added - report empty', added: 0 }; }
  if (!gen.ok) { runlog('report failed: ' + (gen.reason || '?')); return { outcome: 'failed: report did not generate (' + (gen.reason || '?') + ')' }; }
  const rows = rowsToObjects(csvToRows(fs.readFileSync(gen.file).toString('utf8')));
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const key = (re) => headers.find(h => re.test(h));
  const nameKey = key(/patient name/i), createdKey = key(/invoice created/i), totalKey = key(/invoice total/i), linkKey = key(/invoice link/i);
  if (!nameKey || !linkKey) { runlog('missing Patient Name or Invoice Link column'); return { outcome: 'failed: missing needed columns' }; }
  runlog('report rows parsed: ' + rows.length);

  let a;
  try { a = { items: await fsPull() }; } catch (err) {
    runlog('shared list unreachable - job skipped (nothing added, so no duplicates can be minted)');
    return { outcome: 'skipped: shared list unreachable - fix the connection and Run now' };
  }
  const now = new Date().toISOString();
  let added = 0, escalated = 0;
  for (const o of rows) {
    const name = (o[nameKey] || '').trim();
    if (!name) { runlog('  row skipped: blank patient name'); continue; }
    const link = (o[linkKey] || '').trim();
    const invId = idFromLink(link);
    if (!invId) { runlog('  "' + name + '" skipped: no invoice id in link'); continue; }
    const token = 'inv:' + invId;
    // Lifecycle: open item -> skip. Ticked within 50 days -> snoozed, skip.
    // Ticked 50+ days ago and STILL on the report -> escalate it red.
    const known = a.items.find(it => it.kind === 'unpaid' && it.token === token);
    if (known) {
      if (!known.doneAt) { runlog('  "' + name + '" skipped: already open'); continue; }
      if (daysSince(known.doneAt) < 50) { runlog('  "' + name + '" skipped: investigated ' + Math.round(daysSince(known.doneAt)) + 'd ago (snoozed)'); continue; }
      delete known.doneAt;
      known.escalated = new Date().toISOString();
      known.text = 'Unpaid 50+ days after investigation - look again';
      known.updatedAt = known.escalated;
      await fsPush(known);
      escalated++;
      runlog('  "' + name + '" ESCALATED: still unpaid 50+ days after being ticked (note was: "' + (known.noteText || known.doneNote || '—') + '")');
      continue;
    }
    const pm = link.match(/patients\/([A-Za-z0-9]{15,})/);
    const total = totalKey && o[totalKey] !== '' ? '$' + Number(o[totalKey]).toFixed(2) : '';
    const it = {
      id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6),
      patientId: pm ? pm[1] : ('name:' + name),
      name, kind: 'unpaid', section: 'Unpaid invoices',
      text: 'Unpaid invoice - investigate',
      context: [total, createdKey ? 'invoice ' + (o[createdKey] || '—') : ''].filter(Boolean).join(' · '),
      token, createdAt: now,
    };
    a.items.push(it);
    await fsPush(it);
    added++;
  }
  // --- Pending claims: the report is the reconciliation oracle ---
  // Parked items no longer on today's report have been paid: auto-Done.
  // Parked 45+ days and STILL on the report: eject back to the list flagged.
  const onReport = new Set();
  for (const o of rows) {
    const l = (o[linkKey] || '').trim();
    const iv = idFromLink(l);
    if (iv) onReport.add('inv:' + iv);
  }
  let reconciled = 0, ejected = 0;
  for (const it of a.items) {
    if (it.kind !== 'unpaid' || !it.parked || it.doneAt) continue;
    if (!onReport.has(it.token)) {
      it.doneAt = new Date().toISOString();
      it.doneNote = '✓ reconciled ' + new Date().toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit' }) + ' — dropped off the unpaid report (' + it.parked + ')';
      delete it.parked; delete it.parkedAt;
      it.updatedAt = it.doneAt;
      await fsPush(it);
      reconciled++;
      runlog('  "' + it.name + '" reconciled - no longer on the unpaid report');
    } else if (it.parkedAt && daysSince(it.parkedAt) > 45) {
      it.chaseFlag = 'was ' + it.parked + ' 45+ days — chase the claim';
      delete it.parked; delete it.parkedAt;
      it.updatedAt = new Date().toISOString();
      await fsPush(it);
      ejected++;
      runlog('  "' + it.name + '" EJECTED from pending after 45+ days - claim needs chasing');
    }
  }
  saveActions(a);
  runlog('unpaid invoices: ' + added + ' added, ' + escalated + ' escalated, ' + reconciled + ' reconciled, ' + ejected + ' back from pending');
  sendUi('actions-changed', {});
  return { outcome: added + ' added' + (escalated ? ', ' + escalated + ' ESCALATED (red)' : '') + (reconciled ? ', ' + reconciled + ' reconciled ✓' : '') + (ejected ? ', ' + ejected + ' back from pending' : ''), added };
}

// Cellcast credentials: lifted from the Command Center's local file on
// this PC, so there is only ever one copy of the key.
// Baked-in Cellcast credentials (same account as the Command Center).
const CELLCAST_BAKED_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWJqZWN0IjoiNmE1NDU5MTQ1MzY2NzViYjg0MGZlOTAxIiwidHlwZSI6ImFwcC10b2tlbiIsImlhdCI6MTc4MzkxODMwMDgwNywidXNlcklkIjoiNmE1NDU5MTQ1MzY2NzViYjg0MGZlOTAxIn0.fPG1WvSwmRSUXqT-Ot3R3CDioXnz-Ggk4Prga7kLs1c';
const CELLCAST_BAKED_SENDER = '+61493333955';

function cellcastCreds() {
  // First choice: a key saved in this app's own settings.
  try {
    const ms = loadMorningSettings();
    if (ms.cellcastKey) return { key: ms.cellcastKey, sender: CELLCAST_BAKED_SENDER };
  } catch (e) { /* fall through */ }
  try {
    const f = path.join(app.getPath('appData'), 'SDT Command Center', 'credentials.json');
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    let key = null, sender = null;
    for (const [k, v] of Object.entries(j)) {
      if (/cellcast/i.test(k) && /key|token|api/i.test(k) && typeof v === 'string' && v.length > 10) key = v;
      if (/sender/i.test(k) && typeof v === 'string' && v) sender = v;
    }
    if (!key) { for (const [k, v] of Object.entries(j)) { if (/cellcast/i.test(k) && typeof v === 'string' && v.length > 10) key = v; } }
    return { key: key || CELLCAST_BAKED_KEY, sender: sender || CELLCAST_BAKED_SENDER };
  } catch (e) { return { key: CELLCAST_BAKED_KEY, sender: CELLCAST_BAKED_SENDER }; }
}

function normalizeMobile(raw) {
  let n = String(raw || '').replace(/[^\d+]/g, '');
  if (/^04\d{8}$/.test(n)) n = '+61' + n.slice(1);
  if (/^614\d{8}$/.test(n)) n = '+' + n;
  return /^\+614\d{8}$/.test(n) ? n : null;
}

async function sendCellcastSms(key, sender, number, message) {
  // Mirrors the Command Center's backend exactly (its send is proven live):
  // Enterprise gateway, Bearer auth, success means data.status === true,
  // and Cellcast's own reason lives in data.message when it refuses.
  const body = { message, contacts: [number] };
  if (sender) body.sender = sender;
  const r = await fetchT('https://api.cellcast.com/api/v1/gateway', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': 'Bearer ' + key,
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch (e) { /* non-JSON reply */ }
  const ok = r.ok && j && j.status === true;
  const reason = (j && (j.message || (j.error && j.error.errorMessage))) || (text || '').slice(0, 200) || ('http ' + r.status);
  return { ok, detail: ok ? '' : reason };
}

function birthdaySentPath() { return path.join(app.getPath('userData'), 'birthday-sent.json'); }
function loadBirthdaySent() { try { return JSON.parse(fs.readFileSync(birthdaySentPath(), 'utf8')); } catch (e) { return {}; } }

async function runBirthdayJob(job) {
  runlogStart('auto-birthday');
  runlog('=== auto report: ' + job.name + ' ===');
  const login = await ensurePrincipleForJobs();
  if (!login.ok) { runlog('Principle not available - job skipped'); return { outcome: 'skipped: Principle needs a login (window opened)' }; }
  const gen = await principleReport.generateReport(null, (t) => runlog('  ' + t), job.url);
  if (gen.empty) { runlog('report returned 0 rows - no birthdays today'); return { outcome: '0 sent - no birthdays today', added: 0 }; }
  if (!gen.ok) { runlog('report failed: ' + (gen.reason || '?')); return { outcome: 'failed: report did not generate (' + (gen.reason || '?') + ')' }; }
  const rows = rowsToObjects(csvToRows(fs.readFileSync(gen.file).toString('utf8')));
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const key = (re) => headers.find(h => re.test(h));
  const nameKey = key(/patient name/i), dobKey = key(/date of birth/i), ageKey = key(/age/i), mobKey = key(/mobile/i), linkKey = key(/patient link/i);
  if (!nameKey || !mobKey || !dobKey) { runlog('missing needed columns'); return { outcome: 'failed: missing name/dob/mobile columns' }; }
  runlog('report rows parsed: ' + rows.length);

  const creds = cellcastCreds();
  if (!creds.key) { runlog('Cellcast key not found in the Command Center credentials on this PC'); return { outcome: 'failed: Cellcast key not found on this PC' }; }
  const sender = job.sender || creds.sender || '';
  const year = new Date().getFullYear();
  const sent = loadBirthdaySent();

  // Decide the send list first (the >30 gate needs the count).
  const toSend = [];
  for (const o of rows) {
    const name = (o[nameKey] || '').trim();
    if (!name) continue;
    const num = normalizeMobile(o[mobKey]);
    if (!num) { runlog('  "' + name + '" skipped: no usable mobile'); continue; }
    // The app is the age gate: BOTH the age column and the DOB must say adult.
    const ageM = String(o[ageKey] || '').match(/(\d+)/);
    const ageCol = ageM ? Number(ageM[1]) : null;
    let ageDob = null;
    const dm = String(o[dobKey] || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (dm) {
      const b = new Date(Number(dm[3]), Number(dm[2]) - 1, Number(dm[1]));
      const t = new Date();
      ageDob = t.getFullYear() - b.getFullYear() - ((t.getMonth() < b.getMonth() || (t.getMonth() === b.getMonth() && t.getDate() < b.getDate())) ? 1 : 0);
    }
    if (ageCol == null && ageDob == null) { runlog('  "' + name + '" skipped: age unknown'); continue; }
    if ((ageCol != null && ageCol < 18) || (ageDob != null && ageDob < 18)) { runlog('  "' + name + '" skipped: under 18'); continue; }
    if (sent[num] === year) { runlog('  "' + name + '" skipped: this number already got a birthday text this year'); continue; }
    if (await cloudBirthdaySent(num)) { runlog('  "' + name + '" skipped: already texted this year (other computer)'); sent[num] = year; continue; }
    if (toSend.some(x => x.num === num)) continue;              // same number twice today
    toSend.push({ name, num, pid: linkKey ? patientIdFromLink((o[linkKey] || '').trim()) : null });
  }
  runlog('would send: ' + toSend.length);

  if (toSend.length > 30) {
    const s = loadMorningSettings();
    if (!s.telegramToken || !s.telegramChatId) { runlog('over 30 and no Telegram configured - aborting'); return { outcome: 'aborted: ' + toSend.length + ' sends wanted, no Telegram to confirm' }; }
    await telegram.send(s.telegramToken, s.telegramChatId, 'Birthday job wants to send ' + toSend.length + ' SMS today - unusually many. Reply YES within 30 minutes to send, or ignore and nothing goes out.');
    const ans = await telegram.waitForKeyword(s.telegramToken, s.telegramChatId, 'YES', 30 * 60 * 1000, () => false);
    if (!ans || !ans.ok) { runlog('no YES - nothing sent'); return { outcome: 'aborted: ' + toSend.length + ' sends wanted, no YES on Telegram' }; }
    runlog('YES received - sending');
  }

  let okCount = 0, failCount = 0;
  for (const t of toSend) {
    const r = await sendCellcastSms(creds.key, sender, t.num, job.template || 'Happy birthday from all of us at Southside Dental!');
    if (r.ok) {
      okCount++;
      sent[t.num] = year;
      fs.writeFileSync(birthdaySentPath(), JSON.stringify(sent), 'utf8');
      cloudBirthdayMark(t.num);
      if (t.pid) {
        queueNote({ patientId: t.pid, name: t.name, note: 'Birthday SMS sent ' + todayAU() + '.', pin: false });
        runlog('  sent to "' + t.name + '" (file note queued)');
      } else {
        runlog('  sent to "' + t.name + '" (no patient link - no file note)');
      }
    } else {
      failCount++;
      runlog('  FAILED to "' + t.name + '": ' + r.detail);
    }
    await new Promise(r2 => setTimeout(r2, 800));
  }
  runlog('birthday texts: ' + okCount + ' sent, ' + failCount + ' failed');
  return { outcome: okCount + ' sent' + (failCount ? ', ' + failCount + ' failed' : ''), added: okCount };
}

ipcMain.handle('birthday-test', async (e, p) => {
  const num = normalizeMobile(p.number);
  if (!num) return { ok: false, error: 'That number does not look right - use 04xx xxx xxx.' };
  const creds = cellcastCreds();
  if (!creds.key) return { ok: false, error: 'Cellcast key not found on this PC (is the Command Center installed here?).' };
  const s = loadAutoJobs();
  const job = s.jobs.find(j => j.id === 'birthday') || {};
  const r = await sendCellcastSms(creds.key, job.sender || creds.sender || '', num, job.template || 'Test from SDT Reception.');
  appJournal('birthday test SMS to ' + num + ': ' + (r.ok ? 'sent' : 'failed'));
  return r.ok ? { ok: true } : { ok: false, error: 'Cellcast rejected it: ' + r.detail };
});

async function runReactivationJob(job) {
  runlogStart('auto-reactivation');
  runlog('=== auto report: ' + job.name + ' ===');
  const login = await ensurePrincipleForJobs();
  if (!login.ok) { runlog('Principle not available - job skipped'); return { outcome: 'skipped: Principle needs a login (window opened)' }; }
  const gen = await principleReport.generateReport(null, (t) => runlog('  ' + t), job.url);
  if (gen.empty) { runlog('report returned 0 rows'); return { outcome: '0 item(s) added - report empty', added: 0 }; }
  if (!gen.ok) { runlog('report failed: ' + (gen.reason || '?')); return { outcome: 'failed: report did not generate (' + (gen.reason || '?') + ')' }; }
  const rows = rowsToObjects(csvToRows(fs.readFileSync(gen.file).toString('utf8')));
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const key = (re) => headers.find(h => re.test(h));
  const nameKey = key(/patient name/i), mobKey = key(/mobile/i), feeKey = key(/fee schedule/i), lastKey = key(/last visit/i), linkKey = key(/link/i);
  if (!nameKey) { runlog('no Patient Name column'); return { outcome: 'failed: no Patient Name column' }; }
  runlog('report rows parsed: ' + rows.length + (linkKey ? '' : ' (no Patient Link column - add it in the report builder to enable the Principle button and note-writing)'));

  let a;
  try { a = { items: await fsPull() }; } catch (err) {
    runlog('shared list unreachable - job skipped (nothing added, so no duplicates can be minted)');
    return { outcome: 'skipped: shared list unreachable - fix the connection and Run now' };
  }
  const now = new Date().toISOString();
  let added = 0, reopened = 0;
  for (const o of rows) {
    const name = (o[nameKey] || '').trim();
    if (!name) continue;
    const link = linkKey ? (o[linkKey] || '').trim() : '';
    const pid = (link && patientIdFromLink(link)) || ('name:' + name);
    const token = 'react:' + pid;
    const known = a.items.find(it => it.kind === 'reactivation' && it.token === token);
    if (known) {
      if (link && !known.plink) { known.plink = link; known.patientId = pid; fsPush(known); }   // backfill
      if (!known.doneAt) continue;                                        // open (or follow-up scheduled)
      if (daysSince(known.doneAt) < 180) continue;                        // rung within 6 months
      delete known.doneAt; delete known.outcome; known.attempts = '';
      known.text = 'Ring to reactivate (6+ months since last call)';
      known.updatedAt = now;
      fsPush(known); reopened++;
      continue;
    }
    const it = {
      id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6),
      patientId: pid, name, kind: 'reactivation', section: 'Reactivation',
      text: 'Ring to reactivate',
      context: '',
      mobile: mobKey ? (o[mobKey] || '').trim() : '',
      feeSched: feeKey ? (o[feeKey] || '').trim() : '',
      lastVisit: lastKey ? (o[lastKey] || '').trim() : '',
      plink: link || '',
      token, createdAt: now,
    };
    a.items.push(it);
    await fsPush(it);
    added++;
  }
  saveActions(a);
  runlog('reactivation: ' + added + ' added, ' + reopened + ' reopened after 180 days');
  sendUi('actions-changed', {});
  return { outcome: added + ' added' + (reopened ? ', ' + reopened + ' reopened (180d)' : ''), added };
}

const THANKS_SMS = "Thanks for visiting Southside Dental — it was lovely to see you. Your next 6-month check-up and clean is already booked, and we'll send a reminder closer to the date.\nIf you have a spare moment, we'd really appreciate your feedback: https://g.page/r/CaO2SJuXj2SMEAE/review\nThank you,\nThe SDT team";

function thanksSentPath() { return path.join(app.getPath('userData'), 'thanks-sent.json'); }
function loadThanksLocal() {
  try { if (fs.existsSync(thanksSentPath())) return JSON.parse(fs.readFileSync(thanksSentPath(), 'utf8')); } catch (e) { /* fresh */ }
  return {};
}
async function cloudThanksSent(number, visitKey) {
  const f = 'n' + String(number).replace(/\D/g, '');
  // Local file first: same-machine repeats can never happen even when the
  // cloud misbehaves (the lesson of 06/08's double texts).
  const loc = loadThanksLocal();
  if (loc[visitKey] && loc[visitKey][f]) return true;
  try {
    const t = await fbToken();
    const r = await fetchT(FS_ROOT + '/sentBirthdays/thanks_' + visitKey, { headers: { Authorization: 'Bearer ' + t } });
    if (r.status === 403) { fsTell('thank-you guard: cloud memory REFUSED (403) - fix the Firestore rules for sentBirthdays'); return false; }
    if (!r.ok) return false;
    const j = await r.json();
    return !!(j.fields && j.fields[f]);
  } catch (e) { return false; }
}
async function cloudThanksMark(number, visitKey) {
  const f = 'n' + String(number).replace(/\D/g, '');
  try {
    const loc = loadThanksLocal();
    loc[visitKey] = loc[visitKey] || {};
    loc[visitKey][f] = localToday();
    fs.writeFileSync(thanksSentPath(), JSON.stringify(loc), 'utf8');
  } catch (e) { /* cloud may still catch it */ }
  try {
    const t = await fbToken();
    const r = await fetchT(FS_ROOT + '/sentBirthdays/thanks_' + visitKey + '?updateMask.fieldPaths=' + f, {
      method: 'PATCH', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { [f]: { stringValue: localToday() } } }),
    });
    if (!r.ok) fsTell('thank-you guard: cloud mark FAILED (HTTP ' + r.status + ') - fix the Firestore rules for sentBirthdays');
  } catch (e) { fsTell('thank-you guard: cloud mark failed: ' + String(e).slice(0, 80)); }
}

async function runThankYouJob(job) {
  runlogStart('auto-thankyou');
  runlog('=== auto report: ' + job.name + ' ===');
  const creds = cellcastCreds();
  if (!creds || !creds.key) { runlog('no Cellcast key - job skipped'); return { outcome: 'skipped: no Cellcast key saved' }; }
  const login = await ensurePrincipleForJobs();
  if (!login.ok) { runlog('Principle not available - job skipped'); return { outcome: 'skipped: Principle needs a login (window opened)' }; }
  const gen = await principleReport.generateReport(null, (t) => runlog('  ' + t), job.url);
  if (gen.empty) { runlog('report returned 0 rows - nobody to thank'); return { outcome: '0 visits on the report - nothing sent', added: 0 }; }
  if (!gen.ok) { runlog('report failed: ' + (gen.reason || '?')); return { outcome: 'failed: report did not generate (' + (gen.reason || '?') + ')' }; }
  const rows = rowsToObjects(csvToRows(fs.readFileSync(gen.file).toString('utf8')));
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const key = (re) => headers.find(h => re.test(h));
  const nameKey = key(/patient name/i), mobKey = key(/mobile/i), dateKey = key(/appointment date/i);
  if (!mobKey) { runlog('no mobile column on the report'); return { outcome: 'failed: no Patient Mobile Number column' }; }
  let sent = 0, already = 0, noNum = 0, failed = 0;
  for (const o of rows) {
    const name = (o[nameKey] || '').trim();
    const mob = normalizeMobile(o[mobKey] || '');
    const visitKey = String((dateKey && o[dateKey]) || localToday()).replace(/\D/g, '') || localToday().replace(/\D/g, '');
    if (!mob) { noNum++; runlog('no usable mobile for ' + (name || '(no name)')); continue; }
    if (await cloudThanksSent(mob, visitKey)) { already++; continue; }
    const r = await sendCellcastSms(creds.key, creds.sender, mob, THANKS_SMS);
    if (r.ok) {
      sent++;
      await cloudThanksMark(mob, visitKey);
      runlog('thank-you sent to ' + name + ' (' + mob + ')');
    } else {
      failed++;
      runlog('send FAILED for ' + name + ': ' + (r.reason || '?'));
    }
    await new Promise(res => setTimeout(res, 1200));
  }
  runlog('thank-you texts: ' + sent + ' sent, ' + already + ' already thanked, ' + noNum + ' without mobiles, ' + failed + ' failed');
  return { outcome: sent + ' sent' + (already ? ', ' + already + ' already thanked' : '') + (noNum ? ', ' + noNum + ' no mobile' : '') + (failed ? ', ' + failed + ' FAILED' : '') };
}

async function runReactCdbsJob(job) {
  runlogStart('auto-react-cdbs');
  runlog('=== auto report: ' + job.name + ' ===');
  const login = await ensurePrincipleForJobs();
  if (!login.ok) { runlog('Principle not available - job skipped'); return { outcome: 'skipped: Principle needs a login (window opened)' }; }
  const gen = await principleReport.generateReport(null, (t) => runlog('  ' + t), job.url);
  if (gen.empty) { runlog('report returned 0 rows'); return { outcome: '0 item(s) added - report empty', added: 0 }; }
  if (!gen.ok) { runlog('report failed: ' + (gen.reason || '?')); return { outcome: 'failed: report did not generate (' + (gen.reason || '?') + ')' }; }
  const rows = rowsToObjects(csvToRows(fs.readFileSync(gen.file).toString('utf8')));
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const key = (re) => headers.find(h => re.test(h));
  const nameKey = key(/patient name/i), mobKey = key(/mobile/i), dobKey = key(/birth|dob/i), linkKey = key(/link/i);
  if (!nameKey) { runlog('no Patient Name column'); return { outcome: 'failed: no Patient Name column' }; }
  runlog('report rows parsed: ' + rows.length
    + (linkKey ? '' : ' (no Patient Link column - add it in the report builder: needed for balance checks and the Principle button)')
    + (dobKey ? '' : ' (no DOB column - add it for card-finding)'));
  let a;
  try { a = { items: await fsPull() }; } catch (err) {
    runlog('shared list unreachable - job skipped (nothing added, so no duplicates can be minted)');
    return { outcome: 'skipped: shared list unreachable - fix the connection and Run now' };
  }
  const now = new Date().toISOString();
  let added = 0, reopened = 0;
  for (const o of rows) {
    const name = (o[nameKey] || '').trim();
    if (!name) continue;
    const link = linkKey ? (o[linkKey] || '').trim() : '';
    const pid = (link && patientIdFromLink(link)) || ('name:' + name);
    const token = 'reactcdbs:' + pid;
    const known = a.items.find(it => it.kind === 'reactcdbs' && it.token === token);
    if (known) {
      if (link && !known.plink) { known.plink = link; known.patientId = pid; fsPush(known); }
      if (dobKey && !known.dob) { known.dob = (o[dobKey] || '').trim(); fsPush(known); }
      if (!known.doneAt) continue;
      if (daysSince(known.doneAt) < 180) continue;
      delete known.doneAt; delete known.outcome; known.attempts = '';
      known.text = 'Ring to reactivate (6+ months since last call)';
      known.updatedAt = now;
      fsPush(known); reopened++;
      continue;
    }
    const it = {
      id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6),
      patientId: pid, name, kind: 'reactcdbs', section: 'Reactivation CDBS',
      text: 'Ring to reactivate CDBS',
      context: '',
      mobile: mobKey ? (o[mobKey] || '').trim() : '',
      dob: dobKey ? (o[dobKey] || '').trim() : '',
      feeSched: '', lastVisit: '',
      plink: link || '',
      token, createdAt: now,
    };
    a.items.push(it);
    await fsPush(it);
    added++;
  }
  saveActions(a);
  runlog('reactivation CDBS: ' + added + ' added, ' + reopened + ' reopened after 180 days');
  sendUi('actions-changed', {});
  return { outcome: added + ' added' + (reopened ? ', ' + reopened + ' reopened (180d)' : ''), added };
}

async function runAutoJob(id) {
  if (autoRunning) return { ok: false, error: 'An auto report is already running.' };
  if (runAllState.running || runState.running || collectState.running || balanceState.running || genState.running || morningState.running) {
    return { ok: false, error: 'Something else is running - try again shortly.' };
  }
  const s = loadAutoJobs();
  const job = s.jobs.find(j => j.id === id);
  if (!job) return { ok: false, error: 'Unknown job.' };
  autoRunning = true;
  try {
    let result = { outcome: 'unknown job type (id: ' + id + ')' };
    if (job.id === 'phone-confirm') result = await runPhoneConfirmJob(job);
    else if (job.id === 'checkout') result = await runCheckoutJob(job);
    else if (job.id === 'reception-attn') result = await runReceptionAttnJob(job);
    else if (job.id === 'no-next-visit') result = await runNoNextVisitJob(job);
    else if (job.id === 'unpaid') result = await runUnpaidJob(job);
    else if (job.id === 'recall') result = await runRecallJob(job);
    else if (job.id === 'notes-done') result = await runNotesDoneJob(job);
    else if (job.id === 'huddle-tags') result = await runHuddleTagJob(job);
    else if (job.id === 'birthday') result = await runBirthdayJob(job);
    else if (job.id === 'reactivation') result = await runReactivationJob(job);
    else if (job.id === 'react-cdbs') result = await runReactCdbsJob(job);
    else if (job.id === 'thankyou-cc') result = await runThankYouJob(job);
    else if (job.id === 'noteligible-monthly') {
      const lm = job.lastRun && job.lastRun.when ? new Date(job.lastRun.when) : null;
      const nowD = new Date();
      if (lm && lm.getFullYear() === nowD.getFullYear() && lm.getMonth() === nowD.getMonth()) {
        result = { outcome: 'already reminded this month' };
      } else {
        const a2 = loadActions();
        const it2 = {
          id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6),
          patientId: 'noteligible:' + localToday(),
          name: 'Monthly: re-check the Not-eligible CDBS drawer',
          kind: 'general', section: 'General',
          text: 'Open Reactivation CDBS and press "Re-check all ineligible patients" at the top (needs a PRODA code). New entitlement years turn old no-answers into yes.',
          context: '', token: 'noteligible:' + localToday().slice(0, 7),
          createdAt: new Date().toISOString(),
        };
        if (!a2.items.some(x => x.token === it2.token && !x.doneAt)) {
          a2.items.push(it2); saveActions(a2); await fsPush(it2); sendUi('actions-changed', {});
        }
        result = { outcome: 'monthly reminder added to the action list' };
      }
    }
    job.lastRun = { when: new Date().toISOString(), outcome: result.outcome, added: result.added || 0 };
    saveAutoJobs(s);
    appJournal('auto report "' + job.name + '": ' + result.outcome);
    ledgerReport(job.id, job.name, result.outcome).catch(() => {});
    if (/^failed/.test(result.outcome)) alarmPing('Auto report "' + job.name + '" failed: ' + result.outcome);
    return { ok: true, outcome: result.outcome };
  } catch (e) {
    job.lastRun = { when: new Date().toISOString(), outcome: 'crashed: ' + String(e).slice(0, 80) };
    saveAutoJobs(s);
    return { ok: false, error: String(e).slice(0, 120) };
  } finally {
    autoRunning = false;
  }
}

// The 5-minute pulse: run any enabled job whose day + time has arrived.
setInterval(async () => {
  try {
    if (!isWorker()) return;   // viewer computers never fire schedules
    // ONE CLOCK: the per-job times are retired - the whole morning runs as
    // a single scheduled RUN ALL (jobs keep their on/off toggles, which
    // decide what is IN the run).
    const now = new Date();
    const today = localToday();
    const s = loadAutoJobs();
    // TWO CLOCKS, same machinery: the reports run and the SMS run each
    // carry their own time, their own once-a-day memory and their own
    // fleet claim - so texting jobs go out at a civilised hour instead of
    // first thing with the morning reports.
    const clocks = [
      { group: 'reports', enabled: !!s.runAllEnabled, time: s.runAllTime || '08:30', dayKey: 'lastRunAllDay', deferKey: 'lastDeferTold', claim: 'runall', label: 'daily RUN ALL' },
      { group: 'sms', enabled: !!s.smsRunAllEnabled, time: s.smsRunAllTime || '10:45', dayKey: 'lastSmsRunAllDay', deferKey: 'lastSmsDeferTold', claim: 'runall-sms', label: 'daily SMS RUN ALL' },
    ];
    for (const c of clocks) {
      if (!c.enabled) continue;
      const [h, m] = c.time.split(':').map(Number);
      if (now.getHours() * 60 + now.getMinutes() < h * 60 + m) continue;
      if (s[c.dayKey] === today) continue;
      try {
        const fr = await fleetRuns();
        const already = fr.find(r2 => r2.jobId === c.claim && r2.day === today);
        if (already) {
          const sF = loadAutoJobs();
          sF[c.dayKey] = today;
          saveAutoJobs(sF);
          s[c.dayKey] = today;
          appJournal(c.label + ' clock: standing down - already ran today (' + (already.machine || '?') + ')');
          continue;
        }
      } catch (eF) { /* cloud quiet - fall through to the ledger claim below */ }
      if (autoRunAllBusy || morningState.running || runAllState.running || runState.running || collectState.running || balanceState.running || genState.running || noteWorkerBusy) return;
      const login = await ensurePrincipleForJobs();   // heal ladder, not the naked probe
      if (!login.ok) {
        if (s[c.deferKey] !== today) {
          const sD = loadAutoJobs();
          sD[c.deferKey] = today;
          saveAutoJobs(sD);
          s[c.deferKey] = today;
          appJournal(c.label + ': deferring - Principle needs a login (window opened); retrying every 5 minutes');
        }
        return;   // defer to the next pulse, never spend the day
      }
      const claim = await ledgerClaim(c.claim);
      const s2 = loadAutoJobs();   // fresh read: never clobber a Save made during the waits
      if (!claim.mine) {
        s2[c.dayKey] = today;
        saveAutoJobs(s2);
        s[c.dayKey] = today;
        appJournal(c.label + ': already ran today on ' + claim.who);
        continue;
      }
      s2[c.dayKey] = today;
      saveAutoJobs(s2);
      autoRunAllBusy = true;
      runAllCore('scheduled ' + c.time, c.group);
      return;   // one run per pulse - the other clock gets the next pulse
    }
  } catch (e) { /* the pulse never dies */ }
}, 5 * 60 * 1000);

ipcMain.handle('auto-get', () => {
  const s = loadAutoJobs();
  const ms = loadMorningSettings();
  const morningRow = {
    id: 'cdbs-14day',
    group: 'reports',
    name: '14-day CDBS morning run',
    desc: 'The big daily check: pulls the 14-day appointment report, collects Medicare details, asks your phone for the YES, checks every balance in PRODA and writes the notes into Principle. Credentials and Telegram live in Advanced tools - Morning run settings; the schedule lives right here.',
    url: '',
    days: Array.isArray(ms.mDays) && ms.mDays.length ? ms.mDays : [1, 2, 3, 4, 5],
    time: ms.morningTime || '08:30',
    enabled: !!ms.enabled,
    lastRun: ms.lastMorningRun || null,
  };
  return { ...s, jobs: [morningRow, ...(s.jobs || [])] };
});
ipcMain.handle('auto-save', (e, p) => {
  if (p.id === 'cdbs-14day') {
    saveMorningSettings({
      enabled: !!p.enabled,
      morningTime: (() => {
        const d = String(p.time || '').replace(/\D/g, '');
        if (d.length >= 3 && d.length <= 4) {
          const hh = Number(d.slice(0, d.length - 2)), mm = Number(d.slice(-2));
          if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
        }
        return null;
      })(),
      mDays: Array.isArray(p.days) ? p.days.filter(d => d >= 0 && d <= 6) : null,
    });
    return { ok: true };
  }
  const s = loadAutoJobs();
  const job = s.jobs.find(j => j.id === p.id);
  if (!job) return { ok: false };
  if (Array.isArray(p.days)) job.days = p.days.filter(d => d >= 0 && d <= 6);
  {
    // Forgive "830", "0830", "8.30", "8 30" - normalise to HH:MM.
    const digits = String(p.time || '').replace(/\D/g, '');
    if (digits.length >= 3 && digits.length <= 4) {
      const hh = Number(digits.slice(0, digits.length - 2)), mm = Number(digits.slice(-2));
      if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) job.time = String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
    }
  }
  if (p.template != null) job.template = String(p.template).slice(0, 320);
  if (p.sender != null) job.sender = String(p.sender).slice(0, 20);
  job.enabled = !!p.enabled;
  saveAutoJobs(s);
  return { ok: true };
});
let autoRunAllBusy = false;
async function runAllCore(how, group) {
  group = group === 'sms' ? 'sms' : 'reports';
  const LBL = group === 'sms' ? 'SMS RUN ALL' : 'RUN ALL';
  const s = loadAutoJobs();
  const ms = loadMorningSettings();
  const jobs = (s.jobs || []).filter(j => j.enabled && (j.group || 'reports') === group);
  const withMorning = group === 'reports' && !!ms.enabled;
  const results = [];
  // Live headline for the strip under the RUN ALL button of this group's tab.
  const live = (text, done) => { try { sendUi('runall-live', { group, text: String(text || ''), done: !!done }); } catch (e) { /* UI is optional */ } };
  const total = jobs.length + (withMorning ? 1 : 0);
  appJournal(LBL + ' (' + how + '): ' + total + ' job(s)');
  live(LBL + ' started (' + how + '): ' + total + ' job(s)\u2026');
  let prodaWarm = null;
  if (withMorning) {
    appJournal('run all: asking for the PRODA code up front (desk box + Telegram - first answer wins)');
    prodaWarm = ensureProdaLoggedIn((t) => beat('Run all - PRODA warm-up: ' + t)).catch(() => ({ ok: false }));
  }
  let jobNo = 0;
  for (const j of jobs) {
    try {
      jobNo++;
      beat('Run all: ' + j.name);
      live('Running ' + jobNo + ' of ' + total + ': ' + j.name + '\u2026');
      const r = await runAutoJob(j.id);
      results.push({ name: j.name, outcome: (r && r.outcome) || 'done' });
      appJournal('run all - "' + j.name + '": ' + ((r && r.outcome) || 'done'));
    } catch (e2) {
      results.push({ name: j.name, outcome: 'ERRORED: ' + String(e2).slice(0, 80) });
      appJournal('run all - "' + j.name + '" ERRORED: ' + String(e2).slice(0, 100));
    }
  }
  if (withMorning) {
    if (prodaWarm) { beat('Run all: waiting for the PRODA warm-up to finish'); await prodaWarm; }
    beat('Run all: 14-day CDBS morning run (desk mode)');
    live('Running ' + total + ' of ' + total + ': 14-day CDBS morning run \u2014 detailed progress in the Morning run card below\u2026');
    morningState = { running: true, stopRequested: false };
    try {
      try { await morningRun('desk'); } catch (eM) {
        appJournal('morning run crashed: ' + String(eM).slice(0, 120));
        try { saveMorningSettings({ lastMorningRun: { when: new Date().toISOString(), outcome: 'stopped: crashed - ' + String(eM).slice(0, 90) } }); } catch (e2) { /* cosmetic */ }
        ledgerReport('cdbs-14day', '14-day CDBS morning run', 'stopped: crashed').catch(() => {});
        morningState.running = false;
      }
      const ms2 = loadMorningSettings();
      results.push({ name: '14-day CDBS morning run', outcome: (ms2.lastMorningRun && ms2.lastMorningRun.outcome) || 'finished' });
    } catch (e4) {
      morningState.running = false;
      results.push({ name: '14-day CDBS morning run', outcome: 'ERRORED: ' + String(e4).slice(0, 90) });
      appJournal('run all - morning run ERRORED: ' + String(e4).slice(0, 120));
    }
  }
  beat('');
  // ---- the one diagnostic report, straight to the phone ----
  try {
    const ms3 = loadMorningSettings();
    if (ms3.telegramToken && ms3.telegramChatId) {
      const lines = results.map(r2 => ((/fail|error|skipped|aborted|not successful|stopped/i.test(r2.outcome) ? '⚠ ' : '✓ ') + r2.name + ': ' + r2.outcome));
      await telegram.send(ms3.telegramToken, ms3.telegramChatId,
        'Daily ' + LBL + ' (' + how + ') finished ' + new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' }) + '\n' + lines.join('\n'));
    }
  } catch (e3) { appJournal('run-all summary send failed: ' + String(e3).slice(0, 80)); }
  try {
    const lines2 = results.map(r2 => ((/fail|error|skipped|aborted|not successful|stopped/i.test(r2.outcome) ? '⚠ ' : '✓ ') + r2.name + ': ' + r2.outcome));
    await ledgerReport(group === 'sms' ? 'runall-sms' : 'runall', LBL + ' (' + how + ')', lines2.join('\n'));
    const mres = results.find(r2 => r2.name === '14-day CDBS morning run');
    if (mres) await ledgerReport('cdbs-14day', '14-day CDBS morning run', mres.outcome);
  } catch (e5) { /* history is best-effort */ }
  try {
    const bad = results.filter(r2 => /fail|error|skipped|aborted|not successful|stopped/i.test(r2.outcome)).length;
    live('Finished ' + new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' }) + ' \u2014 ' + results.length + ' job(s)' + (bad ? ', ' + bad + ' \u26a0' : ', all \u2713'), true);
  } catch (eL) { /* cosmetic */ }
  appJournal(LBL + ' finished (' + how + ')');
  autoRunAllBusy = false;
}

ipcMain.handle('auto-run-all', async (e, p) => {
  const group = p && p.group === 'sms' ? 'sms' : 'reports';
  if (autoRunAllBusy) return { ok: false, error: 'A run all is already going.' };
  if (noteWorkerBusy) return { ok: false, error: 'A note is being written to Principle - try again in a few seconds.' };
  if (morningState.running || runAllState.running || runState.running || collectState.running || balanceState.running || genState.running) {
    return { ok: false, error: 'Something is already running - let it finish first.' };
  }
  const s = loadAutoJobs();
  const ms = loadMorningSettings();
  const withMorning = group === 'reports' && !!ms.enabled;
  const n = (s.jobs || []).filter(j => j.enabled && (j.group || 'reports') === group).length + (withMorning ? 1 : 0);
  autoRunAllBusy = true;
  runAllCore('button', group);
  return { ok: true, count: n, withMorning };
});

ipcMain.handle('runall-sched', (e, p) => {
  const s = loadAutoJobs();
  const sms = !!(p && p.group === 'sms');
  const enKey = sms ? 'smsRunAllEnabled' : 'runAllEnabled';
  const timeKey = sms ? 'smsRunAllTime' : 'runAllTime';
  const fallback = sms ? '10:45' : '08:30';
  if (p.enabled != null) s[enKey] = !!p.enabled;
  if (p.time != null) {
    const d = String(p.time).replace(/\D/g, '');
    if (d.length >= 3 && d.length <= 4) {
      const hh = Number(d.slice(0, d.length - 2)), mm = Number(d.slice(-2));
      if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) s[timeKey] = String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
    }
  }
  saveAutoJobs(s);
  appJournal('daily ' + (sms ? 'SMS ' : '') + 'RUN ALL schedule: ' + (s[enKey] ? ('ON at ' + (s[timeKey] || fallback)) : 'OFF'));
  return { ok: true, enabled: !!s[enKey], time: s[timeKey] || fallback };
});

ipcMain.handle('auto-run', async (e, p) => {
  if (p.id === 'cdbs-14day') {
    if (morningState.running || runAllState.running || runState.running || collectState.running || balanceState.running || genState.running) {
      return { ok: false, error: 'Something is already running.' };
    }
    morningState = { running: true, stopRequested: false };
    morningRun('desk').catch((eM) => {
      appJournal('morning run crashed: ' + String(eM).slice(0, 120));
      try { saveMorningSettings({ lastMorningRun: { when: new Date().toISOString(), outcome: 'stopped: crashed - ' + String(eM).slice(0, 90) } }); } catch (e2) { /* cosmetic */ }
      ledgerReport('cdbs-14day', '14-day CDBS morning run', 'stopped: crashed').catch(() => {});
      morningState.running = false;
    });
    return { ok: true, outcome: 'desk run started - no phone question; the PRODA code goes into the box in the app' };
  }
  return runAutoJob(p.id);
});

// ---------- IPC for the settings card and the scheduler ----------
ipcMain.handle('morning-get-settings', () => {
  const s = loadMorningSettings();
  return {
    haveUsername: !!s.prodaUsername,
    havePassword: !!s.prodaPassword,
    haveToken: !!s.telegramToken,
    chatId: s.telegramChatId,
    enabled: s.enabled,
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    fbEmail: s.fbEmail || '',
    haveFbPassword: !!s.fbPassword,
  };
});

ipcMain.handle('morning-save-settings', (e, updates) => saveMorningSettings(updates || {}));

ipcMain.handle('fb-auth-test', async () => {
  fbTok = { token: null, exp: 0 };   // force a fresh sign-in next time too
  try {
    const ms = loadMorningSettings();
    if (!ms.fbEmail || !ms.fbPassword) return { ok: false, error: 'No app account saved yet - fill both boxes and Save first.' };
    const r = await fetchT('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + FB_API_KEY, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ms.fbEmail, password: ms.fbPassword, returnSecureToken: true }),
    });
    const j = await r.json();
    if (j.idToken) { appJournal('app cloud sign-in test: OK as ' + ms.fbEmail); return { ok: true, email: ms.fbEmail }; }
    return { ok: false, error: (j.error && j.error.message) || ('HTTP ' + r.status) };
  } catch (e2) { return { ok: false, error: String(e2).slice(0, 120) }; }
});

ipcMain.handle('morning-test-telegram', async () => {
  const s = loadMorningSettings();
  if (!s.telegramToken) return { ok: false, error: 'Save the bot token first.' };
  let chatId = s.telegramChatId;
  if (!chatId) {
    const d = await telegram.discoverChatId(s.telegramToken);
    if (!d.ok) {
      return { ok: false, error: d.reason === 'no-messages'
        ? 'Open Telegram, send your bot any message (e.g. "hello"), then press Test again.'
        : 'Telegram did not accept the token: ' + d.reason };
    }
    chatId = d.chatId;
    saveMorningSettings({ telegramChatId: chatId });
  }
  const sent = await telegram.send(s.telegramToken, chatId, 'Test from SDT Admin - the morning run can reach this phone.');
  return sent.ok ? { ok: true, chatId } : { ok: false, error: 'Could not send: ' + sent.error };
});

ipcMain.handle('morning-run-now', async () => {
  if (noteWorkerBusy) return { ok: false, error: 'A note is being written to Principle - try again in a few seconds.' };
  if (morningState.running || runAllState.running || runState.running || collectState.running || balanceState.running || genState.running) {
    return { ok: false, error: 'Something is already running.' };
  }
  morningState = { running: true, stopRequested: false };
  morningRun('manual-test');
  return { ok: true };
});

ipcMain.handle('morning-stop', () => {
  morningState.stopRequested = true;
  return { ok: true };
});

// The scheduler starts the app with --auto-run (6am if the PC is on, or at
// the first log-on of the day). Guards: weekdays only, once per day, and
// only when the feature is switched on.
function maybeAutoRun() {
  if (!isWorker()) return;   // viewer computers never ask the morning question
  if (!process.argv.includes('--auto-run')) return;
  // The one-clock owns the morning when enabled: the old 6am phone-YES
  // path stands down so the CDBS run can never happen twice in a day.
  try {
    if (loadAutoJobs().runAllEnabled) {
      appJournal('6am auto-run: standing down - the daily RUN ALL clock owns the morning');
      return;
    }
  } catch (e) { /* fall through to the old behaviour */ }
  const day = new Date().getDay();
  const s = loadMorningSettings();
  const okDays = Array.isArray(s.mDays) && s.mDays.length ? s.mDays : [1, 2, 3, 4, 5];
  if (!okDays.includes(day)) return;                  // not a chosen day
  if (!s.enabled) return;
  if (alreadyRanToday()) return;
  // The ask goes out at 8:30. PC on earlier: the app idles until then.
  // PC turned on after 8:30: it asks straight away (12s settle first).
  const now = new Date();
  const [th, tm] = (s.morningTime || '08:30').split(':').map(Number);
  const target = new Date(); target.setHours(th, tm, 0, 0);
  const delay = Math.max(12000, target.getTime() - now.getTime());
  setTimeout(async () => {
    if (morningState.running || runAllState.running || runState.running) return;
    if (alreadyRanToday()) return;
    // Clinic-wide: one computer asks the morning question, not both.
    const claim = await ledgerClaim('cdbs-morning');
    if (!claim.mine) { appJournal('morning run: already handled today by ' + claim.who); return; }
    morningState = { running: true, stopRequested: false };
    morningRun('scheduled');
  }, delay);
}

ipcMain.handle('clear-history', async () => {
  const res = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Clear the written-notes record?',
    message: 'This only clears this program\'s memory of what it has already written.',
    detail: 'Notes already in Principle are not touched. Clearing this means a re-run of the same sheet WILL write those notes again.',
    buttons: ['Cancel', 'Clear it'],
    cancelId: 0,
    defaultId: 0,
  });
  if (res.response === 1) {
    try { fs.unlinkSync(logPath()); } catch (e) { /* ignore */ }
    return { ok: true, cleared: true };
  }
  return { ok: true, cleared: false };
});

// ---------------------------------------------------------------------
// LIFECYCLE
// ---------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Another copy was double-clicked: bring THIS one forward — and if the
    // main window was closed while hidden helpers kept us alive, make a
    // fresh one instead of silently doing nothing.
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
  let pillEpisode = { principle: 'unknown', proda: 'unknown' };
// ---- Telegram task intake: "add <task>" from the owner's chat becomes
// an Urgent item on the shared list. One message, no dialogue.
async function pollTelegramTasks() {
  try {
    const s = loadMorningSettings();
    if (!s.telegramToken || !s.telegramChatId) return;
    await telegram.route(s.telegramToken, s.telegramChatId, async (t) => {
      const m = String(t).match(/^add:?\s*(.*)$/i);
      if (!m) return;
      const wording = (m[1] || '').trim().slice(0, 140);
      if (!wording) {
        await telegram.send(s.telegramToken, s.telegramChatId, 'What should I add? Send it as one message: add <the task>');
        return;
      }
      const a = loadActions();
      const it = {
        id: 'a' + Date.now() + Math.random().toString(36).slice(2, 6),
        patientId: 'urgent:' + Date.now(),
        name: wording, kind: 'urgent', section: 'Urgent',
        text: '', context: 'added from Telegram',
        token: 'urgent:' + Date.now(), createdAt: new Date().toISOString(),
      };
      a.items.push(it);
      saveActions(a);
      await fsPush(it);
      sendUi('actions-changed', {});
      appJournal('urgent task added via Telegram: ' + wording.slice(0, 60));
      await telegram.send(s.telegramToken, s.telegramChatId, 'Added to Urgent ✓ — ' + wording);
    });
  } catch (e) { /* quiet - next poll retries */ }
}
setInterval(pollTelegramTasks, 6 * 1000);

async function probePills() {
  if (runAllState.running || runState.running || collectState.running || balanceState.running || genState.running || morningState.running || autoRunning) return;
  try {
    let ok = (await engine.checkLoggedIn()).ok;
    if (!ok) {
      // Full quiet ladder: navigate-home heal, then credential login if
      // saved. The session resurrects itself within one probe cycle.
      ok = await ensurePrincipleQuiet();
      if (ok) appJournal('pill probe: session self-healed');
    }
    const st = ok ? 'connected' : 'needs-login';
    sendStatus(st);
    // Doctrine: the pill and the error box carry this state - Telegram
    // only speaks when an OUTCOME fails (a job, a run, a pin).
    if (st === 'needs-login' && pillEpisode.principle === 'connected') {
      appJournal('Principle signed out (probe, survived the heal)');
    }
    pillEpisode.principle = st;
  } catch (e) { /* ignore */ }
  try {
    // While a code ask owns the screen, the pill poller stays silent -
    // its 'down'/'idle' pushes were slamming the code box shut seconds
    // after it opened, leaving Telegram as the only door.
    if (deskCode.resolve) { /* the code box holds the stage */ }
    else if (proda.isOpen()) {
      const out = await proda.checkSignedOut();
      const st = out ? 'code' : 'ready';
      sendUi('proda-light', { state: out ? 'down' : 'ready' });
      if (out && pillEpisode.proda === 'ready') appJournal('PRODA signed out (probe)');
      pillEpisode.proda = st;
    } else {
      sendUi('proda-light', { state: 'idle' });
      pillEpisode.proda = 'idle';
    }
  } catch (e) { /* ignore */ }
}

ipcMain.handle('pill-login', async (e, p) => {
  if (p.which === 'principle') { await engine.promptLogin(); return { ok: true }; }
  if (p.which === 'proda') {
    appJournal('PRODA pill clicked - window opened for login');
    proda.openVisible();
    return { ok: true };
  }
  return { ok: false };
});

// Keeps the heartbeat alive while we wait patiently for a human reply —
// waiting is not jamming.
function beatKeeper(label) {
  beat(label);
  return setInterval(() => beat(label), 60 * 1000);
}

// Jam watchdog: a running flag with a stale heartbeat is a jammed run.
let jamNotified = false;
setInterval(() => {
  try {
    const running = runAllState.running || runState.running || collectState.running || balanceState.running || genState.running || morningState.running;
    if (!running) { jamNotified = false; return; }
    if (Date.now() - lastBeat.t < 5 * 60 * 1000) return;
    if (lastBeat.stage === 'idle' || /waiting for the/i.test(lastBeat.stage || '')) return;   // waiting is not jamming
    if (jamNotified) return;
    jamNotified = true;
    appJournal('JAM detected at: ' + lastBeat.stage);
    runlog('JAM WATCHDOG: no heartbeat for 5 minutes at "' + lastBeat.stage + '" - stopping the run safely');
    setRunStatus('cdbs', 'jammed', 'at: ' + lastBeat.stage);
    runAllState.stopRequested = true; runState.stopRequested = true;
    collectState.stopRequested = true; balanceState.stopRequested = true;
    morningState.stopRequested = true;
    alarmPing('A run looks jammed at "' + lastBeat.stage + '" - it has been asked to stop safely. Nothing is written without the review table. If it stays stuck, restart the app at the desk.');
  } catch (e) { /* ignore */ }
}, 60 * 1000);

// Log report: the last 5 days of everything, stitched, into Notepad.
// ---------- DIAGNOSTICS: see inside the machinery ----------
function findDiagWindow(which) {
  const all = BrowserWindow.getAllWindows();
  const urlOf = w => { try { return w.webContents.getURL() || ''; } catch (e) { return ''; } };
  if (which === 'proda') return all.find(w => /proda|servicesaustralia|humanservices|medicare/i.test(urlOf(w)));
  if (which === 'report') return all.find(w => /principle\.dental\/reporting/i.test(urlOf(w)));
  if (which === 'principle') return all.find(w => /principle\.dental/i.test(urlOf(w)) && !/\/reporting/i.test(urlOf(w)));
  return null;
}

const diagCensusScript = `(() => {
  const clean = t => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const btns = [...document.querySelectorAll('button, [role=button], a.mat-button, input[type=submit]')]
    .filter(el => el.offsetParent !== null)
    .map(el => ({
      raw: clean(el.innerText || el.value || el.getAttribute('aria-label') || ''),
      on: !el.disabled && el.getAttribute('aria-disabled') !== 'true' && !/disabled/.test(el.className || ''),
      cls: String(el.className || '').slice(0, 80),
    }));
  return {
    url: location.href,
    title: document.title,
    buttons: btns,
    text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 3000),
  };
})()`;

ipcMain.handle('diag-capture', async (e, p) => {
  try {
    const win = findDiagWindow(p.which);
    if (!win) return { ok: false, error: 'No ' + p.which + ' window exists right now — it appears when that part of the app is used (e.g. run a report first for the report window).' };
    // Show it first so the human can see what is being photographed.
    win.setPosition(80, 80);
    win.showInactive();
    await new Promise(r => setTimeout(r, 700));
    const data = await win.webContents.executeJavaScript(diagCensusScript, true);
    const stamp = localStamp();
    const file = path.join(app.getPath('downloads'), 'SDT-capture__' + p.which + '__' + stamp + '.txt');
    fs.writeFileSync(file, [
      'TO CLAUDE: page capture of the ' + p.which + ' window, taken ' + new Date().toString(),
      'URL: ' + (data.url || ''),
      'TITLE: ' + (data.title || ''),
      '',
      'BUTTONS (' + data.buttons.length + '):',
      ...data.buttons.map(b => '  on=' + (b.on ? 'Y' : 'N') + '  raw="' + b.raw + '"  cls=' + b.cls),
      '',
      'PAGE TEXT (first 3000 chars):',
      data.text || '',
    ].join('\n'), 'utf8');
    appJournal('diagnostics capture saved: ' + p.which);
    return { ok: true, file };
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 120) };
  }
});

ipcMain.handle('diag-window', (e, p) => {
  const win = findDiagWindow(p.which);
  if (!win) return { ok: false, error: 'No ' + p.which + ' window is open right now.' };
  if (p.action === 'show') { win.setPosition(80, 80); win.showInactive(); }
  else win.hide();
  setTimeout(reclaimTyping, 300);
  appJournal('diagnostics: ' + p.which + ' window ' + p.action);
  return { ok: true };
});

// Network recorder: Start -> click around Principle -> Stop -> file to Downloads.
ipcMain.handle('diag-record', async (e, p) => {
  try {
    if (p.action === 'start') {
      const r = principleCapture.start();
      const win = findDiagWindow('principle');
      if (win) { win.setPosition(80, 80); win.showInactive(); }
      appJournal('diagnostics: network recording started');
      return { ok: true, windowFound: r.windowFound };
    }
    const r = await principleCapture.stop();
    let out = null;
    const src2 = r && (r.file || principleCapture.filePath());
    if (src2 && fs.existsSync(src2)) {
      out = path.join(app.getPath('downloads'), 'SDT-recording__' + localStamp() + '.txt');
      fs.copyFileSync(src2, out);
    }
    appJournal('diagnostics: network recording stopped' + (out ? ' -> Downloads' : ''));
    return { ok: true, file: out };
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 120) };
  }
});

ipcMain.handle('diag-vitals', () => ({
  lastBeat: { stage: lastBeat.stage, secondsAgo: Math.round((Date.now() - lastBeat.t) / 1000) },
  runStatus,
  pills: pillEpisode,
}));

ipcMain.handle('open-external', (e, u) => { if (/^(https:\/\/|tel:)/.test(String(u))) shell.openExternal(u); return { ok: true }; });

ipcMain.handle('log-report', () => {
  try {
    const folder = principleCapture.reportsFolder();
    const cutoff = Date.now() - 5 * 24 * 3600 * 1000;
    const files = fs.readdirSync(folder)
      .filter(f => (f.startsWith('runlog__') || f.startsWith('journal__')) && !f.includes('app-log'))
      .map(f => ({ f, m: fs.statSync(path.join(folder, f)).mtimeMs }))
      .filter(x => x.m >= cutoff)
      .sort((x, y) => x.m - y.m);
    const today = localToday();
    let parts = [];
    let total = 0;
    for (const { f } of files) {
      let t = fs.readFileSync(path.join(folder, f), 'utf8');
      total += t.length;
      parts.push({ f, t });
    }
    const trimmed = total > 1500000;
    if (trimmed) {
      for (const p of parts) {
        if (p.f.includes(today)) continue;      // today stays complete
        p.t = p.t.split('\n').filter(l =>
          /fail|error|jam|service door|timed out|skipped|stopped|alarm|===/i.test(l)).join('\n');
      }
    }
    const out = path.join(folder, 'app-log__last-5-days.txt');
    fs.writeFileSync(out, [
      '=============== TO CLAUDE: 5-DAY SYSTEM REVIEW ===============',
      'Everything the SDT Reception app did in the last 5 days: run',
      'journals (CDBS checks, morning runs, auto reports) and the app',
      'journal (logins, pings, jams). Audit per the checklist at the',
      'top of any cdbs-check section, and flag patterns across days.',
      trimmed ? 'NOTE: older days trimmed to errors/warnings only (size).' : 'Complete logs, untrimmed.',
      'Runs included: ' + files.length,
      '==============================================================',
      parts.map(p => '\n\n########## ' + p.f + ' ##########\n' + p.t).join(''),
    ].join('\n'), 'utf8');
    const dl = path.join(app.getPath('downloads'), 'SDT-app-log__' + today + '.txt');
    fs.copyFileSync(out, dl);
    return { ok: true, file: dl };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 120) };
  }
});

app.whenReady().then(async () => {
  // Fleet machines look for a newer published build BEFORE the window opens;
  // if one installs, the app restarts itself and this line never returns.
  try { await fleetSelfUpdate(); } catch (e) { /* start normally */ }
  createWindow(); proda.setLogger(runlog); principleReport.setLogger(runlog); maybeAutoRun();
  appJournal('app started');
  setTimeout(probePills, 20000);
  setInterval(probePills, 5 * 60 * 1000);
  // 6pm daily debrief: one Telegram message summarising every automation's
  // day, with the full diagnostics file attached. Every day, weekends too.
  setInterval(async () => {
    try {
      if (!isWorker()) return;   // the worker computer sends the debrief
      const now = new Date();
      if (now.getHours() < 18) return;
      const today = localToday();
      const hs = loadHealthState();
      if (hs.sentEvening === today) return;
      const s = loadMorningSettings();
      if (!s.telegramToken || !s.telegramChatId) return;

      // One debrief per FLEET per day, not per machine: claim the ledger
      // slot first. (Fail-open like every claim - if the cloud is down we
      // still send rather than go silent.)
      try {
        const dClaim = await ledgerClaim('evening-debrief');
        if (!dClaim.mine) {
          hs.sentEvening = today;
          saveHealthState(hs);
          appJournal('6pm debrief: already sent today by ' + (dClaim.who || 'another machine'));
          return;
        }
      } catch (eC) { /* claim unreachable - send anyway */ }

      // FLEET truth first: the run ledger holds every machine's runs for
      // today, so the debrief no longer goes blind when another computer
      // did the morning's work. Local records are the fallback.
      let fleetToday = [];
      try { fleetToday = (await fleetRuns()).filter(r2 => r2.day === today); } catch (eL) { /* local view only */ }
      const fleetOf = (id) => fleetToday.find(r2 => r2.jobId === id) || null;
      const tagM = (m) => (m && m !== MACHINE ? ' (' + m + ')' : '');
      const badRe = /^(failed|crashed|aborted|stopped)/;

      const lines = ['6pm debrief — ' + now.toLocaleDateString('en-AU', { weekday: 'long', day: '2-digit', month: '2-digit' }) + ':'];
      // The CDBS run. NOTE: success is recorded in lastMorningRun (morning
      // settings); hs.cdbsLastRun only ever holds FAILURES - the old code
      // read only the failure slot, so every good day said "DID NOT RUN".
      const cdbsFleet = fleetOf('cdbs-14day');
      const cdbsLocal =
        (s.lastMorningRun && localDateOf(s.lastMorningRun.when || '') === today) ? s.lastMorningRun :
        (hs.cdbsLastRun && localDateOf(hs.cdbsLastRun.when || '') === today) ? hs.cdbsLastRun : null;
      const cdbsDue = ![0, 6].includes(now.getDay());
      if (cdbsLocal || cdbsFleet) {
        const rec = cdbsLocal || cdbsFleet;
        const who = cdbsLocal ? MACHINE : cdbsFleet.machine;
        lines.push((badRe.test(rec.outcome || '') ? '✗ ' : '✓ ') + 'CDBS check: ' + rec.outcome + tagM(who));
      } else {
        lines.push(cdbsDue ? '✗ CDBS check: DID NOT RUN today' : '— CDBS check: not scheduled today');
      }
      // Every auto report: this machine's record if it ran here, otherwise
      // the ledger's record from whichever machine ran it.
      for (const j of loadAutoJobs().jobs) {
        if (j.id === 'cdbs-14day') continue;
        if (!j.enabled) { lines.push('— ' + j.name + ': switched off'); continue; }
        if (!j.days.includes(now.getDay())) { lines.push('— ' + j.name + ': not scheduled today'); continue; }
        const fr2 = fleetOf(j.id);
        const rec = (j.lastRun && localDateOf(j.lastRun.when || '') === today)
          ? { outcome: j.lastRun.outcome, machine: MACHINE }
          : (fr2 ? { outcome: fr2.outcome, machine: fr2.machine } : null);
        if (rec) {
          lines.push((badRe.test(rec.outcome || '') ? '✗ ' : '✓ ') + j.name + ': ' + rec.outcome + tagM(rec.machine));
        } else {
          lines.push('✗ ' + j.name + ': DID NOT RUN today');
        }
      }
      await telegram.send(s.telegramToken, s.telegramChatId, lines.join('\n'));

      // Full diagnostics file: the same stitch the Log report button makes.
      try {
        const folder = principleCapture.reportsFolder();
        const cutoff = Date.now() - 5 * 24 * 3600 * 1000;
        const files = fs.readdirSync(folder)
          .filter(f => (f.startsWith('runlog__') || f.startsWith('journal__')) && !f.includes('app-log'))
          .map(f => ({ f, m: fs.statSync(path.join(folder, f)).mtimeMs }))
          .filter(x => x.m >= cutoff)
          .sort((x, y) => x.m - y.m);
        const parts = files.map(({ f }) => '########## ' + f + ' ##########\n' + fs.readFileSync(path.join(folder, f), 'utf8'));
        const out = path.join(folder, 'SDT-evening-log__' + today + '.txt');
        fs.writeFileSync(out, 'TO CLAUDE: 6pm debrief diagnostics, last 5 days of logs.\n\n' + parts.join('\n\n'), 'utf8');
        await telegram.sendDocument(s.telegramToken, s.telegramChatId, out, 'Full diagnostics — forward this file to Claude if anything above looks wrong.');
      } catch (e2) { appJournal('evening debrief file failed: ' + String(e2).slice(0, 80)); }

      hs.sentEvening = today;
      saveHealthState(hs);
      appJournal('6pm debrief sent');
    } catch (e) { /* ignore */ }
  }, 15 * 60 * 1000);
});
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
