# GoodTech Staff Portal

Front end for shared staff terminals, hosted on Cloudflare Pages. It runs on the existing Supabase
project `mniqcdqajhhsrvfagmra`.

```
Browser (Cloudflare Pages, static)
   │  x-terminal-token  (per enrolled terminal, localStorage)
   │  x-session-token   (per signed-in person after name + PIN, memory only)
   ▼
supabase/functions/staff-portal      ← this repo: auth, PIN checks, activity log, sign-out rules
   ├─ Grading  → portal_grading_* RPCs → portal_grading_outbox → sheet worker → ASNs DB / Grading tab
   ├─ Shipping → existing staff-shipping function (Cin7, eShip, Shopify)
   ├─ Sales    → existing staff-sales-desk function (Cin7)
   ├─ Dashboard→ portal_ops_dashboard (orders, pick-ups, high alert, returns, Cin7 Repairs/Locked)
   │             + asn_ops_summary (received not tested, graded / repairs / locked not POed)
   └─ Admin    → portal_daily_summary / portal_health, staff PINs and terminals
```

## Staff sign-in

- **Terminals** are enrolled once with a single-use code that only Fraser can create (Admin → Enrol a new terminal, with PIN). A code expires after 15 minutes and only works from the same network (public IP, i.e. the same Wi-Fi) it was created on. Managers can revoke a terminal from Admin.
- **Name + PIN.** On an enrolled terminal, staff tap their name, then enter their 4-digit PIN.
  - The names come from the `staff` table: Crystal (formerly Wei), Li (formerly Liwei), David, Fraser (manager), Haobin, Piper, Tallula and Tristan.
  - First use: someone with no PIN yet sets one, entering it twice. Weak PINs like 1234 or 0000 are refused.
  - Managers see a **PIN set** flag that day so they can confirm it was really that person.
  - A manager can reset a PIN from the Dashboard; the person then sets a new one at next sign-in.
- **PIN again** for sensitive actions:
  - Grading: changing an existing grading record.
  - Shipping: manual IMEI override, or changing shipping settings.
  - Sales: confirming payment received, or voiding an order.
  - Every staff/terminal admin action.
- **Lockout.** 5 wrong PINs lock the person for 15 minutes; a manager can unlock them.
- **Sign-out** happens only when someone taps Sign out, or after 5 minutes without activity. Refreshing the page keeps you signed in. The idle limit is enforced in the browser and on the server, and `portal-expire-sessions` sweeps abandoned sessions every 5 minutes. Finishing a device or order shows a confirmation and resets the screen for the next one; it doesn't sign anyone out.

## Grading

Scan a serial/IMEI, grade it, record the 12 functional tests and the destination, then save. The tester
and date always come from the signed-in session.

**A device is graded once.** Scanning a graded device (in the portal or already in the Grading sheet)
shows its grade and location instead of the grading form. Staff can then:

- **Move it** (Ready For Sale / Repairs / Locked) and update its status note and notes. The change is
  queued for the Grading row like any save and recorded in `operations.device_transfers`.
- **Managers: Change product code** (grade, colour or model correction). See below.

The database refuses a second grading even if the screen is bypassed (`portal_grading_save`).
Duplicate saves can be cancelled with `portal_grading_dismiss(record, reason)` (outbox status `dismissed`).

## Product-code changes (managers, PIN to confirm)

- **One device** (Grading → scan → *Change product code*): pick the new SKU (other grades are one tap)
  and a reason, review the live Cin7 balances, confirm with the PIN.
- **Stock without IMEIs** (Admin → *Move stock between product codes*): from/to SKU, location, quantity.

Cin7 is changed with one stock adjustment, reference `Code change <id>`. It takes N off the old SKU and
puts N on the new SKU at the same location, at the old SKU's average cost. Before each step the live
balances are re-checked, and a draft is created before it's completed. For a device, the PO must show
the IMEI received and there must be no shipping record.

After Cin7, a device change:

1. queues the new grade and colour for its Grading row (sheet worker, within a minute or two);
2. makes ASNs DB (`AsnOpsSync.gs`, every 10 minutes) check ASNs Code (AE). If the formula already
   shows the new SKU it is left alone; otherwise AE is set to the new SKU and the old code is kept in
   Old Stock Code (AJ).

Progress and anything that needs review are listed in Admin → *Product-code changes*
(`portal_code_changes`).

## Daily summaries and flags

`portal_daily_summary(day, staff)` builds each person's NZ-day summary from `portal_activity`:

- devices graded, by grade, linked and regraded;
- orders shipped, devices verified and overrides;
- sales completed and their total, plus voids;
- sign-ins, idle sign-outs and errors.

Flags raised:

- PIN lockout, or 3+ wrong PINs
- PIN set for the first time
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

**Enrolment codes** are created in Admin by Fraser (`staff.can_enrol`). To let someone else create them: `update staff set can_enrol = true where display_name = '…';`

## Known limits

- `staff-sales-desk` checks the staff name against its own hard-coded list (Crystal, David, Fraser, Haobin, Li, Tallula, Teddy, Tim, Tristan, plus old names). Staff added in the portal can't create sales until that list is updated or switched to read the `staff` table.

## ASNs DB sync (Dashboard testing and PO cards)

`apps-script/AsnOpsSync.gs` runs inside ASNs DB every 10 minutes. It reads the sheet and changes nothing. It posts:
- the ASNs rows whose PO (column AG) is blank;
- the Shipment Check SO and Delivered columns.

It posts to the gateway's `sync.asn` action, authenticated by the `x-sync-token` header. The token's SHA-256 is stored in `portal_config.asn_sync_token_sha256`. To rotate it, generate a new token, update that hash and the `PORTAL_SYNC_TOKEN` script property.

## Sales & Ops (managers, approved devices)

A manager-only page, served by its own edge function `portal-sales-ops`. On every request the
function checks the portal session, that the role is manager, and that the terminal is listed in
`portal_config.dashboard_terminals`. The page asks for the PIN each time it's opened. It locks
after 5 minutes without use, when you leave it, or when it detects a badge or barcode scan, and the
server lets the PIN unlock lapse after 5 idle minutes. The nav link only appears where access is
allowed. Devices are ticked under "Devices with access" at the bottom of the page.

Periods: Today, Yesterday, and 7 or 30 full days ending yesterday (NZ time; today is not included).

Sales are net of returns. Returns credited in the period (by credit date) come off units, revenue
and GP. A returned item goes back into stock at its current Cin7 average cost; an accessory with no
cost gives back its whole credit. Models, channels and staff are net too. The return rate compares
device returns with gross devices sold.

Data: `portal_sales_ops(period)` over a 31-day copy of `excel_sales` / `excel_returns`
(`reporting_cache.portal_sales_ops_*`). The copy is refreshed every 10 minutes, 5am–11pm NZ, by
`portal_sales_ops_refresh()`, because the views take 6–8 s each. Shipping completions, grading
records and the weeks-of-cover scorecard are read live.
