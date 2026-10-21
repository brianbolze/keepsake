import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, canonical } from "../src/store.ts";
import { App } from "../src/app.ts";
import { Jev, PRICE } from "../src/jev.ts";
import { publicIPv4, fetchPage } from "../src/enrich.ts";
import { createServer } from "../src/server.ts";
const make = () => new Store(mkdtempSync(join(tmpdir(), "keepsake-test-")));
const post = {
  url: "https://x.com/designer/status/1234?s=20",
  text: "React animation components with keyboard support",
  kind: "bookmark",
  links: ["https://motion.dev"],
};
test("canonical post IDs deduplicate handles and Twitter domains", () => {
  assert.equal(
    canonical(post.url),
    canonical("https://twitter.com/someone/status/1234/photo/1"),
  );
  assert.throws(() => canonical("javascript:alert(1)"));
});
test("existing X posts gain an ID-derived date, then a directly observed date", () => {
  const s = make();
  const url = "https://x.com/XDevelopers/status/1346889436626259968";
  const first = s.capture({ ...post, url });
  assert.equal(first.postedAtSource, "x-id");
  assert.match(first.postedAt, /^2021-01-06T18:40:/);
  s.put({ ...first, postedAt: null, postedAtSource: null });
  s.db.prepare("DELETE FROM settings WHERE key='postDateBackfill'").run();
  const reopened = new Store(s.dir);
  const backfilled = reopened.get(first.id);
  assert.equal(backfilled.postedAtSource, "x-id");
  assert.equal(backfilled.postedAt, first.postedAt);
  const observed = reopened.capture({
    ...post,
    url,
    postedAt: "2021-01-06T18:40:40Z",
  });
  assert.equal(observed.postedAtSource, "x-time");
  assert.equal(observed.postedAt, "2021-01-06T18:40:40.000Z");
});
test("capture persists both signals, merges full text, exports source, handles removal and out-of-order retry", () => {
  const s = make();
  const first = s.capture({
    ...post,
    author: "@designer",
    postedAt: "2025-12-20T12:00:00Z",
    observedAt: "2026-01-01T00:00:00Z",
  });
  s.capture({ ...post, text: "short", kind: "like" });
  let item = s.get(first.id);
  assert.equal(item.text, post.text);
  assert.equal(item.author, "@designer");
  assert.equal(item.postedAt, "2025-12-20T12:00:00.000Z");
  assert.equal(item.signals.like.active, true);
  assert.equal(item.signals.bookmark.active, true);
  s.capture({ ...post, active: false, observedAt: "2026-01-03T00:00:00Z" });
  s.capture({ ...post, observedAt: "2026-01-02T00:00:00Z" });
  item = s.get(first.id);
  assert.equal(item.signals.bookmark.active, false);
  assert.equal(s.list().length, 1);
  assert.match(
    readFileSync(join(s.dir, "notes", first.id + ".md"), "utf8"),
    /Captured source text \(untrusted\)/,
  );
  assert.match(
    readFileSync(join(s.dir, "notes", first.id + ".md"), "utf8"),
    /Posted on X: 2025-12-20T12:00:00.000Z/,
  );
  const reopened = new Store(s.dir);
  assert.equal(reopened.list().length, 1);
  assert.equal(reopened.candidates("animations")[0].id, first.id);
});
test("FTS handles malformed queries and schema abuse as plain text", () => {
  const s = make();
  s.capture({ ...post, folders: [{ id: "123", name: "" }] });
  assert.deepEqual(s.candidates('" OR * --'), []);
  assert.equal(s.candidates("React").length, 1);
});
test("removed items stay archived but excluded from normal search", async () => {
  const s = make();
  s.capture({ ...post, active: false });
  const app = new App(s);
  assert.equal((await app.search("React")).items.length, 0);
  assert.equal(
    (await app.search("React", { includeRemoved: true })).items.length,
    1,
  );
});
test("missing API key degrades semantic request to local search", async () => {
  const s = make();
  s.capture({ ...post, folders: [{ id: "123", name: "" }] });
  const result = await new App(s).search("React", { semantic: true });
  assert.equal(result.mode, "keyword");
  assert.match(result.warning, /not configured/);
  assert.equal(result.items.length, 1);
});
test("Jev caches results and records actual input-token cost", async () => {
  const s = make();
  let count = 0;
  const jev = new Jev(s, "test", {
    fetcher: async () => {
      count++;
      return {
        ok: true,
        json: async () => ({
          model: "jev-1.13.0",
          usage: { input_tokens: 1234 },
          answers: { ok: { type: "noul", noul: 0.9 } },
        }),
      };
    },
  });
  const q = { ok: { type: "noul", instructions: "Useful?" } };
  await jev.ask("test", "post", q);
  const again = await jev.ask("test", "post", q);
  assert.equal(count, 1);
  assert.equal(again.cached, true);
  assert.equal(s.stats().cost, 1234 * PRICE);
});
test("budget blocks dispatch and ambiguous failures retain reservations", async () => {
  const s = make();
  let count = 0;
  const jev = new Jev(s, "test", {
    fetcher: async () => {
      count++;
      throw new Error("timeout");
    },
  });
  await assert.rejects(
    () =>
      jev.ask("test", "one", { q: { type: "noul", instructions: "Useful?" } }),
    /timeout/,
  );
  assert.ok(s.stats().cost > 0);
  s.db.prepare("INSERT INTO usage(cost,status) VALUES (?,?)").run(20, "test");
  await assert.rejects(() => jev.ask("test", "two", {}), /budget/);
  assert.equal(count, 1);
});
test("enrichment rejects local IPs and unsafe protocols", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.1.1",
    "172.16.1.1",
    "192.168.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "::ffff:127.0.0.1",
  ])
    assert.equal(publicIPv4(ip), false);
  assert.equal(publicIPv4("1.1.1.1"), true);
  await assert.rejects(() => fetchPage("file:///etc/passwd"));
  await assert.rejects(() => fetchPage("https://127.0.0.1:443"), /blocked/);
});
test("server rejects unauthenticated requests, hostile origins and hosts; accepts paired capture", async () => {
  const s = make();
  const port = 48763;
  const server = createServer(new App(s), {
    port,
    nextHandler: async (req, res) => res.end(""),
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(base + "/api/status")).status, 401);
    const auth = { Authorization: "Bearer " + s.getSetting("token") };
    assert.equal(
      (await fetch(base + "/api/status", { headers: auth })).status,
      200,
    );
    assert.equal(
      (
        await fetch(base + "/api/status", {
          headers: { ...auth, Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    let hostCode;
    await (server.listeners("request")[0] as (...args: any[]) => Promise<void>)(
      {
        method: "GET",
        url: "/api/status",
        headers: { host: "evil.example", authorization: auth.Authorization },
      },
      {
        setHeader() {},
        writeHead(n) {
          hostCode = n;
        },
        end() {},
      },
    );
    assert.equal(hostCode, 403);
    const result = await fetch(base + "/api/capture", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(post),
    });
    assert.equal(result.status, 200);
    assert.equal(s.list().length, 1);
    const library = await (
      await fetch(base + "/api/library", { headers: auth })
    ).json();
    assert.equal(library.items.length, 1);
    assert.equal(library.items[0].title, s.list()[0].title);
    assert.equal(library.items[0].enrichment, undefined);
    assert.equal((await fetch(base + "/api/library")).status, 401);
    const check = (startedAt, postIds) =>
      fetch(base + "/api/import/check", {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ startedAt, postIds }),
      });
    assert.deepEqual(
      await (
        await check(new Date(Date.now() - 10000).toISOString(), [
          "1234",
          "1234",
          "9999",
        ])
      ).json(),
      { new: 1, existing: 0, pending: 1 },
    );
    assert.deepEqual(
      await (
        await check(new Date(Date.now() + 10000).toISOString(), ["1234"])
      ).json(),
      { new: 0, existing: 1, pending: 0 },
    );
    assert.equal(
      (await check(new Date().toISOString(), ["not-a-post"])).status,
      400,
    );
    const html = await fetch(base + "/");
    assert.match(html.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
    assert.match(
      html.headers.get("content-security-policy"),
      /frame-ancestors 'none'/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
test("malformed local requests and Unicode tokens cannot crash daemon", async () => {
  const s = make(),
    server = createServer(new App(s));
  const handler = server.listeners("request")[0] as (
    ...args: any[]
  ) => Promise<void>;
  for (const req of [
    { url: "//[", headers: { host: "127.0.0.1:47821" } },
    {
      url: "/api/status",
      headers: {
        host: "127.0.0.1:47821",
        authorization: "Bearer " + "é".repeat(64),
      },
    },
  ]) {
    let code;
    await handler(
      { ...req, method: "GET" },
      {
        setHeader() {},
        writeHead(n) {
          code = n;
        },
        end() {},
      },
    );
    assert.ok([400, 401].includes(code));
  }
});
test("versioned backup restores signals, original timestamps and enriched notes", () => {
  const a = make();
  const item = a.capture({
    ...post,
    active: false,
    observedAt: "2026-01-03T00:00:00Z",
  });
  item.classification = {
    category: "library",
    topics: { React: 0.9 },
    model: "test",
  };
  item.tags = ["React"];
  item.enrichment = {
    url: "https://motion.dev/",
    title: "Motion",
    text: "Actual page text",
    fetchedAt: new Date().toISOString(),
  };
  a.put(item);
  const b = make();
  b.restore(JSON.parse(JSON.stringify(a.list()[0])));
  const restored = b.list()[0];
  assert.deepEqual(restored.signals, item.signals);
  assert.deepEqual(restored.tags, ["React"]);
  assert.equal(restored.createdAt, item.createdAt);
  assert.equal(restored.enrichment.text, "Actual page text");
  assert.equal(restored.signals.manual, undefined);
});
test("deep semantic search visits every eligible record beyond the shortlist", async () => {
  const s = make();
  for (let n = 0; n < 65; n++)
    s.capture({ url: `https://example.com/item/${n}`, text: `Resource ${n}` });
  const app = new App(s, "mock");
  const visited = [];
  app.jev.rank = async (_q, items) => {
    visited.push(...items.map((i) => i.id));
    return items.map((i) => ({ ...i, relevance: 0.8 }));
  };
  const result = await app.search("useful software", {
    semantic: true,
    deep: true,
  });
  assert.equal(visited.length, 65);
  assert.equal(new Set(visited).size, 65);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.library, 65);
});
test("semantic shortlist can retrieve an old save through topic affinity", async () => {
  const s = make();
  const target = s.capture({
    url: "https://example.com/old",
    text: "Springs",
    kind: "bookmark",
  });
  target.classification = { category: "other", topics: { animation: 1 } };
  s.put(target);
  for (let n = 0; n < 60; n++)
    s.capture({ url: `https://example.com/new/${n}`, text: "Unrelated news" });
  const app = new App(s, "mock");
  app.jev.queryTopics = async () => ({ animation: 1 });
  app.jev.rank = async (_q, items) =>
    items.map((i) => ({ ...i, relevance: i.id === target.id ? 1 : 0 }));
  const result = await app.search("make my interface feel alive", {
    semantic: true,
  });
  assert.equal(result.items[0].id, target.id);
  assert.equal(result.coverage.complete, false);
  assert.match(result.warning, /--deep/);
});

test("observed folders survive later captures and are searchable and exported", () => {
  const s = make();
  const item = s.capture({
    ...post,
    folders: [{ id: "123", name: "MyDesignFolder" }],
  });
  s.capture({ ...post, folders: [{ id: "123", name: "" }] });
  assert.equal(s.get(item.id).folders[0].name, "MyDesignFolder");
  assert.ok(
    readFileSync(join(s.dir, "notes", item.id + ".md"), "utf8").includes(
      "MyDesignFolder",
    ),
  );
  assert.equal(s.candidates("MyDesignFolder").length, 1);
});
test("configured tailnet host is accepted but cannot read the pairing token", async () => {
  const s = make();
  const remoteHost = "mac.example.ts.net:47821";
  const server = createServer(new App(s), { port: 48764, remoteHost });
  const call = (host, path, origin?: string) =>
    new Promise((resolve) => {
      let code;
      (server.listeners("request")[0] as (...args: any[]) => Promise<void>)(
        {
          method: "GET",
          url: path,
          headers: {
            host,
            authorization: "Bearer " + s.getSetting("token"),
            ...(origin && { origin }),
          },
        },
        {
          setHeader() {},
          writeHead(n) {
            code = n;
          },
          end() {
            resolve(code);
          },
        },
      );
    });
  assert.equal(await call(remoteHost, "/api/status"), 200);
  assert.equal(
    await call(remoteHost, "/api/status", `https://${remoteHost}`),
    200,
  );
  assert.equal(await call(remoteHost, "/api/pair"), 403);
  assert.equal(await call("127.0.0.1:48764", "/api/pair"), 200);
  assert.equal(await call("other.example.ts.net:47821", "/api/status"), 403);
});

test("keyword search ranks by relevance and tolerates typing, typos and word forms", async () => {
  const s = make();
  const add = (n, text, extra = {}) =>
    s.capture({ url: `https://example.com/rank/${n}`, text, ...extra });
  const exact = add(1, "Spring animation library for React");
  const scattered = add(2, "A library. Also React. Later, an animation.", {
    title: "Notes",
  });
  const partial = add(3, "Typography specimens for editorial layouts");
  add(4, "Unrelated news about databases");
  const ids = (query) => s.candidates(query).map((i) => i.id);
  // Words in order outrank the same words scattered; unrelated saves are left out.
  assert.deepEqual(ids("animation library"), [exact.id, scattered.id]);
  assert.equal(s.candidates("animation library")[0].relevance, 1);
  assert.deepEqual(s.candidates("animation library")[0].matched, [
    "animation",
    "library",
  ]);
  // A partly typed last word, another word form, and a typo all still match.
  assert.deepEqual(ids("typogr"), [partial.id]);
  assert.deepEqual(ids("animated libraries"), [exact.id, scattered.id]);
  assert.deepEqual(ids("typografy"), [partial.id]);
  // When no save has every word, the closest partial matches stand in.
  assert.deepEqual(ids("editorial typography kerning"), [partial.id]);
  assert.deepEqual(ids('"animation library"'), [exact.id]);
  assert.deepEqual(ids("library -spring"), [scattered.id]);
  // Agents get the library's filters on the same ranking.
  const tagged = s.setTagEdits(exact.id, { add: ["motion"] });
  const found = await new App(s).search("library", { tag: "motion" });
  assert.deepEqual(
    found.items.map((i) => i.id),
    [tagged.id],
  );
});
test("an index from the older layout is rebuilt from the saved records", () => {
  const s = make();
  const item = s.capture(post);
  s.db.exec(
    "DROP TABLE search_vocab; DROP TABLE search_raw; DROP TABLE search; CREATE VIRTUAL TABLE search USING fts5(id UNINDEXED,text); DELETE FROM settings WHERE key='searchIndex'",
  );
  assert.equal(new Store(s.dir).candidates("keyboard")[0].id, item.id);
});
