export function parseCsv(text) {
  if (typeof text !== "string") throw new TypeError("CSV input must be a string");
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  if (text === "") return [];

  const rows = [];
  let row = [];
  let field = "";
  let state = "start";
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
    if (char === "," || char === "\r" || char === "\n") {
      row.push(field);
      field = "";
      state = "start";
      if (char !== ",") {
        rows.push(row);
        row = [];
        if (char === "\r" && text[i + 1] === "\n") i++;
      }
    } else if (state === "closed") {
      throw new SyntaxError("Unexpected character after closing quote");
    } else if (char === '"') {
      if (state !== "start") throw new SyntaxError("Quote in unquoted field");
      state = "quoted";
    } else {
      field += char;
      state = "bare";
    }
  }
  if (state === "quoted") throw new SyntaxError("Unclosed quoted field");
  if (state !== "start" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
