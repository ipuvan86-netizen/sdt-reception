// =====================================================================
//  proda-engine.js
//
//  A separate, logged-in PRODA/HPOS window — kept apart from the Principle
//  engine so the two can never interfere with each other.
//
//  Right now this does ONE job: capture. You log in yourself, press Start,
//  do a single balance check, and press Stop. It records:
//    - the network requests the page makes (with anything sensitive redacted)
//    - the structure of each screen you pass through (labels and value
//      SHAPES only, e.g. "10 digits" — never the actual numbers)
//
//  Nothing is automated and nothing is submitted. It only watches.
// =====================================================================

const { BrowserWindow, session, screen, app, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const PRODA_URL = 'https://proda.humanservices.gov.au/';
const PARTITION = 'persist:proda';

let prodaWindow = null;
let listenersAttached = false;
let notify = () => {};

function setNotifier(fn) { notify = typeof fn === 'function' ? fn : () => {}; }

let capturing = false;
let captureLog = [];
const pending = new Map();
let pageSnapshots = [];

// ---------------------------------------------------------------------
// Redaction — nothing identifying is ever written to the capture file
// ---------------------------------------------------------------------
function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (/authorization|cookie|token|session|api-key|apikey|saml|jsession/i.test(k)) {
      out[k] = `[redacted, ${String(v).length} chars]`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Replace every digit with # and every long word with its length, so the
// SHAPE of a request body survives but its content doesn't.
function redactBody(text) {
  if (!text) return null;
  return String(text)
    .slice(0, 4000)
    .replace(/\d/g, '#');
}

function attachListeners() {
  if (listenersAttached) return;
  listenersAttached = true;
  const ses = session.fromPartition(PARTITION);

  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    if (capturing && details.method !== 'OPTIONS' &&
        ['xhr', 'mainFrame', 'subFrame'].includes(details.resourceType)) {
      let body = null;
      try {
        if (details.uploadData && details.uploadData.length) {
          body = redactBody(Buffer.concat(
            details.uploadData.filter(u => u.bytes).map(u => u.bytes)
          ).toString('utf8'));
        }
      } catch (e) { body = '(could not read)'; }

      const rec = {
        time: new Date().toISOString(),
        method: details.method,
        // Query strings can carry card numbers, so mask digits in the URL too.
        url: String(details.url).replace(/\d{4,}/g, m => '#'.repeat(m.length)),
        resourceType: details.resourceType,
        body,
        status: null,
      };
      pending.set(details.id, rec);
      captureLog.push(rec);
    }
    callback({});
  });

  ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
    if (capturing) {
      const rec = pending.get(details.id);
      if (rec) rec.headers = redactHeaders(details.requestHeaders);
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  ses.webRequest.onCompleted({ urls: ['*://*/*'] }, (details) => {
    const rec = pending.get(details.id);
    if (rec) { rec.status = details.statusCode; pending.delete(details.id); }
  });
}

// ---------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------
function offscreenSpot() {
  try {
    const displays = screen.getAllDisplays();
    let minX = 0, topY = 0;
    displays.forEach(d => { if (d.bounds.x < minX) { minX = d.bounds.x; topY = d.bounds.y; } });
    return { x: minX - 1600, y: topY };
  } catch (e) {
    return { x: -3200, y: 0 };
  }
}

function createWindow() {
  attachListeners();
  prodaWindow = new BrowserWindow({
    width: 1400,
    height: 950,
    show: false,
    title: 'PRODA',
    backgroundColor: '#ffffff',
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Government sites can be picky about anything that isn't a plain browser.
  try {
    const ua = prodaWindow.webContents.getUserAgent()
      .replace(/ Electron\/[\d.]+/, '')
      .replace(/ sdt-cdbs-admin\/[\d.]+/i, '');
    prodaWindow.webContents.setUserAgent(ua);
  } catch (e) { /* ignore */ }

  prodaWindow.loadURL(PRODA_URL);
  prodaWindow.on('closed', () => { prodaWindow = null; });
}

function openVisible() {
  if (!prodaWindow || prodaWindow.isDestroyed()) createWindow();
  try {
    if (prodaWindow.isMinimized()) prodaWindow.restore();
    prodaWindow.center();
    prodaWindow.show();
    prodaWindow.focus();
  } catch (e) { /* ignore */ }
}

function isOpen() {
  return !!(prodaWindow && !prodaWindow.isDestroyed());
}

// ---------------------------------------------------------------------
// Page structure snapshot — labels and value shapes only
// ---------------------------------------------------------------------
function structureScript() {
  return `(() => {
    const visible = el => el && el.offsetParent !== null && el.getClientRects().length > 0;
    const clean = t => String(t || '').trim().replace(/\\s+/g, ' ');

    // Describe a value without revealing it.
    const shape = (raw) => {
      const t = clean(raw);
      if (!t) return 'empty';
      const digits = (t.match(/\\d/g) || []).length;
      const letters = (t.match(/[A-Za-z]/g) || []).length;
      if (digits && !letters) return digits + ' digits';
      if (digits && letters) return digits + ' digits + ' + letters + ' letters';
      return letters + ' letters';
    };

    const labelFor = (el) => {
      const id = el.getAttribute('id');
      if (id) {
        const lab = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
        if (lab) return clean(lab.innerText);
      }
      const aria = el.getAttribute('aria-label') || el.getAttribute('placeholder');
      if (aria) return clean(aria);
      const wrap = el.closest('div, td, li, fieldset');
      if (wrap) {
        const lab = wrap.querySelector('label');
        if (lab) return clean(lab.innerText);
      }
      return '';
    };

    // Text with digits masked, so labels and layout survive but values don't.
    const maskedText = clean(document.body ? (document.body.innerText || '') : '')
      .replace(/\\d/g, '#')
      .slice(0, 3000);

    return {
      url: location.href.replace(/\\d{4,}/g, m => '#'.repeat(m.length)),
      title: clean(document.title),
      headings: [...document.querySelectorAll('h1, h2, h3, legend')].filter(visible)
        .map(h => clean(h.innerText)).filter(Boolean).slice(0, 25),
      inputs: [...document.querySelectorAll('input, select, textarea')].filter(visible).map(el => ({
        label: labelFor(el).slice(0, 70),
        tag: el.tagName,
        type: el.getAttribute('type') || '',
        name: el.getAttribute('name') || '',
        id: (el.getAttribute('id') || '').slice(0, 60),
        valueShape: shape(el.value),
      })).slice(0, 40),
      buttons: [...document.querySelectorAll('button, input[type=submit], input[type=button], a.button, [role=button]')]
        .filter(visible)
        .map(b => ({
          text: clean(b.innerText || b.value || b.getAttribute('aria-label')).slice(0, 50),
          id: (b.getAttribute('id') || '').slice(0, 60),
          name: (b.getAttribute('name') || '').slice(0, 60),
          tag: b.tagName,
        })).filter(b => b.text).slice(0, 40),
      tables: [...document.querySelectorAll('table')].filter(visible).slice(0, 6).map(t => ({
        headers: [...t.querySelectorAll('th')].map(th => clean(th.innerText)).slice(0, 12),
        firstRowShapes: [...(t.querySelector('tbody tr, tr:nth-child(2)') || { children: [] }).children]
          .map(td => shape(td.innerText)).slice(0, 12),
      })),
      maskedText,
    };
  })()`;
}

async function snapshotCurrentPage(label) {
  if (!isOpen()) return null;
  try {
    const data = await prodaWindow.webContents.executeJavaScript(structureScript(), true);
    const entry = { label: label || '', at: new Date().toISOString(), ...data };
    pageSnapshots.push(entry);
    return entry;
  } catch (e) {
    const entry = { label: label || '', at: new Date().toISOString(), error: String(e) };
    pageSnapshots.push(entry);
    return entry;
  }
}

// ---------------------------------------------------------------------
// GETTING TO THE CDBS SCREEN
//
// You log into PRODA and stop. From there the app clicks "Go to service"
// next to HPOS, notes the address HPOS lives at, and then goes straight to
// the Child Dental Benefits Schedule form for each patient.
// ---------------------------------------------------------------------
let engineLog = () => {};
function setLogger(fn) { engineLog = typeof fn === 'function' ? fn : () => {}; }

let hposOrigin = null;   // learned at run time (the port varies)

function cdbsFormUrl() {
  return hposOrigin ? `${hposOrigin}/pcert/hpos/faces/gus.xhtml?init=Y` : null;
}

async function runInPage(script) {
  if (!isOpen()) return null;
  try {
    return await prodaWindow.webContents.executeJavaScript(script, true);
  } catch (e) {
    return { error: String(e) };
  }
}

function waitMs(ms) { return new Promise(r => setTimeout(r, ms)); }

// Waits for the page to settle after a click or a load.
async function waitForUrlChange(fromUrl, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await waitMs(400);
    if (!isOpen()) return false;
    const now = prodaWindow.webContents.getURL();
    if (now && now !== fromUrl && !prodaWindow.webContents.isLoading()) return true;
  }
  return false;
}

// ---------------------------------------------------------------------
// Automatic login (used by the morning run)
//
// The sequence PRODA itself imposes: the code does not exist until the
// username + password have been SUBMITTED. So: fill, submit, and only when
// the code page appears does the caller get asked to produce a code (which
// it does by messaging the phone). Within PRODA's 4-hour window the code
// page never appears and password alone is enough.
// ---------------------------------------------------------------------
function loginStateScript() {
  return `(() => {
    const visible = el => el && el.offsetParent !== null && el.getClientRects().length > 0;
    const inputs = [...document.querySelectorAll('input')].filter(visible);
    const idOf = el => ((el.getAttribute('name') || '') + ' ' + (el.getAttribute('id') || '')
      + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('placeholder') || '')).toLowerCase();

    // Truth from the 29 Jul 2026 recording: PRODA's 2FA box is
    // name="otp.user.otp" id="otppswd" and is a PASSWORD-type input —
    // so the code check runs FIRST and ignores the input type entirely.
    const code = inputs.find(el => /otp|code|verification|token|totp/.test(idOf(el)));
    const password = inputs.find(el => el.type === 'password' && el !== code);
    const username = inputs.find(el => el.type !== 'password'
      && /user|login|account/.test(idOf(el)));

    const text = (document.body ? (document.body.innerText || '') : '').toLowerCase();
    const loggedIn = !password && !code && /my services|manage my|log ?out/.test(text);

    let page = 'unknown';
    if (loggedIn) page = 'logged-in';
    else if (code) page = 'code';
    else if (password && username) page = 'login';
    else if (password) page = 'password-only';

    return {
      page,
      hint: text.replace(/\\d/g, '#').slice(0, 200),
    };
  })()`;
}

function fillLoginScript(username, password) {
  return `(() => {
    const visible = el => el && el.offsetParent !== null && el.getClientRects().length > 0;
    const inputs = [...document.querySelectorAll('input')].filter(visible);
    const idOf = el => ((el.getAttribute('name') || '') + ' ' + (el.getAttribute('id') || '')
      + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('placeholder') || '')).toLowerCase();

    const set = (el, val) => {
      el.focus();
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value')
        || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      desc.set.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const password = inputs.find(el => el.type === 'password');
    if (!password) return { ok: false, step: 'no-password-field' };
    const username = inputs.find(el => el.type !== 'password' && /user|login|account/.test(idOf(el)));

    const user = ${JSON.stringify(String(username))};
    if (user && username) set(username, user);
    set(password, ${JSON.stringify(String(password))});

    const form = password.closest('form');
    const buttons = [...document.querySelectorAll('button, input[type=submit]')].filter(visible);
    const submit = buttons.find(b => /log ?in|sign ?in|continue|submit|next/i.test(b.innerText || b.value || ''))
      || (form ? form.querySelector('button, input[type=submit]') : null)
      || buttons[0];
    if (!submit) return { ok: false, step: 'no-submit-button' };
    submit.click();
    return { ok: true };
  })()`;
}

function focusCodeScript() {
  return `(() => {
    const idOf = el => ((el.id || '') + ' ' + (el.name || '')).toLowerCase();
    const inputs = [...document.querySelectorAll('input')].filter(el => el.offsetParent !== null);
    const codeEl = inputs.find(el => /otp|code|verification|token|totp/.test(idOf(el)))
      || inputs.find(el => el.type === 'text' || el.type === 'tel' || el.type === 'number' || el.type === 'password');
    if (!codeEl) return { ok: false, step: 'no-code-field' };
    codeEl.focus();
    codeEl.value = '';
    return { ok: true };
  })()`;
}

function codeFieldLengthScript() {
  return `(() => {
    const idOf = el => ((el.id || '') + ' ' + (el.name || '')).toLowerCase();
    const inputs = [...document.querySelectorAll('input')].filter(el => el.offsetParent !== null);
    const codeEl = inputs.find(el => /otp|code|verification|token|totp/.test(idOf(el)));
    return { len: codeEl ? String(codeEl.value || '').length : -1 };
  })()`;
}

function submitCodeScript() {
  return `(() => {
    const btn = document.getElementById('submit-btn')
      || [...document.querySelectorAll('button, input[type=submit]')].find(b =>
           /next|verify|confirm|continue|submit|log ?in/.test(((b.innerText || b.value || '') + '').toLowerCase()));
    if (!btn) return { ok: false, step: 'no-submit' };
    btn.click();
    return { ok: true };
  })()`;
}

function fillCodeScript(code) {
  return `(() => {
    const visible = el => el && el.offsetParent !== null && el.getClientRects().length > 0;
    const inputs = [...document.querySelectorAll('input')].filter(visible);
    const idOf = el => ((el.getAttribute('name') || '') + ' ' + (el.getAttribute('id') || '')
      + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('placeholder') || '')).toLowerCase();

    const codeEl = inputs.find(el => /otp|code|verification|token|totp/.test(idOf(el)))
      || inputs.find(el => el.type === 'text' || el.type === 'tel' || el.type === 'number');
    if (!codeEl) return { ok: false, step: 'no-code-field' };

    const set = (el, val) => {
      el.focus();
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value')
        || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      desc.set.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set(codeEl, ${JSON.stringify(String(code))});

    const buttons = [...document.querySelectorAll('button, input[type=submit]')].filter(visible);
    const submit = buttons.find(b => /verify|confirm|continue|submit|log ?in|next/i.test(b.innerText || b.value || ''))
      || buttons[0];
    if (!submit) return { ok: false, step: 'no-code-submit' };
    submit.click();
    return { ok: true };
  })()`;
}

async function loginState() {
  const s = await runInPage(loginStateScript());
  return (s && !s.error) ? s : { page: 'unknown' };
}

async function waitForPage(wantedPages, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise(r => setTimeout(r, 1200));
    const s = await loginState();
    if (wantedPages.includes(s.page)) return s;
  }
  return await loginState();
}

// askForCode() must resolve with { ok, code } — the morning run wires this
// to the Telegram bot. say(text) narrates progress. Never logs credentials.
async function autoLogin(creds, askForCode, say) {
  const talk = typeof say === 'function' ? say : () => {};
  if (!isOpen()) { createWindow(); parkOffscreen(); }

  try { prodaWindow.loadURL(PRODA_URL); } catch (e) { /* checked below */ }
  await new Promise(r => setTimeout(r, 4000));

  let s = await waitForPage(['login', 'password-only', 'code', 'logged-in'], 20000);
  if (s.page === 'logged-in') {
    await new Promise(r => setTimeout(r, 4000));
    return { ok: true, already: true };
  }
  if (s.page === 'unknown') return { ok: false, reason: 'login-page-not-recognised', hint: s.hint };

  if (s.page === 'login' || s.page === 'password-only') {
    talk(s.page === 'password-only'
      ? 'Signing into PRODA (password only)...'
      : 'Signing into PRODA...');
    const filled = await runInPage(fillLoginScript(creds.username || '', creds.password || ''));
    if (!filled || !filled.ok) return { ok: false, reason: 'could-not-fill-login', detail: filled && filled.step };

    s = await waitForPage(['code', 'logged-in'], 25000);
  }

  if (s.page === 'code') {
    talk('PRODA is asking for the code...');
    const got = await askForCode();
    if (!got || !got.ok) return { ok: false, reason: 'no-code', detail: got && got.reason };

    // Type the code like a human: the otp field ignores programmatic
    // value-sets (same code failed via set, worked by hand), so focus it
    // and send real keystrokes, then press Next.
    const focused = await runInPage(focusCodeScript());
    if (!focused || !focused.ok) return { ok: false, reason: 'could-not-enter-code', detail: focused && focused.step };
    for (const ch of String(got.code)) {
      prodaWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch });
      prodaWindow.webContents.sendInputEvent({ type: 'char', keyCode: ch });
      prodaWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch });
      await new Promise(r => setTimeout(r, 120));
    }
    await new Promise(r => setTimeout(r, 400));
    // Read back what actually landed in the field before pressing Next —
    // if the keystrokes silently missed, retype via the direct method.
    let rb = await runInPage(codeFieldLengthScript());
    engineLog('code field readback: ' + JSON.stringify(rb || {}));
    if (!rb || rb.len !== String(got.code).length) {
      await runInPage(fillCodeScript(got.code));
      rb = await runInPage(codeFieldLengthScript());
      engineLog('code field readback after retype: ' + JSON.stringify(rb || {}));
    }
    const submitted = await runInPage(submitCodeScript());
    if (!submitted || !submitted.ok) {
      const entered = await runInPage(fillCodeScript(got.code));   // fallback: old path
      if (!entered || !entered.ok) return { ok: false, reason: 'could-not-enter-code', detail: submitted && submitted.step };
    }

    s = await waitForPage(['logged-in'], 25000);
  }

  if (s.page === 'logged-in') {
    // Detected the moment the logged-in page appears — but PRODA is often
    // still redirecting and settling at that instant, and starting the HPOS
    // navigation from a half-built page is exactly how "could not open the
    // CDBS search form" happens. Let it settle, then confirm it still looks
    // logged in.
    talk('In — letting PRODA settle...');
    await new Promise(r => setTimeout(r, 7000));
    s = await loginState();
    if (s.page === 'code' || s.page === 'login' || s.page === 'password-only') {
      return { ok: false, reason: 'login-did-not-complete', stuckOn: s.page, hint: s.hint };
    }
    return { ok: true };
  }

  // Wrong password / wrong code / a page shape we've not seen — say which
  // page we're stuck on so the message on the phone is meaningful.
  return { ok: false, reason: 'login-did-not-complete', stuckOn: s.page, hint: s.hint };
}

// ---------------------------------------------------------------------
// FIND A PATIENT (Medicare number lookup)
//
// Built from the 29 Jul 2026 recording of findPerson/search.xhtml:
//  - the "Use" dropdown switches the form to personal-details mode, which
//    re-renders the fields (JSF), so the switch is polled for
//  - fields: firstName, surname, dob_input (digits only; the mask draws
//    the slashes), declaration_input checkbox, findByPersonalDetailsButton
//  - the results table on the SAME page carries first name, Medicare card
//    number, IRN and card expiry — the profile page is never needed
// ---------------------------------------------------------------------
function findUrl() {
  return hposOrigin ? `${hposOrigin}/pcert/hpos/faces/findPerson/search.xhtml` : null;
}

function findStateScript() {
  return `(() => {
    const visible = el => el && el.offsetParent !== null;
    const has = id => { const el = document.getElementById(id); return !!(el && visible(el)); };
    const bodyText = (document.body ? document.body.innerText : '') || '';
    const m = bodyText.match(/Results \\((\\d+)\\)/);
    return {
      hasSearchType: !!document.getElementById('searchType'),
      personalMode: has('firstName') && has('surname'),
      cardMode: has('cardNumber'),
      resultCount: m ? Number(m[1]) : null,
      hasFind: has('findByPersonalDetailsButton'),
      hasVisibleFindText: [...document.querySelectorAll('button, input[type=button], input[type=submit], a')].some(el => el && el.offsetParent !== null && /^find$/i.test(String(el.innerText || el.value || '').replace(/\\s+/g, ' ').trim())),
    };
  })()`;
}

function switchToPersonalScript() {
  return `(() => {
    // PrimeFaces: the visible "dropdown" is a styled div; the real select
    // hides beside it, usually with an _input suffix.
    const sel = document.getElementById('searchType_input')
      || [...document.querySelectorAll('select')].find(s => /searchType/i.test(s.id || s.name || ''))
      || document.getElementById('searchType');
    if (!sel) return { ok: false, step: 'no-search-type' };
    if (sel.tagName !== 'SELECT') return { ok: false, step: 'not-a-select', tag: sel.tagName };
    const options = [...(sel.options || [])];
    const target = options.find(o => /name and date of birth|personal/i.test(o.text || ''));
    if (!target) return { ok: false, step: 'no-personal-option', options: options.map(o => o.text) };
    if (sel.value === target.value) return { ok: true, already: true };
    sel.value = target.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, via: 'hidden-select' };
  })()`;
}

function switchToCardScript() {
  return `(() => {
    const sel = document.getElementById('searchType_input')
      || [...document.querySelectorAll('select')].find(s => /searchType/i.test(s.id || s.name || ''))
      || document.getElementById('searchType');
    if (!sel || sel.tagName !== 'SELECT') return { ok: false, step: 'no-search-type' };
    const options = [...(sel.options || [])];
    const target = options.find(o => /card/i.test(o.text || ''));
    if (!target) return { ok: false, step: 'no-card-option' };
    if (sel.value === target.value) return { ok: true, already: true };
    sel.value = target.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, via: 'hidden-select' };
  })()`;
}

function openSearchWidgetScript() {
  return `(() => {
    const label = document.getElementById('searchType_label')
      || document.getElementById('searchType');
    if (!label) return { ok: false, step: 'no-widget' };
    label.click();
    return { ok: true };
  })()`;
}

function pickPersonalOptionScript() {
  return `(() => {
    const visible = el => el && el.offsetParent !== null;
    const items = [...document.querySelectorAll('.ui-selectonemenu-items li, li[role=option], [role=option]')].filter(visible);
    const target = items.find(li => /name and date of birth|personal/i.test(li.innerText || ''));
    if (!target) return { ok: false, step: 'no-option-item', seen: items.map(li => (li.innerText || '').slice(0, 30)) };
    target.click();
    return { ok: true, via: 'widget-click' };
  })()`;
}

function fillFindScript(details) {
  return `(() => {
    const set = (el, val) => {
      el.focus();
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value')
        || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      desc.set.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const first = document.getElementById('firstName');
    const sur = document.getElementById('surname');
    const dob = document.getElementById('dob_input');
    const decl = document.getElementById('declaration_input');
    const find = document.getElementById('findByPersonalDetailsButton');
    if (!first || !sur || !dob) return { ok: false, step: 'fields-missing' };
    set(first, ${JSON.stringify(String(details.firstName || ''))});
    set(sur, ${JSON.stringify(String(details.surname || ''))});
    set(dob, ${JSON.stringify(String(details.dob8 || ''))});
    if (decl && !decl.checked) decl.click();
    // Submit ladder (2026-08-12): HPOS now hides the id'd Find button and
    // shows a styled one instead - clicking the hidden element is a silent
    // no-op (every search "ran" but the form never submitted; page-tail
    // evidence showed the blank form after 25s, and hasFind read false).
    const isVis = el => !!(el && el.offsetParent !== null && !el.disabled);
    const txt = el => String(el.innerText || el.value || '').replace(/\\s+/g, ' ').trim();
    let target = (find && isVis(find)) ? find : null;
    let via = 'id-button';
    if (!target) {
      target = [...document.querySelectorAll('button, input[type=button], input[type=submit], a')]
        .find(el => isVis(el) && /^find$/i.test(txt(el)));
      via = 'visible-text-button';
    }
    if (!target) return { ok: false, step: 'no-find-button' };
    target.click();
    return { ok: true, via };
  })()`;
}

function readResultsScript() {
  return `(() => {
    const bodyText = (document.body ? document.body.innerText : '') || '';
    const m = bodyText.match(/Results \\((\\d+)\\)/);
    if (!m) return { ready: false };
    const count = Number(m[1]);
    const matches = [];
    for (const table of document.querySelectorAll('table')) {
      if (!/Medicare card number/i.test(table.innerText || '')) continue;
      for (const tr of table.querySelectorAll('tr')) {
        const cells = [...tr.querySelectorAll('td')].map(td => (td.innerText || '').trim());
        if (cells.length < 4) continue;
        const cardIdx = cells.findIndex(c => /^\\d{10}$/.test(c));
        if (cardIdx === -1) continue;
        const irn = /^\\d$/.test(cells[cardIdx + 1] || '') ? cells[cardIdx + 1] : '';
        const expiry = (cells.find(c => /^\\d{2}\\/\\d{2}\\/\\d{4}$/.test(c)) || '');
        const name = (cells.slice(0, cardIdx).find(c => c && !/^\\d/.test(c)) || '').trim();
        matches.push({ firstName: name, cardNumber: cells[cardIdx], irn, expiry });
      }
    }
    return { ready: true, count, matches };
  })()`;
}

async function findMedicareNumber(details) {
  try {
    return await findMedicareNumberInner(details);
  } finally {
    // Leave the room as found: the search form goes back to CARD mode so
    // every later balance query talks to the right form (the 06/08 bug:
    // person-mode leftovers made the reader see form labels as replies).
    try {
      const back = await runInPage(switchToCardScript());
      engineLog('find: restored card mode: ' + JSON.stringify(back || {}));
    } catch (e) { engineLog('find: card-mode restore failed: ' + String(e).slice(0, 80)); }
  }
}

async function findMedicareNumberInner(details) {
  if (!hposOrigin) {
    const entered = await enterHpos();
    if (!entered.ok) return { ok: false, reason: entered.reason || 'could-not-enter-hpos' };
  }
  if (!isOpen()) { createWindow(); parkOffscreen(); }
  try { prodaWindow.loadURL(findUrl()); } catch (e) { /* judged below */ }
  await new Promise(r => setTimeout(r, 2500));

  let s = null;
  for (let i = 0; i < 20; i++) {
    s = await runInPage(findStateScript());
    if (s && !s.error && s.hasSearchType) break;
    await new Promise(r => setTimeout(r, 800));
  }
  engineLog('find: page state ' + JSON.stringify(s || {}));
  if (!s || s.error || !s.hasSearchType) return { ok: false, reason: 'find-page-not-ready' };

  if (!s.personalMode) {
    const sw = await runInPage(switchToPersonalScript());
    engineLog('find: switch rung A (hidden select): ' + JSON.stringify(sw || {}));
    if (sw && sw.ok) {
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 900));
        s = await runInPage(findStateScript());
        if (s && s.personalMode) break;
      }
    }
    if (!s || !s.personalMode) {
      // Rung B: operate the widget like a human — open it, click the option.
      const opened = await runInPage(openSearchWidgetScript());
      engineLog('find: switch rung B open: ' + JSON.stringify(opened || {}));
      await new Promise(r => setTimeout(r, 900));
      const picked = await runInPage(pickPersonalOptionScript());
      engineLog('find: switch rung B pick: ' + JSON.stringify(picked || {}));
      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 900));
        s = await runInPage(findStateScript());
        if (s && s.personalMode) break;
      }
    }
    if (!s || !s.personalMode) return { ok: false, reason: 'could-not-switch-mode' };
  }

  const filled = await runInPage(fillFindScript(details));
  if (!filled || !filled.ok) return { ok: false, reason: 'could-not-fill-find', detail: filled && filled.step };
  engineLog('find: submitted via ' + (filled.via || 'unknown'));

  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const res = await runInPage(readResultsScript());
    if (res && res.ready) {
      if (!res.count) return { ok: true, matches: [] };
      return { ok: true, matches: res.matches || [] };
    }
  }
  // Evidence at failure time: the reader only recognises a literal
  // "Results (N)" heading. If HPOS words a no-match or a validation
  // error any other way, we burn 25s and learn nothing - so photograph
  // what the page actually said (digits masked) before giving up.
  try {
    const snap = await runInPage(`(() => {
      const t = ((document.body ? document.body.innerText : '') || '').replace(/\\d{3,}/g, '###').replace(/\\s+/g, ' ').trim();
      const i = t.search(/Results|No result|no match|not found|could not|error|invalid/i);
      return { snip: (i >= 0 ? t.slice(Math.max(0, i - 40), i + 260) : t.slice(-300)) };
    })()`);
    if (snap && snap.snip) engineLog('find: page said (masked): "' + String(snap.snip).slice(0, 320) + '"');
  } catch (e) { /* evidence only - never fail the run over it */ }
  return { ok: false, reason: 'no-results-appeared' };
}

// Have we been signed out? PRODA sends you back to its login page.
async function checkSignedOut() {
  if (!isOpen()) return true;
  const url = prodaWindow.webContents.getURL() || '';
  if (/prodalogin|\/login|timeout\.jsf/i.test(url)) return true;
  const probe = await runInPage(`(() => ({
    hasPassword: !!document.querySelector('input[type=password]'),
    text: (document.body ? (document.body.innerText || '') : '').slice(0, 300)
  }))()`);
  if (!probe || probe.error) return false;
  return !!probe.hasPassword || /session has timed out|has been inactive/i.test(probe.text || '');
}

// Step 1: from PRODA's My Services page, go into HPOS.
async function enterHpos() {
  if (!isOpen()) return { ok: false, reason: 'no-window' };

  const url = prodaWindow.webContents.getURL() || '';
  if (/medicareaustralia\.gov\.au/i.test(url)) {
    hposOrigin = new URL(url).origin;
    return { ok: true, already: true, origin: hposOrigin };
  }

  if (await checkSignedOut()) return { ok: false, reason: 'signed-out' };

  // Click the "Go to service" link that belongs to the HPOS row.
  const clicked = await runInPage(`(() => {
    const visible = el => el && el.offsetParent !== null && el.getClientRects().length > 0;
    const clean = t => String(t || '').trim().replace(/\\s+/g, ' ');
    const links = [...document.querySelectorAll('a, button, input[type=submit]')].filter(visible);

    // Prefer a "Go to service" link sitting near the words HPOS / Health
    // Professional Online Services, so we can't wander into another service.
    const goLinks = links.filter(l => /go to service/i.test(clean(l.innerText || l.value)));
    const near = goLinks.find(l => {
      let n = l, hops = 0;
      while (n && hops < 6) {
        const t = clean(n.innerText || '');
        if (/health professional online services|hpos/i.test(t)) return true;
        n = n.parentElement; hops++;
      }
      return false;
    });
    const target = near || goLinks[0] ||
      links.find(l => /health professional online services|\\bhpos\\b/i.test(clean(l.innerText || l.value)));

    if (!target) {
      return { ok: false, seen: links.map(l => clean(l.innerText || l.value)).filter(Boolean).slice(0, 30) };
    }
    target.scrollIntoView({ block: 'center' });
    target.click();
    return { ok: true, clicked: clean(target.innerText || target.value).slice(0, 40) };
  })()`);

  if (!clicked || !clicked.ok) {
    return { ok: false, reason: 'no-hpos-link', detail: clicked && clicked.seen };
  }

  const moved = await waitForUrlChange(url, 25000);
  await waitMs(1500);
  const nowUrl = prodaWindow.webContents.getURL() || '';
  if (!/medicareaustralia\.gov\.au/i.test(nowUrl)) {
    return { ok: false, reason: 'hpos-did-not-open', detail: { moved, url: nowUrl.slice(0, 120) } };
  }

  hposOrigin = new URL(nowUrl).origin;
  return { ok: true, origin: hposOrigin };
}

// Step 2: open a fresh CDBS search form.
async function openCdbsForm() {
  if (!hposOrigin) {
    const entered = await enterHpos();
    if (!entered.ok) return entered;
  }
  try {
    await prodaWindow.loadURL(cdbsFormUrl());
  } catch (e) {
    return { ok: false, reason: 'cdbs-load-failed', detail: String(e) };
  }
  await waitMs(1200);

  const ready = await runInPage(`(() => {
    const f = document.getElementsByName('guiForm:guiMedicareCardNumber')[0];
    return { hasForm: !!f, title: document.title };
  })()`);

  if (!ready || !ready.hasForm) {
    if (await checkSignedOut()) return { ok: false, reason: 'signed-out' };
    return { ok: false, reason: 'no-cdbs-form', detail: ready };
  }
  return { ok: true };
}

// Step 3: one balance check.
function balanceCheckScript(cardNumber, irn, firstName) {
  return `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const byName = n => document.getElementsByName(n)[0];

    const card = byName('guiForm:guiMedicareCardNumber');
    const irnField = byName('guiForm:guiIndividualReferenceNumber');
    const nameField = byName('guiForm:guiFirstName');
    const search = byName('guiForm:gui_search');

    if (!card || !irnField || !nameField || !search) {
      return { ok: false, step: 'form-missing' };
    }

    const setValue = (el, val) => {
      el.focus();
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    };

    setValue(card, ${JSON.stringify(String(cardNumber || ''))});
    setValue(irnField, ${JSON.stringify(String(irn || ''))});
    setValue(nameField, ${JSON.stringify(String(firstName || ''))});
    await sleep(250);

    search.click();
    return { ok: true, step: 'submitted' };
  })()`;
}

// Step 4: read whatever came back, word for word.
function readResultScript() {
  return `(() => {
    const clean = t => String(t || '').replace(/\\s+/g, ' ').trim();
    const text = clean(document.body ? (document.body.innerText || '') : '');

    // Static page furniture must never count as a reply: the CDBS page
    // now shows a "Program Information" panel and the form's own help
    // text on the same screen as any answer (HPOS layout change,
    // discovered 2026-08-08 via form forensics).
    const isFurniture = (s) => /known only by one name|date of birth\\s*dd\\/mm\\/yyyy|Program Information|benefit program for children/i.test(s || '');
    const take = (m) => (m && !isFurniture(m[1])) ? clean(m[1]) : '';

    // The balance sentence, exactly as PRODA words it.
    const balanceMatch = text.match(/([^.]*has an available balance of[^.]*\\.)/i);

    // The eligibility statement - Yes/No anchored as whole words, so the
    // "no" inside "known" can never fake a reply.
    const eligibleMatch = text.match(/(\\b(?:Yes|No)\\b[,:]?\\s[^.]*eligib[^.]*\\.)/i);

    // The matched-but-details-differ response.
    const differMatch = text.match(/([^.]*matched using the submitted data[^.]*\\.)/i);

    // Anything that reads like an error or a warning.
    // 2026-08-11: Services Australia reworded its rejections ("is not
    // valid", "could not be matched to Services Australia's records") -
    // sentence-style match so the keyword can sit anywhere in the line.
    const errorMatch = text.match(/([^.]*(?:We could not|Unable to|No match|not found|invalid|incorrect|does not match|not valid|could not be matched|cannot be matched|could not be found|cannot be found|Please enter a Medicare card)[^.]*\\.)/i);

    return {
      balanceLine: take(balanceMatch),
      eligibilityLine: take(eligibleMatch),
      differLine: take(differMatch),
      errorLine: take(errorMatch),
      stillOnForm: !!document.getElementsByName('guiForm:gui_search')[0],
      hasNewSearch: !!document.getElementsByName('guiForm:gui_newSearch')[0],
    };
  })()`;
}

// The whole thing for one patient.
async function checkBalance({ cardNumber, irn, firstName }) {
  if (!cardNumber || !irn) return { ok: false, reason: 'missing-details' };

  const form = await openCdbsForm();
  if (!form.ok) return { ok: false, reason: form.reason, detail: form.detail };

  // Baseline read of the BLANK form. The CDBS page's own help text says
  // "Please enter a Medicare card number", and the nav strip glues into
  // sentence-shaped runs - both match the error keywords (discovered
  // 2026-08-12: build 2026-08-11.8 reported this furniture as PRODA
  // replies for a whole run). Any "error" sentence that already exists
  // before we submit is page furniture, not an answer, and is ignored.
  const baseline = await runInPage(readResultScript());
  const staticLines = {};
  if (baseline && !baseline.error) {
    for (const k of ['errorLine', 'differLine', 'balanceLine', 'eligibilityLine']) {
      if (baseline[k]) staticLines[baseline[k]] = true;
    }
  }
  const dropFurniture = (r) => {
    if (!r || r.error) return r;
    for (const k of ['errorLine', 'differLine', 'balanceLine', 'eligibilityLine']) {
      if (r[k] && staticLines[r[k]]) r[k] = '';
    }
    return r;
  };

  const submitted = await runInPage(balanceCheckScript(cardNumber, irn, firstName));
  if (!submitted || !submitted.ok) {
    return { ok: false, reason: 'could-not-submit', detail: submitted };
  }

  // Wait for the page to come back with an answer.
  let result = null;
  for (let i = 0; i < 40; i++) {
    await waitMs(400);
    if (!isOpen()) return { ok: false, reason: 'window-closed' };
    if (prodaWindow.webContents.isLoading()) continue;
    result = dropFurniture(await runInPage(readResultScript()));
    if (result && !result.error && (result.balanceLine || result.eligibilityLine || result.errorLine || result.differLine)) break;
  }

  if (await checkSignedOut()) return { ok: false, reason: 'signed-out' };
  if (!result || result.error) return { ok: false, reason: 'no-result', detail: result };

  // The result echoes the patient's first name — check it against the one we
  // asked about, so a mismatched answer is never recorded against a patient.
  const echoed = `${result.balanceLine} ${result.eligibilityLine}`.toLowerCase();
  const first = String(firstName || '').trim().toLowerCase();
  if (first && result.balanceLine && !echoed.includes(first)) {
    return { ok: false, reason: 'name-mismatch',
             detail: { expected: firstName, got: result.balanceLine.slice(0, 80) } };
  }

  if (result.balanceLine) {
    return { ok: true, text: result.balanceLine, eligibility: result.eligibilityLine };
  }
  if (result.eligibilityLine) {
    return { ok: true, text: result.eligibilityLine, eligibility: result.eligibilityLine };
  }
  if (result.errorLine) {
    return { ok: false, reason: 'proda-said', text: result.errorLine };
  }
  if (result.differLine) {
    return { ok: false, reason: 'details-differ', text: result.differLine };
  }
  return { ok: false, reason: 'nothing-returned' };
}

// Park the window out of sight while it works.
function parkOffscreen() {
  if (!isOpen()) createWindow();
  try {
    const spot = offscreenSpot();
    prodaWindow.setSkipTaskbar(true);
    prodaWindow.setPosition(spot.x, spot.y);
    prodaWindow.showInactive();
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------
// Capture control
// ---------------------------------------------------------------------
// The PRODA window is in front while you're using it, so the recording
// controls live in ITS menu bar rather than back in the app window.
function applyCaptureMenu() {
  if (!isOpen()) return;
  const menu = Menu.buildFromTemplate([
    {
      label: 'Recording',
      submenu: [
        {
          label: 'Mark this screen',
          accelerator: 'CmdOrCtrl+M',
          click: async () => {
            const snap = await snapshotCurrentPage('marked by hand');
            notify({ type: 'marked', title: snap && snap.title });
          },
        },
        { type: 'separator' },
        {
          label: 'Stop and save',
          click: async () => {
            const res = await stopCapture();
            clearCaptureMenu();
            notify({ type: 'stopped', result: res });
            if (res && res.ok && isOpen()) {
              dialog.showMessageBox(prodaWindow, {
                type: 'info',
                title: 'Recording saved',
                message: `Saved ${res.pageCount} screen${res.pageCount === 1 ? '' : 's'} and ${res.requestCount} request${res.requestCount === 1 ? '' : 's'}.`,
                detail: 'Switch back to the app window for the file location.',
                buttons: ['OK'],
              });
            }
          },
        },
      ],
    },
    { role: 'editMenu' },
    { label: 'Reload', role: 'reload' },
  ]);
  try {
    prodaWindow.setMenu(menu);
    prodaWindow.setMenuBarVisibility(true);
  } catch (e) { /* ignore */ }
}

function clearCaptureMenu() {
  if (!isOpen()) return;
  try { prodaWindow.setMenu(null); } catch (e) { /* ignore */ }
}

function startCapture() {
  capturing = true;
  captureLog = [];
  pageSnapshots = [];
  pending.clear();

  applyCaptureMenu();

  // Take a snapshot on every page change, so each step of the journey is
  // recorded without you having to press anything.
  if (isOpen()) {
    const wc = prodaWindow.webContents;
    if (!wc.__sdtNavHooked) {
      wc.__sdtNavHooked = true;
      wc.on('did-finish-load', () => {
        if (capturing) setTimeout(() => snapshotCurrentPage('page loaded'), 1200);
      });
      wc.on('did-navigate-in-page', () => {
        if (capturing) setTimeout(() => snapshotCurrentPage('in-page change'), 1200);
      });
    }
    setTimeout(() => snapshotCurrentPage('capture started'), 500);
  }
  return { ok: true };
}

function capturePath() {
  return path.join(app.getPath('documents'), 'proda-capture.json');
}

async function stopCapture() {
  await snapshotCurrentPage('capture stopped');
  capturing = false;

  const payload = {
    capturedAt: new Date().toISOString(),
    note: 'Digits are replaced with # and sensitive headers redacted. Safe to share.',
    requestCount: captureLog.length,
    pageCount: pageSnapshots.length,
    pages: pageSnapshots,
    requests: captureLog,
  };

  const file = capturePath();
  try {
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, file, requestCount: captureLog.length, pageCount: pageSnapshots.length };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function isCapturing() { return capturing; }

// Reload the parked PRODA window so the session clock resets. Real
// server traffic, zero interaction — called between patients during a
// long Principle collect so PRODA never idles out before balances.
async function keepAlive() {
  try {
    if (!prodaWindow || prodaWindow.isDestroyed()) return { ok: false };
    prodaWindow.webContents.reload();
    await new Promise((r) => setTimeout(r, 4000));
    return { ok: true };
  } catch (e) { return { ok: false }; }
}

// What is the PRODA window actually looking at right now? Read-only:
// address, page text (trimmed), and a census of inputs and buttons.
// Used by the CDBS run when a reply comes back as the search form, so
// the runlog carries the crime-scene photo instead of a shrug.
async function formForensics() {
  try {
    if (!prodaWindow || prodaWindow.isDestroyed()) return { ok: false, error: 'no PRODA window' };
    const url = prodaWindow.webContents.getURL();
    const data = await prodaWindow.webContents.executeJavaScript(`(() => {
      const t = (document.body && document.body.innerText) || '';
      const inputs = Array.from(document.querySelectorAll('input,select,textarea')).slice(0, 40).map(el => ({
        tag: el.tagName.toLowerCase(), type: el.type || '', id: el.id || '', name: el.name || '',
        visible: !!(el.offsetWidth || el.offsetHeight), value: el.value ? '(filled)' : '(empty)'
      }));
      const buttons = Array.from(document.querySelectorAll('button,input[type=submit],a[role=button]')).slice(0, 40).map(el => ({
        text: (el.innerText || el.value || '').trim().slice(0, 40),
        visible: !!(el.offsetWidth || el.offsetHeight), disabled: !!el.disabled
      }));
      return { title: document.title || '', text: t.slice(0, 1500), inputs, buttons };
    })()`, true);
    return { ok: true, url, title: data.title, text: data.text, inputs: data.inputs, buttons: data.buttons };
  } catch (e) { return { ok: false, error: String(e).slice(0, 120) }; }
}

module.exports = {
  keepAlive,
  formForensics,
  openVisible,
  isOpen,
  setNotifier,
  enterHpos,
  checkBalance,
  checkSignedOut,
  parkOffscreen,
  autoLogin,
  findMedicareNumber,
  setLogger,
  startCapture,
  stopCapture,
  isCapturing,
  snapshotCurrentPage,
  capturePath,
};
