import type { DatabaseSync } from "node:sqlite";
import type { Item } from "./types.ts";
// Keyword relevance shared by the library, CLI and MCP. Local SQLite only; no Jev calls.
// Two FTS tables hold the same columns: `search` is stemmed (matches word forms),
// `search_raw` is unstemmed (matches a word still being typed, and supplies the typo vocabulary).
const columns: [string, number][] = [
  ["title", 4],
  ["author", 3],
  ["tags", 5],
  ["description", 2],
  ["text", 2],
  ["context", 1.5],
  ["page", 0.6],
];
// Each field is scored on its own and then weighted, so a save matching in its title, tags
// and text outranks one matching in a single field.
const score = (table: string) =>
  columns
    .map(
      ([, weight], at) =>
        `${weight}*bm25(${table},0,${columns.map((_, n) => +(n === at))})`,
    )
    .join("+");
export const schema = `
  CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(id UNINDEXED,${columns.map(([name]) => name)},tokenize='porter unicode61 remove_diacritics 2');
  CREATE VIRTUAL TABLE IF NOT EXISTS search_raw USING fts5(id UNINDEXED,${columns.map(([name]) => name)},tokenize='unicode61 remove_diacritics 2');
  CREATE VIRTUAL TABLE IF NOT EXISTS search_vocab USING fts5vocab(search_raw,'row');`;
export function fields(item: Item, tags: string[]) {
  return [
    item.title,
    item.author,
    tags.join("\n"),
    item.description?.text || "",
    item.text,
    [
      ...(item.folders || []).map((f) => f.name),
      item.classification?.category || "",
      ...item.links,
    ].join("\n"),
    [item.enrichment?.title || "", item.enrichment?.text || ""].join("\n"),
  ];
}
const stopwords = new Set(
  "a an and are as at be but by for from how i in is it my of on or that the this to was what when where which who with".split(
    " ",
  ),
);
// `"quoted phrases"` are required, `-word` excludes, everything else is ranked.
export function parse(query: string) {
  const terms: { text: string; tokens: string[]; required: boolean }[] = [],
    exclude: string[] = [];
  for (const [, minus, quoted, word] of String(query).matchAll(
    /(-?)(?:"([^"]*)"?|(\S+))/g,
  )) {
    const tokens = (quoted ?? word)
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}_]+/gu);
    if (!tokens) continue;
    const text = tokens.join(" ");
    if (minus) exclude.push(text);
    else terms.push({ text, tokens, required: quoted !== undefined });
  }
  const useful = terms.filter((t) => t.required || !stopwords.has(t.text));
  return {
    all: terms.slice(0, 16),
    terms: (useful.length ? useful : terms).slice(0, 16),
    exclude: exclude.slice(0, 16),
  };
}
// Edit distance counting a swap of neighbouring letters as one edit; gives up beyond `max`.
function distance(a: string, b: string, max: number) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let before: number[] = [],
    prior = Array.from({ length: b.length + 1 }, (_, n) => n);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prior[j] + 1, row[j - 1] + 1, prior[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        row[j] = Math.min(row[j], before[j - 2] + 1);
      best = Math.min(best, row[j]);
    }
    if (best > max) return max + 1;
    before = prior;
    prior = row;
  }
  return prior[b.length];
}
function correction(db: DatabaseSync, word: string) {
  const max = word.length < 8 ? 1 : 2;
  let best: { term: string; doc: number; d: number } | null = null;
  for (const { term, doc } of db
    .prepare("SELECT term, doc FROM search_vocab WHERE substr(term,1,1)=?")
    .all(word[0]) as { term: string; doc: number }[]) {
    const d = distance(word, term, max);
    if (d <= max && (!best || d < best.d || (d === best.d && doc > best.doc)))
      best = { term, doc, d };
  }
  return best?.term;
}
// Returns [{id, score, matched}] best first, or null when the query has no searchable words.
export function rank(db: DatabaseSync, query: string) {
  const { all, terms, exclude } = parse(query);
  if (!terms.length) return null;
  const match = (table: string, expression: string) =>
    db
      .prepare(
        `SELECT id, -(${score(table)}) AS score FROM ${table} WHERE ${table} MATCH ?`,
      )
      .all(expression) as { id: string; score: number }[];
  const quote = (text: string) => `"${text}"`;
  const total = db.prepare("SELECT count(*) AS n FROM search").get()!
    .n as number;
  const docs = new Map<
    string,
    { id: string; sum: number; cover: number; matched: string[]; score: number }
  >();
  const doc = (id: string) => {
    if (!docs.has(id))
      docs.set(id, { id, sum: 0, cover: 0, matched: [], score: 0 });
    return docs.get(id)!;
  };
  let weightSum = 0;
  const required: Map<string, [number, number]>[] = [];
  terms.forEach((term, index) => {
    // credit: 1 for the word itself, less for a completion or a typo correction.
    const hits = new Map<string, [number, number]>(
      match("search", quote(term.text)).map((r) => [r.id, [r.score, 1]]),
    );
    const last = index === terms.length - 1 && !term.required;
    if (last && term.tokens.at(-1)!.length >= 2)
      for (const r of match("search_raw", quote(term.text) + "*"))
        if (!hits.has(r.id)) hits.set(r.id, [r.score, 0.6]);
    if (!hits.size && term.tokens.length === 1 && term.text.length >= 4) {
      const fixed = correction(db, term.text);
      if (fixed)
        for (const r of match("search", quote(fixed)))
          hits.set(r.id, [r.score, 0.5]);
    }
    const weight = Math.log(
      1 + (total - hits.size + 0.5) / (hits.size + 0.5) + 1e-9,
    );
    weightSum += weight;
    if (term.required) required.push(hits);
    for (const [id, [score, credit]] of hits) {
      const d = doc(id);
      d.sum += score * credit;
      d.cover += weight * credit;
      d.matched.push(term.text);
    }
  });
  // Words appearing together, in order, outrank the same words scattered.
  const boost = (expression: string, factor: number) => {
    for (const r of match("search", expression))
      if (docs.has(r.id)) docs.get(r.id)!.sum += r.score * factor;
  };
  if (all.length > 1) boost(quote(all.map((t) => t.text).join(" ")), 1.5);
  if (terms.length > 2)
    for (let n = 1; n < terms.length; n++)
      boost(quote(terms[n - 1].text + " " + terms[n].text), 0.5);
  if (exclude.length)
    for (const r of match("search", exclude.map(quote).join(" OR ")))
      docs.delete(r.id);
  let found = [...docs.values()].filter((d) =>
    required.every((hits) => hits.has(d.id)),
  );
  // Every word should match; when nothing matches them all, the closest partial matches stand in.
  const best = Math.max(0, ...found.map((d) => d.cover));
  found = found.filter((d) => d.cover >= best * 0.75);
  for (const d of found) d.score = d.sum * (d.cover / weightSum) ** 2;
  return found.sort((a, b) => b.score - a.score);
}
