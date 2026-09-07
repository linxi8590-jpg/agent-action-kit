/**
 * A pretend "existing product" plus the four failure modes people actually hit
 * when they wire a model into it. Run: node example/demo.mjs
 */
import { ActionLayer, ActionError } from '../src/action-layer.mjs';

// ---- the system that already exists, untouched by any of this ----------------
const store = {
  storeName: 'Northwind Coffee',
  currency: 'USD',
  freeShippingThreshold: 50,
  acceptingOrders: true,
  supportEmail: 'help@northwind.example',
};

// ---- what a model is allowed to do, stated once, in one place ---------------
const actions = {
  set_free_shipping_threshold: {
    description: 'Change the order value above which shipping is free.',
    args: { amount: { type: 'number', required: true, min: 0, max: 1000 } },
    allow: (actor) => actor?.role === 'owner' || actor?.role === 'manager',
    snapshot: () => ({ freeShippingThreshold: store.freeShippingThreshold }),
    run: ({ amount }) => { store.freeShippingThreshold = amount; },
  },
  pause_orders: {
    description: 'Temporarily stop accepting new orders.',
    args: { reason: { type: 'string', required: true, maxLength: 200 } },
    allow: (actor) => actor?.role === 'owner',
    snapshot: () => ({ acceptingOrders: store.acceptingOrders }),
    run: () => { store.acceptingOrders = false; },
  },
  set_support_email: {
    description: 'Update the address customers are told to contact.',
    args: { email: { type: 'string', required: true, maxLength: 120 } },
    allow: (actor) => actor?.role === 'owner',
    snapshot: () => ({ supportEmail: store.supportEmail }),
    run: ({ email }) => { store.supportEmail = email; },
  },
};

const layer = new ActionLayer({ actions });

// ---- the model boundary -----------------------------------------------------
// Swap this for a real model call. Its only job is to return an intent; it has
// no access to the store, and nothing it returns is trusted.
function plan(utterance) {
  const money = utterance.match(/\$?(\d+(?:\.\d+)?)/);
  if (/free/i.test(utterance) && /shipping/i.test(utterance) && money) {
    return { action: 'set_free_shipping_threshold', args: { amount: money[1] } };
  }
  if (/pause|stop taking orders/i.test(utterance)) {
    return { action: 'pause_orders', args: { reason: utterance.trim().slice(0, 200) } };
  }
  if (/refund everyone|delete/i.test(utterance)) {
    return { action: 'refund_all_orders', args: {} }; // model invents an action
  }
  return null;
}

const line = (s) => console.log(`\n${s}\n${'-'.repeat(s.length)}`);
async function attempt(label, utterance, actor, opts = {}) {
  line(label);
  console.log(`say    : ${utterance}`);
  const intent = plan(utterance);
  if (!intent) return console.log('result : no action matched; nothing happened');
  if (opts.idempotencyKey) intent.idempotencyKey = opts.idempotencyKey;
  console.log(`intent : ${intent.action} ${JSON.stringify(intent.args)}`);
  try {
    const r = await layer.execute(intent, actor);
    console.log(`result : ok${r.replayed ? ' (replayed, no second write)' : ''}`);
    for (const c of r.changed) console.log(`changed: ${c.field}: ${c.from} -> ${c.to}`);
    if (!r.changed.length) console.log('changed: nothing');
  } catch (e) {
    if (e instanceof ActionError) console.log(`refused: [${e.code}] ${e.message}`);
    else throw e;
  }
}

const owner = { id: 'sam', role: 'owner' };
const clerk = { id: 'lee', role: 'clerk' };

await attempt('1. normal write', 'make shipping free over $75', owner);
await attempt('2. out of range, caught before touching the store',
  'make shipping free over $99999', owner);
await attempt('3. wrong role', 'make shipping free over $20', clerk);
await attempt('4. model invents an action that does not exist',
  'refund everyone and delete the store', owner);
await attempt('5. first call with an idempotency key',
  'pause, we are out of beans', owner, { idempotencyKey: 'ticket-4417' });
await attempt('6. same key again (a retry, a double click, a queue redelivery)',
  'pause, we are out of beans', owner, { idempotencyKey: 'ticket-4417' });
await attempt('7. same key with different arguments is a conflict',
  'pause, the grinder is broken', owner, { idempotencyKey: 'ticket-4417' });
await attempt('8. another actor cannot replay the owner\'s receipt',
  'pause, we are out of beans', clerk, { idempotencyKey: 'ticket-4417' });

line('audit log');
for (const r of layer.audit) {
  const what = r.changed.map((c) => `${c.field} ${c.from}->${c.to}`).join(', ') || 'no change';
  console.log(`${r.at}  ${r.actor}  ${r.action}  ${what}`);
}

line('store now');
console.log(store);
