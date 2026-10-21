import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, effectiveTags } from "../src/store.ts";

const make = () => new Store(mkdtempSync(join(tmpdir(), "keepsake-tags-")));
const capture = (store, text = "A useful software component") =>
  store.capture({
    url: "https://x.com/example/status/1",
    kind: "bookmark",
    title: "Example",
    text,
    author: "@example",
    links: [],
  });

test("curated tag edits extend and hide inferred topics without touching them", () => {
  const store = make();
  const saved = capture(store);
  store.put({ ...saved, tags: ["animation", "React"] });
  const edited = store.setTagEdits(saved.id, {
    add: ["screen recording", " scroll effects ", "screen recording"],
    remove: ["React"],
    by: "agent",
  });
  assert.deepEqual(edited.tags, ["animation", "React"]);
  assert.deepEqual(effectiveTags(edited), [
    "animation",
    "screen recording",
    "scroll effects",
  ]);
  assert.equal(store.candidates("scroll effects", 5).length, 1);
  assert.equal(store.candidates("React", 5).length, 0);
});

test("curated tags survive recapture, changed text, and backup restore", () => {
  const store = make();
  const saved = capture(store);
  store.setTagEdits(saved.id, { add: ["dashboard"], by: "agent" });
  capture(store);
  const changed = capture(store, "Completely different words about layout");
  assert.deepEqual(effectiveTags(changed), ["dashboard"]);
  const restored = make();
  restored.restore(JSON.parse(JSON.stringify(store.list()[0])));
  assert.deepEqual(effectiveTags(restored.list()[0]), ["dashboard"]);
});

test("invalid curated tags are rejected", () => {
  const store = make();
  const saved = capture(store);
  assert.throws(() => store.setTagEdits(saved.id, { add: ["x".repeat(41)] }));
  assert.throws(() => store.setTagEdits(saved.id, { add: [""] }));
  assert.equal(store.setTagEdits("missing", { add: ["a"] }), null);
});

test("a written description is searchable and survives recapture and restore", () => {
  const store = make();
  const saved = capture(store);
  store.setDescription(
    saved.id,
    "Dark dashboard where a tooltip follows the cursor across a chart.",
    "agent",
  );
  assert.equal(store.candidates("tooltip cursor", 5).length, 1);
  const again = capture(store, "Other words entirely");
  assert.match(again.description.text, /tooltip follows/);
  const restored = make();
  restored.restore(JSON.parse(JSON.stringify(store.list()[0])));
  assert.match(restored.list()[0].description.text, /tooltip follows/);
  assert.throws(() => store.setDescription(saved.id, "  "));
});
