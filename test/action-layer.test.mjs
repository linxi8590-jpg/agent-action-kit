import assert from 'node:assert/strict';
import test from 'node:test';

import { ActionError, ActionLayer } from '../src/action-layer.mjs';

function fixture({ delay = 0 } = {}) {
  const state = { value: 0, writes: 0 };
  const layer = new ActionLayer({
    actions: {
      set_value: {
        description: 'Set a value.',
        args: { value: { type: 'number', required: true, min: 0, max: 100 } },
        allow: (actor) => actor?.role === 'owner',
        snapshot: () => ({ value: state.value }),
        run: async ({ value }) => {
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
          state.value = value;
          state.writes += 1;
        },
      },
    },
    now: () => '2026-09-07T00:00:00.000Z',
  });
  return { layer, state };
}

const owner = { id: 'owner-1', role: 'owner' };

test('validates, coerces, writes, and records a field-level receipt', async () => {
  const { layer, state } = fixture();
  const receipt = await layer.execute({ action: 'set_value', args: { value: '12' } }, owner);

  assert.equal(state.value, 12);
  assert.equal(state.writes, 1);
  assert.deepEqual(receipt.changed, [{ field: 'value', from: 0, to: 12 }]);
  assert.equal(layer.audit.length, 1);
});

test('rejects malformed arguments and non-finite numbers before a write', async () => {
  const { layer, state } = fixture();

  await assert.rejects(
    layer.execute({ action: 'set_value', args: null }, owner),
    (error) => error instanceof ActionError && error.code === 'INVALID_ARGUMENT',
  );
  await assert.rejects(
    layer.execute({ action: 'set_value', args: { value: Infinity } }, owner),
    (error) => error instanceof ActionError && error.code === 'INVALID_ARGUMENT',
  );
  assert.equal(state.writes, 0);
});

test('same actor, key, action, and arguments replay one completed write', async () => {
  const { layer, state } = fixture();
  const intent = { action: 'set_value', args: { value: 9 }, idempotencyKey: 'request-1' };

  const first = await layer.execute(intent, owner);
  const replay = await layer.execute(intent, owner);

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(state.writes, 1);
  assert.equal(layer.audit.length, 1);
});

test('simultaneous retries share one in-flight write', async () => {
  const { layer, state } = fixture({ delay: 10 });
  const intent = { action: 'set_value', args: { value: 7 }, idempotencyKey: 'request-2' };

  const [first, replay] = await Promise.all([
    layer.execute(intent, owner),
    layer.execute(intent, owner),
  ]);

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(state.writes, 1);
});

test('a reused key with different arguments is rejected', async () => {
  const { layer, state } = fixture();
  await layer.execute(
    { action: 'set_value', args: { value: 5 }, idempotencyKey: 'request-3' },
    owner,
  );

  await assert.rejects(
    layer.execute(
      { action: 'set_value', args: { value: 6 }, idempotencyKey: 'request-3' },
      owner,
    ),
    (error) => error instanceof ActionError && error.code === 'IDEMPOTENCY_CONFLICT',
  );
  assert.equal(state.value, 5);
  assert.equal(state.writes, 1);
});

test('authorization runs before idempotency lookup and receipts stay actor-scoped', async () => {
  const { layer, state } = fixture();
  const intent = { action: 'set_value', args: { value: 4 }, idempotencyKey: 'shared-key' };
  await layer.execute(intent, owner);

  await assert.rejects(
    layer.execute(intent, { id: 'clerk-1', role: 'clerk' }),
    (error) => error instanceof ActionError && error.code === 'FORBIDDEN',
  );
  assert.equal(state.writes, 1);
});

test('an async authorization policy is awaited and fails closed', async () => {
  const layer = new ActionLayer({
    actions: {
      unsafe: {
        description: 'Never reached.',
        args: {},
        allow: async () => false,
        run: () => assert.fail('write must not run'),
      },
    },
  });

  await assert.rejects(
    layer.execute({ action: 'unsafe', args: {} }, owner),
    (error) => error instanceof ActionError && error.code === 'FORBIDDEN',
  );
});

test('failed writes release their key so a corrected retry can run', async () => {
  let attempts = 0;
  const layer = new ActionLayer({
    actions: {
      flaky: {
        description: 'Fail once.',
        args: {},
        allow: () => true,
        run: () => {
          attempts += 1;
          if (attempts === 1) throw new Error('temporary');
          return 'done';
        },
      },
    },
  });
  const intent = { action: 'flaky', args: {}, idempotencyKey: 'retry-me' };

  await assert.rejects(layer.execute(intent, owner), /temporary/);
  const receipt = await layer.execute(intent, owner);

  assert.equal(receipt.result, 'done');
  assert.equal(attempts, 2);
});
