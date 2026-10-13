function validateArray(value) {
  if (!Array.isArray(value)) throw new TypeError("Expected a dense array");
  for (let i = 0; i < value.length; i++) {
    if (!Object.hasOwn(value, i)) throw new TypeError("Expected a dense array");
  }
}

function validateJson(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new TypeError("Expected a JSON value");
  }
  if (Array.isArray(value)) {
    validateArray(value);
  } else if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError("Expected a JSON object");
  }
  ancestors.add(value);
  for (const child of Object.values(value)) validateJson(child, ancestors);
  ancestors.delete(value);
}

function validateRecord(row, event) {
  if (row === null || typeof row !== "object" || Array.isArray(row) ||
      typeof row.id !== "string" || row.id.length === 0 ||
      !Number.isSafeInteger(row.version) || row.version < 0) {
    throw new TypeError("Invalid record");
  }
  if (event ? row.type !== "upsert" && row.type !== "delete" : typeof row.deleted !== "boolean") {
    throw new TypeError("Invalid record state");
  }
  const needsValue = event ? row.type === "upsert" : !row.deleted;
  if (needsValue && !Object.hasOwn(row, "value")) throw new TypeError("Missing value");
  if (Object.hasOwn(row, "value")) validateJson(row.value);
}

function record(row, deleted) {
  return deleted
    ? { id: row.id, version: row.version, deleted: true }
    : { id: row.id, version: row.version, deleted: false, value: row.value };
}

export function reconcile(current, events) {
  validateArray(current);
  validateArray(events);
  const records = new Map();
  for (const row of current) {
    validateRecord(row, false);
    if (records.has(row.id)) throw new TypeError("Duplicate current id");
    records.set(row.id, record(row, row.deleted));
  }
  for (const event of events) {
    // Validate even stale events: one invalid item invalidates the whole call.
    validateRecord(event, true);
    const known = records.get(event.id);
    if (!known || event.version > known.version) {
      records.set(event.id, record(event, event.type === "delete"));
    }
  }
  return [...records.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
