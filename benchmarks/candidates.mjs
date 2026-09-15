import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { resolveProjectPath } from "../.ai-harness/src/filesystem.mjs";
import { writableFilesFor } from "./task-contract.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const decoder = new TextDecoder("utf-8", {fatal:true,ignoreBOM:true});
const reasons = ["not-file","symlink","invalid-utf8"];

export function validateCandidate(task, candidate) {
  const fail = "Invalid candidate manifest";
  assert.ok(candidate && typeof candidate === "object" && !Array.isArray(candidate),fail);
  assert.deepEqual(Object.keys(candidate).sort(),["files","schemaVersion"],fail);
  assert.equal(candidate.schemaVersion,1,fail);
  assert.ok(candidate.files && typeof candidate.files === "object" && !Array.isArray(candidate.files),fail);
  const paths = writableFilesFor(task);
  assert.deepEqual(Object.keys(candidate.files).sort(),paths,fail);
  const files = Object.create(null);
  for (const file of paths) {
    const entry = candidate.files[file];
    assert.ok(entry && typeof entry === "object" && !Array.isArray(entry),fail);
    if (entry.status === "present") {
      assert.deepEqual(Object.keys(entry).sort(),["content","sha256","status"],fail);
      assert.equal(typeof entry.content,"string",fail);
      assert.equal(decoder.decode(Buffer.from(entry.content)),entry.content,fail);
      assert.equal(entry.sha256,hash(Buffer.from(entry.content)),fail);
      files[file] = {status:"present",content:entry.content,sha256:entry.sha256};
    } else if (entry.status === "missing") {
      assert.deepEqual(Object.keys(entry),["status"],fail);
      files[file] = {status:"missing"};
    } else {
      assert.deepEqual(Object.keys(entry).sort(),["reason","status"],fail);
      assert.equal(entry.status,"invalid",fail);
      assert.ok(reasons.includes(entry.reason),fail);
      files[file] = {status:"invalid",reason:entry.reason};
    }
  }
  return {schemaVersion:1,files};
}

export function candidateDigest(task, candidate) {
  return hash(JSON.stringify(validateCandidate(task,candidate)));
}

export async function collectCandidate(root, task) {
  const files = Object.create(null);
  for (const file of writableFilesFor(task)) {
    try {
      // Keep the lexical path so a junction or symlink in any parent is rejected.
      const absolute = await resolveProjectPath(root,file,{forWrite:true,mustExist:true});
      const info = await lstat(absolute);
      if (!info.isFile()) { files[file]={status:"invalid",reason:"not-file"}; continue; }
      const bytes = await readFile(absolute);
      let content;
      try { content=decoder.decode(bytes); } catch { files[file]={status:"invalid",reason:"invalid-utf8"}; continue; }
      files[file] = {status:"present",content,sha256:hash(bytes)};
    } catch (error) {
      if (["ENOENT","PATH_NOT_FOUND"].includes(error.code)) files[file]={status:"missing"};
      else if (error.code === "ENOTDIR") files[file]={status:"invalid",reason:"not-file"};
      else if (["SYMLINK_WRITE","PATH_ESCAPE"].includes(error.code)) files[file]={status:"invalid",reason:"symlink"};
      else throw error;
    }
  }
  return validateCandidate(task,{schemaVersion:1,files});
}
