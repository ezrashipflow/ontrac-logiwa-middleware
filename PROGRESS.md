# ONTrac Logiwa Middleware - Build Progress

## What This Is
A Railway-hosted Node.js middleware that connects Logiwa (WMS) to OnTrac's shipping API.
Logiwa calls this middleware to get rates, create labels, void labels, and run end-of-day reports.

## Credentials & Config
- CustomerBranch: SHFLNBNJ
- WSID / WSKey: stored in Railway environment variables (never committed to git)
- Railway URL: (update this once deployed)

## OnTrac API Notes
- Auth: WSID + WSKey passed directly in the URL path -- no token refresh needed
- Get Rate: POST /Method/ServicesAndCharges/v3/json/{WSID}/{WSKey}
- Create Label: POST /Method/PlaceOrder/v3/json/{WSID}/{WSKey}/0/1/P4x6
  - Test mode: swap 0 -> 1 in the URL
  - Label format: P4x6 = PDF, Z4x6 = ZPL
- Void Label: NOT supported by OnTrac API (middleware returns success stub)
- End of Day: NOT supported by OnTrac API (middleware returns success stub)
- Tracking: GET /Method/Track/v3/json/{WSID}/{WSKey}/{TRACKINGNUMBER}

## Service Codes
| Logiwa shippingOption | OnTrac ServiceCode |
|---|---|
| GRND (or default) | GRND |
| GRES | GRES |
| XPRS / EXPRESS | XPRS |

---

## Session Log

### Session 1 - 2026-05-07
**Status: GitHub repo created, code written, NOT YET deployed to Railway**

Completed:
- Reviewed DHL and UNiUNi middleware repos for pattern
- Read full OnTrac API documentation (ws.ontrac.com)
- Retrieved OnTrac sample payload for SHFLNBNJ branch
- Built server.js matching exact DHL/UNiUNi pattern
- Created package.json, env.example, .gitignore
- Created GitHub repo: https://github.com/ezrashipflow/ontrac-logiwa-middleware
- Pushed all files to main branch

Next steps (pick up here next session):
1. Deploy to Railway (same way as DHL/UNiUNi)
   - Create new Railway project
   - Connect to GitHub repo ezrashipflow/ontrac-logiwa-middleware
   - Add environment variables: ONTRAC_WSID, ONTRAC_WSKEY, ONTRAC_CUSTOMER_BRANCH
2. Get the Railway public URL and update MIDDLEWARE_URL env var if needed
3. Configure Logiwa custom carrier:
   - Carrier name: ONTrac
   - get-rate URL: https://<railway-url>/get-rate
   - create-label URL: https://<railway-url>/create-label
   - void-label URL: https://<railway-url>/void-label
   - end-of-day-report URL: https://<railway-url>/end-of-day-report
4. Test with a real Logiwa shipment order
5. Confirm label generates and tracking number appears in Logiwa
