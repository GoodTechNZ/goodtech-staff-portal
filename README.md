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
  - Shipping: changing shipping settings.
  - Sales: confirming payment received, or voiding an order.
  - Every staff/terminal admin action.
- **Lockout.** 5 wrong PINs lock the person for 15 minutes; a manager can unlock them.
- **Sign-out** happens only when someone taps Sign out, or after 5 minutes without activity. Refreshing the page keeps you signed in. The idle limit is enforced in the browser and on the server, and `portal-expire-sessions` sweeps abandoned sessions every 5 minutes. Finishing a device or order shows a confirmation and resets the screen for the next one; it doesn't sign anyone out.

## Grading

**Testing priority** sits at the top of the tab (collapsible; remembers open/closed and the Urgent / Urgent + High / All filter). It is the "Daily testing priority" routine, live: untested devices in received SOs (ASNs rows with no grade whose SO has a Delivered date), ranked by Ready For Sale days of cover at the model's sales rate. Velocity = max(sold 30d ÷ 30, sold 90d ÷ 90 × 0.8); Urgent < 7 days, High < 14, Medium < 30, else Low; fewer than 4 sold in 30 days drops a tier; Test now = units to reach 21 days of cover, capped at the number waiting. Sales and stock come from `reporting_cache.portal_testing_demand`, refreshed hourly at :20 (5am–10pm NZ) by cron `portal-testing-demand` (`portal_testing_demand_refresh()`, ~60 s); the ranking itself is `portal_testing_priority()` (gateway `grading.priority`).

Scan a serial/IMEI, grade it, record the 12 functional tests and the destination, then save. The tester
and date always come from the signed-in session.

**A device is graded once.** Scanning a graded device (in the portal or already in the Grading sheet)
shows its grade and location instead of the grading form. Staff can then:

- **Move it** (Ready For Sale / Repairs / Locked) and update its status note and notes. The change is
  queued for the Grading row like any save and recorded in `operations.device_transfers`.
- **Managers: Change product code** (grade, colour or model correction). See below.

The database refuses a second grading even if the screen is bypassed (`portal_grading_save`).
Duplicate saves can be cancelled with `portal_grading_dismiss(record, reason)` (outbox status `dismissed`).


## Shipping

Scan the SO (or label tracking number), scan each device IMEI, print the label, then Ship. Both scan boxes submit by themselves (no Enter needed) about 0.15 s after a barcode scan, detected by scanner-speed keystrokes (5+ characters under 35 ms apart on average). Anything typed or pasted by hand waits for Enter. If an IMEI isn't in the grading records, the packer is asked to confirm the device in hand is the model sold (one button per product still to scan). Confirming records a `manual_not_found` verification in staff-shipping with an automatic reason, against the signed-in name; it shows as a shipping override in the daily summary flags. No PIN is needed. Wrong devices (IMEI maps to another SKU) still can't be overridden.

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
`portal_config.dashboard_terminals` (Fraser's phone, MacBook and home PC). There's no extra PIN on the
page: the portal sign-in PIN and its 5-minute idle sign-out are the protection. The nav link only
appears where access is allowed. Devices are ticked under "Devices with access" at the bottom of
the page.

Periods: Today, Yesterday, and 7 or 30 full days ending yesterday (NZ time; today is not included).

Sales are net of returns. Returns credited in the period (by credit date) come off units, revenue
and GP. A returned item goes back into stock at its current Cin7 average cost; an accessory with no
cost gives back its whole credit. Models, channels and staff are net too. The return rate compares
device returns with gross devices sold.

Sales type: Online (Shopify: website, Reebelo, Trade Me), In-store sales (in-store devices and accessories), Repairs (Repairs sales group or rep), Replacement and Warranty (Cin7 sales rep), net of returns.

Staff sales: lines with no salesperson are labelled **Shopify** when the order came through Shopify (website, Reebelo, Trade Me), otherwise by the Cin7 sales rep role (In-Store Sales, Replacement, Repairs, Warranty); anything left shows as "No salesperson". Returns have no source field, so blank-staff returns on Website/Reebelo/Trade Me count as Shopify.

Email (`portal_sales_ops_email`, read live from the service mailbox sync):
- Replies sent in the period, by staff (by email sign-off), with conversations answered and median
  first-reply time.
- Customer threads open now: the last message is from the customer and unanswered, grouped by age.
  Only people we've replied to before, or personal addresses (Gmail, Hotmail, iCloud…), are counted,
  so supplier stock lists, marketing and notifications are left out. Threads waiting over 14 days are
  counted separately. After we've replied, a customer follow-up only keeps the thread open if it
  needs an answer (`portal_email_is_closing`): a question mark, or a complaint/problem word (still not
  working, refund, broken, faulty, wrong, missing, not received, error, urgent, disappointed, cancel…).
  Thanks, OKs, emoji reactions and confirmations ("please proceed", "I'll bring it in") are left out
  and shown as a count. Threads we haven't replied to are always counted.

Data: `portal_sales_ops(period)` over a 31-day copy of `excel_sales` / `excel_returns`
(`reporting_cache.portal_sales_ops_*`). The copy is refreshed every 10 minutes, 5am–11pm NZ, by
`portal_sales_ops_refresh()`, because the views take 6–8 s each. Shipping completions, grading
records and the weeks-of-cover scorecard are read live.
