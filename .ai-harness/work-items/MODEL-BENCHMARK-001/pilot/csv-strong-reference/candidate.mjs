export function parseCsv(text) {
  if (typeof text !== "string") {
    throw new TypeError("CSV input must be a string");
  }

  if (text.startsWith("\uFEFF")) {
    text = text.slice(1);
  }
  if (text.length === 0) {
    return [];
  }

  const rows = [];
  let row = [];
  let field = "";
  let state = "start";
  let recordPending = true;

  const finishField = () => {
    row.push(field);
    field = "";
    state = "start";
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (state === "quoted") {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          state = "closed";
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === ",") {
      finishField();
      recordPending = true;
      continue;
    }

    if (character === "\n" || character === "\r") {
      finishField();
      rows.push(row);
      row = [];
      recordPending = false;
      if (character === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
      continue;
    }

    if (state === "closed") {
      throw new SyntaxError("Unexpected character after closing quote");
    }
    if (character === '"') {
      if (state !== "start") {
        throw new SyntaxError("Unexpected quote in unquoted field");
      }
      state = "quoted";
    } else {
      field += character;
      state = "bare";
    }
    recordPending = true;
  }

  if (state === "quoted") {
    throw new SyntaxError("Unclosed quoted field");
  }
  if (recordPending) {
    finishField();
    rows.push(row);
  }
  return rows;
}
