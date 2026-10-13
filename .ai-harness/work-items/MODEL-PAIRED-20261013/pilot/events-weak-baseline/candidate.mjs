function isJsonValue(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!array && prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  ancestors.add(value);
  const keys = array ? Array.from({ length: value.length }, (_, i) => i) : Object.keys(value);
  const valid = keys.every(key => Object.hasOwn(value, key) && isJsonValue(value[key], ancestors));
  ancestors.delete(value);
  return valid;
}

function validate(row, event) {
  if (row === null || typeof row !== "object" || Array.isArray(row) ||
      typeof row.id !== "string" || row.id.length === 0 ||
      !Number.isSafeInteger(row.version) || row.version < 0) {
    throw new TypeError("Invalid record id or version");
  }
  if (event ? row.type !== "upsert" && row.type !== "delete" : typeof row.deleted !== "boolean") {
    throw new TypeError("Invalid record state");
  }
  const needsValue = event ? row.type === "upsert" : !row.deleted;
  if ((needsValue && !Object.hasOwn(row, "value")) ||
      (Object.hasOwn(row, "value") && !isJsonValue(row.value))) {
    throw new TypeError("Invalid JSON value");
  }
}

export function reconcile(current, events) {
  if (!Array.isArray(current) || !Array.isArray(events)) throw new TypeError("Expected arrays");
  const records = new Map();
  for (let i = 0; i < current.length; i++) {
    if (!Object.hasOwn(current, i)) throw new TypeError("Sparse current array");
    const row = current[i];
    validate(row, false);
    if (records.has(row.id)) throw new TypeError("Duplicate current id");
    records.set(row.id, row.deleted
      ? { id: row.id, version: row.version, deleted: true }
      : { id: row.id, version: row.version, deleted: false, value: row.value });
  }
  for (let i = 0; i < events.length; i++) {
    if (!Object.hasOwn(events, i)) throw new TypeError("Sparse events array");
    const event = events[i];
    validate(event, true);
    const known = records.get(event.id);
    if (known && event.version <= known.version) continue;
    records.set(event.id, event.type === "delete"
      ? { id: event.id, version: event.version, deleted: true }
      : { id: event.id, version: event.version, deleted: false, value: event.value });
  }
  return [...records.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
