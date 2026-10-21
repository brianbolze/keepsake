import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "../src/server.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { App } from "../src/app.ts";
import { browse, groupItems } from "../lib/library-view.ts";

const make = () => new Store(mkdtempSync(join(tmpdir(), "keepsake-scope-")));
const capture = (store, n = 1) =>
  store.capture({
    url: `https://x.com/example/status/${n}`,
    kind: "bookmark",
    title: `Example ${n}`,
    text: "A useful software component",
    author: "@example",
    links: [],
  });

test("Jev scope backfill preserves a user's correction across recapture and later inference", async () => {
  const store = make();
  const first = capture(store);
  store.put({ ...first, classification: { category: "library" } });
  const app = new App(store, "test");
  app.jev.classifyScopes = async (items) =>
    items.map(({ id }) => ({ id, scope: "work", scopeConfidence: 0.85 }));
  assert.equal((await app.processScopes()).processed, 1);
  assert.equal(store.get(first.id).scope, "work");
  store.setScope(first.id, "personal");
  assert.equal((await app.processScopes()).processed, 0);
  capture(store);
  assert.equal(store.get(first.id).scope, "personal");
  assert.equal(store.get(first.id).scopeSource, "manual");
  const changed = store.capture({
    url: first.url,
    kind: "bookmark",
    title: "Example 1",
    text: "A changed text with more detail",
    links: [],
  });
  assert.equal(changed.scope, "personal");
  assert.equal(changed.scopeSource, "manual");
});

test("work and personal filters and groups keep unlabeled saves visible", () => {
  const store = make();
  const work = capture(store, 1);
  const personal = capture(store, 2);
  const unsorted = capture(store, 3);
  store.setScope(work.id, "work");
  store.setScope(personal.id, "personal");
  const items = [
    store.get(work.id),
    store.get(personal.id),
    store.get(unsorted.id),
  ];
  assert.deepEqual(
    browse(items, { scope: "personal" }).map((i) => i.id),
    [personal.id],
  );
  assert.deepEqual(
    browse(items, { scope: "unsorted" }).map((i) => i.id),
    [unsorted.id],
  );
  assert.deepEqual(
    new Set(groupItems(items, "scope").map((g) => g.name)),
    new Set(["Work", "Personal/Social", "Unsorted"]),
  );
});

test("clearing scope through the API survives backup restore as a manual Unsorted label", async () => {
  const store = make();
  const item = capture(store);
  store.setScope(item.id, "work");
  const server = createServer(new App(store));
  const handler = server.listeners("request")[0];
  const request = (body: object) =>
    new Promise<{ code: number; body: { scope?: string | null } }>(
      (resolve) => {
        let code = 0;
        const req = Object.assign(
          Readable.from([Buffer.from(JSON.stringify(body))]),
          {
            method: "POST",
            url: `/api/items/${item.id}/scope`,
            headers: {
              host: "127.0.0.1:47821",
              authorization: `Bearer ${store.getSetting("token")}`,
              "content-type": "application/json",
            },
          },
        );
        const res = {
          setHeader() {},
          writeHead(status: number) {
            code = status;
          },
          end(text: string) {
            resolve({ code, body: JSON.parse(text) });
          },
        };
        handler(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse,
        );
      },
    );
  const result = await request({ scope: null });
  assert.equal(result.code, 200);
  assert.equal(result.body.scope, null);
  assert.equal((await request({})).code, 400);
  assert.equal((await request({ scope: "invalid" })).code, 400);
  const restored = make().restore(
    JSON.parse(JSON.stringify(store.get(item.id))),
  );
  assert.equal(restored.scope, null);
  assert.equal(restored.scopeSource, "manual");
});
