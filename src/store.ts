import type { Item, CaptureInput, SaveKind, Scope, Media } from "./types.ts";
import { normalizeMedia, cardId } from "./media.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { schema, fields, rank } from "./search.ts";
export const topics = [
  "interface design",
  "animation",
  "typography",
  "design systems",
  "React",
  "SwiftUI",
  "developer tools",
  "AI and agents",
  "databases",
  "open source",
  "product thinking",
  "web performance",
];
// Tags shown and searched: Jev's inferred topics, plus/minus curated edits (kept separately so reprocessing can't erase them).
export function effectiveTags(item: Pick<Item, "tags" | "tagEdits">) {
  const edits = item.tagEdits;
  if (!edits) return item.tags || [];
  const removed = new Set(edits.remove || []);
  return [...new Set([...(item.tags || []), ...(edits.add || [])])].filter(
    (t) => !removed.has(t),
  );
}
function cleanTags(list: unknown) {
  if (!Array.isArray(list)) throw new Error("Tags must be an array");
  return [
    ...new Set(
      list.map((t) => {
        if (typeof t !== "string") throw new Error("Invalid tag");
        const tag = t.trim().replace(/\s+/g, " ");
        if (!tag || tag.length > 40) throw new Error("Invalid tag: " + t);
        return tag;
      }),
    ),
  ];
}
export function canonical(raw: string) {
  const u = new URL(raw);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
    throw new Error("A public HTTP(S) URL is required");
  u.hash = "";
  for (const k of [...u.searchParams.keys()])
    if (/^(utm_|ref$|s$|t$)/.test(k)) u.searchParams.delete(k);
  if (["twitter.com", "www.twitter.com", "www.x.com"].includes(u.hostname))
    u.hostname = "x.com";
  const tweet =
    u.hostname === "x.com" &&
    u.pathname.match(/^\/(?:[^/]+\/status|i\/web\/status)\/(\d+)/);
  if (tweet) return `https://x.com/i/web/status/${tweet[1]}`;
  return u.href;
}
// X post IDs use the timestamp layout in Twitter's Snowflake generator.
function postDateFromId(url: string) {
  const match = url.match(/^https:\/\/x\.com\/i\/web\/status\/(\d{15,20})$/);
  if (!match) return null;
  const ms = Number((BigInt(match[1]) >> 22n) + 1288834974657n);
  return Number.isFinite(ms) &&
    ms > 1288834974657 &&
    ms <= Date.now() + 86400000
    ? new Date(ms).toISOString()
    : null;
}
export class Store {
  dir: string;
  db: DatabaseSync;
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(join(dir, "notes"), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dir, "keepsake.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY,url TEXT UNIQUE NOT NULL,body TEXT NOT NULL,updated TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);
   CREATE TABLE IF NOT EXISTS usage(id INTEGER PRIMARY KEY,kind TEXT,tokens INTEGER DEFAULT 0,cost REAL NOT NULL,status TEXT,created TEXT);
   CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY,value TEXT);
  `);
    if (!this.getSetting("token"))
      this.setSetting("token", randomBytes(32).toString("hex"));
    if (this.getSetting("searchIndex") !== "2") {
      // The index is derived from the item records, so a layout change rebuilds it.
      this.db.exec("BEGIN IMMEDIATE");
      this.db.exec(
        "DROP TABLE IF EXISTS search_vocab; DROP TABLE IF EXISTS search_raw; DROP TABLE IF EXISTS search;" +
          schema,
      );
      for (const item of this.list()) this.index(item);
      this.setSetting("searchIndex", "2");
      this.db.exec("COMMIT");
    } else this.db.exec(schema);
    if (this.getSetting("postDateBackfill") !== "1") {
      for (const item of this.list()) {
        if (item.postedAt) continue;
        const postedAt = postDateFromId(item.url);
        if (postedAt) this.put({ ...item, postedAt, postedAtSource: "x-id" });
      }
      this.setSetting("postDateBackfill", "1");
    }
    if (this.getSetting("mediaOriginals") !== "1") {
      // Re-queue saved media at full fidelity. Old files stay referenced until their replacement lands.
      for (const item of this.list()) {
        if (!item.media?.length) continue;
        let changed = false;
        const media = new Map();
        for (const old of item.media) {
          const next = { ...old, ...normalizeMedia([old])[0] };
          if (next.url !== old.url || next.poster !== old.poster) {
            delete next.status;
            changed = true;
          }
          const key = next.url || next.poster || next.type;
          if (media.has(key)) changed = true;
          else media.set(key, next);
        }
        const video =
          item.source !== "demo" && item.media.some((m) => m.type === "video");
        if (changed || video)
          this.put({
            ...item,
            media: [...media.values()],
            mediaResolvePending: video || item.mediaResolvePending,
            mediaAttempts: 0,
            mediaRetryAt: undefined,
          });
      }
      this.setSetting("mediaOriginals", "1");
    }
    if (this.getSetting("mediaCards") !== "1") {
      // Keep only each record's newest link-card preview, at original size. Its old file stays until the replacement lands.
      const sizes = ["small", "medium", "900x900", "large", "orig"];
      const size = (m: Media) =>
        sizes.indexOf(new URL(m.url!).searchParams.get("name") || "");
      for (const item of this.list()) {
        const cards = (item.media || []).filter(cardId);
        if (!cards.length) continue;
        const newest = cards.reduce((a, b) =>
          BigInt(cardId(b)!) > BigInt(cardId(a)!) ||
          (cardId(b) === cardId(a) && size(b) > size(a))
            ? b
            : a,
        );
        const card = { ...newest, ...normalizeMedia([newest])[0] };
        if (card.url === newest.url && cards.length === 1) continue;
        if (card.url !== newest.url) delete card.status;
        this.put({
          ...item,
          media: item.media!.flatMap((m) =>
            m === newest ? [card] : cardId(m) ? [] : [m],
          ),
          mediaAttempts: 0,
          mediaRetryAt: undefined,
        });
      }
      this.setSetting("mediaCards", "1");
    }
  }
  getSetting(k: string): string | undefined {
    return this.db.prepare("SELECT value FROM settings WHERE key=?").get(k)
      ?.value as string | undefined;
  }
  setSetting(k: string, v: string | number) {
    this.db
      .prepare("INSERT OR REPLACE INTO settings VALUES (?,?)")
      .run(k, String(v));
  }
  get(id: string): Item | null {
    const row = this.db.prepare("SELECT body FROM items WHERE id=?").get(id);
    return row ? JSON.parse(row.body as string) : null;
  }
  list(): Item[] {
    return this.db
      .prepare("SELECT body FROM items ORDER BY updated DESC")
      .all()
      .map((r) => JSON.parse(r.body as string));
  }
  capture(input: CaptureInput) {
    if (!input || typeof input !== "object" || typeof input.url !== "string")
      throw new Error("Item URL is required");
    const url = canonical(input.url),
      id = createHash("sha256").update(url).digest("hex").slice(0, 20),
      old = this.get(id);
    const now = new Date().toISOString();
    const text =
      typeof input.text === "string" ? input.text.slice(0, 14000) : "";
    const kind: SaveKind = ["like", "bookmark", "manual"].includes(
      input.kind || "",
    )
      ? (input.kind as SaveKind)
      : "manual";
    const active = input.active !== false,
      signals = { ...(old?.signals || {}) };
    const observed: string =
      Number.isFinite(Date.parse(input.observedAt || "")) &&
      Date.parse(input.observedAt || "") <= Date.now() + 60000
        ? input.observedAt!
        : now;
    const observedPostDate =
      typeof input.postedAt === "string" &&
      Number.isFinite(Date.parse(input.postedAt)) &&
      Date.parse(input.postedAt) <= Date.now() + 86400000
        ? new Date(input.postedAt).toISOString()
        : null;
    const idPostDate = postDateFromId(url);
    if (!signals[kind] || observed >= signals[kind].at)
      signals[kind] = { active, at: observed };
    const links = Array.isArray(input.links)
      ? input.links.slice(0, 20).flatMap((v) => {
          try {
            return [canonical(v)];
          } catch {
            return [];
          }
        })
      : [];
    const incoming = normalizeMedia(input.media);
    const item: Item = {
      ...old,
      id,
      url,
      title:
        typeof input.title === "string" && input.title
          ? input.title.slice(0, 250)
          : old?.title || text.split("\n")[0].slice(0, 110) || url,
      text: text.length >= (old?.text?.length || 0) ? text : old!.text,
      author:
        typeof input.author === "string"
          ? input.author.slice(0, 120)
          : old?.author || "",
      postedAt: observedPostDate || old?.postedAt || idPostDate,
      postedAtSource: observedPostDate
        ? input.postedAtSource === "x-id"
          ? "x-id"
          : "x-time"
        : old?.postedAtSource || (idPostDate ? "x-id" : null),
      links: [...new Set([...(old?.links || []), ...links])],
      folders: [
        ...new Map(
          [
            ...(old?.folders || []),
            ...(Array.isArray(input.folders)
              ? input.folders
                  .slice(0, 100)
                  .filter(
                    (f) => typeof f?.id === "string" && /^\d{1,30}$/.test(f.id),
                  )
                  .map((f) => ({
                    id: f.id,
                    name: String(
                      f.name ||
                        old?.folders?.find((previous) => previous.id === f.id)
                          ?.name ||
                        "",
                    ).slice(0, 120),
                  }))
              : []),
          ].map((f) => [f.id, f]),
        ).values(),
      ].slice(0, 100),
      media: incoming
        .reduce(
          (all, m) => {
            const at = all.findIndex(
              (oldMedia) =>
                (m.poster && oldMedia.poster === m.poster) ||
                (m.url && oldMedia.url === m.url) ||
                (!m.url && !m.poster && oldMedia.type === m.type),
            );
            if (at < 0) all.push(m);
            else {
              const previous = all[at];
              all[at] = { ...previous, ...m };
              if (m.url && m.url !== previous.url) {
                delete all[at].local;
                delete all[at].status;
                delete all[at].error;
              }
            }
            return all;
          },
          // A newly observed link card supersedes the previews saved before it.
          (old?.media || []).filter(
            (m) =>
              !cardId(m) ||
              !incoming.some(cardId) ||
              incoming.some((card) => card.url === m.url),
          ),
        )
        .slice(0, 12),
      signals,
      createdAt: old?.createdAt || now,
      updatedAt: now,
      source:
        input.source === "demo"
          ? "demo"
          : old?.source === "demo"
            ? "demo"
            : "capture",
      tags: old?.tags || [],
      tagEdits: old?.tagEdits,
      description: old?.description,
      scope: old?.scope || null,
      scopeSource: old?.scopeSource || null,
      scopeConfidence: old?.scopeConfidence ?? null,
      scopeAt: old?.scopeAt || null,
      classification: old?.classification || null,
      enrichment: old?.enrichment || null,
    };
    if (old && item.text !== old.text) {
      item.classification = null;
      item.tags = [];
      if (item.scopeSource === "jev") {
        item.scope = null;
        item.scopeSource = null;
        item.scopeConfidence = null;
        item.scopeAt = null;
      }
    }
    this.put(item);
    return item;
  }
  restore(input: Item) {
    if (!input?.signals || typeof input.signals !== "object")
      throw new Error("Backup record is missing save signals");
    let item;
    for (const kind of ["like", "bookmark", "manual"] as const) {
      const signal = input.signals[kind];
      if (!signal) continue;
      if (
        typeof signal.active !== "boolean" ||
        !Number.isFinite(Date.parse(signal.at))
      )
        throw new Error("Invalid backup signal");
      item = this.capture({
        ...input,
        kind,
        active: signal.active,
        observedAt: signal.at,
      });
    }
    if (!item) throw new Error("Backup record has no valid save signals");
    if (Number.isFinite(Date.parse(input.createdAt)))
      item.createdAt = input.createdAt;
    if (Number.isFinite(Date.parse(input.updatedAt)))
      item.updatedAt = input.updatedAt;
    if (
      input.classification &&
      typeof input.classification.category === "string" &&
      input.classification.topics &&
      Object.entries(input.classification.topics).every(
        ([k, v]) =>
          topics.includes(k) &&
          Number.isFinite(v) &&
          typeof v === "number" &&
          v >= 0 &&
          v <= 1,
      )
    ) {
      item.classification = input.classification;
      item.tags = topics.filter((t) => input.classification!.topics[t] >= 0.7);
    }
    if (
      ["work", "personal", null].includes(input.scope as Scope) &&
      ["manual", "jev"].includes(input.scopeSource || "")
    ) {
      item.scope = input.scope;
      item.scopeSource = input.scopeSource;
      item.scopeConfidence = Number.isFinite(input.scopeConfidence)
        ? input.scopeConfidence
        : null;
      item.scopeAt = input.scopeAt || null;
    }
    if (input.tagEdits) {
      try {
        item.tagEdits = {
          add: cleanTags(input.tagEdits.add || []),
          remove: cleanTags(input.tagEdits.remove || []),
          by: String(input.tagEdits.by || "").slice(0, 60),
          at: input.tagEdits.at || null,
        };
      } catch {}
    }
    if (typeof input.description?.text === "string")
      item.description = {
        text: input.description.text.slice(0, 1200),
        by: String(input.description.by || "").slice(0, 60),
        at: input.description.at || null,
      };
    if (input.enrichment && typeof input.enrichment.text === "string") {
      item.enrichment = {
        url: canonical(input.enrichment.url),
        title: String(input.enrichment.title || "").slice(0, 250),
        text: input.enrichment.text.slice(0, 10000),
        fetchedAt: input.enrichment.fetchedAt,
      };
    }
    this.put(item);
    return item;
  }
  setScope(id: string, scope: Scope) {
    if (!["work", "personal", null].includes(scope))
      throw new Error("Invalid scope");
    const item = this.get(id);
    if (!item) return null;
    const updated = {
      ...item,
      scope,
      scopeSource: "manual" as const,
      scopeConfidence: null,
      scopeAt: new Date().toISOString(),
    };
    this.put(updated);
    return updated;
  }
  // Replace an item's curated tag edits. `add` extends Jev's topics; `remove` hides one of them.
  setTagEdits(
    id: string,
    {
      add = [],
      remove = [],
      by = "",
    }: { add?: string[]; remove?: string[]; by?: string },
  ) {
    const item = this.get(id);
    if (!item) return null;
    const updated = {
      ...item,
      tagEdits: {
        add: cleanTags(add),
        remove: cleanTags(remove),
        by: String(by).slice(0, 60),
        at: new Date().toISOString(),
      },
    };
    this.put(updated);
    return updated;
  }
  // A written description of what the save shows (its media included). Kept apart from the captured source text.
  setDescription(id: string, text: string, by = "") {
    const item = this.get(id);
    if (!item) return null;
    text = String(text || "")
      .trim()
      .slice(0, 1200);
    if (!text) throw new Error("Empty description");
    const updated = {
      ...item,
      description: {
        text,
        by: String(by).slice(0, 60),
        at: new Date().toISOString(),
      },
    };
    this.put(updated);
    return updated;
  }
  index(item: Item) {
    const row = [item.id, ...fields(item, effectiveTags(item))];
    for (const table of ["search", "search_raw"]) {
      this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(item.id);
      this.db
        .prepare(`INSERT INTO ${table} VALUES (?,?,?,?,?,?,?,?)`)
        .run(...row);
    }
  }
  put(item: Item) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT OR REPLACE INTO items VALUES (?,?,?,?)")
        .run(item.id, item.url, JSON.stringify(item), item.updatedAt);
      this.index(item);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.export(item);
  }
  export(item: Item) {
    const text = `# ${item.title.replace(/\n/g, " ")}\n\nSource: ${item.url}\nAuthor: ${item.author || "Unknown"}\nPosted on X: ${item.postedAt || "Unknown"}${item.postedAtSource === "x-id" ? " (derived from X post ID)" : ""}\nAdded to Keepsake: ${item.createdAt}\nSignals: ${
      Object.entries(item.signals)
        .filter(([, v]) => v?.active)
        .map(([k]) => k)
        .join(", ") || "removed"
    }\nX folders (observed): ${(item.folders || []).map((f) => f.name || f.id).join(", ") || "None observed"}\nScope: ${item.scope === "work" ? "Work" : item.scope === "personal" ? "Personal/Social" : "Unsorted"}${item.scopeSource ? ` (${item.scopeSource === "manual" ? "set by user" : "suggested by Jev"})` : ""}\nTopics (inferred): ${item.tags.join(", ") || "Pending"}\nCurated tags: ${item.tagEdits ? effectiveTags(item).join(", ") + (item.tagEdits.by ? ` (edited by ${item.tagEdits.by})` : "") : "None"}\n\n## Description (written by ${item.description?.by || "nobody yet"}; describes the media, not source text)\n\n${item.description?.text || "None"}\n\n## Captured source text (untrusted)\n\n${item.text}\n\n## Saved media\n\n${(item.media || []).map((m) => `- ${m.type}: ${m.alt || ""} | ${m.local ? join(this.dir, m.local) : m.posterLocal ? join(this.dir, m.posterLocal) : "Not downloaded"} | Source: ${m.url || m.poster || item.url}`).join("\n")}\n\n## Links\n\n${item.links.map((u) => "- " + u).join("\n")}\n${item.enrichment?.text ? "\n## Linked page (untrusted)\n\n" + item.enrichment.url + "\n\n" + item.enrichment.text : ""}\n`;
    const file = join(this.dir, "notes", item.id + ".md");
    writeFileSync(file + ".tmp", text, { mode: 0o600 });
    renameSync(file + ".tmp", file);
  }
  // Saves matching the query, best first, each with a `relevance` relative to the top match (1).
  candidates(query: string, limit = 2000) {
    const ranked = rank(this.db, query);
    if (!ranked) return this.list().slice(0, limit);
    const now = Date.now();
    const items = ranked.slice(0, limit).map(({ id, score, matched }) => {
      const item = this.get(id)!;
      // Among near-equal matches, lean toward the more recent post.
      const years =
        (now - (Date.parse(item.postedAt || item.createdAt) || 0)) / 31536e6;
      return {
        ...item,
        relevance: score * (1 + 0.1 * 2 ** -Math.max(0, years)),
        matched,
      };
    });
    items.sort((a, b) => b.relevance - a.relevance);
    const top = items[0]?.relevance || 1;
    for (const item of items)
      item.relevance = Math.round((item.relevance / top) * 1000) / 1000;
    return items;
  }
  stats() {
    return {
      items: this.list().length,
      active: this.list().filter((i) =>
        Object.values(i.signals).some((v) => v?.active),
      ).length,
      cost: this.db
        .prepare("SELECT COALESCE(sum(cost),0) AS n FROM usage")
        .get()!.n as number,
      calls: this.db.prepare("SELECT count(*) AS n FROM usage").get()!
        .n as number,
      notes: join(this.dir, "notes"),
    };
  }
}
