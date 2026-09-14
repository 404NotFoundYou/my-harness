export function parseCsv(text) {
  if (typeof text !== "string") throw new TypeError("CSV input must be a string");
  if (text === "") return [];
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text === "") return [];

  const rows = [];
  let row = [];
  let field = "";
  let fieldStart = true;
  let quoted = false;
  let afterQuote = false;
  let recordStarted = false;

  const finishField = () => {
    row.push(field);
    field = "";
    fieldStart = true;
    afterQuote = false;
  };

  const finishRecord = () => {
    finishField();
    rows.push(row);
    row = [];
    recordStarted = false;
  };

  for (let i = 0; i < text.length;) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          quoted = false;
          afterQuote = true;
          i += 1;
        }
      } else {
        field += char;
        i += 1;
      }
      continue;
    }

    if (afterQuote) {
      if (char === ",") {
        finishField();
        recordStarted = true;
        i += 1;
      } else if (char === "\r" || char === "\n") {
        finishRecord();
        i += char === "\r" && text[i + 1] === "\n" ? 2 : 1;
      } else {
        throw new SyntaxError("Unexpected character after closing quote");
      }
      continue;
    }

    if (fieldStart && char === '"') {
      quoted = true;
      fieldStart = false;
      recordStarted = true;
      i += 1;
    } else if (char === '"') {
      throw new SyntaxError("Unexpected quote in unquoted field");
    } else if (char === ",") {
      finishField();
      recordStarted = true;
      i += 1;
    } else if (char === "\r" || char === "\n") {
      finishRecord();
      i += char === "\r" && text[i + 1] === "\n" ? 2 : 1;
    } else {
      field += char;
      fieldStart = false;
      recordStarted = true;
      i += 1;
    }
  }

  if (quoted) throw new SyntaxError("Unclosed quoted field");
  if (recordStarted) finishRecord();
  return rows;
}
