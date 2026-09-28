const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { menuItems } = require('./menu');
const store = require('./store');

const envFile = path.join(__dirname, '..', '.env');
if (typeof process.loadEnvFile === 'function' && fs.existsSync(envFile)) process.loadEnvFile(envFile);

const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = process.env.NODE_ENV || 'development';
const PAYMENT_MODE = process.env.PAYMENT_MODE || 'TEST';
const allowedOrigins = new Set((process.env.CORS_ORIGINS || 'http://localhost:3000').split(',').map((value) => value.trim()).filter(Boolean));
const orderStates = ['NEW', 'CONFIRMED', 'PREPARING', 'READY', 'RECEIVED', 'COMPLETED', 'CANCELLED'];
const paymentStates = ['UNPAID', 'PAYMENT_PENDING', 'PAID', 'PAYMENT_FAILED', 'PAYMENT_CANCELLED', 'PAYMENT_EXPIRED', 'REFUNDED'];
const transitions = { NEW: ['CONFIRMED', 'PREPARING', 'CANCELLED'], CONFIRMED: ['PREPARING', 'CANCELLED'], PREPARING: ['READY', 'CANCELLED'], READY: ['RECEIVED'], RECEIVED: [], COMPLETED: [], CANCELLED: [] };
const erpNextTimeoutMs = 10000;

function erpNextConfiguration() {
  const baseUrl = (process.env.ERPNEXT_API_URL || '').trim().replace(/\/+$/, '');
  const apiKey = (process.env.ERPNEXT_API_KEY || '').trim();
  const apiSecret = (process.env.ERPNEXT_API_SECRET || '').trim();
  return { baseUrl, apiKey, apiSecret, complete: Boolean(baseUrl && apiKey && apiSecret) };
}

function integrationError(httpStatus, code, message) {
  return Object.assign(new Error(message), { httpStatus, code });
}

async function requestErpNext(resource, query = {}) {
  const configuration = erpNextConfiguration();
  if (!configuration.complete) {
    throw integrationError(503, 'ERPNEXT_UNCONFIGURED', 'ERPNext is unavailable: ERPNEXT_API_URL, ERPNEXT_API_KEY, and ERPNEXT_API_SECRET must be configured.');
  }

  const url = new URL(`${configuration.baseUrl}/api/resource/${resource}`);
  Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), erpNextTimeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', Authorization: `token ${configuration.apiKey}:${configuration.apiSecret}` },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw integrationError(502, 'ERPNEXT_REQUEST_FAILED', `ERPNext returned HTTP ${response.status} for ${resource}.`);
    }
    return body.data || [];
  } catch (caught) {
    if (caught.httpStatus) throw caught;
    if (caught.name === 'AbortError') throw integrationError(504, 'ERPNEXT_TIMEOUT', 'ERPNext did not respond before the connection timed out.');
    throw integrationError(502, 'ERPNEXT_UNREACHABLE', 'ERPNext could not be reached from the backend.');
  } finally {
    clearTimeout(timeout);
  }
}

function inventoryStatus(currentStock, minimumStock) {
  if (currentStock <= 0) return 'OUT OF STOCK';
  if (currentStock <= minimumStock) return 'LOW STOCK';
  return 'IN STOCK';
}

async function getErpNextInventory() {
  const [items, bins] = await Promise.all([
    requestErpNext('Item', { fields: JSON.stringify(['item_code', 'item_name', 'item_group', 'stock_uom', 'safety_stock']), limit_page_length: '1000' }),
    requestErpNext('Bin', { fields: JSON.stringify(['item_code', 'actual_qty', 'warehouse']), limit_page_length: '5000' }),
  ]);
  const stockByItem = new Map();
  bins.forEach((bin) => {
    const current = stockByItem.get(bin.item_code) || { currentStock: 0, warehouses: [] };
    current.currentStock += Number(bin.actual_qty || 0);
    if (bin.warehouse) current.warehouses.push(bin.warehouse);
    stockByItem.set(bin.item_code, current);
  });
  return items.map((item) => {
    const stock = stockByItem.get(item.item_code) || { currentStock: 0, warehouses: [] };
    const currentStock = stock.currentStock;
    const minimumStock = Number(item.safety_stock || 0);
    return {
      id: item.item_code,
      item_code: item.item_code,
      item_name: item.item_name || item.item_code,
      category: item.item_group || 'Uncategorized',
      current_stock: currentStock,
      unit: item.stock_uom || 'Unit',
      minimum_stock: minimumStock,
      status: inventoryStatus(currentStock, minimumStock),
      warehouses: stock.warehouses,
      recent_movements: [],
    };
  });
}

function responseJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}
function error(response, status, code, message) { responseJson(response, status, { success: false, error: { code, message } }); }
function ok(response, body) { responseJson(response, 200, { success: true, ...body }); }
function cors(response, request) {
  const origin = request.headers.origin;
  if (origin && allowedOrigins.has(origin)) response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Vary', 'Origin');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key, X-Webhook-Signature');
}
function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; if (raw.length > 1_000_000) reject(new Error('Request too large')); });
    request.on('end', () => { if (!raw) return resolve({}); try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON')); } });
    request.on('error', reject);
  });
}
function requestIdempotency(request, body) { return request.headers['idempotency-key'] || body.idempotencyKey || null; }
function serveStatic(response, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(__dirname, '..', '..', requested.slice(1));
  const rootPath = path.resolve(__dirname, '..', '..');
  if (!filePath.startsWith(rootPath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  response.writeHead(200, { 'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream' });
  response.end(fs.readFileSync(filePath));
  return true;
}
function itemFromRequest(item) { return menuItems.find((candidate) => candidate.id === (item.item_id || item.itemId || item.id)); }
function normalizeItems(input) {
  if (!Array.isArray(input) || input.length === 0) throw Object.assign(new Error('At least one item is required.'), { code: 'INVALID_ITEMS' });
  return input.map((requested) => {
    const menuItem = itemFromRequest(requested);
    const quantity = Number(requested.quantity);
    if (!menuItem) throw Object.assign(new Error('One or more items are invalid.'), { code: 'INVALID_ITEM' });
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw Object.assign(new Error('Quantity must be a whole number from 1 to 99.'), { code: 'INVALID_QUANTITY' });
    if (!menuItem.available) throw Object.assign(new Error(`${menuItem.name} is unavailable.`), { code: 'ITEM_UNAVAILABLE' });
    return { item_id: menuItem.id, name: menuItem.name, category: menuItem.category, quantity, unit_price: menuItem.price, subtotal: menuItem.price * quantity };
  });
}
function createOrder(body, payment) {
  const lineItems = normalizeItems(body.items);
  const subtotal = lineItems.reduce((sum, item) => sum + item.subtotal, 0);
  const initialStatus = payment?.status === 'PAID' ? 'CONFIRMED' : 'NEW';
  const order = {
    id: store.internalId('ORD'), order_number: store.orderNumber(), queue_number: store.queueNumber(), source: body.source || 'KIOSK', items: lineItems,
    subtotal, discount: 0, tax: 0, total: subtotal, payment: payment || { method: body.paymentMethod || null, status: 'UNPAID', transaction_id: null },
    order_type: body.orderType || body.order_type || null, status: initialStatus, created_at: store.now(), updated_at: store.now(), status_history: [{ status: initialStatus, changed_at: store.now(), changed_by: body.source || 'KIOSK' }]
  };
  return store.saveOrder(order);
}
function publicPayment(payment) { return { id: payment.id, paymentStatus: payment.status, payment_id: payment.id, paymentUrl: payment.payment_url || null, mode: payment.mode }; }
function updatePayment(payment, status, transactionId = payment.transaction_id) {
  if (!paymentStates.includes(status)) throw new Error('Invalid payment state.');
  payment.status = status; payment.transaction_id = transactionId; payment.updated_at = store.now();
  const order = payment.order_id && store.findOrder(payment.order_id);
  if (order) {
    order.payment.status = status;
    order.payment.transaction_id = transactionId;
    if (status === 'PAID' && order.status === 'NEW') {
      order.status = 'CONFIRMED';
      order.status_history.push({ status: 'CONFIRMED', changed_at: store.now(), changed_by: 'PAYMENT' });
    }
    store.saveOrder(order);
  }
  return payment;
}
async function route(request, response) {
  cors(response, request);
  if (request.method === 'OPTIONS') { response.writeHead(204); return response.end(); }
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (request.method === 'GET' && !url.pathname.startsWith('/api/') && serveStatic(response, url.pathname)) return;
    if (request.method === 'GET' && url.pathname === '/api/health') return ok(response, { status: 'ok', service: 'backend', timestamp: store.now(), environment: NODE_ENV });
    if (request.method === 'GET' && url.pathname === '/api/health/database') return ok(response, { status: 'unconfigured', dependency: 'database', message: 'DATABASE_URL is not configured; development store is in memory.' });
    if (request.method === 'GET' && url.pathname === '/api/health/erpnext') return ok(response, { status: erpNextConfiguration().complete ? 'configured' : 'unconfigured', dependency: 'erpnext' });
    if (request.method === 'GET' && url.pathname === '/api/health/payment') return ok(response, { status: process.env.PAYMENT_PROVIDER_URL ? 'configured' : 'unconfigured', dependency: 'payment', mode: PAYMENT_MODE });
    if (request.method === 'GET' && url.pathname === '/api/menu') return ok(response, { categories: [...new Set(menuItems.map((item) => item.category))], items: menuItems });
    if (request.method === 'GET' && url.pathname === '/api/inventory') return ok(response, { source: 'ERPNEXT', capabilities: { movements: false }, items: await getErpNextInventory() });
    if (request.method === 'GET' && url.pathname === '/api/orders/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); response.write(`data: ${JSON.stringify({ type: 'CONNECTED' })}\n\n`); store.addEventClient(response); return;
    }
    if (request.method === 'GET' && (url.pathname === '/api/orders' || url.pathname === '/api/kitchen/orders')) {
      let results = [...store.orders.values()]; const status = url.searchParams.get('status');
      if (status) results = results.filter((order) => order.status === status || order.payment.status === status);
      if (url.pathname === '/api/kitchen/orders') results = results.filter((order) => order.payment.status === 'PAID' && !['RECEIVED', 'COMPLETED', 'CANCELLED'].includes(order.status));
      return ok(response, { orders: results });
    }
    if (request.method === 'GET' && parts[0] === 'api' && parts[1] === 'orders' && parts[2] === 'by-number') {
      const order = store.findOrder(parts[3]); if (!order) return error(response, 404, 'ORDER_NOT_FOUND', 'Order not found.'); return ok(response, { order });
    }
    if (request.method === 'GET' && parts[0] === 'api' && parts[1] === 'customer-display' && parts[2] === 'orders') {
      const order = store.findOrder(parts[3]); if (!order) return error(response, 404, 'ORDER_NOT_FOUND', 'Order not found.'); return ok(response, { order: { order_number: order.order_number, status: order.status, payment_status: order.payment.status, updated_at: order.updated_at } });
    }
    if (request.method === 'GET' && parts[0] === 'api' && parts[1] === 'orders' && parts.length === 3) {
      const order = store.findOrder(parts[2]); if (!order) return error(response, 404, 'ORDER_NOT_FOUND', 'Order not found.'); return ok(response, { order });
    }
    if (request.method === 'POST' && url.pathname === '/api/payments') {
      const body = await readBody(request); const key = requestIdempotency(request, body);
      if (!key) return error(response, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'An idempotency key is required.');
      if (store.idempotency.has(key)) return ok(response, { payment: publicPayment(store.idempotency.get(key)) });
      const lineItems = normalizeItems(body.items); const amount = lineItems.reduce((sum, item) => sum + item.subtotal, 0);
      if (Number(body.total) !== amount) return error(response, 400, 'TOTAL_MISMATCH', 'The submitted total does not match authoritative menu prices.');
      const payment = { id: store.internalId('PAY'), order_id: null, amount, method: body.paymentProvider || body.paymentCategory, status: 'PAYMENT_PENDING', transaction_id: null, mode: PAYMENT_MODE, idempotency_key: key, created_at: store.now(), updated_at: store.now() };
      store.payments.set(payment.id, payment); store.idempotency.set(key, payment); store.emit({ type: 'PAYMENT_UPDATED', payment: publicPayment(payment) });
      return responseJson(response, 201, { success: true, payment: publicPayment(payment) });
    }
    if (request.method === 'GET' && parts[0] === 'api' && parts[1] === 'payments' && parts[3] === 'status') {
      const payment = store.payments.get(parts[2]); if (!payment) return error(response, 404, 'PAYMENT_NOT_FOUND', 'Payment not found.'); return ok(response, { payment: publicPayment(payment) });
    }
    if (request.method === 'POST' && parts[0] === 'api' && parts[1] === 'payments' && parts[3] === 'cancel') {
      const payment = store.payments.get(parts[2]); if (!payment) return error(response, 404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
      if (['PAID', 'REFUNDED'].includes(payment.status)) return error(response, 409, 'PAYMENT_ALREADY_SETTLED', 'A settled payment cannot be cancelled.');
      updatePayment(payment, 'PAYMENT_CANCELLED'); return ok(response, { payment: publicPayment(payment) });
    }
    if (request.method === 'POST' && url.pathname === '/api/payments/webhook') {
      const expected = process.env.PAYMENT_WEBHOOK_SECRET; if (!expected) return error(response, 503, 'PAYMENT_NOT_CONFIGURED', 'Payment webhook secret is not configured.');
      if (request.headers['x-webhook-signature'] !== expected) return error(response, 401, 'INVALID_WEBHOOK_SIGNATURE', 'Payment webhook signature could not be verified.');
      const body = await readBody(request); const payment = store.payments.get(body.payment_id); if (!payment) return error(response, 404, 'PAYMENT_NOT_FOUND', 'Payment not found.');
      updatePayment(payment, body.status, body.transaction_id); return ok(response, { payment: publicPayment(payment) });
    }
    if (request.method === 'POST' && url.pathname === '/api/orders') {
      const body = await readBody(request); const key = requestIdempotency(request, body);
      if (key && store.idempotency.has(key) && store.idempotency.get(key).order_id) return ok(response, { order: store.findOrder(store.idempotency.get(key).order_id) });
      const payment = body.paymentId ? store.payments.get(body.paymentId) : null;
      if (body.paymentId && (!payment || payment.status !== 'PAID')) return error(response, 409, 'PAYMENT_NOT_VERIFIED', 'Payment must be verified as PAID before the order is created.');
      const order = createOrder(body, payment ? { method: payment.method, status: 'PAID', transaction_id: payment.transaction_id } : null);
      if (payment) { payment.order_id = order.id; store.payments.set(payment.id, payment); }
      if (key) { store.idempotency.set(key, { order_id: order.id }); }
      return responseJson(response, 201, { success: true, order });
    }
    if (request.method === 'POST' && url.pathname === '/api/orders/cash-intent') {
      const body = await readBody(request); const key = requestIdempotency(request, body);
      if (!key) return error(response, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'An idempotency key is required.');
      if (store.idempotency.has(key)) {
        const existing = store.idempotency.get(key);
        return ok(response, { order: store.findOrder(existing.order_id), payment: publicPayment(store.payments.get(existing.payment_id)) });
      }
      const lineItems = normalizeItems(body.items); const amount = lineItems.reduce((sum, item) => sum + item.subtotal, 0);
      if (Number(body.total) !== amount) return error(response, 400, 'TOTAL_MISMATCH', 'The submitted total does not match authoritative menu prices.');
      const payment = { id: store.internalId('PAY'), order_id: null, amount, method: body.paymentProvider || body.paymentCategory, status: 'PAYMENT_PENDING', transaction_id: null, mode: PAYMENT_MODE, idempotency_key: key, created_at: store.now(), updated_at: store.now() };
      store.payments.set(payment.id, payment);
      const order = createOrder(body, { method: payment.method, status: 'PAYMENT_PENDING', transaction_id: null });
      payment.order_id = order.id;
      store.payments.set(payment.id, payment);
      store.idempotency.set(key, { order_id: order.id, payment_id: payment.id });
      return responseJson(response, 201, { success: true, order, payment: publicPayment(payment) });
    }
    if (request.method === 'PATCH' && parts[0] === 'api' && parts[1] === 'orders' && parts[3] === 'status') {
      const body = await readBody(request); const order = store.findOrder(parts[2]); if (!order) return error(response, 404, 'ORDER_NOT_FOUND', 'Order not found.');
      if (!orderStates.includes(body.status) || !transitions[order.status].includes(body.status)) return error(response, 409, 'INVALID_STATUS_TRANSITION', `Cannot move ${order.status} to ${body.status}.`);
      order.status = body.status; order.status_history.push({ status: body.status, changed_at: store.now(), changed_by: body.changed_by || 'API' }); store.saveOrder(order); return ok(response, { order });
    }
    if (request.method === 'PATCH' && parts[0] === 'api' && parts[1] === 'kitchen' && parts[2] === 'orders' && parts[4] === 'status') {
      const order = store.findOrder(parts[3]); const body = await readBody(request); if (!order) return error(response, 404, 'ORDER_NOT_FOUND', 'Order not found.');
      if (!['PREPARING', 'READY', 'RECEIVED'].includes(body.status) || !transitions[order.status].includes(body.status)) return error(response, 409, 'INVALID_KITCHEN_TRANSITION', 'Invalid kitchen status transition.');
      order.status = body.status; order.status_history.push({ status: body.status, changed_at: store.now(), changed_by: 'KDS' }); store.saveOrder(order); return ok(response, { order });
    }
    if (request.method === 'POST' && parts[0] === 'api' && parts[1] === 'orders' && parts[3] === 'cancel') {
      const order = store.findOrder(parts[2]); if (!order) return error(response, 404, 'ORDER_NOT_FOUND', 'Order not found.'); if (!transitions[order.status].includes('CANCELLED')) return error(response, 409, 'CANNOT_CANCEL_ORDER', 'This order cannot be cancelled.');
      order.status = 'CANCELLED'; order.status_history.push({ status: 'CANCELLED', changed_at: store.now(), changed_by: 'POS' }); store.saveOrder(order); return ok(response, { order });
    }
    if (request.method === 'POST' && parts[0] === 'api' && parts[1] === 'orders' && parts[3] === 'payment' && parts[4] === 'cash') {
      const body = await readBody(request); const order = store.findOrder(parts[2]); if (!order) return error(response, 404, 'ORDER_NOT_FOUND', 'Order not found.'); const received = Number(body.cashReceived); if (!Number.isFinite(received) || received < order.total) return error(response, 400, 'INSUFFICIENT_CASH', 'Cash received is less than the authoritative amount due.');
      const change = received - order.total;
      order.payment = { ...order.payment, method: order.payment.method || 'CASH', status: 'PAID', transaction_id: order.payment.transaction_id || store.internalId('CASH'), cash_received: received, change };
      order.cash_received = received;
      order.change = change;
      order.status = order.status === 'NEW' ? 'CONFIRMED' : order.status;
      order.status_history.push({ status: order.status, changed_at: store.now(), changed_by: 'POS' });
      const payment = [...store.payments.values()].find((candidate) => candidate.order_id === order.id);
      if (payment) updatePayment(payment, 'PAID', order.payment.transaction_id);
      store.saveOrder(order); return ok(response, { order, change });
    }
    if (request.method === 'POST' && parts[0] === 'api' && parts[1] === 'payments' && parts[3] === 'refund') {
      const payment = store.payments.get(parts[2]); if (!payment) return error(response, 404, 'PAYMENT_NOT_FOUND', 'Payment not found.'); updatePayment(payment, 'REFUNDED'); return ok(response, { payment: publicPayment(payment) });
    }
    return error(response, 404, 'NOT_FOUND', 'Endpoint not found.');
  } catch (caught) {
    const status = caught.httpStatus || (caught.message === 'Request too large' ? 413 : caught.code ? 400 : 500);
    return error(response, status, caught.code || 'INTERNAL_ERROR', status === 500 ? 'The backend could not complete the request.' : caught.message);
  }
}

const server = http.createServer(route);
server.listen(PORT, () => console.log(`Geek Restaurant backend running at http://localhost:${PORT}`));
