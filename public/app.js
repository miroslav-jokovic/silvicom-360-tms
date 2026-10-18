const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
const isoToday = () => new Date().toISOString().slice(0, 10);
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
let loads = [];
let invoices = [];

async function api(url, options) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Something went wrong.');
  return result;
}

function renderLoads() {
  const body = document.querySelector('#loads-body');
  document.querySelector('#loads-empty').hidden = loads.length > 0;
  body.innerHTML = loads.slice(0, 4).map(load => {
    const statusClass = load.status === 'In Transit' ? 'transit' : load.status.toLowerCase();
    const next = { Planned: 'In Transit', 'In Transit': 'Delivered' }[load.status];
    const canInvoice = load.status === 'Delivered' && !invoices.some(invoice => invoice.loadId === load.id);
    return `<tr><td><span class="load-ref">${escapeHtml(load.reference)}</span><span class="load-customer">${escapeHtml(load.customer)}</span></td><td class="route-cell">${escapeHtml(load.origin)} → ${escapeHtml(load.destination)}</td><td class="date-cell">${escapeHtml(load.pickupDate)}</td><td><span class="status-pill ${statusClass}">${escapeHtml(load.status)}</span></td><td class="rate-cell">${money(load.rate)}</td><td><button class="row-action" data-load-action="${load.id}" ${!next && !canInvoice ? 'disabled' : ''}>${canInvoice ? 'Invoice' : next || 'Invoiced'}</button></td></tr>`;
  }).join('');
  document.querySelector('#load-count').textContent = loads.length;
  document.querySelector('#active-loads').textContent = loads.filter(load => load.status !== 'Delivered').length;
  document.querySelector('#in-transit').textContent = loads.filter(load => load.status === 'In Transit').length;
}

function renderInvoices() {
  const list = document.querySelector('#invoice-list');
  const openInvoices = invoices.filter(invoice => invoice.balance > 0);
  const current = openInvoices.filter(invoice => invoice.status !== 'Overdue').reduce((sum, invoice) => sum + invoice.balance, 0);
  const overdue = openInvoices.filter(invoice => invoice.status === 'Overdue').reduce((sum, invoice) => sum + invoice.balance, 0);
  document.querySelector('#outstanding-total').textContent = money(current + overdue);
  document.querySelector('#current-total').textContent = money(current);
  document.querySelector('#late-total').textContent = money(overdue);
  document.querySelector('.aging-bar span').style.width = `${current + overdue ? current / (current + overdue) * 100 : 100}%`;
  document.querySelector('.aging-bar i').style.width = `${current + overdue ? overdue / (current + overdue) * 100 : 0}%`;
  list.innerHTML = openInvoices.length ? openInvoices.slice(0, 2).map(invoice => `<div class="invoice-item"><span class="invoice-mark">▤</span><span class="invoice-info"><b>${escapeHtml(invoice.customer)}</b><small>${escapeHtml(invoice.number)} · Due ${escapeHtml(invoice.dueDate)}</small></span><span class="invoice-amount"><b>${money(invoice.balance)}</b><small class="${invoice.status === 'Overdue' ? 'overdue-label' : ''}">${invoice.status === 'Overdue' ? 'Overdue' : invoice.status}</small></span><button class="row-action" data-payment="${invoice.id}">Pay</button></div>`).join('') : '<div class="empty-copy">All caught up — no open invoices.</div>';
  const eligible = loads.filter(load => load.status === 'Delivered' && !invoices.some(invoice => invoice.loadId === load.id));
  const select = document.querySelector('#invoice-form select');
  select.innerHTML = eligible.map(load => `<option value="${load.id}">${escapeHtml(load.reference)} · ${escapeHtml(load.customer)} · ${money(load.rate)}</option>`).join('');
  document.querySelector('#create-invoice').disabled = eligible.length === 0;
}

function renderJournal(entries) {
  document.querySelector('#journal-list').innerHTML = entries.slice(0, 3).map(entry => {
    const amount = entry.lines.reduce((sum, line) => sum + line.debit, 0);
    return `<div class="journal-row"><span class="journal-icon">⌗</span><span class="journal-copy"><b>${escapeHtml(entry.description)}</b><small>${escapeHtml(entry.reference)} · ${escapeHtml(entry.date)}</small></span><strong>${money(amount)}</strong></div>`;
  }).join('') || '<div class="empty-copy">Accounting activity will appear here.</div>';
}

async function refresh() {
  const [dashboard, loadData, invoiceData, journal] = await Promise.all([
    api('/api/dashboard'), api('/api/loads'), api('/api/invoices'), api('/api/journal')
  ]);
  loads = loadData;
  invoices = invoiceData;
  document.querySelector('#revenue').textContent = money(dashboard.revenue);
  document.querySelector('#receivables').textContent = money(dashboard.receivables);
  document.querySelector('#profit').textContent = money(dashboard.profit);
  document.querySelector('#overdue-count').textContent = dashboard.overdue;
  document.querySelector('#snapshot-revenue').textContent = money(dashboard.revenue);
  document.querySelector('#snapshot-costs').textContent = money(dashboard.expenses);
  document.querySelector('#snapshot-profit').textContent = money(dashboard.profit);
  renderLoads();
  renderInvoices();
  renderJournal(journal);
}

function showError(form, error) {
  form.querySelector('.form-error').textContent = error.message;
}

document.querySelector('#today').textContent = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date());
document.querySelector('#greeting-date').textContent = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date()).toUpperCase();
document.querySelector('#load-form [name="pickupDate"]').value = isoToday();
document.querySelector('#payment-form [name="date"]').value = isoToday();
document.querySelector('#new-load').addEventListener('click', () => document.querySelector('#load-dialog').showModal());
document.querySelector('#create-invoice').addEventListener('click', () => document.querySelector('#invoice-dialog').showModal());
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));

document.querySelector('#load-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form));
  body.rate = Number(body.rate);
  body.carrierCost = Number(body.carrierCost);
  try {
    await api('/api/loads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    form.reset();
    document.querySelector('#load-form [name="pickupDate"]').value = isoToday();
    document.querySelector('#load-dialog').close();
    await refresh();
  } catch (error) { showError(form, error); }
});

document.querySelector('#invoice-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form));
  try {
    await api('/api/invoices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    form.reset();
    document.querySelector('#invoice-dialog').close();
    await refresh();
  } catch (error) { showError(form, error); }
});

document.querySelector('#payment-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form));
  body.amount = Number(body.amount);
  try {
    await api(`/api/invoices/${form.dataset.invoiceId}/payments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    form.reset();
    document.querySelector('#payment-form [name="date"]').value = isoToday();
    document.querySelector('#payment-dialog').close();
    await refresh();
  } catch (error) { showError(form, error); }
});

document.addEventListener('click', async event => {
  const action = event.target.closest('[data-load-action]');
  if (action) {
    const load = loads.find(item => item.id === action.dataset.loadAction);
    try {
      if (load.status === 'Delivered') {
        document.querySelector('#invoice-form [name="loadId"]').value = load.id;
        document.querySelector('#invoice-form [name="dueDate"]').value = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
        document.querySelector('#invoice-dialog').showModal();
      } else {
        await api(`/api/loads/${load.id}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: load.status === 'Planned' ? 'In Transit' : 'Delivered' }) });
        await refresh();
      }
    } catch (error) { window.alert(error.message); }
  }
  const payment = event.target.closest('[data-payment]');
  if (payment) {
    const invoice = invoices.find(item => item.id === payment.dataset.payment);
    const form = document.querySelector('#payment-form');
    form.dataset.invoiceId = invoice.id;
    form.elements.amount.max = invoice.balance;
    form.elements.amount.value = invoice.balance;
    form.elements.date.value = isoToday();
    document.querySelector('.payment-context').textContent = `${invoice.number} · ${invoice.customer} · Balance ${money(invoice.balance)}`;
    document.querySelector('#payment-dialog').showModal();
  }
});

document.querySelectorAll('.nav-item').forEach(link => link.addEventListener('click', () => {
  document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
  link.classList.add('active');
}));

refresh().catch(error => console.error('Unable to load TMS data:', error));
