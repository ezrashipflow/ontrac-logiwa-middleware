# ONTrac Logiwa Middleware — Session Handoff
**Date:** 2026-05-07
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

### 8. Current status at end of session
- Middleware is deployed and running on Railway
- Logiwa is configured with all URLs
- Test was attempted with a Detroit, MI order (order #4748532755-A)
- Rate call reached OnTrac API successfully (no more Attributes error)
- Last error seen: `InjectionPostalCodeNotAllowed` from the ServicesAndCharges call
  - This was FIXED in the last push — the fix removes InjectionPostalCode from get-rate
- The bad service area check was also REMOVED in the last push
- **Railway has redeployed with both fixes but a live test was NOT completed before end of session**

---

## Where to Pick Up Next Session

### Step 1 — Verify the fix worked
1. Open Railway logs tab
2. In Logiwa, find order #4748532755-A (Detroit, MI) or any order
3. Try to get a rate using ONTrac
4. In Railway logs you should see either:
   - `[GET-RATE] OK` with rates — success
   - `[GET-RATE] ERROR` with a new error message — bring that error here

### Step 2 — Test create label
Once get-rate works, test creating an actual label:
1. Pick an order going to any US destination
2. Select ONTrac / OnTrac Ground as the carrier
3. Click Create Label
4. Confirm a tracking number appears and a label PDF is generated

### Step 3 — If any errors come up
Paste the Railway logs here and we debug. The logs are very detailed.

### Step 4 — When everything works
- Do a real shipment to confirm the label scans and tracking works with OnTrac
- Contact your OnTrac rep to confirm the account is active for API usage

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
