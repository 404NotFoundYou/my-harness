function fail() {
  throw new TypeError("Invalid reconcile input");
}

function ownDataValue(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !("value" in descriptor)) fail();
  return descriptor.value;
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJsonValue(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    fail();
  }
  if (typeof value !== "object" || ancestors.has(value)) fail();

  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) fail();
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) fail();
      assertJsonValue(descriptor.value, ancestors);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) fail();
    }
  } else {
    if (!isRecord(value)) fail();
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") fail();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail();
      assertJsonValue(descriptor.value, ancestors);
    }
  }
  ancestors.delete(value);
}

function assertDenseArray(value) {
  if (!Array.isArray(value)) fail();
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) fail();
  }
}

function assertIdVersion(record) {
  const id = ownDataValue(record, "id");
  const version = ownDataValue(record, "version");
  if (typeof id !== "string" || id.length === 0) fail();
  if (!Number.isSafeInteger(version) || version < 0) fail();
  return { id, version };
}

export function reconcile(current, events) {
  assertDenseArray(current);
  assertDenseArray(events);

  const records = new Map();
  for (let index = 0; index < current.length; index++) {
    const row = current[index];
    if (!isRecord(row)) fail();
    const { id, version } = assertIdVersion(row);
    const deleted = ownDataValue(row, "deleted");
    if (typeof deleted !== "boolean" || records.has(id)) fail();
    if (deleted) {
      records.set(id, { id, version, deleted: true });
    } else {
      const value = ownDataValue(row, "value");
      assertJsonValue(value);
      records.set(id, { id, version, deleted: false, value });
    }
  }

  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (!isRecord(event)) fail();
    const { id, version } = assertIdVersion(event);
    const type = ownDataValue(event, "type");
    if (type !== "upsert" && type !== "delete") fail();

    let value;
    if (type === "upsert") {
      value = ownDataValue(event, "value");
      assertJsonValue(value);
    }

    const previous = records.get(id);
    if (!previous || version > previous.version) {
      records.set(id, type === "delete"
        ? { id, version, deleted: true }
        : { id, version, deleted: false, value });
    }
  }

  return [...records.values()].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}
