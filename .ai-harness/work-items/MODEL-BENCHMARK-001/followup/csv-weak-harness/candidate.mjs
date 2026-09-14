export function parseCsv(text) {
  if (typeof text !== "string") throw new TypeError("CSV input must be a string");

  if (text.startsWith("\uFEFF")) text = text.slice(1);
  if (text === "") return [];

  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let afterQuote = false;
  let endedWithRecordSeparator = false;

  const finishRecord = () => {
    row.push(field);
    rows.push(row);
    row = [];
    field = "";
    inQuotes = false;
    afterQuote = false;
    endedWithRecordSeparator = true;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inQuotes) {
      if (char !== '"') {
        field += char;
        continue;
      }
      if (text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        inQuotes = false;
        afterQuote = true;
      }
      endedWithRecordSeparator = false;
      continue;
    }

    if (afterQuote) {
      if (char === ",") {
        row.push(field);
        field = "";
        afterQuote = false;
        endedWithRecordSeparator = false;
        continue;
      }
      if (char === "\r" || char === "\n") {
        if (char === "\r" && text[index + 1] === "\n") index += 1;
        finishRecord();
        continue;
      }
      throw new SyntaxError("Unexpected character after closing quote");
    }

    if (char === '"') {
      if (field !== "") throw new SyntaxError("Unexpected quote in unquoted field");
      inQuotes = true;
      endedWithRecordSeparator = false;
    } else if (char === ",") {
      row.push(field);
      field = "";
      endedWithRecordSeparator = false;
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      finishRecord();
    } else {
      field += char;
      endedWithRecordSeparator = false;
    }
  }

  if (inQuotes) throw new SyntaxError("Unclosed quoted field");
  if (!endedWithRecordSeparator) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
