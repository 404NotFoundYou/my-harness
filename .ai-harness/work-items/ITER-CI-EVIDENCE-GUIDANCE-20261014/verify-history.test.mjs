import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../../..");
test("local reliability repairs do not rewrite historical experiments", async () => {
  const histories = JSON.parse(await readFile(path.join(directory, "historical-hashes.json"), "utf8"));
  let count = 0;
  for (const history of histories) for (const [file, digest] of Object.entries(history.files)) {
    assert.equal(createHash("sha256").update(await readFile(path.join(root, history.directory, file))).digest("hex"), digest, history.directory + "/" + file);
    count++;
  }
  assert.equal(count, 244, "failed and successful samples from all three previous experiments must be preserved byte-for-byte");
});
