// Runs the middleware against a fake OnTrac and a fake Slack. `npm test`.
const { test, before, after } = require('node:test');
const assert  = require('node:assert');
const express = require('express');
const axios   = require('axios');

let mock, mw, base, slackPosts = [];
const script = {};          // orderCode -> array of rate answers ('ok' | 'norate'), consumed in order
const rateCalls = {};

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
    const next = (script[code] || []).shift() || 'ok';
    if (next === 'norate') return res.status(400).json({ Error: true, ErrorMessage: 'NoRate' });
    res.json({ Error: false, ServicesAndCharges: { GRND: { UTCExpectedDeliveryBy: '2030-01-02T22:00:00',
      Charges: [{ ChargeCode: 'BS', Amount: 4.96, Currency: 'USD' }, { ChargeCode: 'EN', Amount: 1.06, Currency: 'USD' }, { ChargeCode: 'RC', Amount: 0.66, Currency: 'USD' }] } } });
  });
  fake.post('/Method/PlaceOrder/v3/json/:id/:key/:t/:l/:fmt', (req, res) =>
    res.json({ Error: false, Order: { Pieces: [{ Barcode: 'TRK-' + req.body.Reference1, Label: Buffer.from('pdf').toString('base64') }] } }));
  fake.post('/slack', (req, res) => { slackPosts.push(req.body.text); res.json({ ok: true }); });
  await new Promise(r => { mock = fake.listen(0, r); });
  const port = mock.address().port;

  Object.assign(process.env, {
    ONTRAC_BASE_URL: 'http://127.0.0.1:' + port, ONTRAC_WSID: 'id', ONTRAC_WSKEY: 'key', ONTRAC_CUSTOMER_BRANCH: 'TEST',
    ONTRAC_NORATE_RETRY_MS: '10', SLACK_WEBHOOK_URL: 'http://127.0.0.1:' + port + '/slack',
  });
  delete process.env.ONTRAC_NORATE_MODE;
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

test('NoRate twice: OnTrac is NOT offered, and never at $0', async () => {
  script.B1 = ['norate', 'norate'];
  const r = await rate(order('B1'));
  assert.equal(r.isSuccessful, false);
  assert.deepEqual(r.rateList, []);
  assert.match(r.message[0], /NoRate/);
  assert.equal(rateCalls.B1, 2, 'retried exactly once');
});

test('NoRate then a price: the retry rescues it', async () => {
  script.C1 = ['norate', 'ok'];
  const r = await rate(order('C1'));
  assert.equal(r.isSuccessful, true);
  assert.equal(r.rateList[0].totalCost.toFixed(2), '6.68');
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
  script.F1 = ['norate', 'norate'];
  const l = await label(order('F1'));
  assert.equal(l.isSuccessful, true, 'the package still ships');
  assert.equal(l.masterTrackingNumber, 'TRK-F1');
  assert.equal(l.rateDetail.totalCost, 0);
  await global.flushAlerts();
  const text = slackPosts.join('\n');
  assert.match(text, /Label made with no price/);
  assert.match(text, /F1/);
  assert.match(text, /NoRate on get-rate/);       // from the B1 case above
});
