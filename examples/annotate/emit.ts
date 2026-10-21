// Validate one proposal (JSON on stdin) and append it to <runDir>/proposals/<agent>.jsonl.
// Usage: node examples/annotate/emit.ts <runDir> <agent> <<'JSON' ... JSON
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const [run, agent] = process.argv.slice(2);
const fail = (m: string): never => {
  console.error("ERROR: " + m);
  process.exit(1);
};
if (!run || !/^[a-z0-9-]+$/.test(agent || ""))
  fail("usage: node emit.ts <runDir> <agent-name> < json");
let j!: {
  id: string;
  add: string[];
  remove?: string[];
  description: string;
  flags?: string[];
};
try {
  j = JSON.parse(readFileSync(0, "utf8"));
} catch (e) {
  fail("invalid JSON: " + e.message);
}
if (!existsSync(join(run, "items", String(j.id), "item.json")))
  fail("unknown id " + j.id);
if (
  !Array.isArray(j.add) ||
  !j.add.every((t) => typeof t === "string" && t.trim() && t.length <= 40)
)
  fail("add must be an array of tags (<= 40 chars each)");
if (j.add.length > 10) fail("too many tags (max 10): keep the most findable");
const forbidden = [
  "overlays",
  "data display",
  "activity states",
  "navigation",
  "inputs",
  "motion",
  "AI interface",
  "video",
  "image",
];
const bad = j.add.filter((t) => forbidden.includes(t));
if (bad.length) fail("don't add group/forbidden tags: " + bad.join(", "));
if (!Array.isArray(j.remove ?? [])) fail("remove must be an array");
if (typeof j.description !== "string" || j.description.trim().length < 40)
  fail("description missing or too short");
if (j.description.length > 800)
  fail(`description too long (${j.description.length} chars, max 800)`);
if (
  /^(this|the) (image|video|post|screenshot) (shows|is)/i.test(
    j.description.trim(),
  )
)
  fail("lead the description with the subject, not 'This image shows'");
appendFileSync(
  join(run, "proposals", agent + ".jsonl"),
  JSON.stringify(j) + "\n",
);
console.log("ok " + j.id);
