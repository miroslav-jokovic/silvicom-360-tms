const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const publicDirectory = path.join(__dirname, 'public');
const accounts = ['Cash', 'Accounts Receivable', 'Accounts Payable', 'Freight Revenue', 'Carrier Expense'];

function today() {
  return new Date().toISOString().slice(0, 10);
}

function seedData() {
  const deliveredDate = today();
  const overdueDate = new Date(Date.now() - 21 * 86400000).toISOString().slice(0, 10);
  const futureDate = new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10);
  return {
    loads: [
      { id: randomUUID(), reference: 'LD-1042', customer: 'Northstar Foods', origin: 'Chicago, IL', destination: 'Nashville, TN', pickupDate: today(), deliveryDate: today(), status: 'Delivered', rate: 4850, carrierCost: 3625 },
      { id: randomUUID(), reference: 'LD-1043', customer: 'Cedar & Stone', origin: 'Detroit, MI', destination: 'Columbus, OH', pickupDate: today(), deliveryDate: '', status: 'In Transit', rate: 2750, carrierCost: 1980 },
      { id: randomUUID(), reference: 'LD-1044', customer: 'Meridian Supply', origin: 'Milwaukee, WI', destination: 'Indianapolis, IN', pickupDate: futureDate, deliveryDate: '', status: 'Planned', rate: 3200, carrierCost: 2310 },
      { id: randomUUID(), reference: 'LD-1045', customer: 'Bluebird Home', origin: 'St. Louis, MO', destination: 'Louisville, KY', pickupDate: today(), deliveryDate: deliveredDate, status: 'Delivered', rate: 3900, carrierCost: 2750 }
    ],
    invoices: [
      { id: randomUUID(), number: `INV-${new Date().getFullYear()}-001`, loadId: '', customer: 'Northstar Foods', amount: 4850, issueDate: overdueDate, dueDate: overdueDate, payments: [{ id: randomUUID(), amount: 4850, date: today(), method: 'ACH' }] },
      { id: randomUUID(), number: `INV-${new Date().getFullYear()}-002`, loadId: '', customer: 'Bluebird Home', amount: 3900, issueDate: overdueDate, dueDate: overdueDate, payments: [] }
    ],
    journal: [],
    nextLoadNumber: 1046,
    nextInvoiceNumber: 3
  };
}

function appendJournal(data, description, reference, lines) {
  const debit = lines.reduce((sum, line) => sum + line.debit, 0);
  const credit = lines.reduce((sum, line) => sum + line.credit, 0);
  if (Math.round(debit * 100) !== Math.round(credit * 100)) {
    throw new Error('Journal entry must balance');
  }
  data.journal.unshift({ id: randomUUID(), date: today(), description, reference, lines });
}

function initializeData(dataFile) {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  if (fs.existsSync(dataFile)) return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const data = seedData();
  data.invoices[0].loadId = data.loads[0].id;
  data.invoices[1].loadId = data.loads[3].id;
  for (const invoice of data.invoices) {
    const load = data.loads.find(item => item.id === invoice.loadId);
    appendJournal(data, 'Freight invoice posted', invoice.number, [
      { account: 'Accounts Receivable', debit: invoice.amount, credit: 0 },
      { account: 'Freight Revenue', debit: 0, credit: invoice.amount },
      { account: 'Carrier Expense', debit: load.carrierCost, credit: 0 },
      { account: 'Accounts Payable', debit: 0, credit: load.carrierCost }
    ]);
  }
  appendJournal(data, 'Customer payment received', data.invoices[0].number, [
    { account: 'Cash', debit: 4850, credit: 0 },
    { account: 'Accounts Receivable', debit: 0, credit: 4850 }
  ]);
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
  return data;
}

function invoiceView(invoice) {
  const paid = invoice.payments.reduce((sum, payment) => sum + payment.amount, 0);
  const balance = Math.max(0, Math.round((invoice.amount - paid) * 100) / 100);
  const status = balance === 0 ? 'Paid' : paid > 0 ? 'Partial' : invoice.dueDate < today() ? 'Overdue' : 'Open';
  return { ...invoice, paid, balance, status };
}

function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) reject(requestError('Request body too large.', 413));
    });
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(requestError('Request body must be valid JSON.'));
      }
    });
    request.on('error', reject);
  });
}

function validAmount(value) {
  return Number.isFinite(value) && value > 0 && Math.abs(value * 100 - Math.round(value * 100)) < 1e-8;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function requestError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function createServer({ dataFile = path.join(__dirname, 'data', 'store.json') } = {}) {
  const data = initializeData(dataFile);
  let queue = Promise.resolve();

  async function handle(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const route = url.pathname;

    if (route.startsWith('/api/')) {
      if (request.method === 'GET' && route === '/api/dashboard') {
        const invoices = data.invoices.map(invoiceView);
        const revenue = data.invoices.reduce((sum, invoice) => sum + invoice.amount, 0);
        const expenses = data.invoices.reduce((sum, invoice) => {
          const load = data.loads.find(item => item.id === invoice.loadId);
          return sum + (load ? load.carrierCost : 0);
        }, 0);
        return sendJson(response, 200, {
          loads: data.loads.length,
          inTransit: data.loads.filter(load => load.status === 'In Transit').length,
          revenue,
          expenses,
          profit: revenue - expenses,
          receivables: invoices.reduce((sum, invoice) => sum + invoice.balance, 0),
          overdue: invoices.filter(invoice => invoice.status === 'Overdue').length,
          cashReceived: data.invoices.reduce((sum, invoice) => sum + invoiceView(invoice).paid, 0)
        });
      }
      if (request.method === 'GET' && route === '/api/loads') return sendJson(response, 200, data.loads);
      if (request.method === 'GET' && route === '/api/invoices') return sendJson(response, 200, data.invoices.map(invoiceView));
      if (request.method === 'GET' && route === '/api/journal') return sendJson(response, 200, data.journal);
      if (request.method === 'GET' && route === '/api/accounts') {
        const balances = Object.fromEntries(accounts.map(account => [account, { debit: 0, credit: 0 }]));
        for (const entry of data.journal) {
          for (const line of entry.lines) {
            balances[line.account].debit += line.debit;
            balances[line.account].credit += line.credit;
          }
        }
        return sendJson(response, 200, balances);
      }

      if (request.method === 'POST' && route === '/api/loads') {
        const body = await readBody(request);
        const required = ['customer', 'origin', 'destination', 'pickupDate'];
        if (required.some(field => typeof body[field] !== 'string' || !body[field].trim()) ||
            !validDate(body.pickupDate) || !validAmount(body.rate) || !validAmount(body.carrierCost)) {
          return sendJson(response, 400, { error: 'Provide customer, route, a valid pickup date, and positive rate and carrier cost.' });
        }
        const load = {
          id: randomUUID(),
          reference: `LD-${data.nextLoadNumber++}`,
          customer: body.customer.trim(),
          origin: body.origin.trim(),
          destination: body.destination.trim(),
          pickupDate: body.pickupDate,
          deliveryDate: '',
          status: 'Planned',
          rate: body.rate,
          carrierCost: body.carrierCost
        };
        data.loads.unshift(load);
        await persist(dataFile, data);
        return sendJson(response, 201, load);
      }

      const statusMatch = route.match(/^\/api\/loads\/([^/]+)\/status$/);
      if (request.method === 'PATCH' && statusMatch) {
        const load = data.loads.find(item => item.id === statusMatch[1]);
        if (!load) return sendJson(response, 404, { error: 'Load not found.' });
        const { status } = await readBody(request);
        const nextStatus = { Planned: 'In Transit', 'In Transit': 'Delivered' }[load.status];
        if (status !== nextStatus) return sendJson(response, 400, { error: `Load can only move to ${nextStatus || 'no further status'}.` });
        load.status = status;
        if (status === 'Delivered') load.deliveryDate = today();
        await persist(dataFile, data);
        return sendJson(response, 200, load);
      }

      if (request.method === 'POST' && route === '/api/invoices') {
        const { loadId, dueDate } = await readBody(request);
        const load = data.loads.find(item => item.id === loadId);
        if (!load) return sendJson(response, 404, { error: 'Load not found.' });
        if (load.status !== 'Delivered') return sendJson(response, 400, { error: 'Only delivered loads can be invoiced.' });
        if (data.invoices.some(invoice => invoice.loadId === load.id)) return sendJson(response, 409, { error: 'This load has already been invoiced.' });
        if (!validDate(dueDate)) return sendJson(response, 400, { error: 'Provide a valid invoice due date.' });
        const invoice = {
          id: randomUUID(),
          number: `INV-${new Date().getFullYear()}-${String(data.nextInvoiceNumber++).padStart(3, '0')}`,
          loadId: load.id,
          customer: load.customer,
          amount: load.rate,
          issueDate: today(),
          dueDate,
          payments: []
        };
        data.invoices.unshift(invoice);
        appendJournal(data, 'Freight invoice posted', invoice.number, [
          { account: 'Accounts Receivable', debit: load.rate, credit: 0 },
          { account: 'Freight Revenue', debit: 0, credit: load.rate },
          { account: 'Carrier Expense', debit: load.carrierCost, credit: 0 },
          { account: 'Accounts Payable', debit: 0, credit: load.carrierCost }
        ]);
        await persist(dataFile, data);
        return sendJson(response, 201, invoiceView(invoice));
      }

      const paymentMatch = route.match(/^\/api\/invoices\/([^/]+)\/payments$/);
      if (request.method === 'POST' && paymentMatch) {
        const invoice = data.invoices.find(item => item.id === paymentMatch[1]);
        if (!invoice) return sendJson(response, 404, { error: 'Invoice not found.' });
        const body = await readBody(request);
        const current = invoiceView(invoice);
        if (!validAmount(body.amount) || body.amount > current.balance || (body.date && !validDate(body.date)) ||
            (body.method && (typeof body.method !== 'string' || body.method.length > 30))) {
          return sendJson(response, 400, { error: 'Provide a valid payment amount, date, and method.' });
        }
        const payment = { id: randomUUID(), amount: body.amount, date: body.date || today(), method: body.method || 'ACH' };
        invoice.payments.push(payment);
        appendJournal(data, 'Customer payment received', invoice.number, [
          { account: 'Cash', debit: payment.amount, credit: 0 },
          { account: 'Accounts Receivable', debit: 0, credit: payment.amount }
        ]);
        await persist(dataFile, data);
        return sendJson(response, 201, invoiceView(invoice));
      }
      return sendJson(response, 404, { error: 'API route not found.' });
    }

    const filePath = route === '/' ? path.join(publicDirectory, 'index.html') : path.resolve(publicDirectory, `.${route}`);
    if (!filePath.startsWith(`${publicDirectory}${path.sep}`)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    fs.readFile(filePath, (error, content) => {
      if (error) {
        response.writeHead(404).end('Not found');
        return;
      }
      const type = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }[path.extname(filePath)] || 'application/octet-stream';
      response.writeHead(200, { 'Content-Type': type });
      response.end(content);
    });
  }

  return http.createServer((request, response) => {
    queue = queue.then(() => handle(request, response)).catch(error => {
      if (!response.headersSent) sendJson(response, error.statusCode || 500, { error: error.statusCode ? error.message : 'Internal server error.' });
      else response.destroy();
    });
  });
}

async function persist(dataFile, data) {
  const temporaryFile = `${dataFile}.tmp`;
  await fs.promises.writeFile(temporaryFile, JSON.stringify(data, null, 2));
  await fs.promises.rename(temporaryFile, dataFile);
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, '127.0.0.1', () => console.log(`Silvicom 360 TMS running at http://127.0.0.1:${port}`));
}

module.exports = { createServer };
