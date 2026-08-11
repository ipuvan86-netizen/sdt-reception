// UI logic for the CDBS Balance Notes app.
// Nothing here talks to Principle directly — it asks the main process,
// which uses the shared Principle engine.

let preview = null;
let resultsFile = null;
let collectFile = null;

const $ = (id) => document.getElementById(id);

// ---------- Local-first items cache ----------
// The cloud is the source of truth; this memory is the working surface.
// Renders and searches read memory instantly; the network only runs at
// the edges (view entry, after a change, gentle background refresh).
let __items = { list: [], at: 0, inflight: null, synced: null };
async function getItems(fresh) {
  const stale = Date.now() - __items.at > 45 * 1000;
  if ((fresh || stale) && !__items.inflight) {
    __items.inflight = window.cdbs.actionGet().then(r => {
      __items.list = (r && r.items) || [];
      __items.synced = !!(r && r.synced);
      __items.at = Date.now();
      __items.inflight = null;
    }).catch(() => { __items.synced = false; __items.inflight = null; });
  }
  if (__items.inflight && (fresh || !__items.list.length)) await __items.inflight;
  return __items.list;
}
function typingInside(el) {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && el && el.contains(a);
}


const show = (el, on) => el.classList.toggle('hidden', !on);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------- Step 1: choose the file ----------
$('btnPick').addEventListener('click', async () => {
  const res = await window.cdbs.pickCsv();
  if (!res.ok) {
    if (res.error) alert('Could not read that file:\n\n' + res.error);
    return;
  }
  preview = res.preview;
  loadedFileName = res.file;
  $('fileInfo').textContent = `Loaded: ${res.file}`;
  show($('fileInfo'), true);
  renderPreview();
});

function renderPreview() {
  const warnings = [];

  if (!preview.balanceColumnFound) {
    warnings.push(`<div class="warn"><strong>No balance column found.</strong>
      Add a column called <strong>${esc(preview.expectedColumnName)}</strong> to the sheet and fill in
      the balances from PRODA, then choose the file again.<br>
      Columns found: ${esc(preview.headers.join(', '))}</div>`);
  } else if (preview.balanceColumnName.toLowerCase() !== preview.expectedColumnName.toLowerCase()) {
    warnings.push(`<div class="warn">Using the column <strong>${esc(preview.balanceColumnName)}</strong>
      as the balance. If that isn't right, rename it to <strong>${esc(preview.expectedColumnName)}</strong>.</div>`);
  }

  if (preview.skipCount > 0) {
    warnings.push(`<div class="warn"><strong>${preview.skipCount} row${preview.skipCount === 1 ? '' : 's'} will be skipped.</strong>
      They're greyed out below with the reason. Nothing will be written for them.</div>`);
  }

  if (!preview.linkColumnName) {
    warnings.push(`<div class="warn"><strong>No patient link column found.</strong>
      This file has no column containing links to patient files, so patients can't be
      identified. Export the report from Principle with the link column included.<br>
      Columns found: ${esc(preview.headers.join(', '))}</div>`);
  }
  $('warnings').innerHTML = warnings.join('');

  $('previewSummary').innerHTML =
    `<span>Using column <strong>${esc(preview.linkColumnName || 'none')}</strong> to identify patients
     and <strong>${esc(preview.balanceColumnName || 'none')}</strong> for the balance.</span><br>` +
    `${preview.readyCount} note${preview.readyCount === 1 ? '' : 's'} ready to write` +
    (preview.skipCount ? `, ${preview.skipCount} skipped` : '') +
    '. Nothing is written until you press the button.';

  $('tbody').innerHTML = preview.items.map(it => `
    <tr class="${it.skip ? 'skipped' : ''}" id="row-${it.rowNumber}">
      <td>${it.rowNumber}</td>
      <td>${esc(it.name)}</td>
      <td>${esc(it.appointmentDate)}</td>
      <td>${esc(it.balance || it.balanceRaw || '—')}</td>
      <td class="note-text">${it.skip ? '<em>' + esc(it.skip) + '</em>' : esc(it.note)}</td>
      <td id="status-${it.rowNumber}">
        <span class="pill ${it.skip ? 'skipped' : 'ready'}">${it.skip ? 'Skipped' : 'Ready'}</span>
      </td>
    </tr>`).join('');

  $('btnRun').disabled = preview.readyCount === 0;
  show($('stepCollect'), preview.items.some(i => i.patientId));
  show($('stepPreview'), true);
  show($('stepDone'), false);
}

// ---------- Run the lot ----------
$('btnRunAll').addEventListener('click', async () => {
  const ok = confirm(
    'Run the whole thing?\n\n' +
    'Report + Medicare details + PRODA balances. Roughly 15-20 minutes for a full list. ' +
    'If a login is needed, the window will come up and wait for you.\n\n' +
    'Nothing is written to any patient file — it stops at the review table.'
  );
  if (!ok) return;

  $('btnRunAll').disabled = true;
  show($('btnStopAll'), true);
  show($('runAllWrap'), true);
  show($('runAllResult'), false);
  $('runAllText').textContent = 'Starting...';

  const res = await window.cdbs.runAll();
  if (!res.ok && res.error) {
    $('btnRunAll').disabled = false;
    show($('btnStopAll'), false);
    $('runAllText').textContent = res.error;
  }
});

$('btnStopAll').addEventListener('click', async () => {
  $('btnStopAll').disabled = true;
  $('runAllText').textContent = 'Stopping after the current patient...';
  await window.cdbs.stopAll();
});

window.cdbs.onRunAllProgress((p) => {
  if (p && p.text) { show($('runAllWrap'), true); $('runAllText').textContent = p.text; }
});

window.cdbs.onRunAllFinished((r) => {
  $('btnRunAll').disabled = false;
  $('btnStopAll').disabled = false;
  show($('btnStopAll'), false);
  show($('runAllResult'), true);

  if (!r.ok) {
    $('runAllText').textContent = '';
    show($('runAllWrap'), false);
    $('runAllResult').innerHTML = `<div class="warn">${esc(r.message || 'The run did not finish.')}</div>`;
    return;
  }

  $('runAllText').textContent = 'Finished.';
  if (typeof r.callList !== 'undefined' && r.callList !== null) {
    $('fileRunState').innerHTML = '<span class="pill good">Done — results below</span>';
  } else {
    $('fileRunState').innerHTML = '';
  }
  $('runAllResult').innerHTML = `
    <div class="info">
      <strong>${r.readyCount} note${r.readyCount === 1 ? '' : 's'} ready to write.</strong>
      ${r.failCount ? `<br>${r.failCount} patient${r.failCount === 1 ? ' was' : 's were'} not successful — each one's reason is shown in the table below and in the spreadsheet, so they can be chased by hand.` : ''}
      ${r.file ? `<br>Spreadsheet saved to: ${esc(r.file)}` : ''}
      <br><br><strong>Read the table below, then press "Write these notes".</strong> Nothing has been written yet.
    </div>
    ${r.sortedPdf ? `<div class="row" style="margin-top:10px;"><button class="secondary" id="btnSortedPdf">Open the sorted summary (PDF)</button></div>` : ''}
    ${r.callList ? `<div class="row" style="margin-top:10px;"><button class="secondary" id="btnCallList">Open the call list (CSV)</button></div>` : ''}`;
  if (r.sortedPdf) {
    $('btnSortedPdf').addEventListener('click', () => window.cdbs.openFile(r.sortedPdf));
  }
  if (r.callList) {
    $('btnCallList').addEventListener('click', () => window.cdbs.openFile(r.callList));
  }

  preview = r.preview;
  loadedFileName = r.file ? r.file.split(/[\\\/]/).pop() : 'run-the-lot';
  $('fileInfo').textContent = 'Loaded from Run the lot' + (r.file ? ` (${loadedFileName})` : '');
  show($('fileInfo'), true);
  renderPreview();
  $('stepPreview').scrollIntoView({ behavior: 'smooth' });
});

// ---------- Step 1 (automatic): generate the report in Principle ----------
$('btnGenerate').addEventListener('click', async () => {
  $('btnGenerate').disabled = true;
  $('btnPick').disabled = true;
  show($('genState'), true);
  $('genState').textContent = 'Checking Principle is logged in...';

  const res = await window.cdbs.generateReport();

  $('btnGenerate').disabled = false;
  $('btnPick').disabled = false;

  if (!res.ok) {
    $('genState').innerHTML = `<span style="color:#b91c1c;">${esc(res.error || 'Could not generate the report.')}</span>`;
    return;
  }

  $('genState').textContent = 'Report generated and loaded.';
  preview = res.preview;
  loadedFileName = res.file;
  $('fileInfo').textContent = `Loaded: ${res.file} (saved in the program's reports folder)`;
  show($('fileInfo'), true);
  renderPreview();
});

window.cdbs.onGenReportProgress((p) => {
  if (p && p.text) { show($('genState'), true); $('genState').textContent = p.text; }
});

// ---------- Step 2: write the notes ----------
$('btnRun').addEventListener('click', async () => {
  const items = preview.items.filter(i => !i.skip);
  if (!items.length) return;

  const ok = confirm(
    `Write ${items.length} note${items.length === 1 ? '' : 's'} into Principle?\n\n` +
    `This takes roughly ${Math.ceil(items.length * 7 / 60)} minute(s). ` +
    `You can keep working — Principle stays out of sight.`
  );
  if (!ok) return;

  $('btnRun').disabled = true;
  $('btnPick').disabled = true;
  show($('btnStop'), true);
  show($('progressWrap'), true);
  $('progressText').textContent = 'Checking Principle is logged in...';

  items.forEach(it => {
    $('status-' + it.rowNumber).innerHTML = '<span class="pill ready">Waiting</span>';
  });

  await window.cdbs.startRun(items);
});

$('btnStop').addEventListener('click', async () => {
  $('btnStop').disabled = true;
  $('progressText').textContent = 'Stopping after the current patient...';
  await window.cdbs.stopRun();
});

window.cdbs.onProgress((p) => {
  const cell = $('status-' + p.rowNumber);
  if (cell) {
    if (p.status === 'working') cell.innerHTML = '<span class="pill working">Writing...</span>';
    else if (p.status === 'done') cell.innerHTML = '<span class="pill done">Written</span>';
    else if (p.status === 'already-done') cell.innerHTML = `<span class="pill already">Already done</span><div class="detail" style="color:#854d0e">${esc(p.detail || '')}</div>`;
    else if (p.status === 'failed') cell.innerHTML = `<span class="pill failed">Failed</span><div class="detail">${esc(p.detail || '')}</div>`;
  }
  const pct = Math.round(((p.index + 1) / p.total) * 100);
  $('progressBar').style.width = pct + '%';
  $('progressText').textContent = `Patient ${p.index + 1} of ${p.total}`;
});

window.cdbs.onFinished((r) => {
  show($('btnStop'), false);
  $('btnStop').disabled = false;
  $('btnPick').disabled = false;
  $('progressText').textContent = r.stopped ? 'Stopped.' : 'All done.';

  if (r.message) {
    $('doneSummary').innerHTML = esc(r.message);
  } else {
    const bits = [`<strong>${r.doneCount} note${r.doneCount === 1 ? '' : 's'} written.</strong>`];
    if (r.failedCount) bits.push(`${r.failedCount} failed — the reason is shown against each row above, and they can be re-run.`);
    if (r.skippedEarlier) bits.push(`${r.skippedEarlier} were already written earlier and were left alone.`);
    if (r.stopped) bits.push('The run was stopped early.');
    $('doneSummary').innerHTML = bits.join('<br>');
  }

  resultsFile = r.resultsFile || null;
  $('btnResults').disabled = !resultsFile;
  show($('stepDone'), true);
  $('stepDone').scrollIntoView({ behavior: 'smooth' });

  // Failed rows can simply be run again — successes are remembered and skipped.
  $('btnRun').disabled = false;
});

// ---------- Check balances in PRODA ----------
let balanceFile = null;
let collectedRows = null;   // what came back from the Medicare collection

$('btnBalances').addEventListener('click', async () => {
  const items = (collectedRows || []).filter(r => r.number && r.irn);
  if (!items.length) {
    show($('balanceResult'), true);
    $('balanceResult').innerHTML = '<div class="warn">No Medicare details to check yet — run <strong>Collect details</strong> first.</div>';
    return;
  }

  const ok = confirm(
    `Check ${items.length} balance${items.length === 1 ? '' : 's'} in PRODA?\n\n` +
    `Make sure you are logged into PRODA first. Takes roughly ${Math.ceil(items.length * 8 / 60)} minute(s).`
  );
  if (!ok) return;

  $('btnBalances').disabled = true;
  show($('btnStopBalances'), true);
  show($('balanceWrap'), true);
  show($('balanceResult'), false);
  $('balanceText').textContent = 'Going into HPOS...';

  await window.cdbs.checkBalances({ items });
});

$('btnStopBalances').addEventListener('click', async () => {
  $('btnStopBalances').disabled = true;
  $('balanceText').textContent = 'Stopping after the current patient...';
  await window.cdbs.stopBalances();
});

window.cdbs.onBalanceProgress((p) => {
  if (p.index < 0) { $('balanceText').textContent = 'Going into HPOS...'; return; }
  const pct = Math.round(((p.index + 1) / p.total) * 100);
  $('balanceBar').style.width = pct + '%';
  $('balanceText').textContent = `Patient ${p.index + 1} of ${p.total}` +
    (p.status === 'failed' && p.detail ? ` — last one: ${p.detail}` : '');
  const cell = $('status-' + p.rowNumber);
  if (cell) {
    if (p.status === 'working') cell.innerHTML = '<span class="pill working">Checking...</span>';
    else if (p.status === 'done') cell.innerHTML = '<span class="pill done">Balance found</span>';
    else if (p.status === 'failed') cell.innerHTML = `<span class="pill failed">No balance</span><div class="detail">${esc(p.detail || '')}</div>`;
  }
});

window.cdbs.onBalancePaused((p) => {
  $('balanceText').innerHTML = `<strong style="color:#b91c1c;">Paused — PRODA signed you out.</strong>
    Log back in (password only, within four hours) and it will carry on from patient ${p.index + 1} by itself.`;
});

window.cdbs.onBalanceFinished((r) => {
  $('btnBalances').disabled = false;
  $('btnStopBalances').disabled = false;
  show($('btnStopBalances'), false);
  $('balanceText').textContent = r.stopped ? 'Stopped.' : 'Finished.';
  show($('balanceResult'), true);

  if (r.message) {
    $('balanceResult').innerHTML = `<div class="warn">${esc(r.message)}</div>`;
    return;
  }

  balanceFile = r.file || null;
  $('balanceResult').innerHTML = `
    <div class="info">
      <strong>${r.okCount} balance${r.okCount === 1 ? '' : 's'} found.</strong>
      ${r.failCount ? `<br>${r.failCount} did not come back — the reason is against each row and in the spreadsheet.` : ''}
      ${r.file ? `<br>Saved to: ${esc(r.file)}` : ''}
      <br><br><strong>Check the balances before writing any notes.</strong>
      Open the spreadsheet, read it through, then load it back in below.
    </div>
    ${r.file ? '<div style="margin-top:12px;"><button class="secondary" id="btnOpenBalances">Open the spreadsheet</button></div>' : ''}`;
  const b = $('btnOpenBalances');
  if (b) b.addEventListener('click', () => window.cdbs.openFile(balanceFile));
});

// ---------- Principle report capture ----------
let reportCaptureFile = null;
let reportMarks = 0;

$('btnReportStart').addEventListener('click', async () => {
  // Enable these BEFORE opening Principle — it takes focus, and the buttons
  // must already be live when you switch back.
  reportMarks = 0;
  $('btnReportStart').disabled = true;
  $('btnReportMark').disabled = false;
  $('btnReportStop').disabled = false;
  const res = await window.cdbs.preportStart();
  $('reportState').innerHTML = '<strong>Recording.</strong> Use the <strong>Recording</strong> menu ' +
    'at the top of the Principle window to mark screens and finish — no need to come back here.';
  show($('reportResult'), false);
});

$('btnReportMark').addEventListener('click', async () => {
  const res = await window.cdbs.preportMark('marked by hand');
  reportMarks++;
  $('reportState').textContent = `Recording — ${reportMarks} screen${reportMarks === 1 ? '' : 's'} marked` +
    (res && res.title ? ` (last: ${res.title})` : '');
});

function showReportResult(res) {
  show($('reportResult'), true);
  if (!res.ok) {
    $('reportResult').innerHTML = `<div class="warn">Could not save the recording: ${esc(res.error || '')}</div>`;
    return;
  }
  reportCaptureFile = res.file;
  const dl = (res.downloads || [])[0];
  const dlBit = dl
    ? `<br><br><strong>The report downloaded straight into this program's folder</strong> — it did not go to Downloads.<br>
       File: ${esc(dl.filename || '')} &nbsp;•&nbsp; ${dl.rowCount != null ? esc(String(dl.rowCount)) + ' rows' : esc(dl.state || '')}
       ${dl.hasPatientLink ? '<br>It has a link column, so patients can be identified.' : (dl.headerRow ? '<br><span style="color:#b91c1c">No link column found in it — patients could not be identified from this report.</span>' : '')}`
    : '<br><br>No download was seen during the recording.';

  $('reportResult').innerHTML = `
    <div class="info">
      <strong>Recording saved.</strong><br>
      ${res.pageCount} screen${res.pageCount === 1 ? '' : 's'} recorded.
      ${dlBit}
      <br><br>Recording saved to: ${esc(res.file)} — send that file to Claude.
      <br>Only the column names from the report are in it, never the rows.
    </div>
    <div class="row" style="margin-top:12px; gap:10px;">
      <button class="secondary" id="btnOpenReportFile">Show the recording</button>
      <button class="secondary" id="btnOpenReportsFolder">Open the reports folder</button>
    </div>`;
  const b = $('btnOpenReportFile');
  if (b) b.addEventListener('click', () => window.cdbs.openFile(reportCaptureFile));
  const b2 = $('btnOpenReportsFolder');
  if (b2) b2.addEventListener('click', () => window.cdbs.preportOpenFolder());
}

$('btnReportStop').addEventListener('click', async () => {
  $('btnReportStop').disabled = true;
  $('btnReportMark').disabled = true;
  const res = await window.cdbs.preportStop();
  $('btnReportStart').disabled = false;
  $('reportState').textContent = '';
  showReportResult(res);
});

// ---------- PRODA capture ----------
let prodaCaptureFile = null;
let markCount = 0;

$('btnProdaOpen').addEventListener('click', () => window.cdbs.prodaOpen());

$('btnProdaStart').addEventListener('click', async () => {
  markCount = 0;
  $('btnProdaStart').disabled = true;
  $('btnProdaMark').disabled = false;
  $('btnProdaStop').disabled = false;
  $('prodaState').innerHTML = '<strong>Recording.</strong> Use the <strong>Recording</strong> menu ' +
    'at the top of the PRODA window to mark screens and finish.';
  await window.cdbs.prodaStartCapture();
  show($('prodaResult'), false);
});

$('btnProdaMark').addEventListener('click', async () => {
  const res = await window.cdbs.prodaMark('marked by hand');
  markCount++;
  $('prodaState').textContent = `Recording — ${markCount} screen${markCount === 1 ? '' : 's'} marked` +
    (res && res.title ? ` (last: ${res.title})` : '');
});

function showProdaResult(res) {
  show($('prodaResult'), true);
  if (!res.ok) {
    $('prodaResult').innerHTML = `<div class="warn">Could not save the recording: ${esc(res.error || '')}</div>`;
    return;
  }
  prodaCaptureFile = res.file;
  $('prodaResult').innerHTML = `
    <div class="info">
      <strong>Recording saved.</strong><br>
      ${res.pageCount} screen${res.pageCount === 1 ? '' : 's'} and ${res.requestCount} request${res.requestCount === 1 ? '' : 's'} recorded.<br>
      Saved to: ${esc(res.file)}<br>
      All numbers were replaced with # before saving. Send that file to Claude.
    </div>
    <div style="margin-top:12px;"><button class="secondary" id="btnOpenProdaFile">Show the file</button></div>`;
  const b = $('btnOpenProdaFile');
  if (b) b.addEventListener('click', () => window.cdbs.openFile(prodaCaptureFile));
}

$('btnProdaStop').addEventListener('click', async () => {
  $('btnProdaStop').disabled = true;
  $('btnProdaMark').disabled = true;
  const res = await window.cdbs.prodaStopCapture();
  $('btnProdaStart').disabled = false;
  $('prodaState').textContent = '';
  showProdaResult(res);
});

// ---------- Collect Medicare details ----------
let loadedFileName = '';

$('btnCollect').addEventListener('click', async () => {
  const items = preview.items.filter(i => i.patientId);
  if (!items.length) return;

  const ok = confirm(
    `Read Medicare details for ${items.length} patient${items.length === 1 ? '' : 's'}?\n\n` +
    `Takes roughly ${Math.ceil(items.length * 8 / 60)} minute(s). Nothing is written to any patient file.`
  );
  if (!ok) return;

  $('btnCollect').disabled = true;
  show($('btnStopCollect'), true);
  show($('collectWrap'), true);
  show($('collectResult'), false);
  $('collectText').textContent = 'Checking Principle is logged in...';

  await window.cdbs.collectMedicare({ items, sourceName: loadedFileName });
});

$('btnStopCollect').addEventListener('click', async () => {
  $('btnStopCollect').disabled = true;
  $('collectText').textContent = 'Stopping after the current patient...';
  await window.cdbs.stopCollect();
});

window.cdbs.onCollectProgress((p) => {
  const pct = Math.round(((p.index + 1) / p.total) * 100);
  $('collectBar').style.width = pct + '%';
  $('collectText').textContent = `Patient ${p.index + 1} of ${p.total}` +
    (p.status === 'failed' && p.detail ? ` — last one: ${p.detail}` : '');
  const cell = $('status-' + p.rowNumber);
  if (cell) {
    if (p.status === 'working') cell.innerHTML = '<span class="pill working">Reading...</span>';
    else if (p.status === 'done') cell.innerHTML = p.warn
      ? `<span class="pill already">Details read</span><div class="detail" style="color:#854d0e">${esc(p.warn)}</div>`
      : '<span class="pill done">Details read</span>';
    else if (p.status === 'failed') cell.innerHTML = `<span class="pill failed">No details</span><div class="detail">${esc(p.detail || '')}</div>`;
  }
});

window.cdbs.onCollectFinished((r) => {
  $('btnCollect').disabled = false;
  $('btnStopCollect').disabled = false;
  show($('btnStopCollect'), false);
  $('collectText').textContent = r.stopped ? 'Stopped.' : 'Finished.';
  show($('collectResult'), true);

  if (r.message) {
    $('collectResult').innerHTML = `<div class="warn">${esc(r.message)}</div>`;
    return;
  }

  collectFile = r.file || null;
  collectedRows = (r.rows || []).filter(x => x.number && x.irn);
  show($('stepBalances'), collectedRows.length > 0);
  $('collectResult').innerHTML = `
    <div class="info">
      <strong>${r.okCount} patient${r.okCount === 1 ? '' : 's'} had Medicare details read.</strong>
      ${r.failCount ? `<br>${r.failCount} did not — the reason is shown against each row, and also in the spreadsheet.` : ''}
      ${r.file ? `<br>Saved to: ${esc(r.file)}` : ''}
      <br><br>Do the PRODA checks from that spreadsheet, fill in the
      <strong>CDBS Available</strong> column, then load it back here to write the notes.
    </div>
    ${r.file ? '<div style="margin-top:12px;"><button class="secondary" id="btnOpenCollected">Open the spreadsheet</button></div>' : ''}`;

  const b = $('btnOpenCollected');
  if (b) b.addEventListener('click', () => window.cdbs.openFile(collectFile));
});

// ---------- Diagnostic: what does Principle store? ----------
$('btnFields').addEventListener('click', async () => {
  const out = $('fieldsResult');
  show(out, true);
  out.innerHTML = '<div class="muted">Checking... if Principle opens, just search for any patient once so I can see how its search works.</div>';
  $('btnFields').disabled = true;

  const res = await window.cdbs.inspectFields();
  $('btnFields').disabled = false;

  if (!res.ok) {
    const why = {
      'not-learned': "Couldn't see Principle's search.",
      'no-search-seen': "No search was seen. Open Principle, search for any patient, then press Check again.",
      'no-results': "The search returned no patients to look at.",
    }[res.reason] || ('Could not check: ' + esc(res.reason || ''));
    out.innerHTML = `<div class="warn">${esc(why)}</div>`;
    return;
  }

  // Highlight anything that looks like it could feed a Medicare lookup.
  const interesting = /medicare|irn|card|dob|birth|expiry|reference/i;
  const rows = res.fields.map(f => {
    const hot = interesting.test(f.name);
    return `<tr${hot ? ' style="background:#E8F1EC"' : ''}>
      <td style="font-family:ui-monospace,Consolas,monospace;font-size:13px;">${esc(f.name)}</td>
      <td class="muted">${esc(f.type)}</td>
      <td class="muted">${f.filledCount} of ${res.sampleSize} had a value</td>
    </tr>`;
  }).join('');

  const hits = res.fields.filter(f => interesting.test(f.name)).map(f => f.name);
  const verdict = hits.length
    ? `<div class="info"><strong>Possible Medicare-related fields found:</strong> ${esc(hits.join(', '))}.
       Send this list to Claude — if the card number and IRN are here, patient files won't need opening.</div>`
    : `<div class="warn"><strong>Nothing Medicare-related in the search index.</strong>
       The details would have to be read from each patient's file instead. Send this list to Claude.</div>`;

  out.innerHTML = verdict + `<div style="margin-top:14px; max-height:340px; overflow:auto;">
    <table><thead><tr><th>Field</th><th>Type</th><th>Filled</th></tr></thead><tbody>${rows}</tbody></table></div>`;
});

// ---------- Diagnostic: the Medicare tab ----------
$('btnMedicare').addEventListener('click', async () => {
  const out = $('medicareResult');
  const first = preview && preview.items.find(i => i.patientId);
  if (!first) {
    show(out, true);
    out.innerHTML = '<div class="warn">Load a report above first — this uses the first patient in it.</div>';
    return;
  }

  show(out, true);
  out.innerHTML = '<div class="muted">Opening the patient file... Principle will appear so you can watch.</div>';
  $('btnMedicare').disabled = true;

  const res = await window.cdbs.snapshotMedicare({ patientId: first.patientId, name: first.name });
  $('btnMedicare').disabled = false;

  if (!res.ok) {
    out.innerHTML = `<div class="warn">Could not read the page: ${esc(res.reason || '')}</div>`;
    return;
  }

  const r = res.report;

  if (!r.panelFound) {
    out.innerHTML = `<div class="warn"><strong>Couldn't find the Medicare panel.</strong>
      ${esc(r.note || '')}<br>Tabs seen: ${esc((r.allTabLabels || []).join(', ') || 'none')}
      ${res.file ? '<br>Saved to ' + esc(res.file) + ' — send it to Claude.' : ''}</div>`;
    return;
  }

  const lines = (r.lines || []).map(l => `<div style="font-family:ui-monospace,Consolas,monospace;font-size:12.5px;padding:2px 0;">${esc(l)}</div>`).join('');

  out.innerHTML = `
    <div class="info">
      <strong>Found the Medicare panel.</strong>
      ${r.clickedTab ? ' (it needed a click to open)' : ' (it was already open)'}<br>
      Numbers are shown as # and the patient's name as &lt;name&gt; — nothing identifying is recorded.
      ${res.file ? '<br>Saved to: ' + esc(res.file) + ' — send that file to Claude.' : ''}
    </div>
    <div style="margin-top:14px; max-height:300px; overflow:auto; background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:12px;">
      ${lines || '<span class="muted">The panel was found but had no readable text.</span>'}
    </div>`;
});

// Keep this window in step when the recording is driven from the other
// window's menu.
window.cdbs.onPreportEvent((msg) => {
  if (!msg) return;
  if (msg.type === 'marked') {
    reportMarks++;
    $('reportState').innerHTML = `<strong>Recording.</strong> ${reportMarks} screen${reportMarks === 1 ? '' : 's'} marked` +
      (msg.title ? ` (last: ${esc(msg.title)})` : '');
  } else if (msg.type === 'stopped') {
    $('btnReportStart').disabled = false;
    $('btnReportMark').disabled = true;
    $('btnReportStop').disabled = true;
    $('reportState').textContent = '';
    if (msg.result) showReportResult(msg.result);
  }
});

window.cdbs.onProdaEvent((msg) => {
  if (!msg) return;
  if (msg.type === 'marked') {
    markCount++;
    $('prodaState').innerHTML = `<strong>Recording.</strong> ${markCount} screen${markCount === 1 ? '' : 's'} marked` +
      (msg.title ? ` (last: ${esc(msg.title)})` : '');
  } else if (msg.type === 'stopped') {
    $('btnProdaStart').disabled = false;
    $('btnProdaMark').disabled = true;
    $('btnProdaStop').disabled = true;
    $('prodaState').textContent = '';
    if (msg.result) showProdaResult(msg.result);
  }
});

// ---------- Principle login status ----------
// Checked the moment the app opens, so you're never surprised mid-run.
window.cdbs.onLoginStatus(({ status }) => {
  const pill = $('loginPill');
  const btn = $('btnLogin');
  const map = {
    checking:   ['checking',  'Checking Principle...'],
    connected:  ['connected', 'Connected to Principle'],
    'logging-in': ['checking', 'Waiting for you to log in...'],
    'needs-login': ['needslogin', 'Not logged in to Principle'],
  };
  const [cls, text] = map[status] || map.checking;
  pill.className = 'pill ' + cls;
  pill.textContent = text;
  show(btn, status === 'needs-login');
});

$('btnLogin').addEventListener('click', () => window.cdbs.checkLogin(true));

// ---------- Odds and ends ----------
$('btnResults').addEventListener('click', () => { if (resultsFile) window.cdbs.openFile(resultsFile); });
$('btnAgain').addEventListener('click', () => {
  preview = null;
  show($('stepPreview'), false);
  show($('stepDone'), false);
  show($('fileInfo'), false);
  show($('progressWrap'), false);
  $('progressBar').style.width = '0%';
});


// ---------- Morning run settings ----------
async function refreshMorningState() {
  const s = await window.cdbs.morningGetSettings();
  if (s.fbEmail) $('mFbEmail').value = s.fbEmail;
  $('mFbPass').placeholder = s.haveFbPassword ? 'app account password (saved)' : 'app account password';
  $('mUsername').placeholder = s.haveUsername ? 'PRODA username (saved)' : 'PRODA username';
  $('mPassword').placeholder = s.havePassword ? 'PRODA password (saved)' : 'PRODA password';
  $('mToken').placeholder = s.haveToken ? 'Telegram bot token (saved)' : 'Telegram bot token';
  if (s.chatId) $('mChatId').value = s.chatId;
  {
    const [h, m] = String(s.morningTime || '08:30').split(':');
    $('mTimeH').value = String(h || '08').padStart(2, '0');
    $('mTimeM').value = String(m || '30').padStart(2, '0');
    if ([...$('mTimeM').options].every(o => o.value !== $('mTimeM').value)) $('mTimeM').value = '30';
    const days = Array.isArray(s.mDays) && s.mDays.length ? s.mDays : [1, 2, 3, 4, 5];
    for (const d of [0, 1, 2, 3, 4, 5, 6]) $('mD' + d).checked = days.includes(d);
  }
  $('mPEmail').value = s.principleEmail || '';
  $('mEnabled').checked = !!s.enabled;
  try {
    const w = await window.cdbs.workerGet();
    $('mWorkerBox').checked = !!w.worker;
    $('workerBadge').style.display = w.worker ? 'none' : 'block';
  } catch (e) { /* ignore */ }
  if (!s.encryptionAvailable) {
    $('morningState').innerHTML = '<span style="color:#b91c1c;">Windows encryption is not available on this account, so credentials cannot be saved.</span>';
  }
  return s;
}
refreshMorningState();

$('btnMorningSave').addEventListener('click', async () => {
  try {
    const w = await window.cdbs.workerSet({ worker: $('mWorkerBox').checked });
    $('workerBadge').style.display = w.worker ? 'none' : 'block';
  } catch (e) { /* ignore */ }
  const res = await window.cdbs.morningSaveSettings({
    fbEmail: $('mFbEmail').value || null,
    fbPassword: $('mFbPass').value || null,
    prodaUsername: $('mUsername').value || null,
    prodaPassword: $('mPassword').value || null,
    telegramToken: $('mToken').value || null,
    telegramChatId: $('mChatId').value || null,
    morningTime: $('mTimeH').value + ':' + $('mTimeM').value,
    mDays: [0, 1, 2, 3, 4, 5, 6].filter(d => $('mD' + d).checked),
    principleEmail: $('mPEmail').value || null,
    cellcastKey: $('mCellcast').value || null,
    principlePassword: $('mPPassword').value || null,
    enabled: $('mEnabled').checked,
  });
  if (res.ok) {
    $('mUsername').value = ''; $('mPassword').value = ''; $('mToken').value = ''; $('mFbPass').value = '';
    $('morningState').textContent = 'Saved (encrypted on this PC).';
    refreshMorningState();
  } else {
    $('morningState').innerHTML = `<span style="color:#b91c1c;">${esc(res.error || 'Could not save.')}</span>`;
  }
});

$('btnMorningTest').addEventListener('click', async () => {
  $('btnMorningTest').disabled = true;
  $('morningState').textContent = 'Testing Telegram...';
  const res = await window.cdbs.morningTestTelegram();
  $('btnMorningTest').disabled = false;
  if (res.ok) {
    if (res.chatId) $('mChatId').value = res.chatId;
    $('morningState').textContent = 'Sent! Check your phone for the test message.';
  } else {
    $('morningState').innerHTML = `<span style="color:#b91c1c;">${esc(res.error || 'Test failed.')}</span>`;
  }
});

$('btnFbTest').addEventListener('click', async () => {
  $('btnFbTest').textContent = 'Testing…';
  const r = await window.cdbs.fbAuthTest();
  $('btnFbTest').textContent = 'Test sign-in';
  alert(r.ok ? ('✓ Signed in to the cloud as ' + r.email + ' - this machine is ready for the rules change.') : ('✗ Sign-in failed: ' + r.error + '\n\nCheck the email and password, Save, and test again.'));
});

$('btnMorningNow').addEventListener('click', async () => {
  const ok = confirm(
    'Run the morning routine now?\n\n' +
    'It does the report + Medicare details, then messages your phone and waits for ' +
    'your YES before touching PRODA. Watch the Run the lot card for progress.'
  );
  if (!ok) return;
  const res = await window.cdbs.morningRunNow();
  $('morningState').textContent = res.ok
    ? 'Morning routine started - progress shows in the Run the lot card at the top.'
    : (res.error || 'Could not start.');
});

// ---------- Check one patient ----------
$('btnCheckOne').addEventListener('click', async () => {
  const number = $('cCard').value.trim();
  const irn = $('cIrn').value.trim();
  const firstName = $('cFirst').value.trim();
  if (!number || !irn || !firstName) {
    $('checkOneState').innerHTML = '<span class="pill bad">All three fields are needed</span>';
    return;
  }
  $('btnCheckOne').disabled = true;
  $('checkOneState').innerHTML = '<span class="pill pending">Results pending…</span>';
  $('checkOneResult').textContent = '';

  const res = await window.cdbs.checkOne({ number, irn, firstName });
  $('btnCheckOne').disabled = false;

  if (!res.ok) {
    $('checkOneState').innerHTML = `<span class="pill bad">${esc(res.error || 'Could not check.')}</span>`;
    return;
  }
  if (res.kind === 'balance') {
    $('checkOneState').innerHTML = `<span class="pill good" style="font-size:16px;">Balance: ${esc(res.value)}</span>`;
  } else if (res.kind === 'not-eligible') {
    $('checkOneState').innerHTML = '<span class="pill warnpill">Not eligible for CDBS</span>';
  } else {
    $('checkOneState').innerHTML = '<span class="pill bad">PRODA rejected the details — check them against the card</span>';
  }
  if (res.raw) $('checkOneResult').textContent = 'PRODA said: ' + res.raw;
});

window.cdbs.onCheckOneProgress((p) => {
  if (p && p.text) $('checkOneState').innerHTML = `<span class="pill pending">${esc(p.text)}</span>`;
});

// ---------- Run everything on a loaded file ----------
$('btnRunFile').addEventListener('click', async () => {
  if (!preview || !preview.items || !preview.items.length) {
    $('fileRunState').innerHTML = '<span class="pill bad">Choose a file first</span>';
    return;
  }
  const linked = preview.items.filter(i => i.patientId).length;
  const ok = confirm(
    'Run everything on this file?\n\n' +
    linked + ' patient' + (linked === 1 ? '' : 's') + ' with links will be looked up in Principle and checked in PRODA. ' +
    'Nothing is written to any file — it ends at the review table, and a call-list CSV is produced.'
  );
  if (!ok) return;
  $('fileRunState').innerHTML = '<span class="pill pending">Results pending…</span>';
  const res = await window.cdbs.runFile(preview.items);
  if (!res.ok && res.error) $('fileRunState').innerHTML = `<span class="pill bad">${esc(res.error)}</span>`;
});

// ---------- Status lights + the code box ----------
window.cdbs.onLoginStatus(({ status }) => {
  const el = $('lightPrinciple');
  if (status === 'connected') { el.className = 'pill good'; el.textContent = 'Principle: ready'; }
  else { el.className = 'pill warnpill'; el.textContent = 'Principle: needs login'; }
});

window.cdbs.onProdaLight((d) => {
  window.__codeBarOpen = (d.state === 'code');
  if (d.state === 'ready' || d.state === 'down' || d.state === 'code') lockModal(false);
  const el = $('lightProda');
  const bar = $('codeBar');
  if (d.state === 'connecting') { el.className = 'pill pending'; el.textContent = 'PRODA: connecting…'; show(bar, false); }
  else if (d.state === 'code') { el.className = 'pill warnpill'; el.textContent = 'PRODA: code needed'; show(bar, true); $('codeInput').value = ''; $('codeBarState').textContent = ''; $('codeInput').focus(); }
  else if (d.state === 'ready') { el.className = 'pill good'; el.textContent = 'PRODA: ready'; show(bar, false); }
  else if (d.state === 'idle') { el.className = 'pill pending'; el.textContent = 'PRODA: not connected'; el.style.animation = 'none'; show(bar, false); }
  else { el.className = 'pill bad'; el.textContent = 'PRODA: needs a hand'; show(bar, false); }
});

let __busyWas = false;
async function pollEngineBusy() {
  try {
    const b = await window.cdbs.engineBusy();
    let ov = document.getElementById('runModal');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'runModal';
      ov.style.cssText = 'position:fixed; inset:0; z-index:5000; display:none; align-items:center; justify-content:center; background:rgba(28,28,30,.55);';
      ov.innerHTML = `<div style="background:#fff; border-radius:18px; padding:26px 34px; max-width:460px; text-align:center; box-shadow:0 16px 60px rgba(0,0,0,.3);">
        <div style="font-size:26px;">⏳</div>
        <div id="runModalText" style="font-size:15.5px; font-weight:700; margin-top:8px;"></div>
        <div class="muted" style="margin-top:6px; font-size:13px;">Please leave the app alone until this finishes — buttons that touch Principle or PRODA are asleep. Ticks, notes and searches still work if you must.</div>
        <button id="btnModalStop" style="margin-top:16px; border:none; border-radius:99px; padding:8px 20px; background:#fdecec; color:#c0392b; cursor:pointer; font-weight:700;">Stop safely</button>
      </div>`;
      document.body.appendChild(ov);
      document.getElementById('btnModalStop').addEventListener('click', async () => {
        if (confirm('Stop the current run safely? Nothing partial is written.')) await window.cdbs.stopEverything();
      });
    }
    // When PRODA wants the 6-digit code, the modal steps aside so the
    // code box is reachable - it returns the moment the code is in.
    const needsCode = b.busy && (b.needsCode || window.__codeBarOpen || /6-digit code/i.test(b.stage || ''));
    ov.style.display = (b.busy && !needsCode) ? 'flex' : 'none';
    // Self-healing box: while the backend says a code is pending, the box
    // MUST be visible - whatever hid it (any stomper, known or future)
    // gets overruled every pulse. When no code is pending, a stray open
    // box with nothing typed closes itself.
    const bar2 = document.getElementById('codeBar');
    if (bar2) {
      if (b.needsCode && bar2.classList.contains('hidden')) {
        bar2.classList.remove('hidden');
        const ci = document.getElementById('codeInput');
        if (ci && document.activeElement !== ci) ci.focus();
      } else if (!b.needsCode && !bar2.classList.contains('hidden')) {
        const ci = document.getElementById('codeInput');
        if (!ci || !ci.value) bar2.classList.add('hidden');
      }
    }
    if (b.busy) document.getElementById('runModalText').textContent = 'Working: ' + (b.stage || 'a run is in progress');
    document.body.classList.toggle('engbusy', !!b.busy);
    if (__busyWas && !b.busy) {
      refreshBalMap().then(() => { refreshReactCdbs(false); refreshReact(false); });
    }
    __busyWas = !!b.busy;
  } catch (e) { /* ignore */ }
}
setInterval(pollEngineBusy, 5000);
// The code box gets a faster heartbeat of its own: within ~1.5s of a code
// becoming pending (or being supplied), the box's state matches reality.
setInterval(async () => {
  try {
    const b = await window.cdbs.engineBusy();
    const bar = document.getElementById('codeBar');
    if (!bar) return;
    if (b.needsCode && bar.classList.contains('hidden')) bar.classList.remove('hidden');
    if (b.needsCode && !bar.classList.contains('hidden')) {
      const ci = document.getElementById('codeInput');
      // Keep the cursor in the box while it's empty - focus theft by the
      // hidden automation windows gets undone every beat. Once typing has
      // started (value non-empty) the cursor is left alone.
      if (ci && !ci.value && document.activeElement !== ci) ci.focus();
    }
  } catch (e) { /* next beat */ }
}, 1500);
setTimeout(pollEngineBusy, 2500);

setInterval(() => {
  if (document.body.classList.contains('engbusy') && !document.getElementById('viewReactCdbs').classList.contains('hidden')) {
    refreshBalMap().then(() => refreshReactCdbs(false));
  }
}, 60 * 1000);

function lockModal(on, text) {
  let m = document.getElementById('modalLock');
  if (!m) {
    m = document.createElement('div');
    m.id = 'modalLock';
    m.style.cssText = 'position:fixed; inset:0; background:rgba(28,28,30,.45); z-index:9999; display:none; align-items:center; justify-content:center;';
    m.innerHTML = '<div style="background:#fff; border-radius:16px; padding:22px 30px; font-size:15px; font-weight:600; box-shadow:0 12px 40px rgba(0,0,0,.25);" id="modalLockText"></div>';
    document.body.appendChild(m);
  }
  document.getElementById('modalLockText').textContent = text || 'Checking the code with PRODA — hold on…';
  m.style.display = on ? 'flex' : 'none';
}

$('btnSupplyCode').addEventListener('click', async () => {
  lockModal(true);
  const res = await window.cdbs.supplyCode($('codeInput').value);
  if (!res.ok) $('codeBarState').textContent = res.error || 'That did not work.';
  else $('codeBarState').textContent = 'Code sent — carrying on.';
});
$('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnSupplyCode').click(); });

// ---------- Find a Medicare number ----------
let findItems = null;

$('btnFindOne').addEventListener('click', async () => {
  const p = { firstName: $('fFirst').value, surname: $('fSur').value, dob: $('fDob').value };
  if (!p.firstName.trim() || !p.surname.trim() || !p.dob.trim()) {
    $('findOneState').innerHTML = '<span class="pill bad">All three fields are needed</span>';
    return;
  }
  $('btnFindOne').disabled = true;
  $('findOneState').innerHTML = '<span class="pill pending">Results pending…</span>';
  $('findOneResult').innerHTML = '';
  const res = await window.cdbs.findNumber(p);
  $('btnFindOne').disabled = false;
  if (!res.ok) { $('findOneState').innerHTML = `<span class="pill bad">${esc(res.error)}</span>`; return; }
  if (!res.matches.length) {
    $('findOneState').innerHTML = '<span class="pill warnpill">No match — check the name and date of birth</span>';
    return;
  }
  $('findOneState').innerHTML = `<span class="pill good">${res.matches.length === 1 ? 'Found' : res.matches.length + ' matches'}</span>`;
  $('findOneResult').innerHTML = res.matches.map((m, i) => `
    <div class="info" style="margin-top:8px;">
      <strong>${esc(m.firstName || p.firstName)}</strong> — Medicare ${esc(m.cardNumber)} · IRN ${esc(m.irn || '?')} · expires ${esc(m.expiry || '?')}
      <button class="secondary" style="margin-left:10px;" data-check="${i}">Check this balance</button>
    </div>`).join('');
  for (const btn of $('findOneResult').querySelectorAll('button[data-check]')) {
    btn.addEventListener('click', () => {
      const m = res.matches[Number(btn.getAttribute('data-check'))];
      $('cCard').value = m.cardNumber; $('cIrn').value = m.irn || ''; $('cFirst').value = p.firstName.trim();
      $('btnCheckOne').click();
      $('cardCheckOne').scrollIntoView({ behavior: 'smooth' });
    });
  }
});

$('btnPickFind').addEventListener('click', async () => {
  const res = await window.cdbs.pickFindCsv();
  if (!res.ok) {
    if (!res.cancelled) $('findPreflight').innerHTML = `<span style="color:#c0392b;">${esc(res.error)}</span>`;
    return;
  }
  findItems = res.items;
  $('findPreflight').innerHTML = `<strong>${esc(res.file)}</strong>: ${res.count} patient${res.count === 1 ? '' : 's'} · ` +
    `${res.withDob} with DOB in the file · ${res.fetchable} will fetch DOB from Principle` +
    (res.unsearchable ? ` · <span style="color:#9a6b00;">${res.unsearchable} cannot be searched (no DOB and no link)</span>` : '') +
    (res.skippedNoName ? ` · ${res.skippedNoName} row(s) skipped (no name)` : '');
});

$('btnFindFile').addEventListener('click', async () => {
  if (!findItems || !findItems.length) {
    $('findFileState').innerHTML = '<span class="pill bad">Choose a list first</span>';
    return;
  }
  const ok = confirm('Search PRODA for ' + findItems.length + ' Medicare number' + (findItems.length === 1 ? '' : 's') + '?\n\nRoughly 20-30 seconds each. A found-numbers CSV comes out at the end.');
  if (!ok) return;
  $('findFileState').innerHTML = '<span class="pill pending">Results pending…</span>';
  const res = await window.cdbs.findFile(findItems);
  if (!res.ok && res.error) $('findFileState').innerHTML = `<span class="pill bad">${esc(res.error)}</span>`;
});

window.cdbs.onFindProgress((p) => {
  if (p && p.text) $('findFileState').innerHTML = `<span class="pill pending">${esc(p.text)}</span>`;
});

window.cdbs.onFindFinished((r) => {
  if (!r.ok) { $('findFileState').innerHTML = `<span class="pill bad">${esc(r.message || 'Did not finish.')}</span>`; return; }
  $('findFileState').innerHTML = `<span class="pill good">Done: ${r.found} found, ${r.noMatch} no match, ${r.check} need checking</span>`;
  if (r.file) {
    $('findPreflight').innerHTML = `<button class="secondary" id="btnOpenFound">Open the found-numbers CSV</button>`;
    $('btnOpenFound').addEventListener('click', () => window.cdbs.openFile(r.file));
  }
});

// ---------- Run log + per-card code prompt ----------
$('btnRunLog').addEventListener('click', async () => {
  const r = await window.cdbs.openRunLog();
  if (!r.ok) alert(r.error || 'No run log yet.');
});

// The code prompt appears inside whichever card started the current job.
let activeCardId = null;
for (const [btn, card] of [['btnCheckOne','cardCheckOne'], ['btnFindOne','cardFinder'], ['btnFindFile','cardFinder'], ['btnRunFile','stepUpload'], ['btnRunAll','cardRunAll'], ['btnMorningNow','cardRunAll']]) {
  const el = document.getElementById(btn);
  if (el) el.addEventListener('click', () => { activeCardId = card; }, true);
}
$('btnCodeCancel').addEventListener('click', async () => {
  await window.cdbs.supplyCode('__cancel__');
  await window.cdbs.stopAll();
  $('codeBar').classList.add('hidden');
});

// ---------- Action list ----------
function actionAge(iso) {
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d + ' days';
}
const PEND_LABELS = ['Denticare current', 'CDBS pending', 'DVA pending', 'Gov voucher pending'];
function pendDays(i) { return i.parkedAt ? Math.floor((Date.now() - Date.parse(i.parkedAt)) / 86400000) : 0; }

async function refreshActions(fresh = true) {
  const all0 = (await getItems(fresh)).filter(i => i.kind !== 'reactivation' && i.kind !== 'reactcdbs');   // reactivation lives on its own screens
  if (typingInside($('actionItems'))) return;   // never eat a half-written note
  const a = { items: all0, synced: __items.synced !== false };
  // The never-lie rule: an unreachable cloud is said out loud, not
  // rendered as an innocently empty list.
  const warn = __items.synced === false
    ? `<div style="background:#fdecec; color:#c0392b; border-radius:12px; padding:11px 14px; margin-bottom:10px; font-weight:600; font-size:13px;">⚠ Can't reach the shared list — showing this computer only. Items from other computers are invisible and changes here may not save.
        <button id="btnCloudRetry" style="margin-left:10px; border:none; border-radius:99px; padding:4px 13px; background:#c0392b; color:#fff; cursor:pointer; font-weight:600;">Retry</button></div>`
    : '';
  const cfgDoc = (a.items || []).find(i => i.id === '_viewsConfig') || {};
  const vCfg = { views: [], rules: {} };
  try { vCfg.views = JSON.parse(cfgDoc.viewsList || '[]'); } catch (e) { /* fresh */ }
  try { vCfg.rules = JSON.parse(cfgDoc.viewsRules || '{}'); } catch (e) { /* fresh */ }
  window.__vCfg = vCfg;
  if (!window.__vRestored) { window.__vRestored = true; try { window.__vWant = localStorage.getItem('sdtViewSel') || ''; } catch (e) { window.__vWant = ''; } }
  let filt = $('fAssign').value || window.__vWant || ''; window.__vWant = '';
  const all = (a.items || []).filter(i => i.id !== '_viewsConfig' && i.kind !== 'viewscfg');
  const namesAll = [...new Set(all.map(i => i.assignee).filter(Boolean))].sort();
  window.__vNames = namesAll;
  window.__vSecs = (() => {
    const pref = ['Urgent', 'CDBS', 'Confirm appts', 'Reception attention', 'Unpaid invoices', 'General', 'Routine', 'Checkouts', 'Rebook', 'Recalls', 'Complete notes', 'Huddle tags'];
    const found = [...new Set(all.map(i => i.section || 'CDBS'))];
    return [...pref.filter(s => found.includes(s)), ...found.filter(s => !pref.includes(s))];
  })();
  // Effective audience: a hand-set chip beats the section rule; '*' is an
  // explicit Everyone; tags naming a removed view are ignored so those
  // items fall back to showing everywhere (nothing can silently vanish).
  const vKnown = new Set([...vCfg.views, ...namesAll]);
  const effTags = (i) => {
    const m = String(i.viewsTag || '').trim();
    if (m === '*') return [];
    if (m) { const t = m.split(',').map(s => s.trim()).filter(s => vKnown.has(s)); return t; }
    return (vCfg.rules[i.section || 'CDBS'] || []).filter(s => vKnown.has(s));
  };
  window.__vEffTags = effTags;
  // Dentist views (a:) keep their assignment-driven behaviour: assigned
  // items always show, tags can only ADD items, never hide assigned work.
  // Custom views (v:) also show untagged items - the safety net.
  const inView = (i) => {
    if (!filt) return true;
    const n = filt.slice(2), t = effTags(i);
    if (filt.startsWith('a:')) return (i.assignee || '') === n || t.includes(n);
    return t.length === 0 || t.includes(n) || (i.assignee || '') === n;
  };
  const vwChip = (i) => {
    const t = effTags(i);
    const man = String(i.viewsTag || '').trim();
    const lab = t.length ? esc(t[0]) + (t.length > 1 ? ' +' + (t.length - 1) : '') : 'Everyone';
    return `<span class="chip" data-vwchip="${i.id}" title="Who sees this item — click to change${man ? '' : ' (following the section rule)'}" style="cursor:pointer;${man ? 'border:1px solid #b6b6bb;' : ''}">👁 ${lab}</span>`;
  };
  const todayIso = (() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();   // LOCAL date, not UTC
  // Scheduled items (a due date in the future) stay hidden until their
  // day arrives — a weekly VAC test surfaces each Monday, not all week.
  let open = all.filter(i => !i.doneAt && !(i.due && i.due > todayIso) && inView(i));
  const sched = all.filter(i => !i.doneAt && i.due && i.due > todayIso && inView(i))
    .sort((a, b) => String(a.due).localeCompare(String(b.due)));
  window.__schOpen = window.__schOpen || {};
  const done = all.filter(i => i.doneAt && (Date.now() - Date.parse(i.doneAt)) < ((i.kind === 'unpaid' ? 60 : 14) * 86400000));
  const badge = $('actionCount');
  const cardEl = document.getElementById('cardActions');
  if (!open.length) {
    badge.className = 'pill good'; badge.textContent = '✓ All sorted';
    if (cardEl) cardEl.style.borderLeftColor = 'transparent';
  } else {
    badge.className = 'pill warnpill'; badge.textContent = open.length + ' waiting';
    if (cardEl) cardEl.style.borderLeftColor = '#e2a93b';
  }
  // View dropdown: Everyone, then custom views, then dentists (assignees)
  const names = namesAll;
  $('fAssign').innerHTML = '<option value="">View: Everyone</option>'
    + vCfg.views.map(v => `<option value="v:${esc(v)}"${('v:' + v) === filt ? ' selected' : ''}>${esc(v)}</option>`).join('')
    + names.map(n => `<option value="a:${esc(n)}"${('a:' + n) === filt ? ' selected' : ''}>${esc(n)}</option>`).join('');
  if ($('fAssign').value !== filt) { $('fAssign').value = ''; filt = ''; }
  renderViewsBox(vCfg, names);

  const today = new Date().toISOString().slice(0, 10);
  const stagePills = (i) => `
    <span style="display:inline-flex; gap:6px; margin-right:6px;">
      <label style="display:inline-flex; align-items:center; gap:5px; background:${i.stageDentist ? '#e6f4ec' : '#f2f2f5'}; border-radius:99px; padding:4px 11px; font-size:12px; font-weight:600; color:${i.stageDentist ? '#1d7a46' : '#6e6e73'}; cursor:pointer;">
        <input type="checkbox" data-stage="${i.id}:dentist" ${i.stageDentist ? 'checked' : ''} style="width:14px; height:14px;">Dentist</label>
      <label style="display:inline-flex; align-items:center; gap:5px; background:${i.stageReception ? '#e6f4ec' : '#f2f2f5'}; border-radius:99px; padding:4px 11px; font-size:12px; font-weight:600; color:${i.stageReception ? '#1d7a46' : '#6e6e73'}; cursor:pointer;">
        <input type="checkbox" data-stage="${i.id}:reception" ${i.stageReception ? 'checked' : ''} style="width:14px; height:14px;">Reception</label>
    </span>`;

  const rowHtml = (i) => {
    const stale = (Date.now() - Date.parse(i.createdAt)) / 86400000 > 3;
    const overdue = i.due && i.due < today;
    const when = i.due
      ? `<span class="${overdue ? 'due-over' : ''}">due ${i.due === today ? 'today' : i.due}${overdue ? ' — overdue' : ''}</span>`
      : `<span style="${stale ? 'color:#9a6b00;font-weight:600;' : ''}">waiting ${actionAge(i.createdAt)}</span>`;
    const twoStage = (i.kind === 'checkout' || i.kind === 'rebook' || i.kind === 'recall');
    const halfDone = twoStage && (i.stageDentist || i.stageReception);
    const ovd = i.kind === 'unpaid' && i.escalated && !i.doneAt;
    return `<div class="row" style="align-items:flex-start; padding:13px 0 13px 8px; border-bottom:1px solid #f0f0f3; ${halfDone ? 'background:#fafdfb; border-radius:10px;' : ''}${ovd ? 'background:#fdf5f5; border-left:3px solid #c0392b; border-radius:10px;' : ''}">
      ${twoStage ? stagePills(i) : `<input type="checkbox" data-tick="${i.id}" style="width:20px; height:20px; margin-top:2px;">`}
      <div style="flex:1;">
        <div style="font-size:14.5px;"><strong>${esc(i.name)}</strong>${i.text ? ' <span style="color:#3c3c43;">— ' + esc(i.text) + '</span>' : ''}
          ${i.assignee ? `<span class="chip">${esc(i.assignee)}</span>` : ''}
          ${vwChip(i)}
          ${i.repeat ? `<span class="chip" title="repeats ${esc(i.repeat)}">↻</span>` : ''}
          ${twoStage && !i.stageDentist ? '<span class="chip" style="background:#fff4e0; color:#9a6b00;">needs dentist</span>' : ''}
          ${i.howTo ? `<a href="#" data-howto="${esc(i.howTo)}" class="chip" style="background:#eef2ff; color:#5e5ce6; text-decoration:none;">How to ↗</a>` : ''}</div>
        <div class="muted" style="margin-top:3px;">${esc(i.context || '')}${i.context ? ' · ' : ''}${when}</div>
      </div>
      <input type="text" data-note="${i.id}" value="${esc(i.noteText || '')}" placeholder="note…" style="width:140px; font-size:12px; padding:6px 10px;">
      ${i.kind === 'unpaid' ? `<select data-park="${i.id}" style="font:inherit; font-size:11px; border:1px solid #d2d2d7; border-radius:8px; padding:5px;"><option value="">Park as… ▾</option>${PEND_LABELS.map(L => `<option>${esc(L)}</option>`).join('')}</select>` : ''}
      ${i.patientId && !String(i.patientId).startsWith('name:')
        ? `<button class="secondary engbtn" data-pinp="${i.id}" title="Write this note into their Principle file and pin it" style="font-size:11px; padding:5px 10px;">→ Principle</button>`
        : `<button class="secondary" disabled title="No Principle link on this item" style="font-size:11px; padding:5px 10px; opacity:.4;">→ Principle</button>`}
      <button class="secondary" data-del="${i.id}" title="Delete completely" style="padding:6px 12px;">✕</button>
    </div>`;
  };

  // Sections are discovered from the items themselves, preferred order
  // first, so new automations' sections appear without a UI change.
  const preferred = ['Urgent', 'CDBS', 'Confirm appts', 'Reception attention', 'Unpaid invoices', 'General', 'Routine', 'Checkouts', 'Rebook'];   // urgent first, dentist sections last
  const parkedAll = open.filter(i => i.parked);
  open = open.filter(i => !i.parked);
  const doneF = done.filter(inView);
  const found = [...new Set([...open, ...sched, ...doneF, ...parkedAll].map(i => i.section || 'CDBS'))];
  const sections = [...preferred.filter(s => found.includes(s)), ...found.filter(s => !preferred.includes(s))];
  const bySection = s => open.filter(i => (i.section || 'CDBS') === s);
  const SEC_COLOR = { 'Urgent': '#ff3b30', 'CDBS': '#2F6B4F', 'Confirm appts': '#e2a93b', 'Checkouts': '#3478f6', 'Reception attention': '#af52de', 'Rebook': '#30b0c7', 'Unpaid invoices': '#bf5af2', 'Routine': '#5e5ce6', 'General': '#8e8e93', 'Recalls': '#ff9f0a', 'Complete notes': '#7a5af5', 'Huddle tags': '#0d9488' };
  window.__secCollapsed = window.__secCollapsed || {};
  let upcomingHtml = '';
  if (sched.length) {
    const upOpen = window.__secCollapsed['__up'] === undefined ? false : !window.__secCollapsed['__up'];
    const upRows = sched.map(i => {
      const d = new Date(i.due + 'T00:00');
      const w = d.toLocaleDateString('en-AU', { weekday: 'short', day: '2-digit', month: '2-digit' });
      const col2 = SEC_COLOR[i.section || 'General'] || '#8e8e93';
      return `<div class="row" style="padding:9px 0 9px 8px; border-bottom:1px solid #f5f5f7;">
        <input type="checkbox" data-tick="${i.id}" title="Tick early — the schedule stays anchored to its dates" style="width:20px; height:20px; margin-top:2px;">
        <span class="muted" style="min-width:86px;">${w}</span>
        <div style="flex:1;"><strong>${esc(i.name)}</strong>
          <span class="chip" style="background:${col2}1c; color:${col2};">${esc(i.section || 'General')}</span>
          ${i.repeat ? `<span class="chip">↻ ${esc(i.repeat)}</span>` : ''}${i.chaseFlag ? `<span class="chip" style="background:#fdecec; color:#c0392b; font-weight:700;">⚠ ${esc(i.chaseFlag)}</span>` : ''}
          ${i.howTo ? `<a href="#" data-howto="${esc(i.howTo)}" class="chip" style="background:#eef2ff; color:#5e5ce6; text-decoration:none;">How to ↗</a>` : ''}</div>
        <button class="secondary" data-del="${i.id}" style="padding:6px 12px;">✕</button>
      </div>`;
    }).join('');
    upcomingHtml = `<details class="dept" data-sec="__up" ${upOpen ? 'open' : ''} style="margin-top:6px;">
      <summary style="font-size:17px; font-weight:700; letter-spacing:-.2px; padding:12px 0;">
        <span class="ci" style="display:inline-block; width:18px; color:#8e8e93; font-weight:600;"></span>Upcoming
        <span class="chip" style="background:#f2f2f5; color:#6e6e73; font-size:12px; margin-left:8px;">${sched.length}</span>
      </summary>${upRows}</details>`;
  }
  $('actionItems').innerHTML = warn + (open.length ? sections.map(s => {
    const items = bySection(s);
    const col = SEC_COLOR[s] || '#8e8e93';
    const schItems = sched.filter(i => (i.section || 'CDBS') === s);
    const schRows = window.__schOpen[s] ? schItems.map(i => {
      const d = new Date(i.due + 'T00:00');
      const when2 = d.toLocaleDateString('en-AU', { weekday: 'short', day: '2-digit', month: '2-digit' });
      return `<div class="row" style="opacity:.55; padding:8px 0 8px 26px; border-bottom:1px solid #f5f5f7;">
        <span class="muted" style="min-width:86px;">${when2}</span>
        <div style="flex:1;"><strong>${esc(i.name)}</strong>
          ${i.repeat ? `<span class="chip" title="repeats ${esc(i.repeat)}">↻ ${esc(i.repeat)}</span>` : ''}
          ${i.howTo ? `<a href="#" data-howto="${esc(i.howTo)}" class="chip" style="background:#eef2ff; color:#5e5ce6; text-decoration:none;">How to ↗</a>` : ''}</div>
        <button class="secondary" data-del="${i.id}" title="Delete this scheduled task" style="padding:6px 12px;">✕</button>
      </div>`;
    }).join('') : '';
    window.__doneOpen = window.__doneOpen || {};
    window.__pendOpen = window.__pendOpen || {};
    const secParked = parkedAll.filter(i => (i.section || 'CDBS') === s);
    const pendPills = PEND_LABELS.map(L => {
      const tenants = secParked.filter(i => i.parked === L);
      if (!tenants.length) return '';
      const hot = tenants.some(i => pendDays(i) >= 30);
      const on = window.__pendOpen[s] === L;
      return `<span class="chip" data-pendtoggle="${esc(s)}|${esc(L)}" style="background:${hot ? '#fdecec' : '#f2f2f5'}; color:${hot ? '#c0392b' : '#6e6e73'}; font-size:12px; cursor:pointer;">${esc(L)} ${tenants.length} ${on ? '▾' : '▸'}</span>`;
    }).join('');
    const pendViewLabel = window.__pendOpen[s];
    const pendTenants = pendViewLabel ? secParked.filter(i => i.parked === pendViewLabel)
      .sort((x, y) => String(x.parkedAt || '').localeCompare(String(y.parkedAt || ''))) : [];
    const pendRows = pendViewLabel
      ? `<div class="muted" style="padding:6px 0 2px 8px; font-size:12px;">Showing ${esc(pendViewLabel)} — click the pill again for the live list. These auto-move to Done when they drop off the daily unpaid report; at 45 days they come back flagged for chasing.</div>`
        + (pendTenants.map(i => {
            const d = pendDays(i);
            return `<div class="row" style="padding:8px 0 8px 12px; border-bottom:1px solid #f6f6f8;">
              <div style="flex:1;"><strong>${esc(i.name)}</strong>${i.context ? ' <span class="muted" style="font-size:12px;">' + esc(i.context) + '</span>' : ''}
                <span class="chip" style="background:${d >= 30 ? '#fdecec' : '#f2f2f5'}; color:${d >= 30 ? '#c0392b' : '#6e6e73'};">${esc(i.parked)} since ${new Date(i.parkedAt).toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit' })}${d >= 30 ? ' — ' + d + ' days' : ''}</span>
              </div>
              <button class="secondary" data-unpark="${i.id}" style="font-size:11px; padding:5px 11px;">↩ Return to list</button>
            </div>`;
          }).join('') || '<div class="muted" style="padding:8px;">None here.</div>')
      : '';
    const doneItems = doneF.filter(i => (i.section || 'CDBS') === s)
      .sort((x, y) => String(y.doneAt).localeCompare(String(x.doneAt)));
    const doneRows = window.__doneOpen[s] ? doneItems.map(i => `
      <div class="muted" style="padding:6px 0 6px 26px; border-bottom:1px solid #f6f6f8;">
        <s>${esc(i.name)}${i.text ? ' — ' + esc(i.text) : ''}</s> ${i.doneNote ? '· "' + esc(i.doneNote) + '"' : ''}
        <label style="float:right; font-size:11px;"><input type="checkbox" data-tick="${i.id}" checked> undo</label>
        <button class="secondary" data-del="${i.id}" title="Delete completely" style="float:right; font-size:11px; padding:2px 8px; margin-right:8px;">✕</button>
      </div>`).join('') : '';
    const needsDent = items.filter(i => (i.kind === 'checkout' || i.kind === 'rebook' || i.kind === 'recall') && !i.stageDentist).length;
    const overdueN = items.filter(i => i.kind === 'unpaid' && i.escalated).length;
    const isOpen = window.__secCollapsed[s] === undefined ? (s === 'Urgent') : !window.__secCollapsed[s];   // clean by default; Urgent demands eyes
    return `<details class="dept" data-sec="${esc(s)}" ${isOpen ? 'open' : ''} style="margin-top:6px;">
      <summary style="font-size:17px; font-weight:700; letter-spacing:-.2px; padding:12px 0;">
        <span class="ci" style="display:inline-block; width:18px; color:#8e8e93; font-weight:600;"></span>${s}
        <span class="chip" style="background:${items.length ? '#fdecec' : '#e6f4ec'}; color:${items.length ? '#c0392b' : '#1d7a46'}; font-size:12px; margin-left:8px;">${items.length}</span>
        ${needsDent ? `<span class="chip" style="background:#fff4e0; color:#9a6b00; font-size:12px;">${needsDent} need dentist</span>` : ''}
        ${overdueN ? `<span class="chip" style="background:#fdecec; color:#c0392b; font-size:12px;">${overdueN} overdue 50d+</span>` : ''}
        ${schItems.length ? `<span class="chip" data-schtoggle="${esc(s)}" style="background:#f2f2f5; color:#6e6e73; font-size:12px; cursor:pointer;">${schItems.length} scheduled ${window.__schOpen[s] ? '▾' : '▸'}</span>` : ''}
        ${pendPills}
        ${doneItems.length ? `<span class="chip" data-donetoggle="${esc(s)}" style="background:#e6f4ec; color:#1d7a46; font-size:12px; cursor:pointer;">${doneItems.length} done ${window.__doneOpen[s] ? '▾' : '▸'}</span>` : ''}
      </summary>${window.__doneOpen[s]
        ? (`<div class="muted" style="padding:6px 0 2px 8px; font-size:12px;">Showing done items — click the green pill again for the live list.</div>` + (doneRows || '<div class="muted" style="padding:8px;">None in the window.</div>'))
        : (pendViewLabel ? pendRows : items.map(rowHtml).join('') + schRows)}</details>`;
  }).join('') + upcomingHtml : (upcomingHtml || '<div class="muted">Nothing waiting — all sorted.</div>'));


  for (const d of document.querySelectorAll('details.dept')) {
    d.addEventListener('toggle', () => { window.__secCollapsed[d.getAttribute('data-sec')] = !d.open; });
  }
}

// One permanent set of delegated listeners on the container — clicks land
// even if a background sync redraws the list mid-press (the double-press bug).
(function wireActionDelegation() {
  const box = document.getElementById('actionItems');
  const handleClick = async (e) => {
    const pn = e.target.closest('button[data-pinp]');
    if (pn) {
      const id = pn.getAttribute('data-pinp');
      const noteEl = document.querySelector(`input[data-note="${id}"]`);
      const text = noteEl ? noteEl.value.trim() : '';
      if (!text) { alert('Type the note in the box first, then press → Principle.'); return; }
      pn.textContent = 'Writing…'; pn.disabled = true;
      const r = await window.cdbs.actionPinNote({ id, text });
      pn.disabled = false; pn.textContent = '→ Principle';
      if (r.ok) { pn.textContent = '✓ queued'; pn.title = 'Sending in the background - it lands in Principle within a minute or so'; setTimeout(() => { pn.textContent = '→ Principle'; }, 4000); }
      else alert(r.error || 'Could not write the note.');
      return;
    }
    const cr = e.target.closest('#btnCloudRetry');
    if (cr) { cr.textContent = 'Retrying…'; refreshActions(true); return; }
    const pt = e.target.closest('[data-pendtoggle]');
    if (pt) {
      e.preventDefault(); e.stopPropagation();
      const parts = pt.getAttribute('data-pendtoggle').split('|');
      const s2 = parts[0], L = parts[1];
      window.__pendOpen = window.__pendOpen || {};
      window.__pendOpen[s2] = window.__pendOpen[s2] === L ? null : L;
      if (window.__doneOpen) window.__doneOpen[s2] = false;
      if (window.__secCollapsed) window.__secCollapsed[s2] = false;
      refreshActions(false);
      return;
    }
    const up = e.target.closest('button[data-unpark]');
    if (up) {
      await window.cdbs.actionPark({ id: up.getAttribute('data-unpark'), label: null });
      refreshActions(true);
      return;
    }
    const dn = e.target.closest('[data-donetoggle]');
    if (dn) {
      e.preventDefault(); e.stopPropagation();
      const s = dn.getAttribute('data-donetoggle');
      window.__doneOpen = window.__doneOpen || {};
      window.__doneOpen[s] = !window.__doneOpen[s];
      if (window.__secCollapsed) window.__secCollapsed[s] = false;
      refreshActions(false);
      return;
    }
    const sch = e.target.closest('[data-schtoggle]');
    if (sch) {
      e.preventDefault(); e.stopPropagation();
      const s = sch.getAttribute('data-schtoggle');
      window.__schOpen[s] = !window.__schOpen[s];
      if (window.__secCollapsed) window.__secCollapsed[s] = false;   // opening the ghosts opens the section
      refreshActions();
      return;
    }
    const how = e.target.closest('a[data-howto]');
    if (how) { e.preventDefault(); window.cdbs.openExternal(how.getAttribute('data-howto')); return; }
    const vwc = e.target.closest('span[data-vwchip]');
    if (vwc) { e.preventDefault(); openViewsEditor(vwc.getAttribute('data-vwchip')); return; }
    const del = e.target.closest('button[data-del]');
    if (del) {
      if (!confirm('Delete this item completely? It will not come back unless a future run re-finds it.')) return;
      await window.cdbs.actionDelete({ id: del.getAttribute('data-del') });
      refreshActions();
    }
  };
  const handleChange = async (e) => {
    const t = e.target;
    if (t.matches('input[data-stage]')) {
      const [id, stage] = t.getAttribute('data-stage').split(':');
      t.disabled = true;                                     // instant feedback
      const row = t.closest('.row'); if (row) row.style.opacity = '0.45';
      await window.cdbs.actionStage({ id, stage, on: t.checked });
      refreshActions();
    } else if (t.matches('input[data-tick]')) {
      const id = t.getAttribute('data-tick');
      t.disabled = true;                                     // instant feedback
      const row = t.closest('.row') || t.closest('div'); if (row) row.style.opacity = '0.45';
      const noteEl = document.querySelector(`input[data-note="${id}"]`);
      await window.cdbs.actionTick({ id, note: noteEl ? noteEl.value : '' });
      refreshActions();
    } else if (t.matches('select[data-park]')) {
      const label = t.value;
      if (label) {
        await window.cdbs.actionPark({ id: t.getAttribute('data-park'), label });
        refreshActions(true);
      }
    } else if (t.matches('input[data-note]')) {
      await window.cdbs.actionNote({ id: t.getAttribute('data-note'), note: t.value });
    }
  };
  for (const el of [box]) {
    el.addEventListener('click', handleClick);
    el.addEventListener('change', handleChange);
  }
})();
refreshActions();
window.cdbs.onActionsChanged(() => refreshActions());

// ---------- Share the Action list page ----------
$('btnShareCopy').addEventListener('click', async () => {
  const html = await window.cdbs.shareHtmlGet();
  await navigator.clipboard.writeText(html);
  $('shareState').textContent = 'Copied — paste into Notepad and save as .html, or straight into an email.';
  setTimeout(() => { $('shareState').textContent = ''; }, 6000);
});
$('btnShareSave').addEventListener('click', async () => {
  const r = await window.cdbs.shareHtmlSave();
  $('shareState').textContent = r.ok ? 'Saved — send that file to whoever works the list.' : '';
});


// ---------- Sidebar navigation ----------
function showView(which) {
  $('viewHome').classList.toggle('hidden', which !== 'home');
  $('viewCdbs').classList.toggle('hidden', which !== 'cdbs');
  $('navHome').classList.toggle('active', which === 'home');
  $('navCdbs').classList.toggle('active', which === 'cdbs');
}
$('navHome').addEventListener('click', () => showView('home'));
$('navCdbs').addEventListener('click', () => showView('cdbs'));

$('fAssign').addEventListener('change', () => {
  try { localStorage.setItem('sdtViewSel', $('fAssign').value || ''); } catch (e) { /* fine */ }
  refreshActions();
});

// ---------- Views: shared audience picker ----------
// One panel for everything: item chips AND section rules. Nothing writes
// until Save is pressed - one atomic change, no live toggling, and the
// open panel is never rebuilt underneath a tap (the glitch fix).
function openAudiencePicker(opts) {
  const old = document.getElementById('vwOverlay'); if (old) old.remove();
  const od = document.createElement('div');
  od.id = 'vwOverlay';
  od.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:999;display:flex;align-items:center;justify-content:center;';
  od.innerHTML = `<div style="background:#fff;border-radius:16px;padding:18px;max-width:340px;width:92%;max-height:72%;overflow:auto;box-shadow:0 8px 30px rgba(0,0,0,.2);">
    <div style="font-weight:700;margin-bottom:4px;">${esc(opts.title)}</div>
    ${opts.subtitle ? `<div class="muted" style="font-size:12px;margin-bottom:10px;">${esc(opts.subtitle)}</div>` : ''}
    ${opts.options.length
      ? opts.options.map(o => `<label style="display:flex;gap:8px;align-items:center;padding:6px 0;font-size:13.5px;"><input type="checkbox" data-vwopt="${esc(o)}" ${opts.selected.includes(o) ? 'checked' : ''} style="width:17px;height:17px;"> ${esc(o)}</label>`).join('')
      : '<div class="muted">No views yet — add one with ＋ in Advanced tools → Views.</div>'}
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
      <button id="vwSaveBtn">Save</button>
      ${opts.ruleButton ? '<button id="vwRuleBtn" class="secondary">Use section rule</button>' : ''}
      <button id="vwCancelBtn" class="secondary">Cancel</button>
    </div>
    <div class="muted" style="margin-top:9px;font-size:11.5px;">${esc(opts.footer || 'No boxes ticked = Everyone.')}</div>
  </div>`;
  document.body.appendChild(od);
  od.addEventListener('click', (e) => { if (e.target === od) od.remove(); });
  document.getElementById('vwCancelBtn').onclick = () => od.remove();
  if (opts.ruleButton) document.getElementById('vwRuleBtn').onclick = () => { od.remove(); opts.onUseRule(); };
  document.getElementById('vwSaveBtn').onclick = () => {
    const picked = [...od.querySelectorAll('input[data-vwopt]')].filter(c => c.checked).map(c => c.getAttribute('data-vwopt'));
    od.remove(); opts.onSave(picked);
  };
}
function askText(title) {
  return new Promise((resolve) => {
    const old = document.getElementById('vwOverlay'); if (old) old.remove();
    const od = document.createElement('div');
    od.id = 'vwOverlay';
    od.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:999;display:flex;align-items:center;justify-content:center;';
    od.innerHTML = `<div style="background:#fff;border-radius:16px;padding:18px;max-width:320px;width:92%;box-shadow:0 8px 30px rgba(0,0,0,.2);">
      <div style="font-weight:700;margin-bottom:10px;">${esc(title)}</div>
      <input type="text" id="vwAskInp" style="width:100%;box-sizing:border-box;" placeholder="e.g. Nurse">
      <div style="display:flex;gap:8px;margin-top:12px;"><button id="vwAskOk">Add</button><button id="vwAskNo" class="secondary">Cancel</button></div>
    </div>`;
    document.body.appendChild(od);
    const fin = (v) => { od.remove(); resolve(v); };
    od.addEventListener('click', (e) => { if (e.target === od) fin(null); });
    const inp = document.getElementById('vwAskInp');
    inp.focus();
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') fin(inp.value); if (e.key === 'Escape') fin(null); });
    document.getElementById('vwAskOk').onclick = () => fin(inp.value);
    document.getElementById('vwAskNo').onclick = () => fin(null);
  });
}
async function openViewsEditor(id) {
  const a = await window.cdbs.actionGet();
  const it = (a.items || []).find(x => x.id === id);
  if (!it) return;
  const vCfg = window.__vCfg || { views: [], rules: {} };
  const options = [...vCfg.views, ...(window.__vNames || []).filter(n => !vCfg.views.includes(n))];
  const man = String(it.viewsTag || '').trim();
  const manual = man && man !== '*' ? man.split(',').map(s => s.trim()) : [];
  const ruleT = (vCfg.rules[it.section || 'CDBS'] || []);
  openAudiencePicker({
    title: 'Who sees this item',
    subtitle: it.name + (man ? '' : ' — following the section rule'),
    options, selected: man ? manual : ruleT,
    ruleButton: true,
    footer: 'No boxes ticked = Everyone. The assigned dentist always sees their items regardless of tags.',
    onUseRule: async () => { await window.cdbs.actionViewsTag({ id, tag: '' }); refreshActions(true); },
    onSave: async (picked) => { await window.cdbs.actionViewsTag({ id, tag: picked.length ? picked.join(',') : '*' }); refreshActions(true); },
  });
}

// ---------- Views: manage views + section rules (Advanced tools) ----------
async function saveViewsCfg(vCfg) {
  await window.cdbs.viewsConfigSet({ views: vCfg.views, rules: vCfg.rules });
  refreshActions(true);
}
function renderViewsBox(vCfg, names) {
  const selEl = document.getElementById('vwSelMgr'), rulesEl = document.getElementById('vwRules');
  if (!selEl || !rulesEl) return;
  if (document.getElementById('vwOverlay')) return;           // never rebuild under an open panel
  const sig = JSON.stringify([vCfg.views, vCfg.rules, names, window.__vSecs || []]);
  if (rulesEl.dataset.sig === sig) return;                    // nothing changed - leave handlers alone
  rulesEl.dataset.sig = sig;
  const keep = selEl.value;
  selEl.innerHTML = vCfg.views.length
    ? vCfg.views.map(v => `<option${v === keep ? ' selected' : ''}>${esc(v)}</option>`).join('')
    : '<option value="">no views yet</option>';
  const secs = window.__vSecs || [];
  const opts = [...vCfg.views, ...names.filter(n => !vCfg.views.includes(n))];
  rulesEl.innerHTML = secs.map(s => {
    const cur = vCfg.rules[s] || [];
    const lab = cur.length ? esc(cur[0]) + (cur.length > 1 ? ' +' + (cur.length - 1) : '') : 'Everyone';
    return `<div class="row" style="padding:7px 0;border-bottom:1px solid #f5f5f7;align-items:center;">
      <span style="flex:1;font-weight:600;font-size:13px;">${esc(s)}</span>
      <button class="secondary" data-vwrule="${esc(s)}" style="font-size:12px;padding:6px 12px;">Seen by: ${lab} ▾</button>
    </div>`;
  }).join('') || '<div class="muted">Sections appear here once the list has items.</div>';
  rulesEl.querySelectorAll('button[data-vwrule]').forEach(el => el.onclick = () => {
    const s = el.getAttribute('data-vwrule');
    openAudiencePicker({
      title: 'Who sees: ' + s,
      subtitle: 'Applies to every current and future item in this section (👁 chips on items override it).',
      options: opts, selected: vCfg.rules[s] || [],
      footer: 'No boxes ticked = Everyone.',
      onSave: (picked) => {
        if (picked.length) vCfg.rules[s] = picked; else delete vCfg.rules[s];
        saveViewsCfg(vCfg);
      },
    });
  });
}
(() => {
  const btnAdd = document.getElementById('btnVwAdd'), btnDel = document.getElementById('btnVwDel'), selEl = document.getElementById('vwSelMgr');
  if (!btnAdd || !btnDel || !selEl) return;
  btnAdd.addEventListener('click', async () => {
    const v0 = await askText('Name the new view');
    const v = (v0 || '').trim().slice(0, 40);
    if (!v) return;
    const vCfg = window.__vCfg || { views: [], rules: {} };
    if (!vCfg.views.includes(v)) { vCfg.views.push(v); await saveViewsCfg(vCfg); }
    selEl.value = v;
  });
  btnDel.addEventListener('click', async () => {
    const v = selEl.value;
    if (!v) return;
    if (!confirm('Delete the view "' + v + '"? Items tagged only to it will show in every view again.')) return;
    const vCfg = window.__vCfg || { views: [], rules: {} };
    vCfg.views = vCfg.views.filter(x => x !== v);
    for (const s of Object.keys(vCfg.rules)) {
      vCfg.rules[s] = (vCfg.rules[s] || []).filter(x => x !== v);
      if (!vCfg.rules[s].length) delete vCfg.rules[s];
    }
    await saveViewsCfg(vCfg);
  });
})();



// ---------- Auto Reports ----------
function showView2(which) {
  for (const [v, n] of [['viewHome','navHome'], ['viewReact','navReact'], ['viewReactCdbs','navReactCdbs'], ['viewAuto','navAuto'], ['viewCdbs','navCdbs']]) {
    document.getElementById(v).classList.toggle('hidden', which !== v);
    document.getElementById(n).classList.toggle('active', which === v);
  }
}
$('navHome').addEventListener('click', () => showView2('viewHome'));
function showAutoTab(which) {
  $('tabReports').classList.toggle('hidden', which !== 'reports');
  $('tabSms').classList.toggle('hidden', which !== 'sms');
  $('tabBtnReports').className = which === 'reports' ? 'primary' : 'secondary';
  $('tabBtnSms').className = which === 'sms' ? 'primary' : 'secondary';
}
$('tabBtnReports').addEventListener('click', () => showAutoTab('reports'));
$('tabBtnSms').addEventListener('click', () => showAutoTab('sms'));
window.cdbs.onRunallLive((p) => {
  const el = p && p.group === 'sms' ? $('raLiveSms') : $('raLiveReports');
  if (!el) return;
  el.textContent = p.text || '';
  el.dataset.running = p.done ? '' : '1';
  if (p.done) setTimeout(refreshAuto, 2500);
});
$('navAuto').addEventListener('click', () => { showView2('viewAuto'); refreshAuto(); });
$('navCdbs').addEventListener('click', () => showView2('viewCdbs'));

const DAY_LABELS = ['S','M','T','W','T','F','S'];
(async () => {
  try {
    const s = await window.cdbs.autoGet();
    $('runAllSchedOn').checked = !!s.runAllEnabled;
    $('runAllTime').value = s.runAllTime || '08:30';
    $('smsRunAllSchedOn').checked = !!s.smsRunAllEnabled;
    $('smsRunAllTime').value = s.smsRunAllTime || '10:45';
  } catch (e) { /* first paint */ }
})();
(async () => { try { const b = await window.cdbs.appBuild(); $('buildBadge').textContent = 'build ' + b.build; } catch (e) { $('buildBadge').textContent = 'build ?'; } })();

(async () => { try { const fr = await window.cdbs.fleetRole(); if (fr.publisher) $('btnFleetPublish').classList.remove('hidden'); } catch (e) { /* stays hidden */ } })();

$('btnFleetPublish').addEventListener('click', async () => {
  $('debugLinkMsg').textContent = 'Uploading this build for the fleet\u2026';
  try {
    const r = await window.cdbs.fleetPublish();
    $('debugLinkMsg').textContent = r.ok
      ? ('Published build ' + r.build + ' (' + r.files + ' files). Every other computer updates itself next time it starts.')
      : ('Publish failed: ' + r.error);
  } catch (e) { $('debugLinkMsg').textContent = 'Publish failed - check the journal.'; }
});

$('btnEditDebugTpl').addEventListener('click', async () => {
  const r = await window.cdbs.debugTemplateGet();
  $('tplText').value = r.template;
  $('tplState').textContent = r.isCustom ? 'custom template in use' : 'default template';
  $('tplMsg').textContent = '';
  $('tplPanel').style.display = 'block';
});
$('btnTplClose').addEventListener('click', () => { $('tplPanel').style.display = 'none'; });
$('btnTplSave').addEventListener('click', async () => {
  await window.cdbs.debugTemplateSave({ template: $('tplText').value });
  $('tplState').textContent = 'custom template in use';
  $('tplMsg').textContent = 'Saved - Copy debug prompt now uses this.';
});
$('btnTplReset').addEventListener('click', async () => {
  if (!confirm('Throw away your edits and go back to the built-in template?')) return;
  await window.cdbs.debugTemplateSave({ reset: true });
  const r = await window.cdbs.debugTemplateGet();
  $('tplText').value = r.template;
  $('tplState').textContent = 'default template';
  $('tplMsg').textContent = 'Reset to default.';
});

$('btnAdvTools').addEventListener('click', () => {
  showView2('viewCdbs');
  const adv = document.getElementById('advancedTools');
  if (adv) { adv.open = true; adv.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
});

$('btnDebugPrompt').addEventListener('click', async () => {
  $('debugLinkMsg').textContent = 'Building prompt…';
  try {
    const r = await window.cdbs.debugPrompt();
    await navigator.clipboard.writeText(r.prompt);
    $('debugLinkMsg').textContent = 'Prompt copied (' + r.machine + ', build ' + r.build + ') - paste into any AI, then fill in FEATURE and SYMPTOM.';
  } catch (e) { $('debugLinkMsg').textContent = 'Could not build the prompt - check the journal.'; }
});

$('btnDebugLink').addEventListener('click', async () => {
  $('debugLinkMsg').textContent = 'Fetching…';
  try {
    const r = await window.cdbs.debugFeedLink();
    await navigator.clipboard.writeText(r.url);
    $('debugLinkMsg').textContent = 'Copied! (' + r.machine + ', build ' + r.build + ')';
  } catch (e) { $('debugLinkMsg').textContent = 'Could not fetch the link - check the journal.'; }
});

$('btnRunHistory').addEventListener('click', async () => {
  const pan = $('histPanel');
  pan.style.display = 'block';
  $('histBody').innerHTML = '<div class="muted">Loading…</div>';
  const r = await window.cdbs.runHistory();
  if (!r.hist || !r.hist.length) { $('histBody').innerHTML = '<div class="muted">No runs recorded yet - history starts collecting from this build onward.</div>'; return; }
  $('histBody').innerHTML = r.hist.map(h => `
    <div style="border:1px solid #e5e5ea; border-radius:12px; padding:10px 14px; margin-bottom:10px;">
      <div style="font-weight:700;">${esc(new Date(h.at || h.day).toLocaleDateString('en-AU', { weekday: 'short', day: '2-digit', month: '2-digit' }))} · ${h.at ? esc(new Date(h.at).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })) : ''} · ${esc(h.name || 'RUN ALL')} · on ${esc(h.machine)}</div>
      <div style="font-size:12.5px; white-space:pre-wrap; margin-top:6px;">${esc(h.outcome || '(no detail recorded)')}</div>
    </div>`).join('');
});
$('btnHistClose').addEventListener('click', () => { $('histPanel').style.display = 'none'; });

$('btnRunAllSchedSave').addEventListener('click', async () => {
  const r = await window.cdbs.runallSched({ group: 'reports', enabled: $('runAllSchedOn').checked, time: $('runAllTime').value });
  $('runAllTime').value = r.time;
  alert(r.enabled ? ('Daily RUN ALL REPORTS scheduled for ' + r.time + ' (every day). The toggles decide what is in the run; SMS jobs run on their own clock below.') : 'Daily RUN ALL REPORTS schedule turned OFF - press the button when you want it.');
});
$('btnSmsRunAllSchedSave').addEventListener('click', async () => {
  const r = await window.cdbs.runallSched({ group: 'sms', enabled: $('smsRunAllSchedOn').checked, time: $('smsRunAllTime').value });
  $('smsRunAllTime').value = r.time;
  alert(r.enabled ? ('Daily RUN ALL SMS scheduled for ' + r.time + ' (every day). The toggles decide which texting jobs are in it.') : 'Daily RUN ALL SMS schedule turned OFF - press the button when you want it.');
});
$('btnRunAllJobs').addEventListener('click', async () => {
  const fl = (__fleet.byJob || {})['runall'];
  const ranToday = fl && fl.day === __fleet.today;
  const warn = ranToday
    ? 'ALREADY RAN TODAY at ' + new Date(fl.at).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' }) + ' on ' + fl.machine + '.\n\nEvery job remembers what it already did (texts cannot repeat), so running again is safe but slow. Run again anyway?'
    : 'Run every switched-ON report now, ending with the 14-day CDBS morning run (desk mode)?\n\nThe PRODA code will be asked for straight away - type it in the app or reply on Telegram, whichever is quicker. Nothing double-sends.';
  if (!confirm(warn)) return;
  const r = await window.cdbs.autoRunAll({ group: 'reports' });
  if (!r.ok) { alert(r.error || 'Could not start.'); return; }
  alert('Run all started: ' + r.count + ' job(s). Watch the banner for progress' + (r.withMorning ? ' - the PRODA code box appears in a moment.' : '.'));
  setTimeout(refreshAuto, 4000);
});
$('btnRunAllSms').addEventListener('click', async () => {
  const fl = (__fleet.byJob || {})['runall-sms'];
  const ranToday = fl && fl.day === __fleet.today;
  const warn = ranToday
    ? 'SMS run ALREADY RAN TODAY at ' + new Date(fl.at).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' }) + ' on ' + fl.machine + '.\n\nEvery texting job remembers who it already texted (nothing double-sends), so running again is safe. Run again anyway?'
    : 'Run every switched-ON SMS report now? Texts go out to patients as each job runs.\n\nNothing double-sends: every job remembers who it has already texted.';
  if (!confirm(warn)) return;
  const r = await window.cdbs.autoRunAll({ group: 'sms' });
  if (!r.ok) { alert(r.error || 'Could not start.'); return; }
  alert('SMS run all started: ' + r.count + ' job(s). Watch the banner for progress.');
  setTimeout(refreshAuto, 4000);
});

let __fleet = { byJob: {}, today: '' };
async function refreshAuto() {
  try { __fleet = await window.cdbs.fleetLastruns(); } catch (e) { __fleet = { byJob: {}, today: '' }; }
  const r = await window.cdbs.autoGet();
  const jobCard = job => `
    <div style="border:1px solid #f0f0f3; border-radius:14px; padding:14px; margin-bottom:10px;">
      <div class="row">
        <div style="flex:1;">
          <strong>${esc(job.name)}</strong>
          <div class="muted" style="margin-top:4px;">${esc(job.desc)}</div>
        </div>
        <label class="muted" style="font-size:12px;"><input type="checkbox" data-en="${job.id}" ${job.enabled ? 'checked' : ''}> On</label>
      </div>
      <div class="row" style="margin-top:10px;">
        <span class="muted">Days:</span>
        ${DAY_LABELS.map((d, idx) => `<label style="font-size:12px;"><input type="checkbox" data-day="${job.id}:${idx}" ${job.days.includes(idx) ? 'checked' : ''}>${d}</label>`).join('')}
        <input type="hidden" data-time="${job.id}" value="${esc(job.time)}">
        <button class="secondary" data-savejob="${job.id}" style="padding:6px 14px;">Save</button>
        <span class="spacer"></span>
        <button class="primary" data-runjob="${job.id}" style="padding:6px 14px;">Run now</button>
      </div>
      ${job.id === 'birthday' ? `
      <div class="row" style="margin-top:10px;">
        <textarea data-tmpl="${job.id}" style="flex:1; min-width:240px; font:inherit; border:1px solid #d2d2d7; border-radius:10px; padding:8px; font-size:13px;" rows="2">${esc(job.template || '')}</textarea>
        <input type="text" data-sender="${job.id}" value="${esc(job.sender || '')}" placeholder="Sender (blank = same as Command Center)" style="width:170px;">
      </div>
      <div class="row" style="margin-top:8px;">
        <input type="text" id="bTestNum" placeholder="04xx xxx xxx" style="width:140px;">
        <button class="secondary" id="btnBirthdayTest" style="padding:6px 14px;">Send test SMS</button>
        <span id="bTestState" class="muted"></span>
      </div>` : ''}
      <div class="muted" style="margin-top:8px;">Last run: ${(() => {
        const fl = __fleet.byJob && __fleet.byJob[job.id];
        const loc = job.lastRun;
        const use = fl && (!loc || (fl.at || '') >= (loc.when || '')) ? { when: fl.at, outcome: fl.outcome, who: fl.machine } : (loc ? { when: loc.when, outcome: loc.outcome, who: '' } : null);
        if (!use) return 'never';
        return esc(new Date(use.when).toLocaleString('en-AU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })) + (use.who ? ' — on ' + esc(use.who) : ' — this computer') + ' — ' + esc((use.outcome || '').split('\n')[0]);
      })()}</div>
    </div>`;
  const allJobs = r.jobs || [];
  $('autoTable').innerHTML = allJobs.filter(j => (j.group || 'reports') !== 'sms').map(jobCard).join('') || '<div class="muted">No jobs yet.</div>';
  $('autoTableSms').innerHTML = allJobs.filter(j => (j.group || 'reports') === 'sms').map(jobCard).join('') || '<div class="muted">No SMS jobs yet.</div>';
  // Idle strips show the last recorded run (fleet-wide) - never overwrite a live run.
  const paintIdle = (id, key) => {
    const el = $(id);
    if (!el || el.dataset.running === '1') return;
    const fl = (__fleet.byJob || {})[key];
    if (!fl) { el.textContent = 'No run recorded yet.'; return; }
    const lines = (fl.outcome || '').split('\n').filter(Boolean);
    const bad = lines.filter(l => /^\u26a0/.test(l)).length;
    el.textContent = 'Last run: ' + new Date(fl.at || fl.day).toLocaleString('en-AU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' on ' + (fl.machine || '?') + ' \u2014 ' + lines.length + ' job(s)' + (bad ? ', ' + bad + ' \u26a0' : ', all \u2713');
  };
  paintIdle('raLiveReports', 'runall');
  paintIdle('raLiveSms', 'runall-sms');

  for (const b of document.querySelectorAll('button[data-savejob]')) {
    b.addEventListener('click', async () => {
      const id = b.getAttribute('data-savejob');
      const days = [...document.querySelectorAll(`input[data-day^="${id}:"]`)]
        .map((cb, idx) => cb.checked ? Number(cb.getAttribute('data-day').split(':')[1]) : null)
        .filter(v => v !== null);
      const time = document.querySelector(`input[data-time="${id}"]`).value.trim();
      const en = document.querySelector(`input[data-en="${id}"]`).checked;
      const tmplEl = document.querySelector(`textarea[data-tmpl="${id}"]`);
      const sndEl = document.querySelector(`input[data-sender="${id}"]`);
      await window.cdbs.autoSave({ id, days, time, enabled: en,
        template: tmplEl ? tmplEl.value : null, sender: sndEl ? sndEl.value : null });
      refreshAuto();
    });
  }
  const bt = document.getElementById('btnBirthdayTest');
  if (bt) bt.addEventListener('click', async () => {
    const num = document.getElementById('bTestNum').value.trim();
    document.getElementById('bTestState').textContent = 'Sending…';
    const r = await window.cdbs.birthdayTest({ number: num });
    document.getElementById('bTestState').textContent = r.ok ? 'Sent ✓ — check the phone.' : (r.error || 'Failed.');
  });
  for (const b of document.querySelectorAll('button[data-runjob]')) {
    b.addEventListener('click', async () => {
      b.disabled = true; b.textContent = 'Running…';
      const flj = (__fleet.byJob || {})[b.getAttribute('data-runjob')];
      if (flj && flj.day === __fleet.today && !confirm('This one already ran today at ' + new Date(flj.at).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' }) + ' on ' + flj.machine + ' — ' + (flj.outcome || '').split('\n')[0] + '.\n\nRun it again anyway?')) { b.disabled = false; b.textContent = 'Run now'; return; }
      const res = await window.cdbs.autoRun({ id: b.getAttribute('data-runjob') });
      if (!res.ok && res.error) alert(res.error);
      refreshAuto();
      refreshActions();
    });
  }
}

// ---------- Status strip + clickable pills + log report ----------
function paintStrip(st) {
  const parts = [];
  const label = { cdbs: 'CDBS check' };
  for (const [k, v] of Object.entries(st || {})) {
    const when = new Date(v.when).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
    const mark = v.state === 'ok' ? '✓' : v.state === 'running' ? '⏳' : '⚠';
    parts.push(`${mark} ${label[k] || k}: ${v.state} ${when}${v.detail ? ' — ' + esc(v.detail) : ''}`);
  }
  $('runStrip').textContent = parts.length ? parts.join('   ·   ') : 'No runs yet this session.';
}
window.cdbs.onRunStatus(paintStrip);
window.cdbs.statusGet().then(paintStrip);

$('btnLogReport').addEventListener('click', async () => {
  const btn = $('btnLogReport');
  btn.textContent = 'Saving…';
  const r = await window.cdbs.logReport();
  btn.textContent = r.ok ? 'Saved to Downloads ✓' : 'Failed';
  setTimeout(() => { btn.textContent = 'Log report'; }, 4000);
  if (!r.ok) alert(r.error || 'Could not build the log report.');
});

$('lightPrinciple').style.cursor = 'pointer';
$('lightPrinciple').addEventListener('click', () => {
  if (/needs/i.test($('lightPrinciple').textContent)) window.cdbs.pillLogin({ which: 'principle' });
});
$('lightProda').style.cursor = 'pointer';
$('lightProda').addEventListener('click', () => {
  if (/needs|hand|code|not connected/i.test($('lightProda').textContent)) window.cdbs.pillLogin({ which: 'proda' });
});

// ---------- Diagnostics panel ----------
$('btnDiag').addEventListener('click', async () => {
  const p = $('diagPanel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) {
    const v = await window.cdbs.diagVitals();
    $('diagVitals').textContent =
      'Heartbeat: ' + v.lastBeat.secondsAgo + 's ago (' + (v.lastBeat.stage || 'idle') + ') · Principle: ' +
      (v.pills.principle || '?') + ' · PRODA: ' + (v.pills.proda || '?');
  }
});
for (const b of document.querySelectorAll('button[data-dw]')) {
  b.addEventListener('click', async () => {
    const [which, action] = b.getAttribute('data-dw').split(':');
    if (action === 'hide') {
      for (const w of ['principle', 'report', 'proda']) await window.cdbs.diagWindow({ which: w, action: 'hide' });
      $('diagState').textContent = 'Windows tucked away.';
      return;
    }
    const r = await window.cdbs.diagWindow({ which, action });
    $('diagState').textContent = r.ok ? 'Showing the ' + which + ' window.' : (r.error || '');
  });
}
for (const b of document.querySelectorAll('button[data-dc]')) {
  b.addEventListener('click', async () => {
    const which = b.getAttribute('data-dc');
    $('diagState').textContent = 'Capturing…';
    const r = await window.cdbs.diagCapture({ which });
    $('diagState').textContent = r.ok ? 'Saved to Downloads ✓ — upload that file to Claude.' : (r.error || 'Capture failed.');
  });
}
$('btnRunLogDiag').addEventListener('click', () => $('btnRunLog').click());
$('btnReportsFolderDiag').addEventListener('click', () => {
  const b = document.getElementById('btnOpenReportsFolder');
  if (b) b.click(); else window.cdbs.diagWindow({ which: 'none', action: 'hide' });
});

// ---------- Network recorder ----------
$('btnRecStart').addEventListener('click', async () => {
  const r = await window.cdbs.diagRecord({ action: 'start' });
  $('diagState').textContent = r.ok
    ? (r.windowFound ? 'Recording — the Principle window is up. Click around, then press Stop & save.'
                     : 'Recording — but no Principle window is open yet.')
    : (r.error || 'Could not start.');
});
$('btnRecStop').addEventListener('click', async () => {
  const r = await window.cdbs.diagRecord({ action: 'stop' });
  $('diagState').textContent = r.ok
    ? (r.file ? 'Recording saved to Downloads ✓ — upload it to Claude.' : 'Stopped — nothing was recorded.')
    : (r.error || 'Could not stop.');
});

// ---------- Staff page link ----------
const STAFF_PAGE_URL = 'https://inv-c20f7.web.app';
$('lnkStaffPage').addEventListener('click', (e) => { e.preventDefault(); require === undefined; window.cdbs.openExternal ? window.cdbs.openExternal(STAFF_PAGE_URL) : window.open(STAFF_PAGE_URL); });
$('btnCopyLink').addEventListener('click', async () => {
  await navigator.clipboard.writeText(STAFF_PAGE_URL);
  $('shareState').textContent = 'Link copied — send it to staff; they sign in with their clinic Google account.';
  setTimeout(() => { $('shareState').textContent = ''; }, 6000);
});

// ---------- Error box on Home ----------
async function refreshErrors() {
  try {
    const r = await window.cdbs.errorsGet();
    const card = document.getElementById('cardErrors');
    if (!r.errors.length) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    $('errList').innerHTML = r.errors.map(e =>
      `<div style="padding:5px 0; border-bottom:1px solid #f6eaea;">
        <span style="color:#8e8e93; font-size:11px;">${new Date(e.when).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}</span>
        &nbsp; ${esc(e.text)}</div>`).join('');
  } catch (e) { /* quiet */ }
}
refreshErrors();
setInterval(refreshErrors, 60 * 1000);
window.cdbs.onRunStatus(() => refreshErrors());


// ---------- Routine tasks (＋) ----------
$('btnRoutineAdd').addEventListener('click', () => {
  $('routineForm').classList.toggle('hidden');
  if (!$('routineForm').classList.contains('hidden')) $('rName').focus();
});
$('btnRoutineSave').addEventListener('click', async () => {
  const btn = $('btnRoutineSave');
  if (btn.disabled) return;                       // no double-fire
  const name = $('rName').value.trim();
  if (!name) { $('rName').focus(); return; }
  const freq = $('rFreq').value;
  if (freq !== 'once' && !$('rDate').value) {
    $('routineState').textContent = 'Pick the first day it\'s due — recurring tasks need a start date (that day sets the rhythm).';
    $('rDate').focus();
    return;
  }
  btn.disabled = true; btn.textContent = 'Adding…';
  const r = await window.cdbs.actionAdd({
    title: name,
    section: 'Routine',
    due: $('rDate').value || null,
    repeat: freq === 'once' ? null : freq,
    howTo: $('rHow').value.trim() || null,
  });
  btn.disabled = false; btn.textContent = 'Add';
  if (r.ok) {
    const due = $('rDate').value;
    const todayIso = (() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();   // LOCAL date, not UTC
    const scheduled = due && due > todayIso;
    $('rName').value = ''; $('rDate').value = ''; $('rHow').value = ''; $('rFreq').value = 'weekly';
    if (scheduled) {
      const d = new Date(due + 'T00:00');
      $('routineState').textContent = 'Added ✓ — scheduled for ' +
        d.toLocaleDateString('en-AU', { weekday: 'short', day: '2-digit', month: '2-digit' }) +
        '; it will appear in the list that day.';
      setTimeout(() => { $('routineState').textContent = ''; $('routineForm').classList.add('hidden'); }, 3500);
    } else {
      $('routineForm').classList.add('hidden');
    }
    refreshActions();
  }
});
$('rName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnRoutineSave').click(); });



// ---------- Reactivation workstation ----------
// ---- Reactivation CDBS: in-app "no answer" text panel -------------
// Big amber confirm strip injected into the card. Send-then-done: the
// main process only marks the card "texted" after Cellcast accepts.
function smsPanelClose(id) {
  const p = document.querySelector(`div[data-smspanel="${id}"]`);
  if (p) p.remove();
}
async function smsPanelOpen(id, cardEl) {
  smsPanelClose(id);
  let it = (__items.list || []).find(x => x.id === id);
  if (!it) { try { await getItems(true); } catch (e) { /* offline - fall through */ } it = (__items.list || []).find(x => x.id === id); }
  const panel = document.createElement('div');
  panel.setAttribute('data-smspanel', id);
  const mob = it && String(it.mobile || '').trim();
  if (!it || !mob) {
    panel.style.cssText = 'margin-top:10px; background:#fdecec; border:2px solid #c0392b; border-radius:12px; padding:13px;';
    panel.innerHTML = `<div style="font-weight:700; font-size:13.5px; color:#c0392b;">No mobile number on this patient — nothing can be sent.</div>
      <div style="margin-top:9px;"><button data-smscancel="${id}" style="border:none; cursor:pointer; border-radius:99px; padding:6px 14px; font-size:12px; background:#f2f2f5; color:#6e6e73;">Close</button></div>`;
    cardEl.appendChild(panel);
    return;
  }
  let tmpl = '';
  try { const t = await window.cdbs.reactSmsTemplate(); tmpl = (t && t.message) || ''; } catch (e) { tmpl = ''; }
  const again = it.smsSentAt
    ? `<div style="background:#fdecec; color:#c0392b; border-radius:9px; padding:7px 11px; font-size:12.5px; font-weight:600; margin-bottom:9px;">⚠ Already texted ${new Date(it.smsSentAt).toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit' })} — sending again anyway will text them twice.</div>`
    : '';
  panel.style.cssText = 'margin-top:10px; background:#fff4e0; border:2px solid #e2a93b; border-radius:12px; padding:14px; width:100%; box-sizing:border-box;';
  panel.innerHTML = `
    <div style="font-weight:700; font-size:14px; color:#9a6b00; margin-bottom:9px;">📱 Text about to go to <span style="color:#1d1d1f;">${esc(mob)}</span> — check the message, then press Send</div>
    ${again}
    <textarea data-smstext="${id}" style="width:100%; box-sizing:border-box; min-height:110px; font:inherit; font-size:13px; line-height:1.45; border:1px solid #d2d2d7; border-radius:10px; padding:9px 11px; resize:vertical;">${esc(tmpl)}</textarea>
    <div style="margin-top:10px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
      <button data-smssend="${id}" style="border:none; cursor:pointer; border-radius:99px; padding:8px 18px; font-size:13px; font-weight:700; background:#2F6B4F; color:#fff;">Send text</button>
      <button data-smscancel="${id}" style="border:none; cursor:pointer; border-radius:99px; padding:8px 15px; font-size:12.5px; background:#f2f2f5; color:#6e6e73;">Cancel</button>
      <span data-smsst="${id}" style="font-size:12.5px; color:#c0392b; font-weight:600;"></span>
    </div>`;
  cardEl.appendChild(panel);
  const ta = panel.querySelector('textarea'); if (ta) ta.focus();
}
async function smsPanelSend(id) {
  const panel = document.querySelector(`div[data-smspanel="${id}"]`);
  if (!panel) return;
  const btn = panel.querySelector(`button[data-smssend="${id}"]`);
  const st = panel.querySelector(`span[data-smsst="${id}"]`);
  const ta = panel.querySelector(`textarea[data-smstext="${id}"]`);
  const msg = (ta && ta.value || '').trim();
  if (!msg) { if (st) st.textContent = 'The message is empty — write it or press Cancel.'; return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; btn.style.background = '#9a9aa0'; }
  if (st) st.textContent = '';
  const r = await window.cdbs.reactSendSms({ id, message: msg });
  if (!r.ok) {
    if (btn) { btn.disabled = false; btn.textContent = 'Retry send'; btn.style.background = '#c0392b'; }
    if (st) st.textContent = r.error || 'Send failed — try again.';
    return;
  }
  panel.style.cssText = 'margin-top:10px; background:#e6f4ec; border:2px solid #1d7a46; border-radius:12px; padding:14px;';
  panel.innerHTML = `<div style="font-weight:700; font-size:14px; color:#1d7a46;">✓ Text sent ${new Date().toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit' })}${r.noteQueued ? ' — Principle note queued' : ''}</div>`;
}

function reactPill(id, key, label, on, color) {
  return `<button data-ro="${id}:${key}" style="border:none; cursor:pointer; border-radius:99px; padding:5px 12px; font-size:12px; font-weight:600; background:${on ? color + '22' : '#f2f2f5'}; color:${on ? color : '#6e6e73'};">${label}</button>`;
}
function reactNotesLog(i) {
  let log = [];
  try { log = JSON.parse(i.notesLog || '[]'); } catch (e) { log = []; }
  if (!log.length && i.noteText) log = [{ t: i.noteText, d: i.updatedAt || i.createdAt, dest: 'local' }];
  return log;
}
function cdbsBalInfo(i) {
  // Local PRODA memory vs the shared card's mirror: most recent check wins,
  // so every machine sees balances no matter which machine ran the check.
  const bm = __balMap[i.patientId];
  const local = bm && bm.balance ? { balance: bm.balance, when: bm.lastChecked || '' } : null;
  const mirror = i.balanceText ? { balance: i.balanceText, when: i.balanceChecked || '' } : null;
  if (local && mirror) return (local.when || '') >= (mirror.when || '') ? local : mirror;
  return local || mirror;
}
function cdbsBalNum(i) {
  const b = cdbsBalInfo(i);
  if (!b) return -2;                                    // never checked: bottom
  if (/not eligible/i.test(b.balance)) return -1;       // not eligible: just above
  const m = String(b.balance).match(/\$\s?([\d,]+(?:\.\d+)?)/);
  return m ? Number(m[1].replace(/,/g, '')) : 0;
}
function cdbsParked(i) {
  // Not eligible, or under $100 left - either way not worth a ring until
  // the monthly re-check (new CDBS years refill balances).
  const n = cdbsBalNum(i);
  return n === -1 || (n >= 0 && n < 100 && !!cdbsBalInfo(i));
}
function cdbsBalChip(i) {
  const bm = cdbsBalInfo(i);
  if (!bm) return '<span class="chip" style="background:#f2f2f5; color:#6e6e73;">balance not checked yet</span>';
  const when = bm.when ? new Date(bm.when).toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit' }) : '?';
  if (/not eligible/i.test(bm.balance)) {
    return `<span class="chip" style="background:#fdecec; color:#c0392b; font-weight:700;">Not eligible · ${when}</span>`;
  }
  const m = String(bm.balance).match(/\$\s?([\d,]+(?:\.\d+)?)/);
  if (m && Number(m[1].replace(/,/g, '')) < 100) return `<span class="chip" style="background:#fdecec; color:#c0392b; font-weight:700;">$${m[1]} left · checked ${when}</span>`;
  if (m) return `<span class="chip" style="background:#e6f4ec; color:#1d7a46; font-weight:700;">$${m[1]} available · checked ${when}</span>`;
  return `<span class="chip" style="background:#f2f2f5; color:#6e6e73;">checked ${when}</span>`;
}

function reactCard(i, todayIso) {
  const doneLabels = { offlist: 'off list — inactivated ✓', texted: 'no answer — texted', booked: 'booked in' };
  const doneColors = { offlist: ['#e6f4ec', '#1d7a46'], texted: ['#fff4e0', '#9a6b00'], booked: ['#e6f4ec', '#1d7a46'] };
  const dc = doneColors[i.outcome] || ['#e6f4ec', '#1d7a46'];
  const status = i.doneAt
    ? `<span class="chip" style="background:${dc[0]}; color:${dc[1]};">${doneLabels[i.outcome] || 'done'} · ${new Date(i.doneAt).toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit' })}</span>`
    : (i.due && i.due > todayIso ? `<span class="chip" style="background:#eef2ff; color:#5e5ce6;">follow-up ${i.due.slice(8, 10)}/${i.due.slice(5, 7)}</span>` : '');
  const att = '';
  const pending = !i.doneAt && i.outcome === 'offlist-pending';
  const log = reactNotesLog(i);
  const logHtml = log.map((n, k) => {
    const when = new Date(n.d).toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit' });
    if (n.dest === 'principle') {
      return `<div style="background:#e6f4ec; color:#1d7a46; border-radius:9px; padding:6px 11px; font-size:12px; margin-top:5px;">✓ ${when} sent to Principle: ${esc(n.t)}</div>`;
    }
    if (n.dest === 'queued') {
      return `<div style="background:#fff4e0; color:#9a6b00; border-radius:9px; padding:6px 11px; font-size:12px; margin-top:5px;">⏳ ${when} sending to Principle: ${esc(n.t)}</div>`;
    }
    if (n.dest === 'failed') {
      return `<div style="background:#fdecec; color:#c0392b; border-radius:9px; padding:6px 11px; font-size:12px; margin-top:5px;">✗ ${when} could not send: ${esc(n.t)}${n.err ? ' — ' + esc(n.err) : ''}
        <button data-noteretry="${i.id}|${esc(n.q || '')}" style="border:none; border-radius:99px; padding:2px 10px; background:#c0392b; color:#fff; cursor:pointer; font-size:11px; margin-left:6px;">Retry</button></div>`;
    }
    return `<div style="background:#f2f2f5; color:#3c3c43; border-radius:9px; padding:6px 11px; font-size:12px; margin-top:5px;">${when} saved here: ${esc(n.t)}
      <button data-rnd="${i.id}:${k}" title="Delete this scratch note" style="border:none; background:none; color:#8e8e93; cursor:pointer;">✕</button></div>`;
  }).join('');
  return `<div class="row" style="align-items:flex-start; padding:13px 0; border-bottom:1px solid #f0f0f3;">
    <div style="flex:1;">
      <div style="font-size:14.5px;"><strong>${esc(i.name)}</strong>
        &nbsp;${i.mobile ? `<a href="#" data-tel="${esc(i.mobile)}" style="color:var(--accent); text-decoration:none; font-weight:600;">${esc(i.mobile)}</a>` : ''}
        ${i.feeSched ? `<span class="chip">${esc(i.feeSched)}</span>` : ''}
        ${i.lastVisit ? `<span class="chip" title="last visit">seen ${esc(i.lastVisit)}</span>` : ''}
        ${i.kind === 'reactcdbs' ? cdbsBalChip(i) : ''}
        ${i.plink ? `<button data-rp="${i.id}" class="secondary" style="padding:3px 10px; font-size:12px;">Principle ↗</button>` : ''}
        ${status} ${att}
        </div>
      ${pending ? `<div class="row" style="margin-top:8px; background:#fff4e0; border-radius:10px; padding:9px 12px;">
        <span style="color:#9a6b00; font-size:12.5px; font-weight:600;">⚠ Now make them inactive:</span>
        ${i.plink ? `<button data-rp="${i.id}" class="secondary" style="padding:4px 11px; font-size:12px;">Open their file ↗</button>` : ''}
        <span class="muted" style="font-size:12px;">Profile → Status → Inactive, then</span>
        <button data-ro="${i.id}:offlist" style="border:none; cursor:pointer; border-radius:99px; padding:5px 12px; font-size:12px; font-weight:600; background:#1d7a4622; color:#1d7a46;">Done — made inactive</button>
        <button data-ro="${i.id}:offlist-cancel" style="border:none; cursor:pointer; border-radius:99px; padding:5px 12px; font-size:12px; background:#f2f2f5; color:#6e6e73;">Cancel</button>
      </div>` : `<div class="row" style="margin-top:8px;">
        ${reactPill(i.id, 'booked', 'Booked in', i.outcome === 'booked', '#1d7a46')}
        ${reactPill(i.id, 'texted', 'No answer — text pt', i.outcome === 'texted', '#9a6b00')}
        ${reactPill(i.id, 'offlist-pending', 'Take off list', false, '#c0392b')}
        ${reactPill(i.id, 'followup', 'Follow-up after ▸', i.outcome === 'followup', '#5e5ce6')}
        <input type="date" data-rd="${i.id}" value="${i.outcome === 'followup' && i.due ? esc(i.due) : ''}" style="font:inherit; border:1px solid #d2d2d7; border-radius:8px; padding:4px;">
      </div>`}
      ${logHtml}
      <div class="row" style="margin-top:8px;">
        <input type="text" data-draft="${i.id}" placeholder="new note…" style="flex:1; min-width:200px; font-size:12px; padding:6px 10px;">
        <button data-rl="${i.id}" class="secondary" style="padding:6px 12px; font-size:12px;">Save here</button>
        <button data-rw="${i.id}" class="secondary" style="padding:6px 12px; font-size:12px;" ${i.plink || !String(i.patientId).startsWith('name:') ? '' : 'disabled title="Needs the Patient Link column in the report"'}>→ Principle &amp; pin</button>
        <span data-rws="${i.id}" class="muted"></span>
      </div>
    </div>
  </div>`;
}
let __balMap = {};
async function refreshBalMap() {
  try { __balMap = await window.cdbs.patientStateMap(); } catch (e) { __balMap = {}; }
}
async function refreshReactKind(kind, boxId, searchId, fresh) {
  const all = (await getItems(fresh)).filter(i => i.kind === kind);
  if (typingInside($(boxId))) return;      // never eat a half-written note
  const q = $(searchId).value.trim().toLowerCase();
  const todayIso = (() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();
  const box = $(boxId);
  if (q) {
    const items = all.filter(i => (i.name || '').toLowerCase().includes(q))
      .sort((a2, b2) => String(a2.name).localeCompare(String(b2.name)));
    box.innerHTML = items.length ? items.map(i => reactCard(i, todayIso)).join('')
      : '<div class="muted">No patient matches that search.</div>';
    return;
  }
  let open = all.filter(i => !i.doneAt && !(i.due && i.due > todayIso))
    .sort((a2, b2) => String(a2.name).localeCompare(String(b2.name)));
  let notElig = [];
  if (kind === 'reactcdbs') {
    notElig = open.filter(i => cdbsParked(i));
    open = open.filter(i => !cdbsParked(i));
    if ($('cdbsSort') && $('cdbsSort').value === 'balance') {
      open.sort((a2, b2) => cdbsBalNum(b2) - cdbsBalNum(a2));
    }
  }
  const done = all.filter(i => i.doneAt && (Date.now() - Date.parse(i.doneAt)) < 180 * 86400000)
    .sort((a2, b2) => String(b2.doneAt).localeCompare(String(a2.doneAt)));
  let html = open.length ? open.map(i => reactCard(i, todayIso)).join('')
    : '<div class="muted">Nobody waiting to be rung — all clear.</div>';
  if (notElig.length) {
    html += `<details class="dept" style="margin-top:14px;">
      <summary style="font-size:17px; font-weight:700; letter-spacing:-.2px; padding:12px 0;">
        <span class="ci" style="display:inline-block; width:18px; color:#8e8e93; font-weight:600;"></span>Not eligible / under $100
        <span class="chip" style="background:#fdecec; color:#c0392b; font-size:12px; margin-left:8px;">${notElig.length}</span>
        <span class="muted" style="font-weight:400; font-size:12px;">&nbsp;parked automatically — eligibility resets with new CDBS years</span>
      </summary>${notElig.map(i => reactCard(i, todayIso)).join('')}</details>`;
  }
  if (done.length) {
    html += `<details class="dept" style="margin-top:14px;">
      <summary style="font-size:17px; font-weight:700; letter-spacing:-.2px; padding:12px 0;">
        <span class="ci" style="display:inline-block; width:18px; color:#8e8e93; font-weight:600;"></span>Done
        <span class="chip" style="background:#e6f4ec; color:#1d7a46; font-size:12px; margin-left:8px;">${done.length}</span>
        <span class="muted" style="font-weight:400; font-size:12px;">&nbsp;shown 180 days — until they become ring-able again</span>
      </summary>${done.map(i => reactCard(i, todayIso)).join('')}</details>`;
  }
  box.innerHTML = html;
}
function wireReactBox(boxId) {
  const box = $(boxId);
  const myRefresh = () => (boxId === 'reactCdbsList' ? refreshReactCdbs(true) : refreshReact(true));
  box.addEventListener('click', async (e) => {
    const nr = e.target.closest('button[data-noteretry]');
    if (nr) {
      const [itemId, qid] = nr.getAttribute('data-noteretry').split('|');
      nr.textContent = 'Queued…';
      await window.cdbs.noteRetry({ itemId, qid });
      myRefresh();
      return;
    }
    const tel = e.target.closest('a[data-tel]');
    if (tel) { e.preventDefault(); window.cdbs.openExternal('tel:' + tel.getAttribute('data-tel').replace(/\s+/g, '')); return; }
    const rp = e.target.closest('button[data-rp]');
    if (rp) { await window.cdbs.reactOpenPatient({ id: rp.getAttribute('data-rp') }); return; }
    const rnd = e.target.closest('button[data-rnd]');
    if (rnd) {
      const [id, idx] = rnd.getAttribute('data-rnd').split(':');
      await window.cdbs.reactNoteDel({ id, idx: Number(idx) });
      myRefresh();
      return;
    }
    const smsSend = e.target.closest('button[data-smssend]');
    if (smsSend) {
      await smsPanelSend(smsSend.getAttribute('data-smssend'));
      // On success the panel turned green; give it a beat, then repaint (card moves to Done).
      setTimeout(() => { myRefresh(); refreshActions(); }, 1400);
      return;
    }
    const smsCancel = e.target.closest('button[data-smscancel]');
    if (smsCancel) { smsPanelClose(smsCancel.getAttribute('data-smscancel')); return; }
    const ro = e.target.closest('button[data-ro]');
    if (ro) {
      const [id, key] = ro.getAttribute('data-ro').split(':');
      const it = (__items.list || []).find(x => x.id === id);
      if (key === 'texted' && boxId === 'reactCdbsList') {
        // CDBS: in-house texting - open the amber confirm panel, nothing marked yet.
        const cardEl = ro.closest('div[style*="flex:1"]') || ro.parentElement;
        await smsPanelOpen(id, cardEl);
        return;
      }
      let date = null;
      if (key === 'followup') {
        const d = document.querySelector(`input[data-rd="${id}"]`);
        date = d && d.value;
        if (!date) { alert('Pick the follow-up date first (the little calendar next to the button).'); return; }
      }
      const r = await window.cdbs.reactOutcome({ id, outcome: key, date });
      if (!r.ok && r.error) alert(r.error);
      if (r.ok && key === 'texted') {
        // Health funds/DVA keeps the old hand-off: open the Command Center on their number.
        if (it && it.mobile) window.cdbs.openExternal('tel:' + String(it.mobile).replace(/\s+/g, ''));
      }
      myRefresh(); refreshActions();
      return;
    }
    const rl = e.target.closest('button[data-rl]');
    if (rl) {
      const id = rl.getAttribute('data-rl');
      const draft = document.querySelector(`input[data-draft="${id}"]`);
      const r = await window.cdbs.reactNoteCommit({ id, text: draft ? draft.value : '' });
      if (!r.ok && r.error) { alert(r.error); return; }
      myRefresh();
      return;
    }
    const rw = e.target.closest('button[data-rw]');
    if (rw) {
      const id = rw.getAttribute('data-rw');
      const draft = document.querySelector(`input[data-draft="${id}"]`);
      const st = document.querySelector(`span[data-rws="${id}"]`);
      rw.disabled = true; st.textContent = 'Writing to Principle…';
      const r = await window.cdbs.reactWriteNote({ id, text: draft ? draft.value : '' });
      rw.disabled = false;
      st.textContent = r.ok ? 'Written & pinned ✓' : (r.error || 'Failed.');
      if (r.ok) myRefresh();
    }
  });
}
wireReactBox('reactList');
$('reactSearch').addEventListener('input', () => refreshReact(false));   // memory-only: instant
function refreshReact(fresh = true) { return refreshReactKind('reactivation', 'reactList', 'reactSearch', fresh); }
function refreshReactCdbs(fresh = true) { return refreshReactKind('reactcdbs', 'reactCdbsList', 'reactCdbsSearch', fresh); }
wireReactBox('reactCdbsList');
$('reactCdbsSearch').addEventListener('input', () => refreshReactCdbs(false));
$('cdbsSort').addEventListener('change', () => refreshReactCdbs(false));

$('navReact').addEventListener('click', () => { showView2('viewReact'); refreshReact(); });
$('navReactCdbs').addEventListener('click', () => { showView2('viewReactCdbs'); refreshBalMap().then(() => refreshReactCdbs()); });
$('btnCdbsBatch').addEventListener('click', async () => {
  if (!confirm('Refresh CDBS balances for up to 20 patients whose balance is more than a fortnight old?\n\nStalest first. One PRODA code, about 15 minutes. Progress shows on the CDBS / Medicare screen.')) return;
  const r = await window.cdbs.reactCdbsCheck({ scope: 'batch' });
  if (!r.ok) { alert(r.error || 'Could not start.'); return; }
  $('cdbsCheckState').textContent = 'Refreshing ' + r.count + ' — balances appear on the cards as they land.';
});
$('btnCdbsUnchecked').addEventListener('click', async () => {
  if (!confirm('Check every patient whose balance has NEVER been looked up?\n\nNo cap — about 45 seconds each, so a long list means a long session. One PRODA code. Progress shows on the CDBS / Medicare screen.')) return;
  const r = await window.cdbs.reactCdbsCheck({ scope: 'unchecked' });
  if (!r.ok) { alert(r.error || 'Could not start.'); return; }
  $('cdbsCheckState').textContent = 'Checking ' + r.count + ' unchecked — balances appear on the cards as they land.';
});
$('btnCdbsNotElig').addEventListener('click', async () => {
  if (!confirm('Re-check CDBS eligibility for every ineligible patient?\n\nOne PRODA code. Anyone who comes back eligible moves onto the main list automatically.')) return;
  const r = await window.cdbs.reactCdbsCheck({ scope: 'noteligible' });
  if (!r.ok) { alert(r.error || 'Could not start.'); return; }
  $('cdbsCheckState').textContent = 'Re-checking ' + r.count + ' — balances refresh as they land.';
});
$('btnCdbsAll').addEventListener('click', async () => {
  if (!confirm('Check EVERYONE on this list whose balance is more than a fortnight old?\n\nA long job — hours for a big list. PRODA stays busy throughout. Best after close.')) return;
  const r = await window.cdbs.reactCdbsCheck({ scope: 'all' });
  if (!r.ok) { alert(r.error || 'Could not start.'); return; }
  $('cdbsCheckState').textContent = 'Checking ' + r.count + ' — balances appear on the cards as they land.';
});
window.cdbs.onRunAllFinished(() => { refreshBalMap().then(() => { refreshReactCdbs(false); }); });
