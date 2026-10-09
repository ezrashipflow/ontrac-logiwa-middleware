// Runs the middleware against a fake OnTrac and a fake Slack. `npm test`.
const { test, before, after } = require('node:test');
const assert  = require('node:assert');
const express = require('express');
const axios   = require('axios');

let mock, mw, base, slackPosts = [];
const script = {};          // orderCode -> array of rate answers ('ok' | 'norate'), consumed in order
const rateCalls = {};
const seenAttributes = { rate: {}, label: {} };   // orderCode -> piece Attributes OnTrac was sent

const order = (code, zip = '19807') => ({
  shipmentOrderCode: code, shipmentOrderIdentifier: 'id-' + code, carrier: 'OnTrac', shippingOption: 'GRND',
  shipTo: { address: { AddressLine1: '1 Main St', City: 'Wilmington', StateOrProvinceCode: 'DE', PostalCode: zip }, contact: { personName: code } },
  requestedPackageLineItems: [{ weight: { Value: 2, Units: 'LB' }, dimensions: { Length: 12, Width: 10, Height: 6 } }],
});

before(async () => {
  const fake = express(); fake.use(express.json({ limit: '5mb' }));
  fake.post('/Method/ServicesAndCharges/v3/json/:id/:key', (req, res) => {
    const code = req.body.DeliverTo.Contact;
    rateCalls[code] = (rateCalls[code] || 0) + 1;
    seenAttributes.rate[code] = req.body.Pieces[0].Attributes;
    const next = (script[code] || []).shift() || 'ok';
    if (next === 'norate') return res.status(400).json({ Error: true, ErrorMessage: 'NoRate' });
    res.json({ Error: false, ServicesAndCharges: { GRND: { UTCExpectedDeliveryBy: '2030-01-02T22:00:00',
      Charges: [{ ChargeCode: 'BS', Amount: 4.96, Currency: 'USD' }, { ChargeCode: 'EN', Amount: 1.06, Currency: 'USD' }, { ChargeCode: 'RC', Amount: 0.66, Currency: 'USD' }] } } });
  });
  fake.post('/Method/PlaceOrder/v3/json/:id/:key/:t/:l/:fmt', (req, res) => {
    seenAttributes.label[req.body.Reference1] = req.body.Pieces[0].Attributes;
    res.json({ Error: false, Order: { Pieces: [{ Barcode: 'TRK-' + req.body.Reference1, Label: Buffer.from('pdf').toString('base64') }] } });
  });
  fake.post('/slack', (req, res) => { slackPosts.push(req.body.text); res.json({ ok: true }); });
  await new Promise(r => { mock = fake.listen(0, r); });
  const port = mock.address().port;

  Object.assign(process.env, {
    ONTRAC_BASE_URL: 'http://127.0.0.1:' + port, ONTRAC_WSID: 'id', ONTRAC_WSKEY: 'key', ONTRAC_CUSTOMER_BRANCH: 'TEST',
    ONTRAC_NORATE_RETRY_MS: '10', SLACK_WEBHOOK_URL: 'http://127.0.0.1:' + port + '/slack',
  });
  delete process.env.ONTRAC_NORATE_MODE;
  delete process.env.ONTRAC_HAZMAT_SIGNATURE;
  const { app, flushAlerts } = require('../server.js');
  global.flushAlerts = flushAlerts;
  await new Promise(r => { mw = app.listen(0, r); });
  base = 'http://127.0.0.1:' + mw.address().port;
});
after(() => { mock.close(); mw.close(); });

const rate  = async o => (await axios.post(base + '/get-rate', [o])).data.data[0];
const label = async o => (await axios.post(base + '/create-label', [o])).data.data[0];

test('a priced package: rate goes to Logiwa and the label carries the same cost', async () => {
  const r = await rate(order('A1'));
  assert.equal(r.isSuccessful, true);
  assert.equal(r.rateList[0].totalCost.toFixed(2), '6.68');
  const l = await label(order('A1'));
  assert.equal(l.isSuccessful, true);
  assert.equal(l.rateDetail.totalCost.toFixed(2), '6.68');
});

test('NoRate: OnTrac is NOT offered, never at $0, and no second call is made', async () => {
  script.B1 = ['norate'];
  const r = await rate(order('B1'));
  assert.equal(r.isSuccessful, false);
  assert.deepEqual(r.rateList, []);
  assert.match(r.message[0], /NoRate/);
  assert.equal(rateCalls.B1, 1, 'no retry by default — no added time');
});

test('label with no remembered price: asks OnTrac again instead of sending $0', async () => {
  const l = await label(order('D1'));              // no get-rate first
  assert.equal(l.isSuccessful, true);
  assert.equal(l.rateDetail.totalCost.toFixed(2), '6.68');
  assert.equal(l.packageResponse[0].rateDetail.totalCost.toFixed(2), '6.68');
});

test('a second label for the same order still has its price', async () => {
  await rate(order('E1'));
  await label(order('E1'));
  const before = rateCalls.E1;
  const l2 = await label(order('E1'));
  assert.equal(l2.rateDetail.totalCost.toFixed(2), '6.68');
  assert.equal(rateCalls.E1, before, 'price came from memory, no extra OnTrac call');
});

test('label when OnTrac still will not price it: label is made, and Slack is told', async () => {
  script.F1 = ['norate'];
  const l = await label(order('F1'));
  assert.equal(rateCalls.F1, 1, 'one re-check only at label time, no retry');
  assert.equal(l.isSuccessful, true, 'the package still ships');
  assert.equal(l.masterTrackingNumber, 'TRK-F1');
  assert.equal(l.rateDetail.totalCost, 0);
  await global.flushAlerts();
  const text = slackPosts.join('\n');
  assert.match(text, /Label made with no price/);
  assert.match(text, /F1/);
  assert.match(text, /NoRate on get-rate/);       // from the B1 case above
});

test('hazmat: the piece is declared to OnTrac as Hazmat, with no signature, on rate and label', async () => {
  const o = order('H1');
  o.requestedPackageLineItems[0].products = [{ sku: '02671', quantity: 1, isHazardous: true }];
  const r = await rate(o);
  assert.equal(r.isSuccessful, true);
  assert.deepEqual(seenAttributes.rate.H1, ['Hazmat']);
  const l = await label(o);
  assert.equal(l.isSuccessful, true);
  assert.deepEqual(seenAttributes.label.H1, ['Hazmat']);
});

test('non-hazmat products are sent with no attributes', async () => {
  const o = order('H2');
  o.requestedPackageLineItems[0].products = [{ sku: 'ABC', quantity: 1, isHazardous: false, hazmatIdentificationNumber: null }];
  const r = await rate(o);
  assert.equal(r.isSuccessful, true);
  assert.deepEqual(seenAttributes.rate.H2, []);
});
