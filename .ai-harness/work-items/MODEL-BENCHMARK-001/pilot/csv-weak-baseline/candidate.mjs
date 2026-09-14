export function parseCsv(text) {
  if (typeof text !== "string") throw new TypeError("CSV input must be a string");
  if (text === "") return [];
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text === "") return [];

  const rows = [];
  let fields = [];
  let field = "";
  let state = "start";
  let endedWithSeparator = false;

  const finishRow = () => {
    fields.push(field);
    rows.push(fields);
    fields = [];
    field = "";
    state = "start";
    endedWithSeparator = true;
  };

  for (let i = 0; i < text.length; i += 1) {
    const character = text[i];
    endedWithSeparator = false;

    if (state === "quoted") {
      if (character === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          state = "afterQuote";
        }
      } else {
        field += character;
      }
      continue;
    }

    if (state === "afterQuote") {
      if (character === ",") {
        fields.push(field);
        field = "";
        state = "start";
      } else if (character === "\r" || character === "\n") {
        if (character === "\r" && text[i + 1] === "\n") i += 1;
        finishRow();
      } else {
        throw new SyntaxError("Unexpected character after closing quote");
      }
      continue;
    }

    if (character === ",") {
      fields.push(field);
      field = "";
      state = "start";
    } else if (character === "\r" || character === "\n") {
      if (character === "\r" && text[i + 1] === "\n") i += 1;
      finishRow();
    } else if (character === '"') {
      if (state !== "start") throw new SyntaxError("Quote in unquoted field");
      state = "quoted";
    } else {
      field += character;
      state = "unquoted";
    }
  }

  if (state === "quoted") throw new SyntaxError("Unclosed quoted field");
  if (!endedWithSeparator) {
    fields.push(field);
    rows.push(fields);
  }
  return rows;
}
