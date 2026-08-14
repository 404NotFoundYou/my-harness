export class HarnessError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "HarnessError";
    this.code = code;
    this.details = details;
  }
}

export function invariant(condition, code, message, details = null) {
  if (!condition) {
    throw new HarnessError(code, message, details);
  }
}
