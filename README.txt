SDT ADMIN - CDBS BALANCE NOTES
==============================

WHAT IT DOES
Reads your CDBS checking report (with balances filled in from PRODA) and
writes one note into each patient's file in Principle.

The note always reads:
  CDBS balance: <whatever is in the cell> (checked in PRODA <today's date>).

TWO STEPS
STEP A - COLLECT MEDICARE DETAILS (optional but saves a lot of time)
Load the exported report, then press "Collect details". The program opens
each patient's file, reads their Medicare number, sub numerate and expiry,
looks up their date of birth, and saves a NEW spreadsheet with those columns
added. Nothing is written to any patient file.
Do your PRODA checks from that spreadsheet.

STEP B - WRITE THE NOTES
Fill in the CDBS Available column on that spreadsheet, load it back in,
check the preview, and write the notes.

HOW TO USE IT
1. Export the CDBS checking report from Principle.
2. Add a column called exactly:  CDBS Available
3. Someone checks each balance in PRODA and fills in that column.
   - Numbers are tidied automatically ($842.50)
   - Anything else (e.g. "Not eligible") is written word for word
   - Blank cells are skipped
4. Open this program and choose the file.
5. Check the preview table - it shows the exact note for every patient.
6. Press "Write these notes".

LOGGING IN
When you open the program it checks Principle straight away.
  - Green "Connected to Principle" means you are ready to go.
  - If you are signed out, the login page opens by itself. Log in
    (email/password or Google) and the window closes on its own.
The login is remembered, so most days you will not see it.

It also checks again the moment you press "Write these notes", so a
session that expired while the program sat open cannot cause a run of
failures - it stops you first and writes nothing.

WHILE IT RUNS
Principle is parked off-screen, so you can keep working. Roughly 5-8
seconds per patient. Press Stop to halt cleanly after the current patient.

SAFETY
- Nothing is written until you approve the preview.
- The patient is identified by the ID in the Appointment Link column,
  so there is no name guessing.
- Before writing, the patient's name on the file is checked against the
  sheet. A mismatch is reported, not written.
- Notes already written are remembered, so re-running the same sheet will
  not write them twice.
- A results file is saved to your Documents folder after every run.

EVERYTHING STAYS ON THIS COMPUTER
The spreadsheet, the progress record and the results file never leave
this machine.

KEEPING IT IN SYNC
principle-engine.js is shared with the Command Center app. If Principle
changes their interface and one app is fixed, copy that same file to the
other so both keep working.
