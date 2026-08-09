// ============================================================
//  patch-2026-08-08.12-code-wait-audit.js
//  Adds the CODE-WAIT AUDIT (observation-only logging) to
//  main.js, preload.js and renderer.js, and bumps the build
//  to 2026-08-08.12. Run via the Apply bat, or:  node patch-2026-08-08.12-code-wait-audit.js
//  Safe to run twice - it detects an already-patched app and stops.
// ============================================================
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
const write = (f, t) => fs.writeFileSync(path.join(DIR, f), t, 'utf8');

function fail(msg) {
  console.error('\n*** PATCH STOPPED: ' + msg);
  console.error('*** Nothing has been changed. Send Claude a photo of this window.');
  process.exit(1);
}
function replaceOnce(name, src, oldStr, newStr, label) {
  const n = src.split(oldStr).length - 1;
  if (n !== 1) fail(name + ': expected exactly 1 match for [' + label + '], found ' + n + '. The file on this machine differs from the one the patch was written against.');
  return src.replace(oldStr, newStr);
}

// ---------- main.js ----------
let m = read('main.js');
if (m.includes("APP_BUILD = '2026-08-08.12'")) fail('this app is already on build 2026-08-08.12 - the patch has been applied before.');
if (!m.includes("APP_BUILD = '2026-08-08.11'")) fail('main.js is not build 2026-08-08.11 - pull the latest in GitHub Desktop first.');

const HELPERS = `
// ---------------------------------------------------------------------
// CODE-WAIT AUDIT (build 2026-08-08.12 - observation only)
//
// The "box shows but the code can't be typed" bug has come back several
// times, and every previous fix was aimed at a guess. So while the
// 6-digit box is open, the run log now records exactly who holds the
// keyboard: every window's state when the box opens, any window CREATED
// during the wait (those escape the freeze), and a heartbeat naming the
// focused window. Nothing in this block changes behaviour - it only
// writes CODE-WAIT lines to the run log so the next failure names its
// thief instead of us guessing again.
// ---------------------------------------------------------------------
function describeWin(w) {
  if (!w || w.isDestroyed()) return 'gone';
  let t = '?', pos = '?';
  const extra = [];
  try { t = w.getTitle() || (w.webContents.getURL() || '').slice(0, 60) || 'untitled'; } catch (eD) { /* keep ? */ }
  try { pos = w.getPosition().join(','); } catch (eD) { /* keep ? */ }
  try { if (w === mainWindow) extra.push('MAIN'); } catch (eD) { /* skip */ }
  try { if (w.isFocused()) extra.push('FOCUSED'); } catch (eD) { /* skip */ }
  try { if (!w.isVisible()) extra.push('hidden'); } catch (eD) { /* skip */ }
  try { if (!w.isFocusable()) extra.push('unfocusable'); } catch (eD) { /* skip */ }
  return '"' + String(t).slice(0, 60) + '" @' + pos + (extra.length ? ' [' + extra.join(' ') + ']' : '');
}
function focusSnapshot() {
  try {
    const f = BrowserWindow.getFocusedWindow();
    const mainF = mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused();
    return 'focusedWindow=' + (f ? describeWin(f) : 'NULL (Windows reports no focused window of ours)')
      + ' | app window focused=' + !!mainF;
  } catch (eS) { return 'focus snapshot failed: ' + String(eS).slice(0, 60); }
}
let codeWaitWindowHook = false;
function armCodeWaitWindowWatch() {
  if (codeWaitWindowHook) return;
  codeWaitWindowHook = true;
  app.on('browser-window-created', (evC, w) => {
    if (!deskCode.resolve) return;   // only interesting while a code is pending
    try {
      runlog('CODE-WAIT: WINDOW CREATED during the wait (NOT covered by the freeze): ' + describeWin(w));
      setTimeout(() => {
        try { if (deskCode.resolve) runlog('CODE-WAIT: 1.5s after that window settled: ' + focusSnapshot()); } catch (eW) { /* audit never breaks a run */ }
      }, 1500);
    } catch (eC) { /* audit never breaks a run */ }
  });
}

`;
m = replaceOnce('main.js', m, 'function askDeskForCode() {', HELPERS + 'function askDeskForCode() {', 'helpers insert');

m = replaceOnce('main.js', m,
`function askDeskForCode() {
  sirenOn();
  sendUi('proda-light', { state: 'code' });`,
`function askDeskForCode() {
  armCodeWaitWindowWatch();
  try {
    runlog('CODE-WAIT: box requested. ' + focusSnapshot());
    for (const wA of BrowserWindow.getAllWindows()) runlog('CODE-WAIT:   window: ' + describeWin(wA));
  } catch (eA) { /* audit never breaks a run */ }
  sirenOn();
  sendUi('proda-light', { state: 'code' });`, 'ask top');

m = replaceOnce('main.js', m,
`  } catch (e0) { /* best effort */ }
  return new Promise((resolve) => {
    deskCode.resolve = resolve;`,
`  } catch (e0) { /* best effort */ }
  try { runlog('CODE-WAIT: froze ' + frozenWins.length + ' helper window(s). ' + focusSnapshot()); } catch (eA2) { /* audit only */ }
  return new Promise((resolve) => {
    deskCode.resolve = resolve;`, 'freeze log');

m = replaceOnce('main.js', m,
`        for (const w of frozenWins) { try { if (!w.isDestroyed()) w.setFocusable(true); } catch (e2) { /* gone */ } }
        sirenOff();
        resolve(r);`,
`        for (const w of frozenWins) { try { if (!w.isDestroyed()) w.setFocusable(true); } catch (e2) { /* gone */ } }
        try { runlog('CODE-WAIT: settled (' + (r && r.ok ? 'code supplied' : ((r && (r.reason || (r.cancelled && 'cancelled'))) || 'no code')) + '). ' + focusSnapshot()); } catch (eA3) { /* audit only */ }
        sirenOff();
        resolve(r);`, 'settle log');

m = replaceOnce('main.js', m,
`    focusGuard = setInterval(() => {
      try {
        const f = BrowserWindow.getFocusedWindow();
        if (f && f !== mainWindow && deskCode.resolve) mainWindow.focus();
      } catch (e3) { /* next beat */ }
    }, 2000);`,
`    let lastFocusLine = '';
    let guardBeats = 0;
    focusGuard = setInterval(() => {
      try {
        const f = BrowserWindow.getFocusedWindow();
        const reclaimed = !!(f && f !== mainWindow && deskCode.resolve);
        if (reclaimed) mainWindow.focus();
        // Audit: name the keyboard holder whenever it changes, plus a
        // heartbeat every ~10s so a frozen state is visible in the log.
        guardBeats++;
        const line = focusSnapshot();
        if (line !== lastFocusLine || guardBeats % 5 === 0) {
          lastFocusLine = line;
          runlog('CODE-WAIT: ' + line + (reclaimed ? ' -> pulled focus back to the app' : ''));
        }
      } catch (e3) { /* next beat */ }
    }, 2000);`, 'focus guard');

m = replaceOnce('main.js', m,
`ipcMain.handle('supply-code', (e, code) => {
  if (String(code) === '__cancel__') {`,
`ipcMain.handle('supply-code', (e, code) => {
  try { runlog('CODE-WAIT: desk box sent ' + (String(code) === '__cancel__' ? 'CANCEL' : 'a code (' + String(code || '').replace(/\\D/g, '').length + ' digits)')); } catch (eA4) { /* audit only */ }
  if (String(code) === '__cancel__') {`, 'supply-code log');

m = replaceOnce('main.js', m,
`ipcMain.handle('open-run-log', () => {`,
`// The app page reports what IT can see while the code box is open
// (clicks arriving, caret position, page focus) - one CODE-WAIT/UI line
// each. Reporting only; nothing else happens here.
ipcMain.handle('code-ui-log', (e, line) => {
  try { runlog('CODE-WAIT/UI: ' + String(line == null ? '' : line).slice(0, 300)); } catch (eU) { /* audit only */ }
  return { ok: true };
});
ipcMain.handle('open-run-log', () => {`, 'code-ui-log ipc');

m = replaceOnce('main.js', m, "const APP_BUILD = '2026-08-08.11';", "const APP_BUILD = '2026-08-08.12';", 'build bump');

// ---------- preload.js ----------
let p = read('preload.js');
if (!p.includes('codeUiLog')) {
  p = replaceOnce('preload.js', p,
    "  supplyCode: (code) => ipcRenderer.invoke('supply-code', code),",
    "  supplyCode: (code) => ipcRenderer.invoke('supply-code', code),\n  codeUiLog: (line) => ipcRenderer.invoke('code-ui-log', line),", 'codeUiLog bridge');
}

// ---------- renderer.js ----------
let r = read('renderer.js');
if (!r.includes('CODE-WAIT AUDIT')) {
  r = r + `

// ---------- CODE-WAIT AUDIT (build 2026-08-08.12 - observation only) ----------
// While the 6-digit box is open, this reports to the run log what THIS
// page can actually see: whether clicks reach the input, whether the page
// holds keyboard focus, where the caret is, and whether keystrokes arrive.
// It changes nothing - one CODE-WAIT/UI line per event, never the code
// digits themselves. Reading the log after a failed attempt tells us
// which of the three suspects it is:
//   - no "input CLICKED" line   -> the click never reached the page (overlay / native dialog)
//   - CLICKED but pageHasFocus=false stays false -> Windows never activated the app window
//   - focus fine but no "keystroke reached" lines -> the keyboard is going to a hidden window
(() => {
  const say = (t) => { try { window.cdbs.codeUiLog(t); } catch (eS) { /* audit never breaks the app */ } };
  const bar = document.getElementById('codeBar');
  const input = document.getElementById('codeInput');
  if (!bar || !input) return;
  const state = () => 'pageHasFocus=' + document.hasFocus()
    + ' activeElement=' + (document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : 'none')
    + ' typed=' + String(input.value || '').length + ' chars'
    + ' barVisible=' + !bar.classList.contains('hidden');
  let wasOpen = false, lastLine = '', beats = 0;
  setInterval(() => {
    const open = !bar.classList.contains('hidden');
    if (open && !wasOpen) { say('box OPENED on the page. ' + state()); lastLine = ''; beats = 0; }
    if (!open && wasOpen) say('box CLOSED. ' + state());
    wasOpen = open;
    if (!open) return;
    beats++;
    const line = state();
    if (line !== lastLine || beats % 5 === 0) { lastLine = line; say(line); }
  }, 2000);
  input.addEventListener('mousedown', () => say('input CLICKED. ' + state()));
  input.addEventListener('focus', () => say('input gained DOM focus. pageHasFocus=' + document.hasFocus()));
  input.addEventListener('blur', () => { if (!bar.classList.contains('hidden')) say('input LOST DOM focus. ' + state()); });
  window.addEventListener('focus', () => { if (!bar.classList.contains('hidden')) say('page gained OS focus'); });
  window.addEventListener('blur', () => { if (!bar.classList.contains('hidden')) say('page LOST OS focus'); });
  document.addEventListener('keydown', () => {
    if (bar.classList.contains('hidden')) return;
    const where = document.activeElement === input ? 'the code input'
      : (document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : 'nowhere');
    say('keystroke reached the page -> landed in ' + where);
  }, true);
})();
`;
}

// ---------- backup, then write ----------
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16).replace(/-(\d\d)$/, '$1');
const bdir = path.join(DIR, 'backup-before-2026-08-08.12-' + stamp);
fs.mkdirSync(bdir, { recursive: true });
for (const f of ['main.js', 'preload.js', 'renderer.js']) fs.copyFileSync(path.join(DIR, f), path.join(bdir, f));

write('main.js', m);
write('preload.js', p);
write('renderer.js', r);

console.log('Patch applied. Backup of the originals: ' + bdir);
console.log('Build is now 2026-08-08.12 (CODE-WAIT AUDIT).');
