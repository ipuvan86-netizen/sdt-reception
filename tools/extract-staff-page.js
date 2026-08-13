// tools/extract-staff-page.js
// Extracts NURSE_PAGE_HTML out of main.js and lays out a ready-to-deploy
// Firebase Hosting folder at tools/staff-page/. Run from anywhere:
//   node tools/extract-staff-page.js
// The deploy bat runs this first, so the page that goes live is ALWAYS
// byte-identical to the one inside the current main.js — never stale.
'use strict';
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const mainPath = path.join(repoRoot, 'main.js');
const outDir = path.join(__dirname, 'staff-page');
const pubDir = path.join(outDir, 'public');

function die(msg) { console.error('EXTRACT FAILED: ' + msg); process.exit(1); }

const src = fs.readFileSync(mainPath, 'utf8');
const key = "NURSE_PAGE_HTML = '";
const at = src.indexOf(key);
if (at < 0) die('NURSE_PAGE_HTML not found in main.js');

// Un-escape the single-quoted JS string by walking it character by character.
let i = at + key.length;
let out = '';
while (i < src.length) {
  const c = src[i];
  if (c === '\\') {
    const n = src[i + 1];
    if (n === 'n') out += '\n';
    else if (n === 't') out += '\t';
    else out += n;          // \' \" \\ and anything else: keep the char
    i += 2;
    continue;
  }
  if (c === "'") break;      // unescaped quote = end of the string
  out += c;
  i++;
}

// Sanity checks: refuse to deploy a page that looks old or broken.
if (out.length < 25000) die('page is only ' + out.length + ' chars - looks truncated or old');
if (!out.includes('let items=[]')) die('page is missing the "let items" fix - old code, do NOT deploy. Pull the latest repo first.');
if (!out.includes('reactrecall')) die('page is missing the recall reactivation tab - old code. Pull the latest repo first.');

fs.mkdirSync(pubDir, { recursive: true });
fs.writeFileSync(path.join(pubDir, 'index.html'), out, 'utf8');
fs.writeFileSync(path.join(outDir, 'firebase.json'),
  JSON.stringify({ hosting: { public: 'public', ignore: ['firebase.json', '**/.*'] } }, null, 2), 'utf8');
fs.writeFileSync(path.join(outDir, '.firebaserc'),
  JSON.stringify({ projects: { default: 'inv-c20f7' } }, null, 2), 'utf8');

console.log('OK: staff page extracted (' + out.length + ' chars) -> ' + path.join(pubDir, 'index.html'));
