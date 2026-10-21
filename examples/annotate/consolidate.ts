interface Proposal {
  id: string;
  add: string[];
  remove?: string[];
  description: string;
  flags?: string[];
}
// Merge <runDir>/proposals/*.jsonl into <runDir>/apply.jsonl for `node src/cli.ts tag-apply`.
// The last line per id wins. Spellings are unified to VOCAB.md, group tags are added from the UI-pattern
// lines, and tags outside the vocabulary are kept only when they are proper nouns or coined by 2+ saves.
// Usage: node examples/annotate/consolidate.ts <runDir>
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const run = process.argv[2];
if (!run) throw new Error("usage: node consolidate.ts <runDir>");
const vocab = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "VOCAB.md"),
  "utf8",
);
const GROUPS = [
  "overlays",
  "data display",
  "activity states",
  "onboarding",
  "navigation",
  "inputs",
  "layout",
  "motion",
  "AI interface",
];
const groupOf: Record<string, string> = {};
const known = new Set<string>();
let rules = false;
for (const line of vocab.split("\n")) {
  if (line.startsWith("#")) rules = line.startsWith("## Rules");
  if (rules || !line.trim() || /^[#>]/.test(line)) continue;
  const group = GROUPS.find((g) => line.startsWith(`- ${g}: `));
  const list = (group ? line.slice(group.length + 4) : line)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  for (const t of list) {
    known.add(t);
    if (group && t !== group) groupOf[t] = group;
  }
}

const props = new Map<string, Proposal>();
let badLines = 0;
for (const f of readdirSync(join(run, "proposals")).filter((f) =>
  f.endsWith(".jsonl"),
))
  for (const l of readFileSync(join(run, "proposals", f), "utf8")
    .split("\n")
    .filter(Boolean)) {
    try {
      const j = JSON.parse(l);
      props.set(j.id, j);
    } catch {
      badLines++;
    }
  }

const key = (t: string) => t.toLowerCase().replace(/s$/, "");
const canon: Record<string, string> = {};
for (const t of known) canon[key(t)] = t;
const norm = (t: string) => canon[key(t.trim())] || t.trim();
const coined: Record<string, number> = {};
const stage: Proposal[] = [];
for (const j of props.values()) {
  const inferred =
    JSON.parse(readFileSync(join(run, "items", j.id, "item.json"), "utf8"))
      .inferredTags || [];
  const add = [...new Set(j.add.map(norm))].filter(
    (t) => !inferred.includes(t),
  );
  for (const t of add) if (!known.has(t)) coined[t] = (coined[t] || 0) + 1;
  stage.push({
    id: j.id,
    add,
    remove: (j.remove || []).filter((t) => inferred.includes(t)),
    description: j.description.trim(),
    flags: j.flags || [],
  });
}
const proper = (t: string) => /^[A-Z0-9]/.test(t) || /[.\/]/.test(t);
const dropped = new Set();
const flags: Record<string, number> = {};
for (const s of stage) {
  s.add = s.add.filter(
    (t) => known.has(t) || proper(t) || coined[t] > 1 || !dropped.add(t),
  );
  s.add = [...new Set([...s.add, ...s.add.map((t) => groupOf[t])])].filter(
    Boolean,
  );
  for (const f of s.flags || []) flags[f] = (flags[f] || 0) + 1;
  delete s.flags;
}
writeFileSync(
  join(run, "apply.jsonl"),
  stage.map((s) => JSON.stringify(s)).join("\n") + (stage.length ? "\n" : ""),
);
const expected = readdirSync(join(run, "items"));
console.log(
  JSON.stringify(
    {
      items: stage.length,
      missing: expected.filter((id) => !props.has(id)),
      badLines,
      noTags: stage.filter((s) => !s.add.length).map((s) => s.id),
      coinedKept: Object.keys(coined).filter((t) => !dropped.has(t)),
      coinedDropped: [...dropped],
      flags,
      applyFile: join(run, "apply.jsonl"),
    },
    null,
    2,
  ),
);
