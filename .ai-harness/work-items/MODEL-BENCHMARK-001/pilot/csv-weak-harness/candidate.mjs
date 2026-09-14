export function parseCsv(text) {
  if (typeof text !== "string") throw new TypeError("CSV input must be a string");

  if (text.startsWith("\uFEFF")) text = text.slice(1);
  if (text.length === 0) return [];

  const rows = [];
  let row = [];
  let field = "";
  let state = "start";
  let recordStarted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (state === "quoted") {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          state = "afterQuote";
        }
      } else {
        field += char;
      }
      continue;
    }

    if (state === "afterQuote" && char !== "," && char !== "\r" && char !== "\n") {
      throw new SyntaxError("Unexpected character after closing quote");
    }

    if (char === ",") {
      row.push(field);
      field = "";
      state = "start";
      recordStarted = true;
    } else if (char === "\r" || char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      state = "start";
      recordStarted = false;
      if (char === "\r" && text[i + 1] === "\n") i += 1;
    } else if (char === '"') {
      if (state !== "start") throw new SyntaxError("Quote in unquoted field");
      state = "quoted";
      recordStarted = true;
    } else {
      if (state === "afterQuote") throw new SyntaxError("Unexpected character after closing quote");
      field += char;
      state = "unquoted";
      recordStarted = true;
    }
  }

  if (state === "quoted") throw new SyntaxError("Unclosed quoted field");
  if (recordStarted || row.length > 0 || field.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}
