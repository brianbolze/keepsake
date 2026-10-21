import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { Store } from "../src/store.ts";
import { App } from "../src/app.ts";
import { createServer } from "../src/server.ts";
test("observed X save travels through extension queue, HTTP, SQLite, Markdown and search", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "keepsake-pipeline-"))),
    app = new App(store),
    port = 47821;
  // Use an isolated port while exercising the extension's exact protocol.
  const actualPort = 48764;
  const server = createServer(app, { port: actualPort });
  await new Promise<void>((r) => server.listen(actualPort, "127.0.0.1", r));
  let receive;
  const state = { token: store.getSetting("token"), queue: [] };
  const chrome = {
    storage: {
      local: {
        get: async (keys) =>
          structuredClone(
            typeof keys === "string"
              ? { [keys]: state[keys] }
              : Object.fromEntries(keys.map((k) => [k, state[k]])),
          ),
        set: async (value) => Object.assign(state, structuredClone(value)),
        setAccessLevel: async () => {},
      },
    },
    action: { setBadgeText: async () => {} },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    runtime: {
      getURL: () => "chrome-extension://" + "b".repeat(32) + "/",
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: {
        addListener(fn) {
          receive = fn;
        },
      },
    },
  };
  vm.runInNewContext(
    readFileSync(
      new URL("../extension/dist/background.js", import.meta.url),
      "utf8",
    ),
    {
      chrome,
      TextEncoder,
      AbortSignal,
      fetch: (url, options) =>
        fetch(url.replace(String(port), String(actualPort)), {
          ...options,
          headers: {
            ...options.headers,
            Origin: "chrome-extension://" + "b".repeat(32),
          },
        }),
    },
  );
  const dom = new JSDOM(
    '<article data-testid="tweet"><a href="/designer/status/987654"><time datetime="2025-11-19T09:30:00Z">Today</time></a><div data-testid="tweetText">A spring animation library for React interfaces</div><button data-testid="removeBookmark"></button></article>',
    { url: "https://x.com/home", runScripts: "outside-only" },
  );
  (dom.window.HTMLElement.prototype as any).__defineGetter__(
    "innerText",
    function () {
      return this.textContent;
    },
  );
  dom.window.chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage: (message, cb) =>
        receive(message, { tab: { id: 1 }, url: "https://x.com/home" }, cb),
    },
  };
  try {
    dom.window.eval(
      readFileSync(
        new URL("../extension/dist/capture.js", import.meta.url),
        "utf8",
      ),
    );
    for (
      let n = 0;
      n < 100 && (store.list().length === 0 || state.queue.length);
      n++
    )
      await new Promise((r) => setTimeout(r, 20));
    assert.equal(store.list().length, 1);
    assert.equal(state.queue.length, 0);
    const item = store.list()[0];
    assert.equal(item.signals.bookmark.active, true);
    assert.equal(item.author, "@designer");
    assert.equal(item.postedAt, "2025-11-19T09:30:00.000Z");
    assert.match(
      readFileSync(join(store.dir, "notes", item.id + ".md"), "utf8"),
      /spring animation/,
    );
    assert.equal((await app.search("React animation")).items[0].id, item.id);
  } finally {
    dom.window.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
test("a Jev outage pauses background classification instead of spending on retries", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "keepsake-outage-"))),
    app = new App(store, "test-key");
  for (let n = 1; n <= 5; n++)
    store.capture({
      url: `https://x.com/example/status/${n}`,
      text: `Illustrative saved post ${n}`,
      kind: "like",
    });
  let calls = 0;
  app.jev.fetcher = async () => {
    calls++;
    throw new Error("network down");
  };
  await app.process();
  await app.process();
  assert.equal(calls, 1);
  const failed = store.list().find((item) => item.error);
  assert.equal(failed.attempts, 1);
  assert.ok(failed.retryAt > Date.now() + 4 * 60 * 1000);
  assert.ok(app.jevPaused());
  app.jevRetryAt = 0;
  await app.process();
  assert.equal(calls, 2);
  assert.ok(app.jevRetryAt - Date.now() > 9 * 60 * 1000);
  store.db.close();
});
