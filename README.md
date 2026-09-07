# agent-action-kit

A small, dependency-free action layer for the moment a language model stops
answering questions and starts changing things.

The model never calls your endpoints. It proposes an intent. This layer decides
whether that intent becomes a write, and returns a receipt saying exactly what
moved.

```
node example/demo.mjs
npm test
```

## Why not just give the model your API

Because "the model called the right endpoint" and "the right thing happened"
are different claims, and only the second one matters at 2am. Five things sit
between an intent and a write:

| | |
|---|---|
| **allowlist** | actions are declared in one place; anything else is refused by name |
| **authorization** | each action states who may run it, checked per call |
| **validation** | arguments are typed, bounded and coerced before any state is touched |
| **idempotency** | a same-actor retry returns the first receipt; conflicting reuse is refused |
| **receipt** | every write records a field-level before/after, not just "success" |

## What a receipt looks like

```
intent : set_free_shipping_threshold {"amount":"75"}
result : ok
changed: freeShippingThreshold: 50 -> 75
```

and when the model is wrong, which it will be:

```
refused: [INVALID_ARGUMENT] set_free_shipping_threshold: "amount" above maximum 1000
refused: [FORBIDDEN] lee may not run set_free_shipping_threshold
refused: [UNKNOWN_ACTION] no such action: refund_all_orders
```

That last one matters more than it looks. A model asked to "refund everyone and
delete the store" will happily emit an action name that does not exist. The
allowlist is what turns that from an incident into a log line.

## Declaring an action

```js
set_free_shipping_threshold: {
  description: 'Change the order value above which shipping is free.',
  args: { amount: { type: 'number', required: true, min: 0, max: 1000 } },
  allow: (actor) => actor.role === 'owner' || actor.role === 'manager',
  snapshot: () => ({ freeShippingThreshold: store.freeShippingThreshold }),
  run: ({ amount }) => { store.freeShippingThreshold = amount; },
}
```

`snapshot` is what makes the receipt possible: it is read before and after
`run`, and the difference is the diff. Omit it and the action still works, the
receipt just says nothing changed that it could see.

## Where the model goes

`example/demo.mjs` uses a hand-written planner so the demo runs offline. Replace
it with a real model call — the layer neither knows nor cares which one. Use
`await layer.list(actor)` to build the tool definition in your provider's format,
take back an intent, then pass it to `layer.execute`. Everything the model
returns is untrusted input.

The `actor` is different: build it from your authenticated server-side session,
never from model output. That identity is what authorization and idempotency are
bound to. Attach the idempotency key from the inbound request, job or queue
message as well; do not ask the model to invent one. Authorization policies may
be synchronous or async and must resolve to the boolean `true` to allow a call.

## Scope

This is a reference implementation, not a framework. It is one file, no runtime
dependencies, and it is meant to be read in ten minutes and copied into your own
codebase rather than installed. The included idempotency store is process-local.
Durable, atomic idempotency across workers, transactions, retention and retry
policy deliberately belong to the system that already exists, not to the layer
in front of it.

[MIT](LICENSE).
