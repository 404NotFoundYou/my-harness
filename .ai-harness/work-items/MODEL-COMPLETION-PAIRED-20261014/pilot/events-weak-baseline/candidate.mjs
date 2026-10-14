function isJsonValue(value, ancestors = new Set()) {
  if (value === null) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value !== "object" || ancestors.has(value)) return false;
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  ancestors.add(value);
  let valid = true;
  if (array) {
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i) || !isJsonValue(value[i], ancestors)) {
        valid = false;
        break;
      }
    }
  } else {
    valid = Object.values(value).every(item => isJsonValue(item, ancestors));
  }
  ancestors.delete(value);
  return valid;
}

function validate(row, event) {
  if (row === null || typeof row !== "object" || Array.isArray(row) ||
      typeof row.id !== "string" || row.id.length === 0 ||
      !Number.isSafeInteger(row.version) || row.version < 0) {
    throw new TypeError("Invalid record identity or version");
  }
  if (event ? row.type !== "upsert" && row.type !== "delete" : typeof row.deleted !== "boolean") {
    throw new TypeError("Invalid record operation");
  }
  const deleted = event ? row.type === "delete" : row.deleted;
  if ((!deleted && !Object.hasOwn(row, "value")) || (Object.hasOwn(row, "value") && !isJsonValue(row.value))) {
    throw new TypeError("Expected a JSON value, required on live records");
  }
  return deleted;
}

export function reconcile(current, events) {
  if (!Array.isArray(current) || !Array.isArray(events)) {
    throw new TypeError("Expected dense arrays");
  }
  const records = new Map();
  for (let i = 0; i < current.length; i++) {
    if (!Object.hasOwn(current, i)) throw new TypeError("Sparse current array");
    const row = current[i];
    const deleted = validate(row, false);
    if (records.has(row.id)) throw new TypeError("Duplicate current id");
    records.set(row.id, deleted
      ? { id: row.id, version: row.version, deleted: true }
      : { id: row.id, version: row.version, deleted: false, value: row.value });
  }
  for (let i = 0; i < events.length; i++) {
    if (!Object.hasOwn(events, i)) throw new TypeError("Sparse events array");
    const event = events[i];
    const deleted = validate(event, true);
    const previous = records.get(event.id);
    if (previous && event.version <= previous.version) continue;
    records.set(event.id, deleted
      ? { id: event.id, version: event.version, deleted: true }
      : { id: event.id, version: event.version, deleted: false, value: event.value });
  }
  return [...records.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
