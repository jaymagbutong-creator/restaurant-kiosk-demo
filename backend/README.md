# Geek Restaurant Backend

Development API boundary shared by the kiosk, cashier POS, KDS, and customer display. The backend is the authority for menu prices, order totals, payment state, and order state.

## Run

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

Orders and payments use the intentional in-memory development adapter and reset when the process stops. Inventory is read from ERPNext only when `ERPNEXT_API_URL`, `ERPNEXT_API_KEY`, and `ERPNEXT_API_SECRET` are configured; inventory is never stored locally.

## API

- `GET /api/health`
- `GET /api/health/database`
- `GET /api/health/erpnext`
- `GET /api/health/payment`
- `GET /api/menu`
- `GET /api/inventory` (ERPNext `Item` and `Bin` resources; returns `503 ERPNEXT_UNCONFIGURED` until configured)
- `POST /api/orders`
- `POST /api/orders/cash-intent`
- `GET /api/orders?view=pos&status=NEW`
- `GET /api/orders/:id`
- `GET /api/orders/by-number/:orderNumber`
- `GET /api/orders/events` (SSE)
- `PATCH /api/orders/:id/status`
- `POST /api/orders/:id/cancel`
- `POST /api/orders/:id/payment/cash`
- `POST /api/payments`
- `GET /api/payments/:id/status`
- `POST /api/payments/:id/cancel`
- `POST /api/payments/webhook`
- `POST /api/payments/:id/refund`
- `GET /api/kitchen/orders`
- `PATCH /api/kitchen/orders/:id/status`
- `GET /api/customer-display/orders/:orderNumber`

Online payments remain pending until a configured, signature-verified provider webhook marks them `PAID`. No frontend success signal is trusted. The test mode still requires a backend webhook; it does not fake payment success.

Production work still required: database transactions and indexes, authentication/authorization, rate limiting, request validation library, signed provider integration, ERPNext adapter, Kong configuration, durable audit history, and HTTPS deployment.
