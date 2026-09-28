const crypto = require('node:crypto');

const orders = new Map();
const payments = new Map();
const idempotency = new Map();
const events = new Set();
let nextOrderNumber = 1000;

function now() { return new Date().toISOString(); }
function internalId(prefix) { return `${prefix}-${now().slice(0, 10).replaceAll('-', '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; }
function orderNumber() { nextOrderNumber += 1; return String(nextOrderNumber); }
function queueNumber() { return `A${String(nextOrderNumber).padStart(3, '0')}`; }
function emit(event) { const data = `data: ${JSON.stringify(event)}\n\n`; events.forEach((response) => response.write(data)); }
function addEventClient(response) { events.add(response); response.on('close', () => events.delete(response)); }
function findOrder(id) { return [...orders.values()].find((order) => order.id === id || order.order_number === id); }
function saveOrder(order) { order.updated_at = now(); orders.set(order.id, order); emit({ type: 'ORDER_UPDATED', order }); return order; }

module.exports = { orders, payments, idempotency, now, internalId, orderNumber, queueNumber, emit, addEventClient, findOrder, saveOrder };
