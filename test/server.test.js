const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server');

async function startServer(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'silvicom-tms-'));
  const server = createServer({ dataFile: path.join(directory, 'store.json') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function request(baseUrl, route, options) {
  const response = await fetch(`${baseUrl}${route}`, options);
  return { status: response.status, body: await response.json() };
}

const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('serves the dashboard and starts with balanced sample accounting', async t => {
  const baseUrl = await startServer(t);
  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Silvicom 360/);

  const [dashboard, journal, accounts] = await Promise.all([
    request(baseUrl, '/api/dashboard'),
    request(baseUrl, '/api/journal'),
    request(baseUrl, '/api/accounts')
  ]);
  assert.equal(dashboard.body.loads, 4);
  assert.equal(dashboard.body.revenue, 8750);
  assert.equal(dashboard.body.expenses, 6375);
  assert.equal(dashboard.body.profit, 2375);
  assert.equal(dashboard.body.receivables, 3900);
  assert.equal(dashboard.body.overdue, 1);
  assert.equal(journal.body.length, 3);
  for (const entry of journal.body) {
    assert.equal(entry.lines.reduce((sum, line) => sum + line.debit, 0), entry.lines.reduce((sum, line) => sum + line.credit, 0));
  }
  assert.equal(accounts.body.Cash.debit, accounts.body.Cash.credit + 4850);
});

test('requires delivery before invoicing and prevents duplicate invoices', async t => {
  const baseUrl = await startServer(t);
  const loads = await request(baseUrl, '/api/loads');
  const load = loads.body.find(item => item.status === 'In Transit');

  const earlyInvoice = await request(baseUrl, '/api/invoices', json({ loadId: load.id, dueDate: '2026-11-30' }));
  assert.equal(earlyInvoice.status, 400);

  const delivered = await request(baseUrl, `/api/loads/${load.id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'Delivered' })
  });
  assert.equal(delivered.status, 200);

  const invoice = await request(baseUrl, '/api/invoices', json({ loadId: load.id, dueDate: '2026-11-30' }));
  assert.equal(invoice.status, 201);
  assert.equal(invoice.body.amount, load.rate);
  assert.equal(invoice.body.balance, load.rate);

  const duplicate = await request(baseUrl, '/api/invoices', json({ loadId: load.id, dueDate: '2026-11-30' }));
  assert.equal(duplicate.status, 409);
});

test('records partial payments, rejects overpayment, and keeps journal entries balanced', async t => {
  const baseUrl = await startServer(t);
  const load = (await request(baseUrl, '/api/loads')).body.find(item => item.status === 'In Transit');
  await request(baseUrl, `/api/loads/${load.id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'Delivered' })
  });
  const created = await request(baseUrl, '/api/invoices', json({ loadId: load.id, dueDate: '2026-11-30' }));
  const invoice = created.body;
  const amount = 100;

  const partial = await request(baseUrl, `/api/invoices/${invoice.id}/payments`, json({ amount, method: 'ACH' }));
  assert.equal(partial.status, 201);
  assert.equal(partial.body.paid, amount);
  assert.equal(partial.body.balance, invoice.amount - amount);
  assert.equal(partial.body.status, 'Partial');

  const tooMuch = await request(baseUrl, `/api/invoices/${invoice.id}/payments`, json({ amount: invoice.amount }));
  assert.equal(tooMuch.status, 400);

  const settled = await request(baseUrl, `/api/invoices/${invoice.id}/payments`, json({ amount: invoice.amount - amount }));
  assert.equal(settled.body.status, 'Paid');
  assert.equal(settled.body.balance, 0);

  const journal = await request(baseUrl, '/api/journal');
  for (const entry of journal.body) {
    const debit = entry.lines.reduce((sum, line) => sum + line.debit, 0);
    const credit = entry.lines.reduce((sum, line) => sum + line.credit, 0);
    assert.equal(debit, credit);
  }
});

test('persists load and invoice changes across server restarts', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'silvicom-tms-persist-'));
  const dataFile = path.join(directory, 'store.json');
  const firstServer = createServer({ dataFile });
  await new Promise(resolve => firstServer.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${firstServer.address().port}`;
  const load = await request(baseUrl, '/api/loads', json({
    customer: 'Test customer',
    origin: 'Austin, TX',
    destination: 'Dallas, TX',
    pickupDate: '2026-10-19',
    rate: 750,
    carrierCost: 500
  }));
  assert.equal(load.status, 201);
  await new Promise(resolve => firstServer.close(resolve));

  const secondServer = createServer({ dataFile });
  await new Promise(resolve => secondServer.listen(0, '127.0.0.1', resolve));
  const restartedUrl = `http://127.0.0.1:${secondServer.address().port}`;
  const stored = await request(restartedUrl, '/api/loads');
  assert.ok(stored.body.some(item => item.id === load.body.id));
  await new Promise(resolve => secondServer.close(resolve));
  fs.rmSync(directory, { recursive: true, force: true });
});

test('rejects malformed JSON and invalid calendar dates', async t => {
  const baseUrl = await startServer(t);
  const malformed = await fetch(`${baseUrl}/api/loads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{invalid'
  });
  assert.equal(malformed.status, 400);

  const invalidDate = await request(baseUrl, '/api/loads', json({
    customer: 'Test customer',
    origin: 'Austin, TX',
    destination: 'Dallas, TX',
    pickupDate: '2026-02-30',
    rate: 750,
    carrierCost: 800
  }));
  assert.equal(invalidDate.status, 400);
});
