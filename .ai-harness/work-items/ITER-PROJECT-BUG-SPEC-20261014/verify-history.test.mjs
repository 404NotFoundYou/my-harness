import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../../..");
test("structured BUGFIX changes keep every historical experiment byte unchanged", async () => {
  const histories = JSON.parse(await readFile(path.join(directory, "historical-hashes.json"), "utf8"));
  let files = 0;
  for (const history of histories) for (const [file, digest] of Object.entries(history.files)) {
    assert.equal(createHash("sha256").update(await readFile(path.join(root, history.directory, file))).digest("hex"), digest, history.directory + "/" + file);
    files++;
  }
  assert.equal(files, 351, "old failed and successful samples must not be rewritten as new successes");
});
