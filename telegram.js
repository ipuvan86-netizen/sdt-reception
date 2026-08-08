// =====================================================================
//  telegram.js
//
//  The phone leg of the morning run. A private Telegram bot sends you
//  messages ("PRODA code?", the end-of-run summary) and reads your reply.
//
//  Security shape:
//    - the ONLY secret that ever crosses Telegram is the 6-digit PRODA
//      code, which is useless minutes later. Passwords never leave the PC.
//    - only messages from YOUR chat id are read; anything else is ignored.
//    - the bot token is stored encrypted on the PC, same as the passwords.
//    - patient names are NEVER sent — summaries are counts and reasons.
//
//  Uses plain long-polling (getUpdates) — the clinic PC only ever calls
//  OUT to api.telegram.org, so no firewall or router changes are needed.
// =====================================================================

const https = require('https');

let lastUpdateId = 0;

function api(token, method, params) {
  return new Promise((resolve) => {
    const body = JSON.stringify(params || {});
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 40000,
    }, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ ok: false, description: 'Bad reply from Telegram: ' + String(e) }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, description: String(e) }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, description: 'timed out' }); });
    req.write(body);
    req.end();
  });
}

async function send(token, chatId, text) {
  const res = await api(token, 'sendMessage', { chat_id: chatId, text });
  return { ok: !!res.ok, error: res.ok ? null : (res.description || 'unknown') };
}

// Reads new messages. Only ones from chatId count (anyone else messaging the
// bot is ignored). Returns an array of text strings, oldest first.
async function fetchReplies(token, chatId) {
  const res = await api(token, 'getUpdates', {
    offset: lastUpdateId + 1,
    timeout: 0,
    allowed_updates: ['message'],
  });
  if (!res.ok || !Array.isArray(res.result)) return [];
  const texts = [];
  for (const u of res.result) {
    if (u.update_id > lastUpdateId) lastUpdateId = u.update_id;
    const m = u.message;
    if (m && m.chat && String(m.chat.id) === String(chatId) && typeof m.text === 'string') {
      texts.push(m.text.trim());
    }
  }
  return texts;
}

// Throw away anything sent before now, so an old message can't be mistaken
// for today's code or today's YES.
async function drainOld(token) {
  const res = await api(token, 'getUpdates', { offset: lastUpdateId + 1, timeout: 0 });
  if (res.ok && Array.isArray(res.result)) {
    for (const u of res.result) if (u.update_id > lastUpdateId) lastUpdateId = u.update_id;
  }
}

// ------------------------------------------------------------------
// ONE TELEGRAM BRAIN
// Exactly one place (route, called by main every few seconds) reads the
// bot's inbox and hands each message to whoever it belongs to: a pending
// code waiter, a pending keyword waiter, or the add-a-task handler.
// Waiters never touch getUpdates themselves, so nothing can eat anyone
// else's reply - the class of bug where the task poller swallowed a YES
// mid-long-poll is structurally gone.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let codeWaiter = null;      // { take(code) }
let keyWaiter = null;       // { words:[..], take(word) }
function isBusy() { return !!(codeWaiter || keyWaiter); }

async function route(token, chatId, onTask) {
  const texts = await fetchReplies(token, chatId);
  for (const t of texts) {
    const digits = t.replace(/\s+/g, '').match(/\d{6}/);
    if (codeWaiter && digits) { codeWaiter.take(digits[0]); continue; }
    const norm = t.toLowerCase().replace(/[^a-z]/g, '');
    if (keyWaiter && keyWaiter.words.includes(norm)) { keyWaiter.take(norm); continue; }
    if (/^add:?\s*/i.test(t)) { try { if (onTask) await onTask(t); } catch (e) { /* task handler's problem */ } continue; }
    // anything else is dropped on purpose (old behaviour, now explicit)
  }
}

async function waitForCode(token, chatId, timeoutMs, shouldStop) {
  const started = Date.now();
  let got = null, reminded = false;
  codeWaiter = { take: (code) => { got = { ok: true, code }; } };
  try {
    while (Date.now() - started < timeoutMs) {
      if (got) return got;
      if (shouldStop && shouldStop()) return { ok: false, reason: 'stopped' };
      if (!reminded && Date.now() - started > timeoutMs / 2) {
        reminded = true;
        await send(token, chatId, 'Still waiting for the PRODA code — reply with the 6 digits.');
      }
      await sleep(1000);
    }
    return got || { ok: false, reason: 'timeout' };
  } finally { codeWaiter = null; }
}

// deadline may be a Date (expires then) or a number of milliseconds.
async function waitForKeyword(token, chatId, words, deadline, shouldStop) {
  const wanted = [].concat(words).map(w => String(w).toLowerCase());
  const until = (deadline && typeof deadline.getTime === 'function') ? deadline.getTime() : Date.now() + Number(deadline || 0);
  let got = null;
  keyWaiter = { words: wanted, take: (word) => { got = { ok: true, word }; } };
  try {
    while (Date.now() < until) {
      if (got) return got;
      if (shouldStop && shouldStop()) return { ok: false, reason: 'stopped' };
      await sleep(1000);
    }
    return got || { ok: false, reason: 'expired' };
  } finally { keyWaiter = null; }
}

// For first-time setup: after the person messages the bot once, this finds
// their chat id so it never has to be looked up by hand.
async function discoverChatId(token) {
  const res = await api(token, 'getUpdates', { timeout: 0 });
  if (!res.ok || !Array.isArray(res.result) || !res.result.length) {
    return { ok: false, reason: res.ok ? 'no-messages' : (res.description || 'bad-token') };
  }
  for (let i = res.result.length - 1; i >= 0; i--) {
    const m = res.result[i].message;
    if (m && m.chat && m.chat.id) {
      for (const u of res.result) if (u.update_id > lastUpdateId) lastUpdateId = u.update_id;
      return { ok: true, chatId: String(m.chat.id), name: (m.chat.first_name || '') };
    }
  }
  return { ok: false, reason: 'no-messages' };
}

async function sendDocument(token, chatId, filePath, caption) {
  const fs = require('fs');
  const path = require('path');
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', String(caption).slice(0, 1000));
  form.append('document', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
  const r = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form });
  const j = await r.json();
  return { ok: !!j.ok };
}

module.exports = { isBusy, fetchReplies, send, sendDocument, waitForCode, waitForKeyword, discoverChatId, drainOld, route };
