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

## Dashboard: connect the ASN / Shipment Check sources
Four cards say "Not connected": Received · not tested, Graded · not POed, Repairs · not POed and Locked · not POed. They need the live ASN sheet (PO column) and the Shipment Check delivery dates. The PO links stored in Supabase are incomplete: they give about 16,700 "not POed" against 20 and 6 on the existing Operations Dashboard. Either sync those sheets into Supabase, or point the portal at whatever the existing dashboard reads.

## Dashboard: NZ public holidays
High alert counts Monday–Friday business days but doesn't skip NZ national and Auckland anniversary holidays yet.
