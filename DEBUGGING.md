# Live debug feeds

Each machine running SDT Reception publishes its current day's log (journal + runlogs, patient names reduced to initials) to a private Firestore document behind an unguessable secret. The links below always show NOW - they refresh after every run and hourly.

**For auditors (human or AI):** fetch every URL listed under Machines before analysing any symptom. The response is JSON; the `log` field holds the prose log, the `stats` field holds a JSON summary (build number, machine, per-run outcomes) - use `stats` to orient, `log` for the detail. The `build` field must match the build badge reported in the symptom; if it doesn't, say so before anything else.

**To add/refresh a machine's link:** in the app -> Advanced tools -> "Debug log link (for Claude)" -> Copy my debug link -> paste it below.

## Machines

- HOME: (paste link here)
- RECEPTION: (paste link here)
- ROOM: (paste link here)

## Notes

- Links only work after the debugLogs rules block is published in Firestore (see DEBUG-FEED-RULES-ADDITION).
- The feed shows today only, ~750KB tail max. For history, ask for the Telegram 6pm dossier of the relevant day.
- These URLs contain a per-machine secret. This repo is private; keep it that way.
