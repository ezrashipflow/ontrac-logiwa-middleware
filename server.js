/**
 * OnTrac <-> Logiwa Custom Carrier Middleware v1.0.1
 *
 * Account: ShipFlow | Customer ID: D991 | Branch: SHFLNBNJ
 * Injection Facility: SBSC (South Brunswick)
 * Tender: 16:00 ET | Departure: 17:00 ET
 *
 * Endpoints called by Logiwa:
 *   POST /get-rate          -> OnTrac ServicesAndCharges API
 *   POST /create-label      -> OnTrac PlaceOrder API (returns label + tracking)
 *   POST /void-label        -> Not supported by OnTrac (returns success stub)
 *   POST /end-of-day-report -> Not supported by OnTrac (returns stub)
 *   GET  /label/:id         -> Serves cached label binary back to Logiwa
 *
 * Auth: WSID + WSKey passed as URL path params -- no OAuth token refresh needed.
 */
const express = require('express');
const axios   = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '10mb' }));

const ONTRAC_WSID            = process.env.ONTRAC_WSID;
const ONTRAC_WSKEY           = process.env.ONTRAC_WSKEY;
const ONTRAC_CUSTOMER_BRANCH = process.env.ONTRAC_CUSTOMER_BRANCH;
const PORT = process.env.PORT || 3000;

const ONTRAC_BASE_URL = process.env.ONTRAC_BASE_URL || 'https://ws.ontrac.com';

// What to tell Logiwa when OnTrac will not price a package ("NoRate"):
//   unavailable (default) -> no rate, so rate shopping picks another carrier
//   zero                  -> the old behaviour: a $0 rate. A $0 rate wins every rate shop,
//                            so only use this as a deliberate, temporary override.
const NORATE_MODE     = (process.env.ONTRAC_NORATE_MODE || 'unavailable').toLowerCase();
// Retry on NoRate is OFF by default so a refused package adds no time to rate shopping.
// ONTRAC_NORATE_RETRY=1 turns on one retry after NORATE_RETRY_MS.
const NORATE_RETRY    = process.env.ONTRAC_NORATE_RETRY === '1';
const NORATE_RETRY_MS = parseInt(process.env.ONTRAC_NORATE_RETRY_MS || '250', 10);
// Hard cap on the EXTRA OnTrac calls the safeguards add (the retry, and the re-check at label
// time), so a slow OnTrac can never hold a packer up. The normal first rate call is unchanged.
const EXTRA_CALL_TIMEOUT_MS = parseInt(process.env.ONTRAC_EXTRA_CALL_TIMEOUT_MS || '1500', 10);
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';

const MIDDLEWARE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
  : (process.env.MIDDLEWARE_URL || 'https://ontrac-logiwa-middleware-production.up.railway.app');

const labelCache = {};
const rateCache  = {}; // orderCode -> { cost, at }, populated by get-rate, read by create-label
const RATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function rememberRate(orderCode, cost) {
  if (!orderCode || !(cost > 0)) return;
  rateCache[orderCode] = { cost, at: Date.now() };
}
// Kept (not deleted) after a label so a second box or a reprint still has its price.
function recallRate(orderCode) {
  const hit = rateCache[orderCode];
  if (!hit) return null;
  if (Date.now() - hit.at > RATE_CACHE_TTL_MS) { delete rateCache[orderCode]; return null; }
  return hit.cost;
}
setInterval(() => {
  const cutoff = Date.now() - RATE_CACHE_TTL_MS;
  for (const k of Object.keys(rateCache)) if (rateCache[k].at < cutoff) delete rateCache[k];
}, 60 * 60 * 1000).unref();

// --- ALERTS -------------------------------------------------------------------
// Rate problems are collected and posted to Slack at most once a minute, so a bad
// afternoon is one short stream of messages, not one per package. No webhook = log only.
const pendingAlerts = [];
function alertRateProblem(kind, orderCode, detail) {
  console.warn('[ALERT] ' + kind + ' order=' + orderCode + (detail ? ' ' + detail : ''));
  pendingAlerts.push({ kind, orderCode, detail });
}
async function flushAlerts() {
  if (!pendingAlerts.length) return;
  const batch = pendingAlerts.splice(0, pendingAlerts.length);
  if (!SLACK_WEBHOOK_URL) return;
  const byKind = {};
  for (const a of batch) (byKind[a.kind] = byKind[a.kind] || []).push(a.orderCode);
  const lines = Object.entries(byKind).map(([k, codes]) =>
    '• ' + k + ': ' + codes.length + ' (' + codes.slice(0, 8).join(', ') + (codes.length > 8 ? ', …' : '') + ')');
  try {
    await axios.post(SLACK_WEBHOOK_URL, { text: ':warning: OnTrac rate problem (last minute)\n' + lines.join('\n') }, { timeout: 5000 });
  } catch (e) {
    console.error('[ALERT] Slack post failed: ' + e.message);
  }
}
setInterval(flushAlerts, 60 * 1000).unref();

// --- SHIPFLOW WAREHOUSE DEFAULTS ----------------------------------------------

const DEFAULT_FROM = {
  Contact:             'Shipping Manager',
  Company:             'ShipFlow',
  StreetAddress:       '625 JERSEY AVE',
  Address2:            'STE 9',
  PostalCode:          '08901-3679',
  City:                'NEW BRUNSWICK',
  State:               'NJ',
  ISOCountryCode:      'US',
  Phone:               '9085253857',
  SpecialInstructions: '',
};

const INJECTION_FACILITY_CODE   = 'SBSC';
const INJECTION_POSTAL_CODE     = '08901';
const CUSTOMER_BRANCH_POSTAL    = '08901';

// --- EASTERN TIME SCHEDULING --------------------------------------------------
// ONTrac requires specific pickup/departure times (16:00 ET tender, 17:00 ET departure).
// These helpers compute the correct next UTC datetime without any external library.

function getNthSunday(year, month0, n) {
  // Returns the nth Sunday of the given month at 02:00 UTC (DST transition time)
  const d = new Date(Date.UTC(year, month0, 1));
  const offset = (7 - d.getUTCDay()) % 7; // days until first Sunday
  return new Date(Date.UTC(year, month0, 1 + offset + (n - 1) * 7, 2, 0, 0));
}

function etOffsetHours(date) {
  // EDT (UTC-4) runs from 2nd Sunday in March to 1st Sunday in November
  const y    = date.getUTCFullYear();
  const dstStart = getNthSunday(y, 2, 2);   // 2nd Sunday in March
  const dstEnd   = getNthSunday(y, 10, 1);  // 1st Sunday in November
  return (date >= dstStart && date < dstEnd) ? 4 : 5; // EDT=4, EST=5
}

function nextETTimeUTC(hourET) {
  // Returns ISO string for the next occurrence of hourET:00:00 ET
  const now    = new Date();
  const offset = etOffsetHours(now);
  const target = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    hourET + offset, 0, 0, 0
  ));
  // If we are already past that time today, advance to tomorrow
  if (now >= target) target.setUTCDate(target.getUTCDate() + 1);
  return target.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function tenderDateTime() {
  return nextETTimeUTC(16); // 4:00 PM ET
}

function expectedDepartureDateTime() {
  // Always 1 hour after the tender (17:00 ET, same calendar day)
  const tenderISO = tenderDateTime();
  const departure = new Date(new Date(tenderISO).getTime() + 60 * 60 * 1000);
  return departure.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// --- LOGGING ------------------------------------------------------------------

function logRequest(tag, method, url, body) {
  console.log('\n' + '-'.repeat(60));
  console.log('[' + tag + '] > REQUEST  ' + method + ' ' + url);
  if (body) console.log('[' + tag + ']   BODY:\n' + JSON.stringify(body, null, 2));
}

function logResponse(tag, status, data) {
  console.log('[' + tag + '] < RESPONSE status=' + status);
  const body = JSON.stringify(data, null, 2);
  console.log('[' + tag + ']   BODY:\n' + body.slice(0, 1000) + (body.length > 1000 ? '\n...[truncated]' : ''));
  console.log('-'.repeat(60) + '\n');
}

function logError(tag, error) {
  console.error('[' + tag + '] ERROR');
  if (error.response) {
    console.error('[' + tag + ']   HTTP STATUS : ' + error.response.status);
    console.error('[' + tag + ']   RESPONSE BODY:\n' + JSON.stringify(error.response.data, null, 2));
  } else {
    console.error('[' + tag + ']   MESSAGE: ' + error.message);
  }
  console.error('-'.repeat(60) + '\n');
}

// --- HELPERS ------------------------------------------------------------------

function parseLogiwaBody(body) { return Array.isArray(body) ? body : [body]; }

function getAddr(obj) {
  if (!obj) return {};
  const a = obj.address || obj;
  return {
    address1:   a.AddressLine1 || a.addressLine1 || a.adressLine1 || '',
    address2:   a.AddressLine2 || a.addressLine2 || '',
    city:       a.City         || a.city         || '',
    state:      a.StateOrProvinceCode || a.stateOrProvinceCode || '',
    postalCode: a.PostalCode   || a.postalCode   || '',
    country:    a.CountryCode  || a.countryCode  || 'US',
  };
}

function getContact(obj) {
  if (!obj) return {};
  const c = obj.contact || obj;
  return {
    name:    c.personName   || c.name    || '',
    company: c.companyName  || c.company || '',
    phone:   c.phoneNumber  || c.phone   || '',
    email:   c.emailAddress || c.email   || '',
  };
}

function weightToLbs(value, unit) {
  const v = parseFloat(value) || 0;
  const u = (unit || 'LB').toUpperCase();
  if (u === 'OZ') return Math.max(v / 16,      0.1);
  if (u === 'G')  return Math.max(v / 453.592, 0.1);
  if (u === 'KG') return Math.max(v * 2.20462, 0.1);
  return Math.max(v, 0.1);
}

// Compute transit days from an OnTrac UTCExpectedDeliveryBy ISO string
function transitDaysFromUTC(utcStr) {
  if (!utcStr) return 0;
  const delivery = new Date(utcStr);
  if (isNaN(delivery.getTime())) return 0;
  const days = Math.ceil((delivery.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  return days > 0 ? days : 0;
}

// --- HAZMAT -------------------------------------------------------------------
// Logiwa flags hazmat per product (isHazardous + hazmat* fields) on each box's
// products[] and on internationalOptions.customsItems. OnTrac takes the
// declaration as the piece attribute "Hazmat", on the rate AND the order.
// We send "Hazmat" alone. OnTrac's docs say "Also include signature required
// with this option", but its API accepts Hazmat without it and the signature
// adds about $9 to the quote (both checked live), so the signature is opt-in:
// ONTRAC_HAZMAT_SIGNATURE=1 adds "SignatureRequired".
const HAZMAT_SIGNATURE = process.env.ONTRAC_HAZMAT_SIGNATURE === '1';

function isHazmatLine(p) {
  return !!p && (p.isHazardous === true || String(p.isHazardous).toLowerCase() === 'true'
    || !!p.hazmatIdentificationNumber || !!p.hazmatClassDivisionNumber);
}

function orderProducts(order) {
  const boxes = Array.isArray(order.requestedPackageLineItems) ? order.requestedPackageLineItems : [];
  const customs = order.internationalOptions?.customsItems;
  return boxes.flatMap(b => Array.isArray(b.products) ? b.products : [])
    .concat(Array.isArray(customs) ? customs : []);
}

// SKUs of the hazmat items on the order; empty when there are none.
function hazmatSkus(order) {
  return [...new Set(orderProducts(order).filter(isHazmatLine).map(p => p.sku || p.description || 'unknown SKU'))];
}

// Piece attributes for an order: [] unless it holds a hazmat product.
function hazmatAttributes(order) {
  if (!hazmatSkus(order).length) return [];
  return HAZMAT_SIGNATURE ? ['Hazmat', 'SignatureRequired'] : ['Hazmat'];
}

// --- LIMITED QUANTITY MARK ----------------------------------------------------
// A hazmat carton must carry the Limited Quantity mark (49 CFR §172.315): a
// square on point, top and bottom corners black, centre white. We print it as
// a second label straight after the shipping label, in the same file, so the
// packer gets both from one print.
//
// Size: the rule is 100 mm per side, or no less than 50 mm where the package
// is too small for that. A 4x6 label is 101.6 mm wide, so the largest mark it
// can hold is about 63 mm per side — the reduced size, right for small parcels.
//
// Lithium batteries take the lithium battery mark instead, which needs a UN
// number and phone number; we do not print that one.

const LITHIUM_UN = ['3480', '3481', '3090', '3091'];

// Does this box hold hazmat that takes the Limited Quantity mark? Uses the
// box's own products[]; when Logiwa sends none, the order's items stand in.
function needsLimitedQuantityMark(order, box) {
  const own = box && Array.isArray(box.products) && box.products.length ? box.products : null;
  return (own || orderProducts(order)).filter(isHazmatLine).some(p =>
    !LITHIUM_UN.includes(String(p.hazmatIdentificationNumber || '').replace(/\D/g, '')));
}

// The mark as plain geometry, in whatever unit the caller draws in.
//   r = half the diagonal, t = border thickness, a = half-height of the white band
function lqGeometry(width, height, margin, t) {
  const r  = Math.min(width, height) / 2 - margin;
  const cx = width / 2, cy = height / 2;
  const a  = r * 0.5;
  const ri = r - t * Math.SQRT2;          // inner (white) diamond, inset by the border
  return { r, cx, cy, a, ri, t };
}

async function lqMarkPdf(pdfBase64, caption) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const doc   = await PDFDocument.load(Buffer.from(pdfBase64, 'base64'));
  const first = doc.getPage(0).getSize();
  const page  = doc.addPage([first.width, first.height]);
  const { width: W, height: H } = first;
  const mm = 72 / 25.4;
  const g  = lqGeometry(W, H, 6 * mm, 2 * mm);
  const P  = (pts) => 'M ' + pts.map(([x, y]) => x.toFixed(2) + ' ' + y.toFixed(2)).join(' L ') + ' Z';
  // SVG path space: origin top-left of the page, y down.
  const at = { x: 0, y: H };
  page.drawSvgPath(P([[g.cx, g.cy - g.r], [g.cx + g.r, g.cy], [g.cx, g.cy + g.r], [g.cx - g.r, g.cy]]), { ...at, color: rgb(0, 0, 0) });
  const w = g.ri - g.a;                    // half-width of the white band at its top and bottom
  page.drawSvgPath(P([[g.cx - w, g.cy - g.a], [g.cx + w, g.cy - g.a], [g.cx + g.ri, g.cy], [g.cx + w, g.cy + g.a], [g.cx - w, g.cy + g.a], [g.cx - g.ri, g.cy]]), { ...at, color: rgb(1, 1, 1) });
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const size = 14;
  page.drawText(caption, { x: (W - font.widthOfTextAtSize(caption, size)) / 2, y: 7 * mm, size, font, color: rgb(0, 0, 0) });
  return Buffer.from(await doc.save()).toString('base64');
}

// Carriers hand ZPL back either as plain text or base64; return it the same way.
function lqMarkZpl(label, caption) {
  const plain = String(label).includes('^XA');
  const zpl   = plain ? String(label) : Buffer.from(String(label), 'base64').toString('utf8');
  if (!zpl.includes('^XA')) throw new Error('label is not ZPL text');
  // Match the printer resolution of the carrier's own label: ^PW is its width in dots.
  const pw  = parseInt((zpl.match(/\^PW(\d+)/) || [])[1], 10) || 812;
  const dpm = pw / 101.6;                  // dots per mm on a 4-inch-wide label
  const W = pw, H = Math.round(pw * 1.5);
  const g = lqGeometry(W, H, 6 * dpm, 2 * dpm);
  const step = 3;                          // strip height in dots
  const bar  = Math.round(g.t * Math.SQRT2);
  const out  = ['^XA', '^PW' + W, '^LL' + H, '^LH0,0'];
  const strip = (x, y, w) => out.push('^FO' + Math.round(x) + ',' + Math.round(y) + '^GB' + Math.max(Math.round(w), 1) + ',' + step + ',' + step + '^FS');
  for (let y = g.cy - g.r; y < g.cy + g.r; y += step) {
    const hw = g.r - Math.abs(y + step / 2 - g.cy);   // half-width of the diamond on this row
    if (hw <= 0) continue;
    if (Math.abs(y + step / 2 - g.cy) >= g.a || hw * 2 <= bar * 2) {
      strip(g.cx - hw, y, hw * 2);                     // black corner: full width
    } else {
      strip(g.cx - hw, y, bar);                        // white band: just the two borders
      strip(g.cx + hw - bar, y, bar);
    }
  }
  out.push('^FO0,' + Math.round(H - 14 * dpm) + '^A0N,' + Math.round(5 * dpm) + ',' + Math.round(5 * dpm) + '^FB' + W + ',1,0,C^FD' + caption.replace(/[\^~\\]/g, ' ') + '^FS', '^XZ');
  const both = zpl.replace(/\s+$/, '') + '\n' + out.join('\n') + '\n';
  return plain ? both : Buffer.from(both).toString('base64');
}

// The shipping label with the Limited Quantity mark added after it, when the
// box needs one. The shipping label is already bought by the time this runs,
// so any failure here hands the original label back untouched.
async function withLimitedQuantityMark(tag, label, format, order, box) {
  if (!label || !needsLimitedQuantityMark(order, box)) return label;
  const fmt = String(format || '').toLowerCase();
  const caption = 'LIMITED QUANTITY - ' + (order.shipmentOrderCode || '');
  try {
    let out;
    if (fmt.includes('zpl')) out = lqMarkZpl(label, caption);
    else if (fmt.includes('pdf')) out = await lqMarkPdf(label, caption);
    else throw new Error('cannot add a label to ' + (format || 'unknown') + ' format');
    console.log('[' + tag + '] Limited Quantity mark added after the shipping label (' + fmt + ')');
    return out;
  } catch (e) {
    console.warn('[' + tag + '] ⚠ could not add the Limited Quantity mark — apply one by hand: ' + e.message);
    return label;
  }
}

// Map Logiwa shippingOption string -> ONTrac ServiceCode
function mapServiceCode(s) {
  if (!s) return 'GRND';
  const u = s.toUpperCase();
  if (u === 'XPRS' || u.includes('EXPRESS') || u.includes('EXP')) return 'XPRS';
  if (u === 'GRES' || u.includes('RESIDENTIAL') || u.includes('GRES')) return 'GRES';
  return 'GRND';
}

// Build ONTrac TenderAt / ReturnTo block from Logiwa shipFrom (falls back to ShipFlow defaults)
function buildTenderAt(shipFrom) {
  const a = getAddr(shipFrom);
  const c = getContact(shipFrom);
  return {
    Contact:             c.name       || DEFAULT_FROM.Contact,
    Company:             c.company    || DEFAULT_FROM.Company,
    StreetAddress:       a.address1   || DEFAULT_FROM.StreetAddress,
    Address2:            a.address2   || DEFAULT_FROM.Address2,
    PostalCode:          a.postalCode || DEFAULT_FROM.PostalCode,
    City:                a.city       || DEFAULT_FROM.City,
    State:               a.state      || DEFAULT_FROM.State,
    ISOCountryCode:      a.country    || DEFAULT_FROM.ISOCountryCode,
    Phone:               c.phone      || DEFAULT_FROM.Phone,
    SpecialInstructions: '',
  };
}

// Build a single ONTrac Piece from a Logiwa package line item
function buildPiece(pkg, attributes = []) {
  const dims       = pkg.dimensions || {};
  const weightVal  = pkg.weight?.Value || pkg.weight?.value || 1;
  const weightUnit = (pkg.weight?.Units || pkg.weight?.units || 'LB').toUpperCase();
  const lbs        = weightToLbs(weightVal, weightUnit);

  const l = parseFloat(dims.Length || dims.length || 0);
  const w = parseFloat(dims.Width  || dims.width  || 0);
  const h = parseFloat(dims.Height || dims.height || 0);

  const piece = {
    ContainerType:           'CustomPackaging',
    Weight:                  Math.round(lbs * 100) / 100,
    WeightUnitOfMeasurement: 'lbs',
    Description:             'Shipment',
    Reference:               '',
    ExpirationDate:          new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    Attributes:              attributes,
  };

  if (l > 0 && w > 0 && h > 0) {
    const dimUnit = (dims.Units || dims.units || 'IN').toUpperCase();
    piece.Length            = l;
    piece.Width             = w;
    piece.Height            = h;
    piece.UnitOfMeasurement = dimUnit === 'CM' ? 'cm' : 'in';
  }

  return piece;
}

// --- ONTRAC RATE LOOKUP -------------------------------------------------------
// One place that asks OnTrac for a price. Returns
//   { services: [{ ServiceCode, totalCost, currency, estimatedDays }] }  on success
//   { noRate: true }                 OnTrac answered "NoRate"
//   { error: '<message>' }           anything else
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchOnTracRates(order, tag, opts = {}) {
  const pkg       = order.requestedPackageLineItems?.[0] || {};
  const shipTo    = getAddr(order.shipTo);
  const toContact = getContact(order.shipTo);
  const rateReq = {
    CustomerBranch: ONTRAC_CUSTOMER_BRANCH,
    TenderDateTime: tenderDateTime(),
    TenderAt:       { ...DEFAULT_FROM },
    DeliverTo: {
      Contact:        toContact.name    || 'Recipient',
      Company:        toContact.company || '',
      StreetAddress:  shipTo.address1   || '',
      Address2:       shipTo.address2   || '',
      PostalCode:     shipTo.postalCode || '',
      City:           shipTo.city       || '',
      State:          shipTo.state      || '',
      ISOCountryCode: shipTo.country    || 'US',
      Phone:          toContact.phone   || '',
      Email:          toContact.email   || '',
    },
    Pieces: [buildPiece(pkg, hazmatAttributes(order))],
  };
  const rateUrl = ONTRAC_BASE_URL + '/Method/ServicesAndCharges/v3/json/' + ONTRAC_WSID + '/' + ONTRAC_WSKEY;

  for (let attempt = 1; attempt <= 2; attempt++) {
    logRequest(tag, 'POST', rateUrl.replace(ONTRAC_WSKEY, '***WSKey***'), rateReq);
    try {
      // Only the extra calls are capped: the retry, and every call made at label time.
      const capped = attempt > 1 || opts.extra;
      const rateRes = await axios.post(rateUrl, rateReq, {
        headers: { 'Content-Type': 'application/json' },
        ...(capped ? { timeout: EXTRA_CALL_TIMEOUT_MS } : {}),
      });
      logResponse(tag, rateRes.status, rateRes.data);
      // ServicesAndCharges is an object keyed by service code, not an array
      const svcObj = rateRes.data?.ServicesAndCharges || {};
      const list = Array.isArray(svcObj)
        ? svcObj
        : Object.entries(svcObj).map(([code, svc]) => ({ ServiceCode: code, ...svc }));
      const services = list.map(svc => ({
        ServiceCode:   svc.ServiceCode,
        totalCost:     (svc.Charges || []).reduce((sum, c) => sum + (parseFloat(c.Amount) || 0), 0),
        currency:      svc.Charges?.[0]?.Currency || 'USD',
        estimatedDays: transitDaysFromUTC(svc.UTCExpectedDeliveryBy),
      }));
      return { services };
    } catch (e) {
      logError(tag, e);
      const isNoRate = e.response?.data?.ErrorMessage === 'NoRate';
      if (isNoRate && attempt === 1 && NORATE_RETRY && !opts.noRetry) {
        console.log('[' + tag + '] NoRate from OnTrac — retrying once in ' + NORATE_RETRY_MS + 'ms');
        await sleep(NORATE_RETRY_MS);
        continue;
      }
      if (isNoRate) return { noRate: true };
      return { error: e.response?.data?.ErrorMessage || e.message };
    }
  }
  return { noRate: true };
}

// --- HEALTH CHECK -------------------------------------------------------------

app.get('/', (req, res) => res.json({
  status:          'running',
  service:         'OnTrac <-> Logiwa Middleware',
  version: '1.1.0',
  customerBranch:  ONTRAC_CUSTOMER_BRANCH,
  injectionFacility: INJECTION_FACILITY_CODE,
}));

// --- LABEL PROXY --------------------------------------------------------------

app.get('/label/:id', (req, res) => {
  const cached = labelCache[req.params.id];
  if (!cached) {
    console.log('[LABEL-PROXY] Miss for id=' + req.params.id);
    return res.status(404).json({ error: 'Label not found', id: req.params.id });
  }
  const buf         = Buffer.from(cached.labelData, 'base64');
  const fmt         = (cached.format || 'pdf').toLowerCase();
  const contentType = fmt === 'zpl' ? 'application/x-zebra-zpl' : 'application/pdf';
  console.log('[LABEL-PROXY] Serving label id=' + req.params.id + ' format=' + fmt + ' size=' + buf.length + ' bytes');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', 'inline; filename="' + req.params.id + '.' + fmt + '"');
  res.send(buf);
});

// --- GET RATE -----------------------------------------------------------------

app.post('/get-rate', async (req, res) => {
  const orders = parseLogiwaBody(req.body);
  console.log('\n[GET-RATE] == Incoming Logiwa request == orders=' + orders.length
    + ' first=' + orders[0]?.shipmentOrderCode
    + ' service=' + orders[0]?.shippingOption
    + ' carrier=' + orders[0]?.carrier
    + ' to=' + (orders[0]?.shipTo?.address?.PostalCode || orders[0]?.shipTo?.address?.postalCode || '?'));

  try {
    const out = [];

    for (const order of orders) {
      const hazmat = hazmatSkus(order);
      console.log('[GET-RATE] ' + order.shipmentOrderCode + ' products=' + orderProducts(order).length + ' hazmat=' + (hazmat.length ? hazmat.join(',') : 'no'));

      let rateList = [], msg = '';
      const requestedService = mapServiceCode(order.shippingOption);
      const result = await fetchOnTracRates(order, 'GET-RATE');

      if (result.services) {
        rateList = result.services
          // A service OnTrac lists with no charges is not a price — never pass $0 on.
          .filter(svc => svc.totalCost > 0)
          .map(svc => ({
            carrier:        order.carrier || 'OnTrac',
            shippingOption: svc.ServiceCode,
            totalCost:      svc.totalCost,
            shippingCost:   svc.totalCost,
            otherCost:      0,
            currency:       svc.currency,
            estimatedDays:  svc.estimatedDays,
          }));

        // Prefer the requested service if available
        const matched = rateList.find(r => r.shippingOption === requestedService);
        if (matched) rateList = [matched];

        console.log('[GET-RATE] OK ' + order.shipmentOrderCode + ' - ' + rateList.length + ' rates');
        if (rateList.length && order.shipmentOrderCode) {
          rememberRate(order.shipmentOrderCode, rateList[0].totalCost);
          console.log('[GET-RATE] Cached rate $' + rateList[0].totalCost + ' for ' + order.shipmentOrderCode);
        }
        if (!rateList.length) msg = 'No OnTrac rates available for this destination';

      } else if (result.noRate) {
        alertRateProblem('NoRate on get-rate', order.shipmentOrderCode,
          'zip=' + (getAddr(order.shipTo).postalCode || '?') + ' mode=' + NORATE_MODE);
        if (NORATE_MODE === 'zero') {
          // Deliberate override only (ONTRAC_NORATE_MODE=zero): a $0 stub so the label can
          // still be made. This makes OnTrac the cheapest option in every rate shop.
          rateList = [{
            carrier:        order.carrier || 'OnTrac',
            shippingOption: requestedService,
            totalCost:      0,
            shippingCost:   0,
            otherCost:      0,
            currency:       'USD',
            estimatedDays:  0,
          }];
          console.log('[GET-RATE] NoRate from OnTrac — returning $0 stub for ' + requestedService + ' (ONTRAC_NORATE_MODE=zero)');
        } else {
          msg = 'OnTrac could not price this package (NoRate) — not offering OnTrac for this order';
          console.log('[GET-RATE] NoRate from OnTrac — returning no rate for ' + order.shipmentOrderCode);
        }
      } else {
        msg = 'OnTrac error: ' + result.error;
      }

      out.push({
        shipmentOrderCode:       order.shipmentOrderCode,
        shipmentOrderIdentifier: order.shipmentOrderIdentifier,
        rateList,
        isSuccessful: rateList.length > 0,
        message: msg ? [msg] : [],
      });
    }

    console.log('[GET-RATE] -> Response to Logiwa: '
      + (out[0]?.rateList?.length || 0) + ' rates for ' + out[0]?.shipmentOrderCode);
    return res.json({ data: [out[0]] });

  } catch (err) {
    console.error('[GET-RATE] Fatal:', err.message);
    return res.json({
      data: parseLogiwaBody(req.body).map(o => ({
        shipmentOrderCode:       o.shipmentOrderCode,
        shipmentOrderIdentifier: o.shipmentOrderIdentifier,
        rateList:     [],
        isSuccessful: false,
        message:      ['Middleware error: ' + err.message],
      })),
    });
  }
});

// --- CREATE LABEL -------------------------------------------------------------

app.post('/create-label', async (req, res) => {
  const orders = parseLogiwaBody(req.body);
  console.log('\n[CREATE-LABEL] == Incoming Logiwa request == orders=' + orders.length
    + ' first=' + orders[0]?.shipmentOrderCode
    + ' service=' + orders[0]?.shippingOption);

  try {
    const out = [];

    for (const order of orders) {
      const hazmat = hazmatSkus(order);
      if (hazmat.length) console.log('[CREATE-LABEL] ' + order.shipmentOrderCode + ' hazmat=' + hazmat.join(',') + ' — declared to OnTrac as ' + hazmatAttributes(order).join('+'));

      const pkg       = order.requestedPackageLineItems?.[0] || {};
      const shipTo    = getAddr(order.shipTo);
      const toContact = getContact(order.shipTo);
      const piece     = buildPiece(pkg, hazmatAttributes(order));
      const svcCode   = mapServiceCode(order.shippingOption);
      const tender    = tenderDateTime();
      const departure = expectedDepartureDateTime();

      console.log('[CREATE-LABEL] TenderDateTime=' + tender + ' DepartureDateTime=' + departure);


      // Label format: P4x6 = PDF (default), Z4x6 = ZPL
      const rawFmt = (
        order.labelSpecification?.labelFileType ||
        order.labelSpecification?.labelFormat   ||
        'PDF'
      ).toUpperCase();
      const isZpl         = rawFmt === 'ZPL';
      const labelFmtParam = isZpl ? 'Z4x6' : 'P4x6';
      const labelFmt      = isZpl ? 'zpl'  : 'pdf';
      console.log('[CREATE-LABEL] Label format: ' + labelFmt.toUpperCase() + ' (' + labelFmtParam + ')');

      const orderReq = {
        CustomerBranch:            ONTRAC_CUSTOMER_BRANCH,
        ThirdPartyBillingAccount:  '',
        CustomerOrderNumber:       (order.shipmentOrderCode || '').slice(0, 30),
        Reference1:                order.shipmentOrderCode || '',
        Reference2:                '',
        ServiceCode:               svcCode,
        PickupType:                'OnTrac',
        TenderDateTime:            tender,
        ExpectedDepartureDateTime: departure,
        TenderAt:                  { ...DEFAULT_FROM },
        InjectionFacilityCode:     INJECTION_FACILITY_CODE,
        InjectionPostalCode:       INJECTION_POSTAL_CODE,
        CustomerBranchePostalCode: CUSTOMER_BRANCH_POSTAL,
        DeliverTo: {
          Contact:             toContact.name    || 'Recipient',
          Company:             toContact.company || '',
          StreetAddress:       shipTo.address1   || '',
          Address2:            shipTo.address2   || '',
          PostalCode:          shipTo.postalCode || '',
          City:                shipTo.city       || '',
          State:               shipTo.state      || '',
          ISOCountryCode:      shipTo.country    || 'US',
          Phone:               toContact.phone   || '',
          Email:               toContact.email   || '',
          SpecialInstructions: '',
        },
        ReturnTo: { ...DEFAULT_FROM },
        Pieces: [piece],
      };

      // Production URL: Test=0, Label=1, format=P4x6 or Z4x6
      const labelUrl = ONTRAC_BASE_URL + '/Method/PlaceOrder/v3/json/'
        + ONTRAC_WSID + '/' + ONTRAC_WSKEY + '/0/1/' + labelFmtParam;
      logRequest('CREATE-LABEL', 'POST', labelUrl.replace(ONTRAC_WSKEY, '***WSKey***'), orderReq);

      try {
        const ontracRes = await axios.post(labelUrl, orderReq, {
          headers: { 'Content-Type': 'application/json' },
        });

        const d = ontracRes.data;

        // Log without dumping full base64
        logResponse('CREATE-LABEL', ontracRes.status, {
          Error:        d.Error,
          ErrorMessage: d.ErrorMessage,
          Order: d.Order ? {
            ...d.Order,
            Pieces: (d.Order.Pieces || []).map(p => ({
              ...p,
              Label: p.Label ? '[BASE64 label ' + Buffer.from(p.Label, 'base64').length + ' bytes]' : undefined,
            })),
          } : undefined,
        });

        if (d.Error) {
          throw new Error(d.ErrorMessage || 'OnTrac returned an error');
        }

        const ontracOrder = d.Order || {};
        const pieces      = Array.isArray(ontracOrder.Pieces) ? ontracOrder.Pieces : [];
        const firstPiece  = pieces[0] || {};

        // Tracking number (Barcode) and label come from the Piece or Order object
        const trk       = firstPiece.Barcode || ontracOrder.Barcode || order.shipmentOrderCode;
        const labelData = await withLimitedQuantityMark('CREATE-LABEL', firstPiece.Label || ontracOrder.Labels || '', labelFmt, order, pkg);

        if (labelData) {
          labelCache[trk] = { labelData, format: labelFmt };
          console.log('[CREATE-LABEL] Label cached -> key=' + trk + ' format=' + labelFmt);
        } else {
          console.warn('[CREATE-LABEL] WARNING: No label data in OnTrac response');
        }

        const proxyLabelUrl = MIDDLEWARE_URL + '/label/' + trk;
        // OnTrac PlaceOrder response does not include Charges — use rate cached from get-rate
        // If the price is not remembered (middleware restarted, or the label was made without
        // a rate shop), ask OnTrac again rather than reporting $0.
        let totalCost = recallRate(order.shipmentOrderCode);
        if (totalCost == null) {
          console.log('[CREATE-LABEL] No remembered rate for ' + order.shipmentOrderCode + ' — asking OnTrac again');
          const again = await fetchOnTracRates(order, 'CREATE-LABEL-RATE', { extra: true, noRetry: true }).catch(e => ({ error: e.message }));
          const svc = (again.services || []).find(x => x.ServiceCode === svcCode) || (again.services || [])[0];
          if (svc && svc.totalCost > 0) {
            totalCost = svc.totalCost;
            rememberRate(order.shipmentOrderCode, totalCost);
          }
        }
        if (totalCost == null) {
          // The label is already made, so the package ships; the cost is unknown, not free.
          totalCost = 0;
          alertRateProblem('Label made with no price', order.shipmentOrderCode, 'tracking=' + trk);
        }
        console.log('[CREATE-LABEL] SUCCESS tracking=' + trk + ' cost=$' + totalCost + ' labelUrl=' + proxyLabelUrl);

        out.push({
          shipmentOrderIdentifier: order.shipmentOrderIdentifier,
          shipmentOrderCode:       order.shipmentOrderCode,
          carrier:        order.carrier || 'OnTrac',
          shippingOption: order.shippingOption,
          packageResponse: [{
            packageSequenceNumber: pkg.packageSequenceNumber || 0,
            trackingNumber:        trk,
            encodedLabel:          labelData,
            labelURL:              proxyLabelUrl,
            trackingUrl:           null,
            rateDetail: {
              totalCost,
              shippingCost: totalCost,
              otherCost:    0,
              currency:     'USD',
            },
            externalReference: trk,
          }],
          rateDetail: {
            totalCost,
            shippingCost: totalCost,
            otherCost:    0,
            currency:     'USD',
          },
          masterTrackingNumber: trk,
          isSuccessful: true,
          message:      [],
        });

      } catch (e) {
        logError('CREATE-LABEL', e);
        const em = e.response?.data?.ErrorMessage || e.message;
        out.push({
          shipmentOrderIdentifier: order.shipmentOrderIdentifier,
          shipmentOrderCode:       order.shipmentOrderCode,
          carrier:        order.carrier || 'OnTrac',
          shippingOption: order.shippingOption,
          packageResponse: [],
          rateDetail: { totalCost: 0, shippingCost: 0, otherCost: 0, currency: 'USD' },
          masterTrackingNumber: '',
          isSuccessful: false,
          message: ['OnTrac error: ' + em],
        });
      }
    }

    console.log('[CREATE-LABEL] -> Response to Logiwa: tracking='
      + out[0]?.masterTrackingNumber + ' success=' + out[0]?.isSuccessful);
    return res.json({ data: [out[0]] });

  } catch (err) {
    console.error('[CREATE-LABEL] Fatal:', err.message);
    const o = parseLogiwaBody(req.body)[0] || {};
    return res.json({
      data: [{
        shipmentOrderIdentifier: o.shipmentOrderIdentifier,
        shipmentOrderCode:       o.shipmentOrderCode,
        carrier:        o.carrier || 'OnTrac',
        shippingOption: o.shippingOption,
        packageResponse: [],
        rateDetail: { totalCost: 0, shippingCost: 0, otherCost: 0, currency: 'USD' },
        masterTrackingNumber: '',
        isSuccessful: false,
        message:      ['Middleware error: ' + err.message],
      }],
    });
  }
});

// --- VOID LABEL ---------------------------------------------------------------
// OnTrac does not support voiding labels via API.
// Clear local cache and return success so Logiwa does not error.

app.post('/void-label', (req, res) => {
  const orders = parseLogiwaBody(req.body);
  console.log('\n[VOID-LABEL] OnTrac has no void API -- clearing cache for trk='
    + orders[0]?.masterTrackingNumber);
  const out = orders.map(order => {
    if (order.masterTrackingNumber) delete labelCache[order.masterTrackingNumber];
    return {
      shipmentOrderIdentifier: order.shipmentOrderIdentifier,
      masterTrackingNumber:    order.masterTrackingNumber || '',
      externalReference:       order.masterTrackingNumber || '',
      isSuccessful: true,
      message:      [],
    };
  });
  return res.json({ data: [out[0]] });
});

// --- END OF DAY REPORT --------------------------------------------------------
// OnTrac does not have a manifest/end-of-day API.
// Return a stub so Logiwa's EOD flow completes without error.

app.post('/end-of-day-report', (req, res) => {
  const body = Array.isArray(req.body) ? req.body[0] : req.body;
  console.log('\n[EOD] OnTrac has no manifest API -- returning stub');
  return res.json({
    carrierSetupIdentifier: body?.carrierSetupIdentifier,
    carrier:       body?.carrier || 'ONTRAC',
    encodedReport: Buffer.from(JSON.stringify({
      status: 'accepted',
      note:   'OnTrac does not require a manifest submission.',
    })).toString('base64'),
    isSuccessful: true,
    message:      '',
  });
});

// --- START --------------------------------------------------------------------

if (require.main === module) app.listen(PORT, () => {
  console.log('\nOnTrac-Logiwa Middleware v1.1.0 on port ' + PORT);
  console.log('   NoRate mode      : ' + NORATE_MODE + (SLACK_WEBHOOK_URL ? ' (Slack alerts on)' : ' (Slack alerts off — no SLACK_WEBHOOK_URL)') + ', retry ' + (NORATE_RETRY ? 'on' : 'off'));
  console.log('   Label proxy      : ' + MIDDLEWARE_URL + '/label/:id');
  console.log('   Customer Branch  : ' + ONTRAC_CUSTOMER_BRANCH);
  console.log('   Injection Facility: ' + INJECTION_FACILITY_CODE);
  console.log('   Base URL         : ' + ONTRAC_BASE_URL + '\n');
});

module.exports = { app, flushAlerts };
