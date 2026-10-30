# GoodTech Staff Portal

Front end for shared staff terminals, hosted on Cloudflare Pages. It runs on the existing Supabase
project `mniqcdqajhhsrvfagmra`.

```
Browser (Cloudflare Pages, static)
   │  x-terminal-token  (per enrolled terminal, localStorage)
   │  x-session-token   (per signed-in person, memory only)
   ▼
supabase/functions/staff-portal      ← this repo: auth, PIN checks, activity log, sign-out rules
   ├─ Grading  → portal_grading_* RPCs → portal_grading_outbox → sheet worker → ASNs DB / Grading tab
   ├─ Shipping → existing staff-shipping function (Cin7, eShip, Shopify)
   ├─ Sales    → existing staff-sales-desk function (Cin7)
   └─ Dashboard→ portal_daily_summary / portal_health
```

## Staff sign-in

- **Terminals** are enrolled once with the enrolment code (bcrypt hash in `portal_config`). Managers can revoke a terminal from the Dashboard.
- **Badge + PIN.** The `staff` table is the roster: Crystal (formerly Wei), Li (formerly Liwei), David, Fraser (manager), Haobin, Tallula and Tristan.
  - First use of a badge: the person picks their name from the staff who have no badge yet and sets a 4-digit PIN. PINs like 1234 or 0000 are rejected.
  - Managers see a **badge registered** flag that day.
- **PIN again** for sensitive actions:
  - Grading: changing an existing grading record.
  - Shipping: manual IMEI override, or changing shipping settings.
  - Sales: confirming payment received, or voiding an order.
  - Every staff/terminal admin action.
- **Lockout.** 5 wrong PINs lock the person for 15 minutes; a manager can unlock them.
- **Sign-out** happens:
  - after 10 minutes idle (enforced in the browser and on the server, and swept every 5 minutes by `portal-expire-sessions`);
  - after each completed device (grading save or link);
  - after each completed order (ship, pickup ready or collected, sale handed over).

## Grading

Scan a serial/IMEI, grade it, record the 12 functional tests and the destination, then save. The tester
and date always come from the signed-in session.

**Serial already in the Grading sheet:**

- **Same grade:** the save links to the existing row instead of blocking or writing a duplicate.
  - The screen offers *Same grade — link to row N*, which writes nothing.
  - The database also links a save that races a manual sheet entry.
  - The worker's `CONFLICT: Serial was added to the sheet separately.` is resolved automatically on the next claim, ack or import.
  - The outbox status is `linked`.
- **Different grade:** the existing row is updated, which needs the PIN.
- Other conflicts (manual sheet edits) stay as `conflict` for review. The Dashboard shows how many there are.

## Daily summaries and flags

`portal_daily_summary(day, staff)` builds each person's NZ-day summary from `portal_activity`:

- devices graded, by grade, linked and regraded;
- orders shipped, devices verified and overrides;
- sales completed and their total, plus voids;
- sign-ins, idle sign-outs and errors.

Flags raised:

- PIN lockout, or 3+ wrong PINs
- badge registered
- shipping override
- 3+ scan errors
- 3+ devices graded under 30 s apart
- regrades
- grading conflicts
- voided sales
- lines sold below catalogue price
- 5+ errors

A nightly job (`portal-daily-rollup-*`) stores the day in `portal_daily_summaries`.

## Develop

```bash
npm install
npm test          # vitest: gateway rules, grading form, idle timer
npm run typecheck # front end + edge function
npm run dev
```

## Deploy

**Database:** apply `supabase/migrations/*` (already applied to `mniqcdqajhhsrvfagmra`).

**Edge function:**

```bash
supabase functions deploy staff-portal --no-verify-jwt --project-ref mniqcdqajhhsrvfagmra
```

The function does its own terminal and session auth. Secrets:

- `PORTAL_BRIDGE_TOKEN`: the existing sales-desk bridge token, the one whose SHA-256 is `staff_sales_desk_config.bridge_token_sha256`. Shipping and Sales stay disabled until it is set.
- `PORTAL_ALLOWED_ORIGINS` (optional): a comma-separated list, e.g. `https://goodtech-staff.pages.dev`. Defaults to `*`.

**Cloudflare Pages:**

- Connect this repo.
- Build command: `npm run build`. Output directory: `dist`.
- Optional environment variable: `VITE_PORTAL_API`; it defaults to the project's function URL.
- `public/_headers` sets the CSP and no-index headers.

**Rotate the terminal enrolment code** (existing terminals keep working):

```sql
update portal_config set value = extensions.crypt('NEW-CODE-HERE', extensions.gen_salt('bf', 10)), updated_at = now()
 where key = 'terminal_enrol_code_hash';
```

## Known limits

- `staff-sales-desk` checks the staff name against its own hard-coded list (Crystal, David, Fraser, Haobin, Li, Tallula, Teddy, Tim, Tristan, plus old names). Staff added in the portal can't create sales until that list is updated or switched to read the `staff` table.
