# SDT Reception (cdbs-admin)

Electron desktop app for Southside Dental Toowoomba. Automates the practice's morning: CDBS balance checks against PRODA/HPOS, patient file notes in Principle, birthday & thank-you SMS, and a cloud-shared action list (Firebase) used by every reception machine and the staff web page.

**Current build: 2026-08-12.5** (the build number shows as a badge in the app header).

## Architecture

| File | Role |
|---|---|
| `main.js` | Electron main process - all jobs, schedulers, the morning run, Firestore sync, Telegram, fleet run-ledger |
| `renderer.js` | The app UI logic (action list, Auto Reports, review table, code box) |
| `preload.js` | IPC bridge |
| `index.html` | UI markup + styles (build badge lives here) |
| `proda-engine.js` | Drives the PRODA/HPOS browser window: login, balance checks, Medicare card search |
| `principle-engine.js` | Drives Principle: login, patient files, note writing (**frozen - do not edit**) |
| `principle-report.js` | Custom-report download automation |
| `principle-capture.js` | Page snapshot tooling |
| `telegram.js` | Single-route Telegram brain: code asks, YES gates, report cards |

App icons (`sdt-icon.png` / `sdt-icon.ico`) are generated assets shipped in the deploy zip, not tracked here.

## Key design rules

- **Conservation of patients**: every patient entering the morning pipeline must exit in exactly one visible state (checked / not eligible / healed / flagged). The `unaccounted` bucket + action items enforce this.
- **Both doors for PRODA codes**: the desk code box and Telegram are asked simultaneously; first answer wins.
- **One clock**: the daily RUN ALL scheduler owns the morning; button runs and other machines stand the clock down via the shared run ledger.
- **Nothing double-sends**: birthday/thank-you texts are guarded by local files + cloud memory keyed on the normalized mobile number.
- **Hard time-caps everywhere**: report gen, each patient check (90s), sorted sheet (90s), action sync (120s) - no stage can wedge a run.
- Credentials are stored per-machine with Electron `safeStorage`; nothing secret lives in this repo.

## Deploying

Builds ship as `cdbs-admin-app.zip` + one-click `UPDATE-CDBS-ADMIN*.bat` files (run as administrator). The bat verifies the zip, replaces the app folder, and restarts the app. `REMOVE-CDBS-ADMIN.bat` fully uninstalls a machine. Firestore rules are locked to the app's service login + clinic Google accounts.
