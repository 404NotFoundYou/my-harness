export function parseCsv(text) {
  if (typeof text !== "string") throw new TypeError("CSV input must be a string");
  if (text.startsWith("\uFEFF")) text = text.slice(1);
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
    if (char === "," || char === "\r" || char === "\n") {
      row.push(field);
      field = "";
      state = "start";
      if (char !== ",") {
        rows.push(row);
        row = [];
        if (char === "\r" && text[i + 1] === "\n") i++;
        recordStart = i + 1;
      }
    } else if (char === '"' && state === "start") {
      state = "quoted";
    } else {
      if (state === "closed" || char === '"') {
        throw new SyntaxError("Invalid character outside quoted CSV field");
      }
      field += char;
      state = "bare";
    }
  }
  if (state === "quoted") throw new SyntaxError("Unclosed quoted CSV field");
  if (recordStart < text.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
