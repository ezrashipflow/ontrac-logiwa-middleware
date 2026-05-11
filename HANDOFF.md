# ONTrac Logiwa Middleware — Session Handoff
**Last updated:** 2026-05-11
**Built by:** Claude Code (AI assistant) with Ezra (ShipFlow)

---

## What We Built

A Node.js middleware deployed on Railway that connects **Logiwa WMS** to the **OnTrac shipping API**.
This follows the exact same pattern as ShipFlow's existing DHL and UNiUNi middlewares.

When Logiwa needs to rate shop or create a label for OnTrac, it calls this middleware.
The middleware translates the request into OnTrac's format, calls OnTrac, and sends the result back to Logiwa.

---

## GitHub Repo

**https://github.com/ezrashipflow/ontrac-logiwa-middleware**

Files:
- `server.js` — the full middleware application
- `package.json` — Node.js dependencies (express, axios, dotenv)
- `env.example` — shows what environment variables are needed (no real credentials)
- `.gitignore` — keeps .env and node_modules out of git
- `PROGRESS.md` — session log
- `HANDOFF.md` — this file

---

## Live Deployment

**Railway URL:** https://ontrac-logiwa-middleware-production.up.railway.app

Health check (open in browser to confirm it's running):
https://ontrac-logiwa-middleware-production.up.railway.app/

Should return:
```json
{ "status": "running", "service": "OnTrac <-> Logiwa Middleware", "version": "1.0.1" }
```

---

## OnTrac Account Details

| Field | Value |
|---|---|
| Customer ID | D991 |
| Company | ShipFlow |
| Customer Branch | SHFLNBNJ |
| Injection Facility | SBSC (South Brunswick, NJ) |
| TenderAt Address | 625 JERSEY AVE, STE 9, NEW BRUNSWICK, NJ 08901-3679 |
| Return Address | Same as above |
| Tender Time | 16:00 ET (4:00 PM Eastern) |
| Departure Time | 17:00 ET (5:00 PM Eastern) |
| Default Service | GRND |
| Pickup Type | OnTrac |

**API Credentials (stored in Railway environment variables — never in code):**
- `ONTRAC_WSID` — set in Railway
- `ONTRAC_WSKEY` — set in Railway
- `ONTRAC_CUSTOMER_BRANCH` = SHFLNBNJ — set in Railway

---

## How OnTrac API Works (different from DHL/UNiUNi)

| Feature | DHL/UNiUNi | OnTrac |
|---|---|---|
| Auth | OAuth token, refresh every hour | WSID + WSKey in the URL — no token needed |
| Get Rate | Separate API call | POST /Method/ServicesAndCharges/v3/json/{WSID}/{WSKey} |
| Create Label | Separate API call | POST /Method/PlaceOrder/v3/json/{WSID}/{WSKey}/0/1/P4x6 |
| Void Label | Supported | NOT supported — middleware returns success stub |
| End of Day | Manifest API | NOT supported — middleware returns success stub |
| Label format | Query param | In URL path: P4x6=PDF, Z4x6=ZPL |
| Service area | Domestic + international | US domestic, 31 states + DC |

---

## Service Codes

| Logiwa shippingOption | OnTrac ServiceCode |
|---|---|
| GRND (default) | GRND — Ground |
| GRES | GRES — Ground Residential |
| XPRS / EXPRESS | XPRS — Express |

---

## Logiwa Configuration

### Step 1 — Data Setup (DONE)
Settings → Data Setup → Custom Carrier → Create New

| Field | Value |
|---|---|
| Carrier Code | ONTRAC |
| Carrier Name | ONTrac |
| Services | GRND / GRES / XPRS |
| Package | PKG — Custom Package |

### Step 2 — Custom Carrier Integration (DONE)
Settings → Integrations → Custom Carrier → Add New

| Field | Value |
|---|---|
| Setup Name | ONTrac |
| Get Rate URL | https://ontrac-logiwa-middleware-production.up.railway.app/get-rate |
| Create Label URL | https://ontrac-logiwa-middleware-production.up.railway.app/create-label |
| Void Label URL | https://ontrac-logiwa-middleware-production.up.railway.app/void-label |
| End of Day URL | https://ontrac-logiwa-middleware-production.up.railway.app/end-of-day-report |
| API Key | blank |
| API Secret | blank |
| Token URL | blank |
| Label Format | PDF |
| Label Size | 4x6 |

---

## Full Session Timeline — What We Did

### 1. Reviewed existing repos
- Looked at DHL: https://github.com/ezrashipflow/dhl-logiwa-middleware
- Looked at UNiUNi: https://github.com/ezrashipflow/uniuni-logiwa-middleware
- Confirmed pattern: Express server, 4 endpoints, Railway deployed, env vars for credentials

### 2. Read all OnTrac API documentation
- https://ws.ontrac.com/Documentation/Order
- https://ws.ontrac.com/Samples/Order
- https://ws.ontrac.com/Samples/ServicesAndCharges
- https://ws.ontrac.com/Samples/Track
- Retrieved the ShipFlow-specific sample payload from OnTrac

### 3. Built the middleware
- Created server.js matching exact DHL/UNiUNi pattern
- All 4 Logiwa endpoints implemented
- TenderDateTime auto-computes next 16:00 ET
- ExpectedDepartureDateTime auto-computes next 17:00 ET
- Label cached in memory and served via proxy URL

### 4. Created GitHub repo and pushed
- Repo: https://github.com/ezrashipflow/ontrac-logiwa-middleware
- All files pushed to main branch

### 5. Deployed to Railway
- Connected Railway to GitHub repo
- Added 3 environment variables (WSID, WSKEY, CUSTOMER_BRANCH)
- Generated domain: ontrac-logiwa-middleware-production.up.railway.app

### 6. Configured Logiwa
- Completed Data Setup (carrier, services, packages)
- Completed Custom Carrier Integration (URLs, label settings)

### 7. Bugs fixed during testing

**Bug 1: Pieces-0-Attributes**
- OnTrac requires `Attributes: []` on every Piece object even if empty
- Fixed in commit: "Fix: add Attributes:[] to Pieces"

**Bug 2: InjectionPostalCodeNotAllowed**
- InjectionPostalCode and InjectionFacilityCode are NOT valid fields in the ServicesAndCharges (get-rate) API call
- Removed them from get-rate, kept them only in create-label (PlaceOrder)
- Fixed in commit: "Fix: remove InjectionPostalCode/FacilityCode from get-rate"

**Bug 3: Wrong service area assumption**
- Initially added a check blocking non-western-US states (wrong — OnTrac covers 31 states + DC)
- Removed the check entirely
- Fixed in commit: "Remove incorrect western-US-only service area check"

### 8. Session 2 fixes (2026-05-11)

**Bug 4: `estimatedDays: null` causing Logiwa to reject get-rate response**
- Error: `Error converting value {null} to type 'System.Int32'. Path 'data[0].rateList[0].estimatedDays'`
- Logiwa's .NET deserializer requires `estimatedDays` to be an integer, not null
- Fix: changed `estimatedDays: null` → `estimatedDays: 0`
- Committed as `cd19952` — deployed and confirmed working

**Bug 5: Label not delivered to Logiwa ("Label Result is empty. PDF header not found.")**
- Root cause: code was reading `firstPiece.Label` but OnTrac actually returns the label at `Order.Labels` (top-level), not inside Pieces
- Fix: `const labelData = firstPiece.Label || ontracOrder.Labels || ''`
- Committed as `1cd0afd` — confirmed working, label cached and served via proxy URL
- Confirmed working: logs show `[CREATE-LABEL] Label cached -> key=1LSD991000W1RFI format=pdf`

**Bug 6: get-rate returns NoRate — `TenderAt` origin address was wrong**
- get-rate was building `TenderAt` from `order.shipFrom` (whatever Logiwa sent), which could be empty or a different warehouse address
- create-label was already using the hardcoded `DEFAULT_FROM` (ShipFlow, 625 JERSEY AVE, NJ) and worked fine
- Fix: changed get-rate to also use `{ ...DEFAULT_FROM }` for `TenderAt` — same as create-label
- Committed as `611f076` — deployed

**Remaining issue: ServicesAndCharges still returns NoRate even with correct TenderAt**
- After the TenderAt fix, OnTrac is still returning `NoRate` (HTTP 400) for NJ → CA GRND
- This is **NOT a code bug** — it is an OnTrac account configuration issue
- The rate table for account SHFLNBNJ / D991 does not appear to have rates loaded for all routes
- PlaceOrder (create-label) succeeds for the same routes — a different system, unaffected by the rate table
- **Workaround in place:** when ServicesAndCharges returns NoRate, the middleware returns a `$0 stub rate` so Logiwa can still proceed to create-label (committed as `d32a865`)
- **Action needed:** Email Eugene (OnTrac head IT) to get the rate table fully loaded for all service areas
  - Sample label to attach: `https://ontrac-logiwa-middleware-production.up.railway.app/label/1LSD991000W1RFI`
  - Email was drafted in this session (ask Claude to regenerate if needed)

### 9. Current status (end of 2026-05-11 session)
- Middleware is deployed and running on Railway ✓
- Logiwa is configured with all URLs ✓
- Create label works — tracking number and PDF label generated successfully ✓
- Get rate works technically (returns a rate to Logiwa) BUT the rate is $0 because OnTrac's ServicesAndCharges API returns NoRate for this account
- Root cause of $0: rate table not fully configured on OnTrac's side for account SHFLNBNJ
- Email sent (or to be sent) to Eugene at OnTrac to resolve rate table

---

## Where to Pick Up Next Session

### Step 1 — Follow up with Eugene at OnTrac
- Confirm he received the email about the rate table
- Ask him to confirm when the rate table is loaded for all GRND/GRES/XPRS routes
- Once he confirms, remove the $0 NoRate stub from `server.js` (or keep it as a safety net — your call)

### Step 2 — Test get-rate after OnTrac fixes the rate table
1. In Logiwa, try to rate-shop any order using ONTrac
2. In Railway logs, you should now see `[GET-RATE] OK` with a real dollar amount (not the NoRate stub line)
3. Verify the rate shown in Logiwa matches what OnTrac quotes

### Step 3 — Remove the $0 stub (optional)
Once real rates come back, you can optionally remove the NoRate stub in `server.js` around line 327:
```js
// Remove or keep this block — if removed, NoRate will block Logiwa from showing the carrier
const isNoRate = e.response?.data?.ErrorMessage === 'NoRate';
if (isNoRate) { ... }
```
Keeping it is fine — it means if OnTrac ever has a route with no rate, the label can still be created.

### Step 4 — Full end-to-end test
- Ship a real order via ONTrac from Logiwa
- Confirm the label scans and tracking updates on OnTrac's tracking page

---

## Reference Links

- GitHub repo: https://github.com/ezrashipflow/ontrac-logiwa-middleware
- Railway app: https://ontrac-logiwa-middleware-production.up.railway.app
- OnTrac API docs: https://ws.ontrac.com
- OnTrac sample payload: https://ws.ontrac.com/Samples/Order
- Logiwa custom carrier data setup: https://intercom.help/mylogiwa/en/articles/7928987-custom-carrier-data-setup
- Logiwa custom carrier integration: https://intercom.help/mylogiwa/en/articles/7988801-add-a-custom-carrier-setup

---

## Other ShipFlow Middleware Repos (for reference)
- DHL: https://github.com/ezrashipflow/dhl-logiwa-middleware
- UNiUNi: https://github.com/ezrashipflow/uniuni-logiwa-middleware
