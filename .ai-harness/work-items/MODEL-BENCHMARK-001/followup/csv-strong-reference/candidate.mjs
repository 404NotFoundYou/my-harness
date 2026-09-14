export function parseCsv(text) {
  if (typeof text !== "string") throw new TypeError("CSV input must be a string");

  if (text.startsWith("\uFEFF")) text = text.slice(1);
  if (text === "") return [];

  const rows = [];
  let row = [];
  let field = "";
  let state = "start";

  const finishField = () => {
    row.push(field);
    field = "";
    state = "start";
  };

  const finishRow = () => {
    finishField();
    rows.push(row);
    row = [];
  };

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

    if (state === "closed" && char !== "," && char !== "\r" && char !== "\n") {
      throw new SyntaxError("Unexpected character after closing quote");
    }

    if (char === ",") {
      finishField();
    } else if (char === "\r" || char === "\n") {
      finishRow();
      if (char === "\r" && text[i + 1] === "\n") i++;
    } else if (char === '"') {
      if (state !== "start") throw new SyntaxError("Unexpected quote in unquoted field");
      state = "quoted";
    } else {
      field += char;
      state = "unquoted";
    }
  }

  if (state === "quoted") throw new SyntaxError("Unclosed quoted field");
  if (row.length > 0 || field !== "" || state !== "start") finishRow();

  return rows;
}
