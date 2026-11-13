# GoodTech Staff Portal

Front end for shared staff terminals, hosted on Cloudflare Pages. It runs on the existing Supabase
project `mniqcdqajhhsrvfagmra`.

```
Browser (Cloudflare Pages, static)
   │  x-terminal-token  (per enrolled terminal, localStorage)
   │  x-session-token   (per signed-in person after tapping their name)
   ▼
supabase/functions/staff-portal      ← this repo: auth, Admin unlock, activity log, sign-out rules
   ├─ Grading  → portal_grading_* RPCs → portal_grading_outbox → sheet worker → ASNs DB / Grading tab
   ├─ Shipping → existing staff-shipping function (Cin7, eShip, Shopify)
   ├─ Returns  → portal-returns function (returns log, eShip labels, Replacement / Warranty SOs)
   ├─ Sales    → existing staff-sales-desk function (Cin7)
   ├─ Dashboard→ portal_ops_dashboard (orders, pick-ups, high alert, returns, Cin7 Repairs/Locked)
   │             + asn_ops_summary (received not tested, graded / repairs / locked not POed)
   └─ Admin    → managers only (Fraser): portal_daily_summary / portal_health, staff PINs and terminals; hidden from other staff
```

## Staff sign-in

- **Terminals** are enrolled once with a single-use code that only Fraser can create (Admin → Enrol a new terminal). A code expires after 15 minutes and only works from the same network (public IP, i.e. the same Wi-Fi) it was created on. Managers can revoke a terminal from Admin.
- **Name only.** On an enrolled terminal, staff tap their name to sign in. No PIN.
  - The names come from the `staff` table: Crystal (formerly Wei), Li (formerly Liwei), David, Fraser (manager), Haobin, Piper, Tallula and Tristan.
  - **Switch user:** the name in the header is a menu. Pick another name to end this session and sign in as them. On phones, Sign out is in this menu too.
  - Signing in elsewhere ends that person's other session, as before.
- **PIN only for Admin and Sales & Ops.** Opening either tab shows a PIN pad. The manager's PIN (`portal_session_elevate`, called by gateway `auth.unlock`) unlocks the session (`portal_sessions.elevated_at`) until sign-out, switching user or the 5-minute idle sign-out. The same unlock covers confirming a Cin7 product-code change from Grading.
  - Enforced on the server: the gateway refuses every `admin.*` action and `stock.commit` with `403 {elevate:true}`, and `portal-sales-ops` refuses its data and device actions, until the session is unlocked.
  - Everything else needs no PIN: re-grading, payment received and void in Sales, and shipping settings ask Confirm/Cancel at most.
- **No PIN on Fraser's own devices.** On a terminal listed in `portal_config.pinless_terminals` (Fraser's 17 Pro, MacBook and Home PC), Admin and Sales & Ops are already unlocked.
- **Lockout.** 5 wrong PINs lock the PIN for 15 minutes; a manager can unlock it from Admin.
- **Sign-out** happens only when someone taps Sign out, or after 5 minutes without activity. Refreshing the page keeps you signed in. The idle limit is enforced in the browser and on the server, and `portal-expire-sessions` sweeps abandoned sessions every 5 minutes. Finishing a device or order shows a confirmation and resets the screen for the next one; it doesn't sign anyone out.

## Grading

**Supplier returns · day 7+** sits above it: untested and Locked devices in received orders on day 7 or later since delivery (day 7 is the last day to return devices to the supplier), grouped by order with day 7 first and highlighted. It shows model, serial, grade (or Untested), location and status, plus the orders reaching day 7 tomorrow. Days = NZ today − Delivered date in ASNs Shipment Check (`portal_supplier_cutoff()`, served with `grading.priority`).

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

**Sales:** once the order is in Cin7 (Picking, or Paid & invoiced before handover), **Print pick list** prints one page in the Dashboard pick-list layout: SO, customer, IN-STORE, items grouped by SKU with the scanned IMEIs, the order memo, and a Picked by line. The scan box submits by itself for a barcode scanner (same rule as Shipping). Add-ons appear under each device in the cart, only once it's added, and only those that fit it: iPhone → screen protector, clear gel case, and MagSafe clear / black silicone cases (iPhone 12+ and Air; not SE or 16e); iPad → screen protector; Pixel → screen protector and gel case; Galaxy phones → gel case, plus the screen protector on S21–S24.

## Returns

A tab for all staff, served by its own edge function `portal-returns` (same portal session check as the gateway).

1. **Find** the order: name, email, phone, SO, Shopify # or IMEI (`portal_returns_find`, Cin7 sales from the last 3 years). Searches use `portal_sales_search` (one slim row per sale with trigram indexes, kept current by a trigger on `cin7_sales_raw`), so they take well under a second instead of reading every sale's full JSON.
2. **Log the return** (`portal_returns`, numbered RT1001…): items (with IMEI), reason, details, what the customer wants (refund, replacement, warranty repair, not decided) and contact / address. Recorded against the signed-in staff; every step goes in `portal_return_events` and the activity log.
3. **Email return label**: creates an eShip order addressed to GoodTech (Service | GoodTech, 1A Elgin Street), prints the label, and queues the PDF in `portal_outbound_email`. `apps-script/ReturnsMailer.gs`, running in the service mailbox, sends it within a minute, so replies come back to the service inbox. Label settings (CourierPost, Courier Pack A5) are copied once from the latest manual return label and kept in `portal_config.returns_eship_return_template`.
4. **Mark received**: scan the device back in. It must match the IMEI on the return.
5. **Replacement / warranty**: creates and authorises a Cin7 SO (rep Replacement or Warranty, reference RT1001-R / -W, the customer's delivery address, prices as entered) and a matching eShip order. Then **scan that SO in Shipping**, verify the device, print the label and Ship, as for any other SO. Courier settings are copied from a recent Shopify courier parcel (`returns_eship_outbound_template`).
6. **Close** with an outcome note (e.g. the credit note number), or cancel with a reason.

Credit notes and refunds are still done in Cin7.

**Mailer setup (once):** in the service mailbox account, create an Apps Script project with `apps-script/ReturnsMailer.gs`, set the script property `RETURNS_MAIL_TOKEN` (its SHA-256 is `portal_config.returns_mail_token_sha256`), run `sendQueuedReturnEmails` once to grant Gmail access, and add an every-minute trigger.

## Order links

Cin7 SO numbers and Shopify order numbers (#39430) shown in the portal link to the order (new tab): SOs to `https://inventory.dearsystems.com/Sale#<sale id>~<sale id>~tabOrder`, # numbers to `https://admin.shopify.com/store/goodtech/orders/<order id>`. Used on the Dashboard order lists and pick results, the Shipping order header and the Sales order heading. `orderRef()` (src/orderlinks.ts) renders the number and one batched `dashboard.links` call (`portal_order_links`, from `cin7_sales_raw` and `shopify_orders`) fills in the links. Numbers that aren't found stay plain text. Supplier (HYLA) order numbers aren't linked.

## Product-code changes (managers, unlocked session)

- **One device** (Grading → scan → *Change product code*): pick the new SKU (other grades are one tap)
  and a reason, review the live Cin7 balances, then confirm (asks for the PIN if the session isn't unlocked yet).
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
`portal_config.dashboard_terminals` (Fraser's phone, MacBook and home PC). The session must also be
unlocked with the manager's PIN (see Staff sign-in), unless it is one of Fraser's own devices. The nav link only
appears where access is allowed. Devices are ticked under "Devices with access" at the bottom of
the page.

Periods: Today, Yesterday, and 7 or 30 full days ending yesterday (NZ time; today is not included).

Sales are net of returns. Returns credited in the period (by credit date) come off units, revenue
and GP. A returned item goes back into stock at its current Cin7 average cost; an accessory with no
cost gives back its whole credit. Models, channels and staff are net too. The return rate compares
device returns with gross devices sold.

Channels always list Website, In-store, Reebelo and Trade Me ($0 when a channel has no sales in the period). Sales type: Website, Reebelo, Trade Me, In-store sales (in-store devices and accessories), Repairs (Repairs sales group or rep), Replacement and Warranty (Cin7 sales rep), net of returns.

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
