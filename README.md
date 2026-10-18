# Silvicom 360 TMS

A lightweight transportation management MVP with load tracking, customer billing, cash receipts, and double-entry accounting.

## Run locally

Requires Node.js 20 or newer. No third-party packages are required.

```sh
npm start
```

Open [http://localhost:3000](http://localhost:3000). The app stores its data in `data/store.json` and creates a small sample workspace on first launch. Set `PORT` to use another port.
The development server binds to the local loopback interface and is intended for local evaluation, not direct production deployment.

## Workflows

- Create loads with customer rate and carrier cost; advance them from planned to in transit to delivered.
- Create invoices only for delivered loads. Posting an invoice recognizes freight revenue and carrier costs with a balanced journal entry.
- Record full or partial customer payments. Each receipt debits cash and credits accounts receivable.
- Review dashboard totals, outstanding/overdue receivables, and recent journal entries.

## API

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/dashboard` | Revenue, expenses, profit, receivables, and load totals |
| `GET` | `/api/loads` | List loads |
| `POST` | `/api/loads` | Create a load |
| `PATCH` | `/api/loads/:id/status` | Advance a load to its next status |
| `GET` | `/api/invoices` | List invoices and calculated balances |
| `POST` | `/api/invoices` | Post an invoice for a delivered load |
| `POST` | `/api/invoices/:id/payments` | Record a payment |
| `GET` | `/api/journal` | List balanced journal entries |
| `GET` | `/api/accounts` | Account debit and credit totals |

Run the built-in tests with `npm test`.