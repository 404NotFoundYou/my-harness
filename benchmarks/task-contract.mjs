import { createHash } from "node:crypto";
import { tasks } from "./tasks.mjs";
import { projectTasks } from "./project-tasks.mjs";
import { fileMatchesScope } from "../.ai-harness/src/validator.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");

function safeFile(file) {
  return typeof file === "string" && /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(file);
}

export function writableFilesFor(task) {
  if (task.writableFiles === undefined) return [task.entry];
  const files = task.writableFiles;
  if (!Array.isArray(files) || !files.length || files.some(file => !safeFile(file) || !file.startsWith("src/") || !file.endsWith(".mjs") || !Object.hasOwn(task.files, file)) || new Set(files.map(file => file.toLowerCase())).size !== files.length) throw new Error("Invalid task writable files");
  return [...files].sort();
}

export function taskManifest(task) {
  const basic = {id:task.id,split:task.split,taskDigest:hash(JSON.stringify(task.files)),judgeDigest:hash(JSON.stringify(task.cases))};
  if (task.writableFiles === undefined) return basic;
  const files = Object.keys(task.files);
  if (files.some(file => !safeFile(file) || typeof task.files[file] !== "string") || new Set(files.map(file => file.toLowerCase())).size !== files.length || !Object.hasOwn(task.files, task.entry) || !/^[A-Za-z_$][\w$]*$/.test(task.name) || task.type !== "BUGFIX") throw new Error("Invalid project task contract");
  return {...basic,entry:task.entry,name:task.name,type:task.type,writableFiles:writableFilesFor(task)};
}

export function tasksForSuite(suite = "core") {
  if (suite === "core") return tasks;
  if (suite !== "project") throw new Error("Invalid task suite");
  for (const task of projectTasks) taskManifest(task);
  return projectTasks;
}

export function projectWorkflowContract(task, records) {
  const items=records.map(({state,plan})=>{
    if (state.type !== "ANALYSIS" && plan?.workItemId !== state.id) throw new Error("Project workflow plan owner differs");
    return {id:state.id,type:state.type,status:state.status,writeScopes:state.type === "ANALYSIS" ? [] :
      [...new Set(plan.tasks.filter(entry=>entry.status === "COMPLETED").flatMap(entry=>entry.writeScopes))].sort()};
  });
  const development=items.filter(item=>item.type !== "ANALYSIS");
  const scopes=development.filter(item=>item.type === task.type && item.status === "DONE").flatMap(item=>item.writeScopes);
  const uncoveredFiles=writableFilesFor(task).filter(file=>!scopes.some(scope=>fileMatchesScope(file,scope)));
  return {requiredType:task.type,items,uncoveredFiles,ok:development.length > 0 &&
    items.every(item=>item.type === "ANALYSIS" ? item.status === "ANSWERED" : item.type === task.type && item.status === "DONE") && uncoveredFiles.length === 0};
}
