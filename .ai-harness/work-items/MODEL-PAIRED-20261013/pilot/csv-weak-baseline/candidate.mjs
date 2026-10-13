export function parseCsv(text) {
  if (typeof text !== "string") throw new TypeError("CSV input must be a string");
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  if (text === "") return [];

  const rows = [];
  let row = [];
  let field = "";
  let state = "start";
  let recordStart = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (state === "quoted") {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          state = "closed";
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === ",") {
      row.push(field);
      field = "";
      state = "start";
    } else if (char === "\r" || char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      state = "start";
      if (char === "\r" && text[i + 1] === "\n") i++;
      recordStart = i + 1;
    } else if (state === "closed") {
      throw new SyntaxError("Unexpected character after closing quote");
    } else if (char === '"') {
      if (state !== "start") throw new SyntaxError("Quote inside unquoted field");
      state = "quoted";
    } else {
      field += char;
      state = "plain";
    }
  }

  if (state === "quoted") throw new SyntaxError("Unclosed quoted field");
  if (recordStart < text.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
