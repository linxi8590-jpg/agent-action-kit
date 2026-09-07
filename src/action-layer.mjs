/**
 * A server-side action layer for letting a language model change real state.
 *
 * The model never touches your endpoints. It emits an intent; this layer decides
 * whether that intent becomes a write, and hands back a receipt describing
 * exactly what changed.
 *
 * Five things happen to every intent, in order:
 *   1. the action must exist in the allowlist
 *   2. the caller must be permitted to run it
 *   3. arguments are validated and coerced against a declared schema
 *   4. a repeated idempotency key from the same actor returns the first receipt
 *      only when the action and arguments are identical
 *   5. the write is recorded with a before/after diff
 */

export class ActionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** Minimal declarative validation. Keeps the allowlist readable at a glance. */
function validate(schema, args, actionName) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new ActionError('INVALID_ARGUMENT', `${actionName}: args must be an object`);
  }

  const out = {};
  for (const [key, rule] of Object.entries(schema)) {
    const present = Object.prototype.hasOwnProperty.call(args, key);
    let value;
    if (!present) {
      if (rule.required) {
        throw new ActionError('INVALID_ARGUMENT', `${actionName}: missing required "${key}"`);
      }
      if (!('default' in rule)) continue;
      value = rule.default;
    } else {
      value = args[key];
    }
    if (rule.type === 'number') {
      value = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ActionError('INVALID_ARGUMENT', `${actionName}: "${key}" must be a finite number`);
      }
      if (rule.min !== undefined && value < rule.min) {
        throw new ActionError('INVALID_ARGUMENT', `${actionName}: "${key}" below minimum ${rule.min}`);
      }
      if (rule.max !== undefined && value > rule.max) {
        throw new ActionError('INVALID_ARGUMENT', `${actionName}: "${key}" above maximum ${rule.max}`);
      }
    } else if (rule.type === 'boolean') {
      if (typeof value === 'string') value = value === 'true' ? true : value === 'false' ? false : value;
      if (typeof value !== 'boolean') {
        throw new ActionError('INVALID_ARGUMENT', `${actionName}: "${key}" must be a boolean`);
      }
    } else if (rule.type === 'string') {
      if (typeof value !== 'string') {
        throw new ActionError('INVALID_ARGUMENT', `${actionName}: "${key}" must be a string`);
      }
      if (rule.enum && !rule.enum.includes(value)) {
        throw new ActionError('INVALID_ARGUMENT',
          `${actionName}: "${key}" must be one of ${rule.enum.join(', ')}`);
      }
      if (rule.maxLength !== undefined && value.length > rule.maxLength) {
        throw new ActionError('INVALID_ARGUMENT', `${actionName}: "${key}" longer than ${rule.maxLength}`);
      }
    } else {
      throw new TypeError(`${actionName}: unsupported schema type "${rule.type}" for "${key}"`);
    }
    out[key] = value;
  }
  const unknown = Object.keys(args).filter((k) => !(k in schema));
  if (unknown.length) {
    throw new ActionError('UNKNOWN_ARGUMENT', `${actionName}: unexpected ${unknown.join(', ')}`);
  }
  return out;
}

/** Await authorization so an async policy can never pass through by Promise truthiness. */
async function isAllowed(action, actor) {
  if (!action.allow) return true;
  return (await action.allow(actor)) === true;
}

export class ActionLayer {
  constructor({ actions, audit = [], now = () => new Date().toISOString() }) {
    this.actions = actions;
    this.audit = audit;
    this.now = now;
    this.idempotencyEntries = new Map();
  }

  async list(actor) {
    const visible = [];
    for (const [name, action] of Object.entries(this.actions)) {
      if (await isAllowed(action, actor)) {
        visible.push({ name, description: action.description, args: action.args });
      }
    }
    return visible;
  }

  /**
   * @param intent {{action: string, args: object, idempotencyKey?: string}}
   *   Whatever produced this — an LLM, a form, a cron — is untrusted input.
   */
  async execute(intent, actor) {
    const { action: name, args = {}, idempotencyKey } = intent || {};

    const action = Object.prototype.hasOwnProperty.call(this.actions, name)
      ? this.actions[name]
      : undefined;
    if (!action) {
      throw new ActionError('UNKNOWN_ACTION', `no such action: ${name}`,
        { known: Object.keys(this.actions) });
    }
    if (!await isAllowed(action, actor)) {
      throw new ActionError('FORBIDDEN', `${actor?.id ?? 'anonymous'} may not run ${name}`);
    }

    const clean = validate(action.args, args, name);
    let scope;
    let fingerprint;

    if (idempotencyKey !== undefined) {
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > 200) {
        throw new ActionError('INVALID_IDEMPOTENCY_KEY',
          'idempotencyKey must be a non-empty string of at most 200 characters');
      }
      if (typeof actor?.id !== 'string' || actor.id.length === 0) {
        throw new ActionError('INVALID_ACTOR',
          'a stable actor.id is required when using an idempotency key');
      }

      // Actor scope prevents one caller from replaying another caller's receipt.
      // The fingerprint prevents a reused key from silently suppressing a new write.
      scope = JSON.stringify([actor.id, idempotencyKey]);
      fingerprint = JSON.stringify([name, clean]);
      const existing = this.idempotencyEntries.get(scope);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new ActionError('IDEMPOTENCY_CONFLICT',
            `${name}: idempotency key was already used for a different request`);
        }
        const receipt = await existing.promise;
        return { ...receipt, replayed: true };
      }
    }

    const perform = async () => {
      const before = action.snapshot ? await action.snapshot(clean) : null;
      const result = await action.run(clean, actor);
      const after = action.snapshot ? await action.snapshot(clean) : null;

      const receipt = {
        ok: true,
        action: name,
        actor: actor?.id ?? null,
        at: this.now(),
        args: clean,
        changed: diff(before, after),
        result: result ?? null,
        idempotencyKey: idempotencyKey ?? null,
        replayed: false,
      };

      this.audit.push(receipt);
      return receipt;
    };

    if (!scope) return perform();

    // Defer execution until after the entry is stored so simultaneous calls with
    // the same key share one promise and cannot both reach action.run().
    const entry = { fingerprint, promise: Promise.resolve().then(perform) };
    this.idempotencyEntries.set(scope, entry);
    try {
      return await entry.promise;
    } catch (error) {
      if (this.idempotencyEntries.get(scope) === entry) {
        this.idempotencyEntries.delete(scope);
      }
      throw error;
    }
  }
}

/** Field-level before/after, so a receipt says what moved rather than "success". */
export function diff(before, after) {
  if (!before && !after) return [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const changes = [];
  for (const key of keys) {
    const from = before ? before[key] : undefined;
    const to = after ? after[key] : undefined;
    if (JSON.stringify(from) !== JSON.stringify(to)) changes.push({ field: key, from, to });
  }
  return changes;
}
