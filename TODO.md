# To do

## PIN-only sign-in
Replace "tap your name, then PIN" with a single PIN pad: the PIN identifies the person.

- PINs must be unique across staff.
- Decide first-time setup:
  - a small "New here? Set your PIN" link to the name list (self-chosen PIN, refused if taken); or
  - managers assign PINs in the Dashboard.
- Lockout moves from per-person to per-terminal (short pause after several misses).
- Show "Signed in as <name> — Not you?" so a mistyped PIN that hits someone else is obvious.
- PIN-again on sensitive actions becomes a confirmation step. Optionally require a manager PIN for overrides and voids instead.

## Connect Shipping and Sales
Set the `PORTAL_BRIDGE_TOKEN` edge-function secret to the existing sales-desk bridge token.

## Sales staff list
`staff-sales-desk` checks staff names against its own hard-coded list. Update it, or make it read the `staff` table, so Piper and new staff can make sales.

## Dashboard: install the ASNs DB sync script
`apps-script/AsnOpsSync.gs` feeds the Testing and "not POed" cards. Add it to ASNs DB (Extensions → Apps Script), set the `PORTAL_SYNC_TOKEN` script property, then run `installAsnOpsTrigger` once. Until then the cards show a one-off snapshot loaded on 6 Nov and say when it was read.

## Dashboard: NZ public holidays
High alert counts Monday–Friday business days but doesn't skip NZ national and Auckland anniversary holidays yet.

## Product-code changes: update the ASNs DB script
Paste the new `apps-script/AsnOpsSync.gs` over the old one in ASNs DB (no other setup). Until then a
device's Cin7 adjustment and Grading row still update, but its change stays at "updating sheets" and
ASNs Code (AE) isn't checked.

## Grading import
`refreshFastGrading` (bound to ASNs DB) imports the Grading sheet every 10 minutes. It stopped for a
day on 5 Nov (duplicate key, fixed). Check its trigger stays installed.
