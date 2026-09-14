function isJsonValue(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;

  ancestors.add(value);
  let valid;
  if (Array.isArray(value)) {
    valid = true;
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index) || !isJsonValue(value[index], ancestors)) {
        valid = false;
        break;
      }
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    valid = (prototype === Object.prototype || prototype === null) &&
      Object.keys(value).every(key => isJsonValue(value[key], ancestors));
  }
  ancestors.delete(value);
  return valid;
}

function isDenseArray(value) {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasValidIdVersion(value) {
  return typeof value.id === "string" && value.id.length > 0 &&
    Number.isSafeInteger(value.version) && value.version >= 0;
}

function assertJsonValue(record) {
  if (!Object.hasOwn(record, "value") || !isJsonValue(record.value)) {
    throw new TypeError("value must be an own JSON value");
  }
}

export function reconcile(current, events) {
  if (!isDenseArray(current) || !isDenseArray(events)) {
    throw new TypeError("current and events must be dense arrays");
  }

  const seen = new Set();
  for (const row of current) {
    if (!isRecord(row) || !hasValidIdVersion(row) || typeof row.deleted !== "boolean") {
      throw new TypeError("invalid current record");
    }
    if (seen.has(row.id)) throw new TypeError("duplicate current id");
    seen.add(row.id);
    if (!row.deleted) assertJsonValue(row);
  }

  for (const event of events) {
    if (!isRecord(event) || !hasValidIdVersion(event) ||
        (event.type !== "upsert" && event.type !== "delete")) {
      throw new TypeError("invalid event");
    }
    if (event.type === "upsert") assertJsonValue(event);
  }

  const records = new Map(current.map(row => [row.id, {
    id: row.id,
    version: row.version,
    deleted: row.deleted,
    ...(!row.deleted ? { value: row.value } : {}),
  }]));

  for (const event of events) {
    const previous = records.get(event.id);
    if (previous && event.version <= previous.version) continue;
    records.set(event.id, event.type === "delete"
      ? { id: event.id, version: event.version, deleted: true }
      : { id: event.id, version: event.version, deleted: false, value: event.value });
  }

  return [...records.values()].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
}
