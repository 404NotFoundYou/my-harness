function validateJson(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || ancestors.has(value)) throw new TypeError("Invalid JSON value");
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!array && prototype !== Object.prototype && prototype !== null) throw new TypeError("Invalid JSON object");
  ancestors.add(value);
  if (array) {
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) throw new TypeError("Sparse JSON array");
      validateJson(value[i], ancestors);
    }
  } else {
    for (const key of Object.keys(value)) validateJson(value[key], ancestors);
  }
  ancestors.delete(value);
}

function validateRow(row, event) {
  if (row === null || typeof row !== "object" || Array.isArray(row) ||
      typeof row.id !== "string" || row.id.length === 0 ||
      !Number.isSafeInteger(row.version) || row.version < 0) {
    throw new TypeError("Invalid record");
  }
  if (event ? row.type !== "upsert" && row.type !== "delete" : typeof row.deleted !== "boolean") {
    throw new TypeError("Invalid record state");
  }
  if (event ? row.type === "upsert" : !row.deleted) {
    if (!Object.hasOwn(row, "value")) throw new TypeError("Missing value");
    validateJson(row.value);
  }
}

export function reconcile(current, events) {
  if (!Array.isArray(current) || !Array.isArray(events)) throw new TypeError("Expected arrays");
  const records = new Map();
  for (let i = 0; i < current.length; i++) {
    if (!Object.hasOwn(current, i)) throw new TypeError("Sparse current array");
    const row = current[i];
    validateRow(row, false);
    if (records.has(row.id)) throw new TypeError("Duplicate current id");
    records.set(row.id, row.deleted
      ? { id: row.id, version: row.version, deleted: true }
      : { id: row.id, version: row.version, deleted: false, value: row.value });
  }
  for (let i = 0; i < events.length; i++) {
    if (!Object.hasOwn(events, i)) throw new TypeError("Sparse events array");
    const event = events[i];
    validateRow(event, true);
    const previous = records.get(event.id);
    if (previous && event.version <= previous.version) continue;
    records.set(event.id, event.type === "delete"
      ? { id: event.id, version: event.version, deleted: true }
      : { id: event.id, version: event.version, deleted: false, value: event.value });
  }
  return [...records.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
