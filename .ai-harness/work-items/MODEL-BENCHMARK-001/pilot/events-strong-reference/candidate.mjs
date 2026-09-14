function isJsonValue(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;

  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  if (ancestors.has(value)) return false;

  ancestors.add(value);
  let valid = true;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index) || !isJsonValue(value[index], ancestors)) {
        valid = false;
        break;
      }
    }
  } else {
    valid = Object.getOwnPropertySymbols(value).length === 0
      && Object.keys(value).every(key => isJsonValue(value[key], ancestors));
  }
  ancestors.delete(value);
  return valid;
}

function assertDenseArray(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new TypeError(`${name} must be dense`);
  }
}

function assertCommonRecord(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) throw new TypeError("invalid record");
  if (!Object.hasOwn(record, "id") || typeof record.id !== "string" || record.id.length === 0) throw new TypeError("invalid id");
  if (!Object.hasOwn(record, "version") || !Number.isSafeInteger(record.version) || record.version < 0) throw new TypeError("invalid version");
}

function assertValue(record, required) {
  const hasValue = Object.hasOwn(record, "value");
  if ((required && !hasValue) || (hasValue && !isJsonValue(record.value))) throw new TypeError("invalid value");
}

export function reconcile(current, events) {
  assertDenseArray(current, "current");
  assertDenseArray(events, "events");

  const seen = new Set();
  for (const record of current) {
    assertCommonRecord(record);
    if (!Object.hasOwn(record, "deleted") || typeof record.deleted !== "boolean") throw new TypeError("invalid deleted flag");
    assertValue(record, !record.deleted);
    if (seen.has(record.id)) throw new TypeError("duplicate current id");
    seen.add(record.id);
  }

  for (const event of events) {
    assertCommonRecord(event);
    if (!Object.hasOwn(event, "type") || (event.type !== "upsert" && event.type !== "delete")) throw new TypeError("invalid event type");
    assertValue(event, event.type === "upsert");
  }

  const records = new Map();
  for (const record of current) {
    records.set(record.id, record.deleted
      ? { id: record.id, version: record.version, deleted: true }
      : { id: record.id, version: record.version, deleted: false, value: record.value });
  }

  for (const event of events) {
    const known = records.get(event.id);
    if (known && event.version <= known.version) continue;
    records.set(event.id, event.type === "delete"
      ? { id: event.id, version: event.version, deleted: true }
      : { id: event.id, version: event.version, deleted: false, value: event.value });
  }

  return [...records.values()].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}
