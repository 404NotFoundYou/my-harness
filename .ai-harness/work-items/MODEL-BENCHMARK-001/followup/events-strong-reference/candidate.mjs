const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function isJsonValue(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;

  seen.add(value);
  let valid;
  if (Array.isArray(value)) {
    valid = value.every((item, index) => hasOwn(value, index) && isJsonValue(item, seen));
  } else {
    const prototype = Object.getPrototypeOf(value);
    valid = (prototype === Object.prototype || prototype === null)
      && Object.keys(value).every(key => isJsonValue(value[key], seen));
  }
  seen.delete(value);
  return valid;
}

function assertDenseArray(value) {
  if (!Array.isArray(value)) throw new TypeError("Expected an array");
  for (let index = 0; index < value.length; index += 1) {
    if (!hasOwn(value, index)) throw new TypeError("Expected a dense array");
  }
}

function assertCommonFields(item) {
  if (item === null || typeof item !== "object" || Array.isArray(item)
    || !hasOwn(item, "id") || typeof item.id !== "string" || item.id.length === 0
    || !hasOwn(item, "version") || !Number.isSafeInteger(item.version) || item.version < 0) {
    throw new TypeError("Invalid record");
  }
}

function assertValue(item, required) {
  const present = hasOwn(item, "value");
  if ((required && !present) || (present && !isJsonValue(item.value))) {
    throw new TypeError("Invalid value");
  }
}

function validateCurrent(current) {
  assertDenseArray(current);
  const ids = new Set();
  for (const item of current) {
    assertCommonFields(item);
    if (!hasOwn(item, "deleted") || typeof item.deleted !== "boolean" || ids.has(item.id)) {
      throw new TypeError("Invalid current record");
    }
    assertValue(item, !item.deleted);
    ids.add(item.id);
  }
}

function validateEvents(events) {
  assertDenseArray(events);
  for (const event of events) {
    assertCommonFields(event);
    if (!hasOwn(event, "type") || (event.type !== "upsert" && event.type !== "delete")) {
      throw new TypeError("Invalid event");
    }
    assertValue(event, event.type === "upsert");
  }
}

export function reconcile(current, events) {
  validateCurrent(current);
  validateEvents(events);

  const records = new Map();
  for (const item of current) {
    records.set(item.id, item.deleted
      ? { id: item.id, version: item.version, deleted: true }
      : { id: item.id, version: item.version, deleted: false, value: item.value });
  }

  for (const event of events) {
    const known = records.get(event.id);
    if (known && event.version <= known.version) continue;
    records.set(event.id, event.type === "delete"
      ? { id: event.id, version: event.version, deleted: true }
      : { id: event.id, version: event.version, deleted: false, value: event.value });
  }

  return [...records.values()].sort((left, right) => {
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
  });
}
