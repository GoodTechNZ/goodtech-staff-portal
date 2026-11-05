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
