// =====================================================================
//  principle-engine.js
//
//  The shared "how to drive Principle" logic. This file is copied VERBATIM
//  from the Command Center app so both programs behave identically — if
//  Principle changes their interface, fix it in one place and copy it to
//  the other. Do not edit one copy only.
//
//  What it does:
//    - keeps a logged-in Principle window (login is manual, and remembered)
//    - parks that window off-screen while working, so nothing is seen
//    - opens a patient's profile and writes a note into their timeline
//    - confirms the save actually happened before reporting success
// =====================================================================

const { BrowserWindow, screen, session } = require('electron');

const PRINCIPLE_URL = 'https://app.principle.dental/';
let PARTITION = 'persist:principle-admin';
let SLUG = 'southside-dental-toowoomba';

let principleWindow = null;
let listenersAttached = false;
let firestoreWriteWatcher = null;

function configure(opts = {}) {
  if (opts.partition) PARTITION = opts.partition;
  if (opts.slug) SLUG = opts.slug;
}

function patientProfileUrl(patientId) {
  return `${PRINCIPLE_URL}${SLUG}/patients/${patientId}/profile`;
}

// Watches for the database write Principle makes when a note is saved, so a
// success is confirmed rather than assumed.
function attachListeners() {
  if (listenersAttached) return;
  listenersAttached = true;
  const ses = session.fromPartition(PARTITION);

  // Principle searches patients through Typesense. By watching its own
  // searches we learn the address and key, so nothing has to be hardcoded
  // and it keeps working when Principle rotates the key.
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    sniffTypesense(details.url);
    callback({});
  });

  ses.webRequest.onCompleted({ urls: ['*://*/*'] }, (details) => {
    if (firestoreWriteWatcher && /Firestore\/Write\/channel/.test(details.url)) {
      firestoreWriteWatcher();
    }
  });
}

function watchForFirestoreWrite(timeoutMs = 9000) {
  return new Promise(resolve => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; firestoreWriteWatcher = null; resolve(false); }
    }, timeoutMs);
    firestoreWriteWatcher = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      firestoreWriteWatcher = null;
      resolve(true);
    };
  });
}

let typesense = null;

function sniffTypesense(url) {
  try {
    if (!/typesense\.net\/collections\/.+_patients\/documents\/search/.test(url)) return;
    const u = new URL(url);
    if (!u.searchParams.get('x-typesense-api-key')) return;
    typesense = {
      fullUrl: url,
      origin: u.origin,
      pathname: u.pathname,
      apiKey: u.searchParams.get('x-typesense-api-key'),
      queryBy: u.searchParams.get('query_by') || '',
      filterBy: u.searchParams.get('filter_by') || '',
      learnedAt: new Date().toISOString(),
    };
  } catch (e) { /* ignore */ }
}

function hasLearnedSearch() { return !!typesense; }

// Lists WHICH FIELDS Principle keeps about a patient — field names only,
// plus whether each one holds anything. No patient values are returned or
// stored; this is purely to find out whether Medicare details are available
// without opening every patient's file.
async function inspectPatientFields() {
  if (!typesense) return { ok: false, reason: 'not-learned' };
  try {
    const res = await fetch(typesense.fullUrl, { headers: { Accept: 'application/json' } });
    if (!res.ok) return { ok: false, reason: `search-http-${res.status}` };
    const data = await res.json();
    const hits = data.hits || [];
    if (!hits.length) return { ok: false, reason: 'no-results' };

    // Merge the field names across the returned records, so a field that
    // happens to be empty on the first patient still shows up.
    const seen = {};
    hits.slice(0, 10).forEach(h => {
      const doc = h.document || {};
      Object.keys(doc).forEach(k => {
        const v = doc[k];
        const filled = !(v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0));
        if (!seen[k]) seen[k] = { name: k, type: Array.isArray(v) ? 'list' : typeof v, filledCount: 0 };
        if (filled) seen[k].filledCount++;
      });
    });

    const fields = Object.values(seen).sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, fields, sampleSize: Math.min(hits.length, 10) };
  } catch (e) {
    return { ok: false, reason: 'fetch-failed', detail: String(e) };
  }
}

// A spot no monitor can display, worked out from the real display layout so
// it stays hidden on single or dual screen setups.
function offscreenSpot() {
  try {
    const displays = screen.getAllDisplays();
    let minX = 0, topY = 0;
    displays.forEach(d => {
      if (d.bounds.x < minX) { minX = d.bounds.x; topY = d.bounds.y; }
    });
    return { x: minX - 1600, y: topY };
  } catch (e) {
    return { x: -3200, y: 0 };
  }
}

function isOnScreen() {
  if (!principleWindow || principleWindow.isDestroyed()) return false;
  try {
    return principleWindow.isVisible() && principleWindow.getPosition()[0] > (offscreenSpot().x + 800);
  } catch (e) {
    return false;
  }
}

function createWindow() {
  attachListeners();
  principleWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    skipTaskbar: true,
    title: 'Principle',
    backgroundColor: '#ffffff',
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Google refuses sign-in from anything that identifies itself as an app
  // rather than a browser, so drop the Electron marker from the signature.
  try {
    const ua = principleWindow.webContents.getUserAgent()
      .replace(/ Electron\/[\d.]+/, '')
      .replace(/ sdt-cdbs-admin\/[\d.]+/i, '');
    principleWindow.webContents.setUserAgent(ua);
  } catch (e) { /* ignore */ }

  principleWindow.loadURL(PRINCIPLE_URL);
  principleWindow.on('closed', () => { principleWindow = null; });
}

// Bring Principle on screen — used for logging in.
function openVisible() {
  if (!principleWindow || principleWindow.isDestroyed()) createWindow();
  try {
    principleWindow.setSkipTaskbar(false);
    if (principleWindow.isMinimized()) principleWindow.restore();
    if (!isOnScreen()) principleWindow.center();
    principleWindow.show();
    principleWindow.focus();
  } catch (e) { /* ignore */ }
}

function hide() {
  if (!principleWindow || principleWindow.isDestroyed()) return;
  try {
    principleWindow.hide();
    principleWindow.setSkipTaskbar(true);
  } catch (e) { /* ignore */ }
}

// Chromium suspends rendering for hidden windows, so the window has to be
// genuinely shown — just parked where no screen can display it.
async function prepareForBackgroundWork() {
  const isNew = !principleWindow || principleWindow.isDestroyed();
  if (isNew) createWindow();

  const alreadyVisible = isOnScreen();
  if (!alreadyVisible) {
    try {
      principleWindow.setSkipTaskbar(true);
      const spot = offscreenSpot();
      principleWindow.setPosition(spot.x, spot.y);
      principleWindow.showInactive();
    } catch (e) { /* ignore */ }
  }

  if (isNew) {
    await new Promise(resolve => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      principleWindow.webContents.once('did-finish-load', finish);
      setTimeout(finish, 20000);
    });
  }
  return { hideAfter: !alreadyVisible };
}

// Works out whether we're signed in, by looking at where Principle sends us
// and whether a password box is on screen.
async function readLoginState() {
  if (!principleWindow || principleWindow.isDestroyed()) return { loggedIn: false, reason: 'no-window' };
  try {
    const url = principleWindow.webContents.getURL();
    const probe = await principleWindow.webContents.executeJavaScript(`(() => ({
      url: location.href,
      hasPassword: !!document.querySelector('input[type=password]'),
      text: (document.body ? (document.body.innerText || '') : '').slice(0, 400)
    }))()`, true);

    const looksLikeLogin = /\/login|\/sign-?in|\/auth/i.test(probe.url)
      || probe.hasPassword
      || /sign in|log in/i.test(probe.text);
    const insideClinic = probe.url.includes('/' + SLUG);

    return { loggedIn: insideClinic && !looksLikeLogin, url: probe.url || url };
  } catch (e) {
    return { loggedIn: false, reason: 'check-failed', detail: String(e) };
  }
}

// Loads Principle quietly and reports whether we're already signed in.
async function checkLoggedIn() {
  await prepareForBackgroundWork();
  if (!principleWindow) return { ok: false, reason: 'no-window' };

  // Give a freshly-loaded page a moment to settle or redirect.
  for (let i = 0; i < 20; i++) {
    const state = await readLoginState();
    if (state.loggedIn) return { ok: true, url: state.url };
    if (state.url && /\/login|\/sign-?in|\/auth/i.test(state.url)) break;  // definitely logged out
    await new Promise(r => setTimeout(r, 500));
  }
  const finalState = await readLoginState();
  return finalState.loggedIn ? { ok: true, url: finalState.url } : { ok: false, reason: 'not-logged-in' };
}

// Shows the login page and watches until the login succeeds, then tucks the
// window away again. onDone(true/false) is called when finished or timed out.
let loginWatchTimer = null;
function watchForLogin(onDone, timeoutMs = 10 * 60 * 1000) {
  if (loginWatchTimer) clearInterval(loginWatchTimer);
  const started = Date.now();
  loginWatchTimer = setInterval(async () => {
    if (!principleWindow || principleWindow.isDestroyed()) {
      clearInterval(loginWatchTimer); loginWatchTimer = null; onDone(false); return;
    }
    const state = await readLoginState();
    if (state.loggedIn) {
      clearInterval(loginWatchTimer); loginWatchTimer = null;
      hide();
      onDone(true);
    } else if (Date.now() - started > timeoutMs) {
      clearInterval(loginWatchTimer); loginWatchTimer = null;
      onDone(false);
    }
  }, 2000);
}

// Bring up the login page ready for signing in.
async function promptLogin() {
  if (!principleWindow || principleWindow.isDestroyed()) createWindow();
  try { await principleWindow.loadURL(PRINCIPLE_URL); } catch (e) { /* ignore */ }
  openVisible();
}

function noteAutomationScript(noteText) {
  return `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const NOTE = ${JSON.stringify(noteText)};
    const visible = el => el && el.offsetParent !== null && el.getClientRects().length > 0;
    const BOX_SEL = 'textarea, [contenteditable="true"], [contenteditable=""], .ProseMirror';
    const label = b => ((b.innerText || b.getAttribute('aria-label') || '').trim().toLowerCase().replace(/\\s+/g, ' '));
    const describe = el => ({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 120),
                              aria: el.getAttribute('aria-label') || '', text: (el.innerText || '').trim().slice(0, 40) });

    // --- 1. Find the "Note" action button (icon text is part of innerText) ---
    const buttons = () => [...document.querySelectorAll('button, [role="button"]')].filter(visible);
    const noteBtn =
      buttons().find(b => /(^|\\s)note$/.test(label(b)) && /text_snippet/.test(label(b))) ||
      buttons().find(b => label(b) === 'note') ||
      buttons().find(b => /(^|\\s)note$/.test(label(b)) && !/add note|social/.test(label(b)));

    if (!noteBtn) {
      return { ok: false, step: 'find-note-button',
               detail: 'Could not find the Note action button on the profile.',
               buttons: buttons().map(label).filter(Boolean).slice(0, 40) };
    }

    // Remember the editors that already exist (e.g. the social note box),
    // so we can tell which editor is genuinely new after the click.
    const before = new Set([...document.querySelectorAll(BOX_SEL)]);
    const beforeButtons = new Set([...document.querySelectorAll('button, [role="button"]')]);

    noteBtn.click();

    // --- 2. Wait for the note composer to appear ---
    let box = null;
    for (let i = 0; i < 30 && !box; i++) {
      await sleep(200);
      box = [...document.querySelectorAll(BOX_SEL)].find(el => visible(el) && !before.has(el)) || null;
    }
    if (!box) {
      return { ok: false, step: 'wait-for-composer',
               detail: 'Clicked Note but no new note box appeared.',
               clicked: label(noteBtn) };
    }

    // The dialog/panel that the new editor lives in — we only look for the
    // save button inside it, so we never hit the social note buttons.
    const scope = box.closest('[role="dialog"], mat-dialog-container, .mat-mdc-dialog-container, .cdk-overlay-pane, form') || document.body;

    // --- 3. Type the note the way the editor expects ---
    box.scrollIntoView({ block: 'center' });
    box.click();
    await sleep(250);
    box.focus();
    await sleep(150);

    if (box.tagName === 'TEXTAREA' || box.tagName === 'INPUT') {
      const proto = box.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(box, NOTE);
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, NOTE);
      box.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    await sleep(600);

    const typed = (box.value !== undefined ? box.value : box.innerText) || '';
    if (!typed.includes(NOTE.slice(0, 20))) {
      return { ok: false, step: 'type', detail: 'Text did not stick in the note box.', box: describe(box) };
    }

    // --- 4. Save ---
    // Angular Material puts the ICON NAME into a button's text, so a save
    // button can read "save Save" rather than "Save". Matching is therefore
    // done on a cleaned label with icon elements stripped out, using plain
    // string comparison (no regex, so nothing can be lost to escaping).
    const SAVE_WORDS = ['save', 'add note', 'post', 'create', 'submit', 'done', 'add'];

    const cleanLabel = (b) => {
      let text = '';
      try {
        const clone = b.cloneNode(true);
        clone.querySelectorAll('mat-icon, .material-icons, .material-icons-outlined, .material-symbols-outlined, [class*="material-icons"], [class*="material-symbols"], i.fa, svg').forEach(n => n.remove());
        text = clone.textContent || '';
      } catch (e) {
        text = b.innerText || '';
      }
      if (!text.trim()) text = b.getAttribute('aria-label') || b.getAttribute('title') || '';
      return text.trim().toLowerCase().replace(/\\s+/g, ' ');
    };

    const enabled = b => !b.disabled
      && b.getAttribute('aria-disabled') !== 'true'
      && !/mat-mdc-button-disabled|mat-button-disabled/.test((b.className || '').toString());

    // Only consider buttons that are inside the composer, or that appeared
    // after we clicked Note. That keeps us away from the social note's own
    // Add Note button, which was on the page all along.
    const candidates = () => {
      const inScope = [...scope.querySelectorAll('button, [role="button"]')];
      const fresh = [...document.querySelectorAll('button, [role="button"]')].filter(b => !beforeButtons.has(b));
      return [...new Set([...inScope, ...fresh])].filter(visible);
    };

    const findSave = () => {
      const list = candidates();
      return list.find(b => SAVE_WORDS.includes(cleanLabel(b)) && enabled(b))
          || list.find(b => SAVE_WORDS.some(w => cleanLabel(b).includes(w)) && enabled(b))
          || null;
    };

    let save = null;
    for (let i = 0; i < 30 && !save; i++) {
      save = findSave();
      if (!save) await sleep(200);
    }

    if (!save) {
      // Record every button on the page BEFORE saving, so we can work out
      // which one is the real Save button and click it properly next time.
      const surveyButtons = () => [...document.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .map(b => ({
          text: cleanLabel(b),
          raw: label(b),
          enabled: enabled(b),
          inComposer: scope.contains(b),
          appearedAfterNoteClick: !beforeButtons.has(b)
        }))
        .slice(0, 80);

      const diagnostic = {
        why: 'No button matched, so the keyboard shortcut was used instead.',
        scopeTag: scope.tagName,
        scopeClass: (scope.className || '').toString().slice(0, 160),
        candidatesConsidered: candidates().map(b => ({ text: cleanLabel(b), raw: label(b), enabled: enabled(b) })).slice(0, 40),
        allVisibleButtons: surveyButtons()
      };

      // Last resort: many note editors save on Ctrl+Enter.
      box.focus();
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true, bubbles: true }));
      await sleep(800);
      if (!document.contains(box) || !visible(box)) {
        return { ok: true, step: 'saved-with-keyboard', openedWith: label(noteBtn), box: describe(box), diagnostic };
      }
      return { ok: false, step: 'find-save',
               detail: 'Typed the note but no Save button became clickable.',
               diagnostic };
    }

    save.click();
    await sleep(400);
    return { ok: true, step: 'clicked-save', savedWith: label(save), openedWith: label(noteBtn), box: describe(box) };
  })()`;
}

async function waitForProfileReady(win, timeoutMs = 25000) {
  const probe = `(() => {
    const btns = [...document.querySelectorAll('button, [role="button"]')];
    const hasNote = btns.some(b => ((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase().includes('note'));
    return {
      ready: hasNote,
      buttonCount: btns.length,
      readyState: document.readyState,
      bodyLength: document.body ? (document.body.innerText || '').length : 0,
      hidden: document.hidden,
      url: location.href
    };
  })()`;
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await win.webContents.executeJavaScript(probe, true);
    } catch (e) {
      last = { error: String(e) };
    }
    if (last && last.ready) return { ok: true, waitedMs: Date.now() - started, ...last };
    await new Promise(r => setTimeout(r, 500));
  }
  return { ok: false, waitedMs: Date.now() - started, ...(last || {}) };
}

// SNAPSHOT OF THE MEDICARE TAB
//
// Opens a patient's file, clicks through to the Medicare section, and writes
// down the STRUCTURE of what's there — labels, field names, and the SHAPE of
// each value (e.g. "10 digits", "1 digit", "date") — never the values
// themselves. That's enough to build a precise reader without any patient
// information leaving this computer.
function maskingSnapshotScript(expectedName) {
  return `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const visible = el => el && el.offsetParent !== null && el.getClientRects().length > 0;
    const clean = t => String(t || '').trim().replace(/\\s+/g, ' ');

    // Anything with digits in it is masked (# per digit) so no real numbers
    // are recorded. The patient's name is blanked out too. Plain words stay,
    // because those are the labels we need to see.
    const NAME_PARTS = ${JSON.stringify(String(expectedName || '').toLowerCase().split(/\s+/).filter(w => w.length >= 2))};
    const mask = (t) => {
      let out = clean(t);
      NAME_PARTS.forEach(part => {
        if (!part) return;
        const re = new RegExp(part.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'), 'gi');
        out = out.replace(re, '<name>');
      });
      return out.replace(/\\d/g, '#');
    };

    const report = { url: location.href, panelFound: false, tabLabel: '', clickedTab: false, lines: [], nodes: [], note: '' };

    // Find the Medicare tab itself
    const tabs = [...document.querySelectorAll('[role="tab"], button, a, .mat-mdc-tab, .mdc-tab')].filter(visible);
    const tab = tabs.find(t => /^medicare$/i.test(clean(t.innerText))) ||
                tabs.find(t => /medicare/i.test(clean(t.innerText)));
    if (tab) report.tabLabel = clean(tab.innerText).slice(0, 40);

    // Find the panel the tab controls. Try the proper link first, then fall
    // back to looking for a container that mentions Medicare.
    let panel = null;
    if (tab) {
      const controls = tab.getAttribute('aria-controls');
      if (controls) panel = document.getElementById(controls);
      if (!panel) {
        const group = tab.closest('mat-tab-group, .mat-mdc-tab-group, [role="tablist"]');
        const parent = group ? group.parentElement : null;
        if (parent) {
          panel = [...parent.querySelectorAll('[role="tabpanel"], .mat-mdc-tab-body-active, .mat-tab-body-active')]
            .filter(visible)[0] || null;
        }
      }
    }
    if (!panel) {
      panel = [...document.querySelectorAll('[role="tabpanel"], .mat-mdc-tab-body-active, .mat-tab-body-active')]
        .filter(visible)[0] || null;
    }

    // Still nothing? The tab may need clicking after all.
    if ((!panel || !clean(panel.innerText)) && tab) {
      report.clickedTab = true;
      tab.click();
      await sleep(2500);
      const controls = tab.getAttribute('aria-controls');
      panel = (controls && document.getElementById(controls)) ||
        [...document.querySelectorAll('[role="tabpanel"], .mat-mdc-tab-body-active, .mat-tab-body-active')].filter(visible)[0] ||
        panel;
    }

    // Last resort: the smallest visible box whose text mentions Medicare.
    if (!panel) {
      const candidates = [...document.querySelectorAll('div, section, mat-card')].filter(v =>
        visible(v) && /medicare/i.test(clean(v.innerText)) && clean(v.innerText).length < 900);
      panel = candidates.sort((a, b) => clean(a.innerText).length - clean(b.innerText).length)[0] || null;
      if (panel) report.note = 'Panel located by searching for the word Medicare.';
    }

    if (!panel) {
      report.note = 'No Medicare panel could be located on this page.';
      report.allTabLabels = tabs.map(t => clean(t.innerText)).filter(Boolean).slice(0, 40);
      return report;
    }

    report.panelFound = true;
    report.panelTag = panel.tagName;
    report.panelClass = (panel.className || '').toString().slice(0, 160);

    // 1. The panel's text, line by line, masked. This is what shows us the
    //    labels and how the values are laid out.
    report.lines = clean(panel.innerText).split('\\n')
      .map(l => mask(l)).filter(Boolean).slice(0, 60);
    const rawLines = (panel.innerText || '').split('\\n').map(clean).filter(Boolean);
    report.lines = rawLines.map(mask).slice(0, 60);

    // 2. Every element inside, with its tag, classes and masked text — so a
    //    precise reader can be written against real selectors.
    const walk = (el, depth) => {
      if (depth > 6 || report.nodes.length > 160) return;
      [...el.children].forEach(child => {
        if (!visible(child)) return;
        const own = clean([...child.childNodes]
          .filter(n => n.nodeType === 3)
          .map(n => n.textContent).join(' '));
        if (own) {
          report.nodes.push({
            depth,
            tag: child.tagName,
            cls: (child.className || '').toString().slice(0, 90),
            text: mask(own).slice(0, 80)
          });
        }
        walk(child, depth + 1);
      });
    };
    walk(panel, 0);

    return report;
  })()`;
}

// READING MEDICARE DETAILS OFF A PATIENT'S FILE
//
// Principle lays these out as a Material list: the VALUE sits in a
// "primary-text" span, with its LABEL in the "secondary-text" span directly
// after it. So we find each label by name and take the value paired with it —
// which survives styling changes far better than relying on position.
function medicareReadScript() {
  return `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const visible = el => el && el.offsetParent !== null && el.getClientRects().length > 0;
    const clean = t => String(t || '').trim().replace(/\\s+/g, ' ');

    // Find the Medicare tab.
    const tabs = [...document.querySelectorAll('[role="tab"], .mat-mdc-tab, .mdc-tab, button, a')].filter(visible);
    const isMedicareTab = t => /^medicare$/i.test(clean(t.innerText));
    let tab = tabs.find(isMedicareTab);
    if (!tab) return { ok: false, reason: 'no-medicare-tab' };

    const isSelected = (t) => t.getAttribute('aria-selected') === 'true'
      || /mdc-tab--active|mat-mdc-tab-active|active|selected/.test((t.className || '').toString());

    // Make sure Medicare is the tab actually showing — the neighbouring DVA
    // and Health Fund tabs also have a "Number", and reading the wrong one
    // would put a DVA number in as a Medicare number.
    if (!isSelected(tab)) {
      tab.scrollIntoView({ block: 'center' });
      tab.click();
      await sleep(2200);
      tab = [...document.querySelectorAll('[role="tab"], .mat-mdc-tab, .mdc-tab, button, a')]
        .filter(visible).find(isMedicareTab) || tab;
    }

    // Locate its panel, preferring the tab's own link to it.
    let panel = null;
    let panelSource = '';
    const controls = tab.getAttribute('aria-controls');
    if (controls) {
      const byId = document.getElementById(controls);
      if (byId && visible(byId)) { panel = byId; panelSource = 'aria-controls'; }
    }
    if (!panel && isSelected(tab)) {
      panel = [...document.querySelectorAll('[role="tabpanel"], .mat-mdc-tab-body-active, .mat-tab-body-active')]
        .filter(visible)[0] || null;
      if (panel) panelSource = 'active-panel';
    }

    // If we can't be sure which panel belongs to Medicare, stop. Reporting
    // nothing is far better than reporting the wrong card's number.
    if (!panel) {
      return { ok: false, reason: 'cannot-confirm-medicare-tab',
               detail: { tabSelected: isSelected(tab) } };
    }

    const panelText = clean(panel.innerText);

    // Belt and braces: a Medicare panel should not be talking about DVA or
    // health funds. If it is, we're on the wrong one.
    if (/\\bdva\\b|veteran|gold card|white card|health fund|fund name|membership/i.test(panelText)) {
      return { ok: false, reason: 'wrong-panel', detail: { panelSource } };
    }

    // Pair each value with the label that follows it.
    const spans = [...panel.querySelectorAll('span')].filter(visible);
    const pairs = [];
    for (let i = 0; i < spans.length; i++) {
      const cls = (spans[i].className || '').toString();
      if (!/primary-text/.test(cls)) continue;
      const value = clean(spans[i].innerText);
      let label = '';
      for (let j = i + 1; j < Math.min(i + 4, spans.length); j++) {
        const c2 = (spans[j].className || '').toString();
        if (/secondary-text/.test(c2)) { label = clean(spans[j].innerText); break; }
        if (/primary-text/.test(c2)) break;
      }
      if (label) pairs.push({ label, value });
    }

    const pick = (test) => {
      const hit = pairs.find(p => test.test(p.label));
      return hit ? hit.value : '';
    };

    const number = pick(/^number$/i) || pick(/card.*number|medicare.*number/i);
    const irn = pick(/sub\\s*numerate|^irn$|reference/i);
    const expiry = pick(/expiry|expires|valid/i);

    // A Medicare panel proper should show "Sub Numerate" — DVA and health
    // fund panels don't. Treat its absence as a reason to distrust the read.
    const hasMedicareMarker = pairs.some(p => /sub\\s*numerate/i.test(p.label));

    const addButton = [...panel.querySelectorAll('button, [role="button"]')]
      .filter(visible)
      .some(b => /add card|add medicare|add details/i.test(clean(b.innerText)));

    if (!number && addButton) return { ok: false, reason: 'no-card-on-file' };
    if (!number) return { ok: false, reason: 'not-found', labelsSeen: pairs.map(p => p.label).slice(0, 12) };
    if (!hasMedicareMarker) {
      return { ok: false, reason: 'not-confirmed-medicare',
               detail: { labelsSeen: pairs.map(p => p.label).slice(0, 12), panelSource } };
    }

    return { ok: true, number, irn, expiry, panelSource };
  })()`;
}

// Opens one patient's file and reads their Medicare details.
async function readMedicareDetails(patientId, expectedName) {
  const { hideAfter } = await prepareForBackgroundWork();
  if (!principleWindow) return { ok: false, reason: 'no-window' };

  const done = (result) => {
    if (hideAfter) hide();
    return result;
  };

  try {
    await principleWindow.loadURL(patientProfileUrl(patientId));
  } catch (e) {
    return done({ ok: false, reason: 'load-failed', detail: String(e) });
  }

  const currentUrl = principleWindow.webContents.getURL();
  if (!/\/patients\//.test(currentUrl)) {
    openVisible();
    return { ok: false, reason: 'not-logged-in' };
  }

  const ready = await waitForProfileReady(principleWindow, 25000);
  if (!ready.ok) return done({ ok: false, reason: 'page-not-ready', detail: ready });

  // Same safety check as note-writing: is this really the right patient?
  if (expectedName && expectedName.trim()) {
    const pageText = (await readPageText(principleWindow)).toLowerCase();
    const parts = expectedName.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
    const missing = parts.filter(w => !pageText.includes(w));
    if (missing.length) {
      return done({ ok: false, reason: 'name-mismatch', detail: { expected: expectedName } });
    }
  }

  try {
    const res = await principleWindow.webContents.executeJavaScript(medicareReadScript(), true);
    return done(res || { ok: false, reason: 'no-result' });
  } catch (e) {
    return done({ ok: false, reason: 'read-error', detail: String(e) });
  }
}

// Looks up a patient's date of birth from Principle's search index — much
// quicker than reading it off the page, and it's already there.
async function lookupDateOfBirth(name) {
  if (!typesense || !name) return '';
  try {
    const url = `${typesense.origin}${typesense.pathname}?` + new URLSearchParams({
      q: name,
      query_by: typesense.queryBy || 'name,searchNames',
      per_page: '5',
      page: '1',
      filter_by: typesense.filterBy || 'isDuplicate:!=true && deleted:=false',
      'x-typesense-api-key': typesense.apiKey,
    }).toString();
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return '';
    const data = await res.json();
    const hits = (data.hits || []).map(h => h.document || {});
    const wanted = name.trim().toLowerCase();
    const exact = hits.find(d => (d.name || '').trim().toLowerCase() === wanted);
    const doc = exact || hits[0];
    return doc ? (doc.dateOfBirth || '') : '';
  } catch (e) {
    return '';
  }
}

// Runs the snapshot against one patient, with the window visible so you can
// watch what it does.
async function snapshotMedicareTab(patientId, expectedName) {
  if (!principleWindow || principleWindow.isDestroyed()) createWindow();
  openVisible();

  try {
    await principleWindow.loadURL(patientProfileUrl(patientId));
  } catch (e) {
    return { ok: false, reason: 'load-failed', detail: String(e) };
  }

  const ready = await waitForProfileReady(principleWindow, 25000);
  if (!ready.ok) return { ok: false, reason: 'page-not-ready', detail: ready };

  try {
    const report = await principleWindow.webContents.executeJavaScript(maskingSnapshotScript(expectedName), true);
    return { ok: true, report };
  } catch (e) {
    return { ok: false, reason: 'snapshot-failed', detail: String(e) };
  }
}

// Reads the visible text of the profile so the patient's name can be checked
// against the spreadsheet before anything is written.
async function readPageText(win) {
  try {
    return await win.webContents.executeJavaScript(
      `(() => (document.body ? (document.body.innerText || '') : ''))()`, true);
  } catch (e) {
    return '';
  }
}

// Writes one note into one patient's file.
// expectedName (optional) is checked against the page before writing — a
// mismatch stops the write rather than risking the wrong patient's record.
async function addNoteToPatient(patientId, noteText, expectedName) {
  const { hideAfter } = await prepareForBackgroundWork();
  if (!principleWindow) return { ok: false, reason: 'no-window' };

  const done = (result) => {
    if (hideAfter) hide();
    return result;
  };

  try {
    await principleWindow.loadURL(patientProfileUrl(patientId));
  } catch (e) {
    return done({ ok: false, reason: 'load-failed', detail: String(e) });
  }

  const currentUrl = principleWindow.webContents.getURL();
  if (!/\/patients\//.test(currentUrl)) {
    openVisible();
    return { ok: false, reason: 'not-logged-in', detail: currentUrl };
  }

  const ready = await waitForProfileReady(principleWindow, 25000);
  if (!ready.ok) {
    return done({ ok: false, reason: 'page-not-ready', detail: ready });
  }

  // Safety check: does this page really belong to the patient in the sheet?
  if (expectedName && expectedName.trim()) {
    const pageText = (await readPageText(principleWindow)).toLowerCase();
    const parts = expectedName.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
    const missing = parts.filter(w => !pageText.includes(w));
    if (missing.length) {
      return done({ ok: false, reason: 'name-mismatch',
                    detail: { expected: expectedName, missingParts: missing } });
    }
  }

  const confirmation = watchForFirestoreWrite(9000);
  let result;
  try {
    result = await principleWindow.webContents.executeJavaScript(noteAutomationScript(noteText), true);
  } catch (e) {
    return done({ ok: false, reason: 'automation-error', detail: String(e) });
  }
  if (!result || !result.ok) {
    return done({ ok: false, reason: 'automation-failed', detail: result });
  }

  const saved = await confirmation;
  return done(saved
    ? { ok: true, patientId, via: result.step }
    : { ok: false, reason: 'no-save-confirmation', detail: result });
}

module.exports = {
  configure,
  openVisible,
  hide,
  checkLoggedIn,
  readLoginState,
  watchForLogin,
  promptLogin,
  hasLearnedSearch,
  inspectPatientFields,
  snapshotMedicareTab,
  readMedicareDetails,
  lookupDateOfBirth,
  addNoteToPatient,
  patientProfileUrl,
};
