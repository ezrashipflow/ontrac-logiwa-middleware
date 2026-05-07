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

const ONTRAC_BASE_URL = 'https://ws.ontrac.com';

const MIDDLEWARE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
  : (process.env.MIDDLEWARE_URL || 'https://ontrac-logiwa-middleware-production.up.railway.app');

const labelCache = {};

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
function buildPiece(pkg) {
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

// --- HEALTH CHECK -------------------------------------------------------------

app.get('/', (req, res) => res.json({
  status:          'running',
  service:         'OnTrac <-> Logiwa Middleware',
  version:         '1.0.1',
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
    + ' to=' + (orders[0]?.shipTo?.address?.PostalCode || orders[0]?.shipTo?.address?.postalCode || '?'));

  try {
    const out = [];

    for (const order of orders) {
      const pkg       = order.requestedPackageLineItems?.[0] || {};
      const shipTo    = getAddr(order.shipTo);
      const toContact = getContact(order.shipTo);
      const piece     = buildPiece(pkg);

      const tender    = tenderDateTime();
      console.log('[GET-RATE] TenderDateTime=' + tender);

      const rateReq = {
        CustomerBranch:       ONTRAC_CUSTOMER_BRANCH,
        TenderDateTime:       tender,
        TenderAt:             buildTenderAt(order.shipFrom),
        InjectionFacilityCode: INJECTION_FACILITY_CODE,
        InjectionPostalCode:  INJECTION_POSTAL_CODE,
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
        Pieces: [piece],
      };

      const rateUrl = ONTRAC_BASE_URL + '/Method/ServicesAndCharges/v3/json/'
        + ONTRAC_WSID + '/' + ONTRAC_WSKEY;
      logRequest('GET-RATE', 'POST', rateUrl.replace(ONTRAC_WSKEY, '***WSKey***'), rateReq);

      let rateList = [], msg = '';
      try {
        const rateRes = await axios.post(rateUrl, rateReq, {
          headers: { 'Content-Type': 'application/json' },
        });
        logResponse('GET-RATE', rateRes.status, rateRes.data);

        const services = Array.isArray(rateRes.data?.ServicesAndCharges)
          ? rateRes.data.ServicesAndCharges : [];

        const requestedService = mapServiceCode(order.shippingOption);

        rateList = services.map(svc => {
          const totalCost = (svc.Charges || []).reduce((sum, c) => sum + (parseFloat(c.Amount) || 0), 0);
          return {
            carrier:        order.carrier || 'ONTRAC',
            shippingOption: svc.ServiceCode,
            totalCost,
            shippingCost:   totalCost,
            otherCost:      0,
            currency:       svc.Charges?.[0]?.Currency || 'USD',
            estimatedDays:  null,
          };
        });

        // Prefer the requested service if available
        const matched = rateList.find(r => r.shippingOption === requestedService);
        if (matched) rateList = [matched];

        console.log('[GET-RATE] OK ' + order.shipmentOrderCode + ' - ' + rateList.length + ' rates');
        if (!rateList.length) msg = 'No OnTrac rates available for this destination';

      } catch (e) {
        logError('GET-RATE', e);
        msg = 'OnTrac error: ' + (e.response?.data?.ErrorMessage || e.message);
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
      const pkg       = order.requestedPackageLineItems?.[0] || {};
      const shipTo    = getAddr(order.shipTo);
      const toContact = getContact(order.shipTo);
      const piece     = buildPiece(pkg);
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
        CustomerOrderNumber:       (order.shipmentOrderCode || '').slice(0, 30),
        Reference1:                order.shipmentOrderCode || '',
        Reference2:                '',
        ServiceCode:               svcCode,
        PickupType:                'OnTrac',
        TenderDateTime:            tender,
        ExpectedDepartureDateTime: departure,
        TenderAt:                  buildTenderAt(order.shipFrom),
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
        ReturnTo: buildTenderAt(order.shipFrom),
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

        // Tracking number (Barcode) and label come from the Piece object
        const trk       = firstPiece.Barcode || ontracOrder.Barcode || order.shipmentOrderCode;
        const labelData = firstPiece.Label   || '';

        if (labelData) {
          labelCache[trk] = { labelData, format: labelFmt };
          console.log('[CREATE-LABEL] Label cached -> key=' + trk + ' format=' + labelFmt);
        } else {
          console.warn('[CREATE-LABEL] WARNING: No label data in OnTrac response');
        }

        const proxyLabelUrl = MIDDLEWARE_URL + '/label/' + trk;
        const totalCost = (ontracOrder.Charges || []).reduce((s, c) => s + (parseFloat(c.Amount) || 0), 0);
        console.log('[CREATE-LABEL] SUCCESS tracking=' + trk + ' cost=$' + totalCost + ' labelUrl=' + proxyLabelUrl);

        out.push({
          shipmentOrderIdentifier: order.shipmentOrderIdentifier,
          shipmentOrderCode:       order.shipmentOrderCode,
          carrier:        order.carrier || 'ONTRAC',
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
          carrier:        order.carrier || 'ONTRAC',
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
        carrier:        o.carrier || 'ONTRAC',
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

app.listen(PORT, () => {
  console.log('\nOnTrac-Logiwa Middleware v1.0.1 on port ' + PORT);
  console.log('   Label proxy      : ' + MIDDLEWARE_URL + '/label/:id');
  console.log('   Customer Branch  : ' + ONTRAC_CUSTOMER_BRANCH);
  console.log('   Injection Facility: ' + INJECTION_FACILITY_CODE);
  console.log('   Base URL         : ' + ONTRAC_BASE_URL + '\n');
});
