# ONTrac Logiwa Middleware - Build Progress

## What This Is
A Railway-hosted Node.js middleware that connects Logiwa (WMS) to OnTrac's shipping API.
Logiwa calls this middleware to get rates, create labels, void labels, and run end-of-day reports.

## Account Details
- Customer ID: D991
- Company: ShipFlow
- Customer Branch: SHFLNBNJ
- Injection Facility: SBSC (South Brunswick)
- TenderAt / Return Address: 625 JERSEY AVE, STE 9, NEW BRUNSWICK, NJ 08901-3679
- Tender Time: 16:00 ET (4:00 PM)
- Departure Time: 17:00 ET (5:00 PM)
- Default Service: GRND
- WSID / WSKey: stored in Railway environment variables (never committed to git)

## Live URLs
- Railway app: https://ontrac-logiwa-middleware-production.up.railway.app
- Health check: https://ontrac-logiwa-middleware-production.up.railway.app/
- Get Rate:     https://ontrac-logiwa-middleware-production.up.railway.app/get-rate
- Create Label: https://ontrac-logiwa-middleware-production.up.railway.app/create-label
- Void Label:   https://ontrac-logiwa-middleware-production.up.railway.app/void-label
- End of Day:   https://ontrac-logiwa-middleware-production.up.railway.app/end-of-day-report

## GitHub Repo
https://github.com/ezrashipflow/ontrac-logiwa-middleware

## OnTrac API Notes
- Auth: WSID + WSKey passed directly in the URL path -- no token refresh needed
- Get Rate: POST /Method/ServicesAndCharges/v3/json/{WSID}/{WSKey}
- Create Label: POST /Method/PlaceOrder/v3/json/{WSID}/{WSKey}/0/1/P4x6
  - Test mode: swap 0 -> 1 in the URL
  - Label format: P4x6 = PDF, Z4x6 = ZPL
- Void Label: NOT supported by OnTrac API (middleware returns success stub)
- End of Day: NOT supported by OnTrac API (middleware returns success stub)

## Service Codes
| Logiwa shippingOption | OnTrac ServiceCode |
|---|---|
| GRND (or default) | GRND |
| GRES | GRES |
| XPRS / EXPRESS | XPRS |

---

## Session Log

### Session 1 - 2026-05-07
**Status: Deployed to Railway. Ready for Logiwa configuration.**

Completed:
- Reviewed DHL and UNiUNi middleware repos for pattern
- Read full OnTrac API documentation (ws.ontrac.com)
- Retrieved OnTrac sample payload for SHFLNBNJ branch
- Built server.js v1.0.1 with exact account details:
  - InjectionFacilityCode: SBSC
  - TenderDateTime: 16:00 ET, Departure: 17:00 ET
  - PostalCode: 08901-3679 (zip+4)
- Created package.json, env.example, .gitignore, PROGRESS.md
- Created GitHub repo: https://github.com/ezrashipflow/ontrac-logiwa-middleware
- Deployed to Railway
- Railway domain: ontrac-logiwa-middleware-production.up.railway.app

Railway environment variables set:
- [x] ONTRAC_WSID
- [x] ONTRAC_WSKEY
- [x] ONTRAC_CUSTOMER_BRANCH = SHFLNBNJ

Next steps (pick up here next session):
1. Confirm env variables are added in Railway (ONTRAC_WSID, ONTRAC_WSKEY, ONTRAC_CUSTOMER_BRANCH)
2. Hit the health check URL to confirm app is running:
   https://ontrac-logiwa-middleware-production.up.railway.app/
3. Configure Logiwa custom carrier (see Logiwa Setup section below)
4. Test with a real Logiwa shipment order
5. Confirm label generates and tracking number appears in Logiwa

## Logiwa Custom Carrier Setup
In Logiwa go to: Settings -> Carriers -> Add Custom Carrier

Field values:
- Carrier Name: ONTrac
- Get Rate URL:     https://ontrac-logiwa-middleware-production.up.railway.app/get-rate
- Create Label URL: https://ontrac-logiwa-middleware-production.up.railway.app/create-label
- Void Label URL:   https://ontrac-logiwa-middleware-production.up.railway.app/void-label
- End of Day URL:   https://ontrac-logiwa-middleware-production.up.railway.app/end-of-day-report
