# CLAUDE.md — Standing instructions for SDT Reception

These rules apply to every Claude Code session in this repo. They are non-negotiable unless Immanuel explicitly overrides them in the session.

## What this project is

SDT Reception is a private Electron app for Southside Dental Toowoomba. It automates clinic workflows: CDBS/PRODA Medicare balance checks, SMS outreach (Cellcast), action lists, note-writing into Principle dental software, and Firebase/Firestore sync across a four-machine fleet. Immanuel is the sole product owner and decision-maker.

## Hard rules

1. **`principle-engine.js` is FROZEN.** Analyse it if needed, but never edit it. If a fix seems to require changing it, stop and explain why instead.
2. **Never commit credentials, `.env` files, tokens, or patient CSVs.** Check `.gitignore` covers anything new before committing. If patient-identifiable data appears in a file, do not stage it.
3. **Brainstorm before building.** For any new feature or behavioural change: restate the request, present 2–3 approaches with plain-English trade-offs and a recommendation, ask any needed questions, then ask "Do you accept this approach — want me to go ahead and build?" and WAIT for a yes. Skip this only if Immanuel says "just build it" / "full build", or for trivial tweaks. Bugs in code Claude itself built: just diagnose and fix.
4. **Never claim a fix worked without evidence.** Rate findings as CONFIRMED / LIKELY / SPECULATIVE before recommending action. For intermittent failures, prefer adding automatic failure-time evidence capture (page state, button census, masked text into the runlog/live feed) over guess-and-retry.

## Build protocol (every commit that changes app code)

1. Syntax-check `main.js` and `renderer.js` with `node --check`.
2. Extract the inline staff-page script from the `NURSE_PAGE_HTML` template literal in `main.js` and syntax-check it standalone. Reliable extraction pattern: `/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g` — the last match is the inline logic.
3. Increment the build stamp in BOTH places together: `const APP_BUILD = '...'` in `main.js` AND `**Current build: ...**` in `README.md`. Format: `YYYY-MM-DD.N`.
4. Commit with a clear one-line message. Docs-only changes (like this file) do not need a build bump.
5. If a change touches both the desk app and the embedded staff web page, verify both implementations side by side before calling it done.

## Fleet & deployment (Claude never touches the fleet directly)

- Commits land on `main`. Immanuel pulls at HOME (`DESKTOP-GA2C9NI`, clone at `C:\Users\sdt\cdbs-admin`, GitHub Desktop), restarts the app, and uses "Publish build to fleet".
- Fleet machines (RECEPTION, ROOM 1 `MSI`, ROOM 2 `sdts2`) have no git and auto-update from Firestore at startup. Never advise git operations on them.
- Do NOT regenerate `cdbs-admin-app.zip` or update bats on every build — only when Immanuel explicitly asks.

## Debugging references

- `AUDIT-PROMPT.md` is the single source of truth for the full audit procedure.
- `DEBUGGING.md` holds the four machines' live debug feed links and standing workflows.
- The Firestore debug feed only updates on three triggers (hourly timer from app launch, throttled push during run activity, Diagnostics button press). A freshly restarted idle app leaves the feed frozen for up to an hour. The in-app build badge is more reliable than the feed's `stats.build` for confirming a machine's current build.
- After any Services Australia/HPOS outage or maintenance banner: run one supervised 3-patient probe before trusting automation. If the probe fails, check the debug feed before running anything else.

## Working style

- Immanuel communicates concisely, sometimes with typos/abbreviations — interpret intent, confirm understanding of prior work before designing new features.
- He uses GitHub Desktop, not command-line git — explain git steps using its buttons (Commit, Push, Pull, History).
- When a build is ready, tell him the build number and remind him: Pull origin in GitHub Desktop at HOME → restart → Publish build to fleet.
