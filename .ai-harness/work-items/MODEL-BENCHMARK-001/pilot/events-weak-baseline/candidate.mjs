const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function isJsonValue(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (!hasOwn(value, i) || !isJsonValue(value[i], seen)) return false;
    }
    seen.delete(value);
    return true;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  for (const key of Object.keys(value)) {
    if (!isJsonValue(value[key], seen)) return false;
  }
  seen.delete(value);
  return true;
}

function isDenseArray(value) {
  if (!Array.isArray(value)) return false;
  for (let i = 0; i < value.length; i += 1) {
    if (!hasOwn(value, i)) return false;
  }
  return true;
}

function isVersion(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateCurrentRow(row) {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return false;
  if (typeof row.id !== "string" || row.id.length === 0 || !isVersion(row.version)) return false;
  if (typeof row.deleted !== "boolean") return false;
  return row.deleted || (hasOwn(row, "value") && isJsonValue(row.value));
}

function validateEvent(event) {
  if (event === null || typeof event !== "object" || Array.isArray(event)) return false;
  if (typeof event.id !== "string" || event.id.length === 0 || !isVersion(event.version)) return false;
  if (event.type !== "upsert" && event.type !== "delete") return false;
  return event.type === "delete" || (hasOwn(event, "value") && isJsonValue(event.value));
}

export function reconcile(current, events) {
  if (!isDenseArray(current) || !isDenseArray(events)) throw new TypeError("current and events must be dense arrays");
  const records = new Map();
  for (const row of current) {
    if (!validateCurrentRow(row) || records.has(row.id)) throw new TypeError("invalid current record");
    records.set(row.id, {
      id: row.id,
      version: row.version,
      deleted: row.deleted,
      ...(row.deleted ? {} : { value: row.value }),
    });
  }
  for (const event of events) {
    if (!validateEvent(event)) throw new TypeError("invalid event");
    const known = records.get(event.id);
    if (known && event.version <= known.version) continue;
    records.set(event.id, event.type === "delete"
      ? { id: event.id, version: event.version, deleted: true }
      : { id: event.id, version: event.version, deleted: false, value: event.value });
  }
  return [...records.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}
