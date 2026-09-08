# Check authorization before replaying a tool result

An idempotency cache can stop a repeated request from performing the same write twice. It can also return a previous caller's result if the cache lookup happens before authorization.

During review of an early version of agent-action-kit, I found that ordering problem alongside two related gaps: conflicting reuse of a key could silently suppress a different request, and concurrent requests could both reach the write. The fixes illustrate three separate questions an action handler needs to answer:

1. May this caller perform the action now?
2. Is this actually the same request?
3. Has another execution already claimed it?

The examples below describe the [reference implementation at `e52e8da`](https://github.com/linxi8590-jpg/agent-action-kit/blob/e52e8da4069168add85cab49a1bde3904f6f7860/src/action-layer.mjs). Its idempotency store lives in one JavaScript instance; distributed execution needs additional storage and transaction design.

## A cached response still needs authorization

Consider this deliberately incomplete handler:

```js
if (cache.has(key)) return cache.get(key);
await authorize(actor, action);
return performWrite();
```

On a cache hit, the caller never reaches authorization. If keys are global, someone who knows another caller's key can receive their cached receipt. Even a caller replaying their own key may have lost permission since the first request.

The reference implementation checks that the action exists, awaits its authorization policy, validates the arguments, and only then consults the idempotency store. A configured policy must resolve to the boolean `true` to allow execution. Awaiting it matters: an unresolved Promise is truthy even when its eventual answer is `false`.

The application must supply the caller from its authenticated server-side session. Model output must not choose the caller's identity or role. Authorization policy design remains the application's responsibility; an action without an `allow` callback has no policy check in this small implementation.

## A key identifies a request, not permission to change it

These two expressions serve different purposes:

```js
scope = JSON.stringify([actor.id, idempotencyKey]);
fingerprint = JSON.stringify([name, clean]);
```

The scope isolates callers. The fingerprint records the action and validated arguments. A matching scope with a different fingerprint raises `IDEMPOTENCY_CONFLICT`; it does not silently return the first write's result.

For example, setting a value to `5` with key `request-3`, then reusing that key to set it to `6`, is a conflict. Retrying the same validated request can replay the original receipt. This fingerprint is tailored to the implementation's simple schema; it is not a general canonical serialization scheme for arbitrary nested objects.

## Claim execution before starting the write

Checking a cache after the first write finishes leaves a concurrency window. Two callers can both observe a missing entry and both start work.

The implementation stores a Promise before the write starts:

```js
const entry = { fingerprint, promise: Promise.resolve().then(perform) };
this.idempotencyEntries.set(scope, entry);
```

After the checks above, a matching retry awaits that same Promise. This coordinates calls through one layer instance. It does not coordinate separate instances, workers, or process restarts.

There is another boundary worth testing in the host application: a database write can commit before the handler throws. This reference releases failed entries for retry, so it cannot guarantee exactly-once effects in that situation. Durable idempotency must account for the commit and its receipt together, using the application's storage guarantees.

## A before/after receipt is evidence with a defined scope

An optional `snapshot` callback reads state before and after `run`; the receipt records a field-level diff. In the offline demo, that state is an in-memory object. An integration can supply a real storage read, but the layer does not automatically verify database persistence or compare the resulting state with the requested target.

An empty diff can mean the requested value was already present. It can also mean the snapshot did not observe the intended change. A receipt with `ok: true` therefore does not, by itself, establish that a requested business outcome occurred. Define that outcome and its read-back check at the integration boundary.

## Run the examples

From the repository root, with Node.js 18 or later:

```sh
npm test
npm run demo
```

The [eight tests](https://github.com/linxi8590-jpg/agent-action-kit/blob/e52e8da4069168add85cab49a1bde3904f6f7860/test/action-layer.test.mjs) cover validation, completed replay, concurrent retries, conflicting key reuse, authorization before replay, asynchronous denial, and retry after failure. The demo needs no API key or model connection; its planner is hand-written.

When adapting this pattern, test the failure windows of the actual deployment as well: permissions changing between calls, concurrent workers, process restarts, and errors after a storage commit. The location of the cache lookup is only one part of making retries reliable.
