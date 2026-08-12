// =====================================================================
//  principle-report.js
//
//  Runs the CDBS checking report in Principle and catches the CSV it
//  downloads — so the report no longer has to be exported by hand.
//
//  DESIGN NOTE: the report is SAVED in Principle with Predefined Dates set
//  to "This Year", so no dates are ever typed here (Angular's date-range
//  boxes ignore programmatic typing — learned the hard way). The app trims
//  the CSV down to today + 14 days itself, in main.js.
//
//  How the run works (from the recording of 28 Jul 2026):
//    - the whole job happens on one page, the custom report screen
//    - the Run Report button goes DISABLED while the report runs and
//      comes back when it's done — that's the "finished" signal
//    - the download arrives as a blob, which the will-download hook
//      catches and saves into this program's own reports folder
//
//  Kept separate from principle-engine.js, which is shared byte-for-byte
//  with the Command Center app and must not drift.
// =====================================================================

const { BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const capture = require('./principle-capture.js');

const REPORT_URL = 'https://app.principle.dental/reporting/custom-reports/bXueQjkX89wyBVb3yH92';

let notify = () => {};
let repLog = () => {};
function setLogger(fn) { repLog = typeof fn === 'function' ? fn : () => {}; }
function setNotifier(fn) { notify = typeof fn === 'function' ? fn : () => {}; }

function principleWindow() {
  return BrowserWindow.getAllWindows().find(w => {
    try {
      return !w.isDestroyed() && /principle\.dental/i.test(w.webContents.getURL() || '');
    } catch (e) {
      return false;
    }
  }) || null;
}

function waitMs(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------
// Catching the download
// ---------------------------------------------------------------------
// Armed only while a generation run is waiting for its file, so this can
// never interfere with the recorder's own download hook (which only acts
// while a recording is on) or with anything else.
let armed = null;            // { resolve } while waiting, else null
let hookAttachedTo = null;   // the session we've hooked, so it's done once

function hookDownloads(ses) {
  if (hookAttachedTo === ses) return;
  hookAttachedTo = ses;
  ses.on('will-download', (event, item) => {
    if (!armed) return;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeName = String(item.getFilename() || 'report.csv').replace(/[^A-Za-z0-9._-]/g, '_');
    const saveTo = path.join(capture.reportsFolder(), `${stamp}__${safeName}`);

    try { item.setSavePath(saveTo); } catch (e) { /* keep going; done event still fires */ }

    item.once('done', (e, state) => {
      if (!armed) return;
      const a = armed;
      armed = null;
      if (state === 'completed') {
        a.resolve({ ok: true, file: saveTo, filename: item.getFilename(), mimeType: item.getMimeType() });
      } else {
        a.resolve({ ok: false, reason: 'download-' + state });
      }
    });
  });
}

// Resolves with the next download, or {ok:false, reason:'no-download'} after
// timeoutMs. Extending the wait is done by simply calling this again — the
// armed hook stays live until a file arrives or disarm() is called.
function waitForDownload(timeoutMs) {
  return new Promise(resolve => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; resolve({ ok: false, reason: 'no-download' }); }
    }, timeoutMs);
    armed = {
      resolve: (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(result);
      },
    };
  });
}

function disarm() { armed = null; }

// ---------------------------------------------------------------------
// Injected page scripts
// ---------------------------------------------------------------------
// Buttons are matched on a cleaned label with icon elements stripped out,
// exactly as the note-writer does — Angular Material folds icon names into
// a button's text, so "Run Report" can read "run report" or similar.
function buttonHelpers() {
  return `
    const visible = el => el && el.offsetParent !== null && el.getClientRects().length > 0;
    const rawLabel = b => ((b.innerText || b.textContent || b.getAttribute('aria-label') || '').trim().toLowerCase().replace(/\\s+/g, ' '));
    const cleanLabel = (b) => {
      let text = '';
      try {
        const clone = b.cloneNode(true);
        clone.querySelectorAll('mat-icon, .material-icons, .material-icons-outlined, .material-symbols-outlined, [class*="material-icons"], [class*="material-symbols"], svg').forEach(n => n.remove());
        text = clone.textContent || '';
      } catch (e) { text = b.innerText || ''; }
      if (!text.trim()) text = b.getAttribute('aria-label') || b.getAttribute('title') || '';
      return text.trim().toLowerCase().replace(/\\s+/g, ' ');
    };
    const enabled = b => !b.disabled
      && b.getAttribute('aria-disabled') !== 'true'
      && !/mat-mdc-button-disabled|mat-button-disabled/.test((b.className || '').toString());
    const allButtons = () => [...document.querySelectorAll('button, [role="button"]')].filter(visible);
  `;
}

function buttonCensusScript() {
  return `(() => {
    ${buttonHelpers()}
    return allButtons().map(b => ({ clean: cleanLabel(b), raw: rawLabel(b), on: enabled(b) })).slice(0, 40);
  })()`;
}

function clickRunScript() {
  return `(() => {
    ${buttonHelpers()}
    const run = allButtons().find(b => cleanLabel(b).includes('run report') && enabled(b));
    if (!run) return { ok: false, step: 'find-run-button' };
    run.scrollIntoView({ block: 'center' });
    run.click();
    return { ok: true };
  })()`;
}

function pageStateScript() {
  return `(() => {
    ${buttonHelpers()}
    const runBtn = allButtons().find(b => cleanLabel(b).includes('run report'));
    const dlReport = allButtons().find(b => /download report/.test(rawLabel(b)) && enabled(b));
    const dlPresent = allButtons().find(b => /download report/.test(rawLabel(b)));
    const dlIcons = allButtons().filter(b => rawLabel(b) === 'download' && enabled(b));
    return {
      hasRunButton: !!runBtn,
      runEnabled: !!(runBtn && enabled(runBtn)),
      hasDownloadReport: !!dlReport,
      hasDownloadPresent: !!dlPresent,
      dataRowCount: Math.max(document.querySelectorAll('mat-row').length, document.querySelectorAll('tbody tr').length),
      downloadIconCount: dlIcons.length,
    };
  })()`;
}

// index -1 means: click the "Download Report" button. index >= 0 means:
// click the Nth enabled icon-only "download" button.
function clickDownloadScript(index) {
  return `(() => {
    ${buttonHelpers()}
    ${index === -2
      ? `const target = allButtons().find(b => /download csv/.test(rawLabel(b)) && enabled(b));`
      : index < 0
      ? `const target = allButtons().find(b => /download report/.test(rawLabel(b)) && enabled(b));`
      : `const target = allButtons().filter(b => rawLabel(b) === 'download' && enabled(b))[${Number(index)}] || null;`}
    if (!target) return { ok: false };
    target.scrollIntoView({ block: 'center' });
    target.click();
    return { ok: true };
  })()`;
}

// ---------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------
async function runInPage(win, script) {
  try {
    return await win.webContents.executeJavaScript(script, true);
  } catch (e) {
    return { error: String(e) };
  }
}

// Generates the report for [today, today + rangeDays] and resolves with the
// saved CSV path. progress(text) keeps the app window informed.
async function generateReport(rangeDays, progress, reportUrl) {
  const say = typeof progress === 'function' ? progress : () => {};

  const win = principleWindow();
  if (!win) return { ok: false, reason: 'no-window' };
  hookDownloads(win.webContents.session);

  // A hidden window doesn't render, and Angular only builds the results
  // area (table + Download Report button) inside a live viewport — so the
  // button never appears if the window stays hidden. Park it off-screen
  // but showing: fully rendered, no focus stolen, nothing on screen.
  try {
    win.setSkipTaskbar(true);
    win.setPosition(-20000, -20000);
    win.showInactive();
  } catch (e) { /* cosmetic only */ }

  // --- open the report page ---
  say('Opening the report screen...');
  try {
    await win.loadURL(reportUrl || REPORT_URL);
  } catch (e) { /* SPA navigations can reject; the URL check below decides */ }
  await waitMs(1500);

  const nowUrl = win.webContents.getURL() || '';
  if (!/custom-reports/.test(nowUrl)) {
    return { ok: false, reason: 'not-logged-in', detail: nowUrl.slice(0, 120) };
  }

  // Wait for the date fields to exist — the page builds itself after loading.
  let state = null;
  for (let i = 0; i < 40; i++) {
    state = await runInPage(win, pageStateScript());
    if (state && state.hasRunButton) break;
    await waitMs(500);
  }
  if (!state || !state.hasRunButton) {
    return { ok: false, reason: 'report-page-not-ready', detail: state };
  }

  // --- run the report (its saved "This Year" range; trimmed in main.js) ---
  say('Running the report...');
  const clicked = await runInPage(win, clickRunScript());
  if (!clicked || !clicked.ok) {
    return { ok: false, reason: 'could-not-run', detail: clicked };
  }

  // The Run Report button disables while the report runs. Watch for that,
  // then wait for it to come back — with a plain time fallback in case the
  // run is so quick the disabled moment is missed. The saved "This Year"
  // range makes this a big report (hundreds of rows), so the run gets six
  // minutes, not two.
  let sawRunning = false;
  const started = Date.now();
  let screenCheckAt = Date.now() + 45000;
  while (Date.now() - started < 360000) {
    await waitMs(700);
    state = await runInPage(win, pageStateScript());
    if (!state || state.error) continue;
    // A missing Run button reads as "report running" - but the calendar has
    // no Run button either (2026-08-12: a run that never left the calendar
    // "ran" for 6 minutes). Every 45s, prove the report screen is really
    // there; if the census has no Run Report button, we lost the screen.
    if (Date.now() > screenCheckAt && !state.runEnabled && !state.hasDownloadReport && !(state.downloadIconCount > 0)) {
      screenCheckAt = Date.now() + 45000;
      try {
        const cs = await runInPage(win, buttonCensusScript());
        const onReportScreen = Array.isArray(cs) && cs.some(b => /run report/i.test((b && b.raw) || ''));
        if (!onReportScreen) {
          repLog('report screen LOST - census has no Run Report button: ' + JSON.stringify(cs).slice(0, 600));
          return { ok: false, reason: 'report-screen-lost' };
        }
      } catch (e) { /* census is evidence only */ }
    }
    if (!state.runEnabled) {
      sawRunning = true;
      say('Report is running... (' + Math.round((Date.now() - started) / 1000) + 's — the full-year report takes a while)');
      continue;
    }
    if (sawRunning) break;                                  // ran, now finished
    if (Date.now() - started > 6000 &&
        (state.hasDownloadReport || state.downloadIconCount > 0)) break;   // finished before we looked
  }

  // The Download Report button appears once the results table has built
  // itself, which for the big report lags the run finishing — so wait for
  // it rather than demanding it instantly.
  say('Report finished — waiting for the download button...');
  try {
    const c0 = await runInPage(win, buttonCensusScript());
    repLog('download-wait census at start: ' + JSON.stringify(c0));
  } catch (e) { /* ignore */ }
  const btnFrom = Date.now();
  let proceedDisabled = false;
  while (Date.now() - btnFrom < 90000) {
    if (state && (state.hasDownloadReport || state.downloadIconCount > 0)) break;
    // Some reports paint the Download button "disabled" yet it works when
    // pressed (the press stage verifies a real download starts). If it has
    // been present-but-disabled for 20s, stop waiting and try it.
    if (state && state.hasDownloadPresent && Date.now() - btnFrom > 20000) {
      if (!state.dataRowCount) {
        repLog('report finished with 0 data rows - nothing to download (that is a success)');
        return { ok: true, empty: true };
      }
      proceedDisabled = true;
      repLog('download button present but reads disabled for 20s - proceeding to press it anyway');
      break;
    }
    await waitMs(1000);
    state = await runInPage(win, pageStateScript());
  }
  if (!proceedDisabled && (!state || (!state.hasDownloadReport && !(state.downloadIconCount > 0)))) {
    try {
      const cT = await runInPage(win, buttonCensusScript());
      repLog('download-wait census at TIMEOUT: ' + JSON.stringify(cT));
    } catch (e) { /* ignore */ }
    return { ok: false, reason: 'report-did-not-finish', detail: state };
  }

  // --- download it ---
  say('Downloading the report...');
  try {
    const census = await runInPage(win, buttonCensusScript());
    repLog('download-stage button census: ' + JSON.stringify(census));
  } catch (e) { repLog('census failed: ' + String(e)); }
  const downloadPromise = waitForDownload(45000);

  // Try the explicit "Download Report" button first; otherwise click each
  // enabled download icon in turn, giving the export panel a moment to
  // appear and pressing its "Download Report" if it does.
  // Click Download Report; if that opens an export panel (as the recording
  // showed), the panel's own confirm is also labelled "download report" —
  // so keep clicking whatever matching button remains, until the file
  // actually starts, logging the buttons after each press.
  // Truth from the 29 Jul run log: pressing "Download Report" opens a panel
  // whose confirm is labelled "download csv" — that second press births the
  // file. So: one press to open, then hunt the csv button.
  const tryClicks = async () => {
    let s = await runInPage(win, pageStateScript());
    if (s && s.hasDownloadReport) {
      repLog('pressing Download Report (opens the export panel)');
      await runInPage(win, clickDownloadScript(-1));
    } else if (s && s.downloadIconCount > 0) {
      repLog('pressing download icon');
      await runInPage(win, clickDownloadScript(0));
    }
    for (let attempt = 1; attempt <= 6; attempt++) {
      if (!armed) return;                        // the file arrived
      await waitMs(1200);
      const hit = await runInPage(win, clickDownloadScript(-2));
      repLog('download csv press attempt ' + attempt + ': ' + JSON.stringify(hit || {}));
      if (hit && hit.ok) {
        for (let w = 0; w < 10; w++) { await waitMs(500); if (!armed) return; }
      } else if (attempt === 2 || attempt === 4) {
        // The export panel may never have opened — press the main
        // Download Report button again before the next hunt.
        s = await runInPage(win, pageStateScript());
        if (s && s.hasDownloadReport) {
          repLog('re-pressing Download Report (panel may not have opened)');
          await runInPage(win, clickDownloadScript(-1));
        }
      }
    }
    // Still nothing: photograph the page so the log shows exactly what
    // buttons existed at the moment the hunt failed.
    const cen = await runInPage(win, buttonCensusScript());
    repLog('csv-hunt failed - final census: ' + JSON.stringify(cen || []).slice(0, 1800));
  };
  await tryClicks();

  let dl = await downloadPromise;

  // Couldn't find the right button? Bring Principle up and let the person
  // press it — the hook stays armed, so their click still lands here.
  if (!dl.ok && dl.reason === 'no-download') {
    say('Could not find the download button — Principle is on screen. Press its download yourself and I will take it from there.');
    try {
      win.setSkipTaskbar(false);
      if (win.isMinimized()) win.restore();
      win.center(); win.show(); win.focus();
    } catch (e) { /* ignore */ }
    notify({ type: 'manual-download-needed' });
    dl = await waitForDownload(180000);
  }
  disarm();

  if (!dl.ok) return { ok: false, reason: dl.reason || 'no-download' };

  // A sanity check on what actually arrived — a chart image is not a report.
  try {
    const head = fs.readFileSync(dl.file).slice(0, 4);
    if (head.length > 1 && head[0] === 0x89 && head[1] === 0x50) {
      return { ok: false, reason: 'downloaded-an-image', detail: dl.filename };
    }
  } catch (e) { /* unreadable is handled by the CSV parser upstream */ }

  return { ok: true, file: dl.file, filename: dl.filename };
}

module.exports = { generateReport, setNotifier, setLogger, principleWindow };
