import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const html = readFileSync(
  new URL("../extension/popup.html", import.meta.url),
  "utf8",
);
const script = readFileSync(
  new URL("../extension/dist/popup.js", import.meta.url),
  "utf8",
);
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

test("pairing persists and import activity remains visible after reopening", async () => {
  const state: { queue: { url: string }[]; token?: string } = {
    queue: [{ url: "https://x.com/example/status/1" }],
  };
  const importState = {
    phase: "running",
    label: "Bookmarks",
    scrolls: 12,
    seen: 34,
    reason: "",
    startedAt: "2026-09-23T12:00:00.000Z",
  };
  const makePopup = () => {
    const dom = new JSDOM(html, {
      url: "chrome-extension://example/popup.html",
      runScripts: "outside-only",
    });
    dom.window.chrome = {
      storage: {
        local: {
          get: async () => ({ ...state }),
          set: async (values) => Object.assign(state, values),
          remove: async (keys) => keys.forEach((key) => delete state[key]),
        },
      },
      tabs: {
        query: async () => [{ id: 1 }],
        sendMessage: async () => ({
          collection: "bookmark",
          state: importState,
          postIds: Array.from({ length: 34 }, (_, n) => String(n + 1)),
        }),
      },
      runtime: { sendMessage: async () => ({ ok: true }) },
    };
    (dom.window as any).fetch = async () => ({
      ok: true,
      json: async () => ({ new: 4, existing: 30, pending: 0 }),
    });
    dom.window.eval(script);
    return dom;
  };

  let popup = makePopup();
  await tick();
  assert.equal(popup.window.document.getElementById("setup").hidden, false);
  popup.window.document.querySelector<HTMLInputElement>("#token").value =
    "a".repeat(64);
  popup.window.document.getElementById("pair").click();
  await tick();
  assert.equal(state.token, "a".repeat(64));
  assert.equal(popup.window.document.getElementById("main").hidden, false);
  assert.equal(
    popup.window.document.getElementById("import-count").textContent,
    "4",
  );
  assert.equal(
    popup.window.document.getElementById("import-stats").textContent,
    "34 seen · 30 already in library",
  );
  popup.window.close();

  popup = makePopup();
  await tick();
  assert.equal(popup.window.document.getElementById("setup").hidden, true);
  assert.equal(popup.window.document.getElementById("main").hidden, false);
  assert.equal(
    popup.window.document.getElementById("scroll-count").textContent,
    "12 of 100 scrolls",
  );
  popup.window.document.getElementById("settings-open").click();
  assert.equal(popup.window.document.getElementById("settings").hidden, false);
  popup.window.document.getElementById("replace-open").click();
  popup.window.document.querySelector<HTMLInputElement>(
    "#replacement-token",
  ).value = "b".repeat(64);
  popup.window.document.getElementById("replace-token").click();
  await tick();
  assert.equal(state.token, "b".repeat(64));
  popup.window.document.getElementById("settings-open").click();
  popup.window.document.getElementById("disconnect").click();
  await tick();
  assert.equal(state.token, undefined);
  assert.equal(state.queue.length, 1);
  assert.equal(popup.window.document.getElementById("setup").hidden, false);
  popup.window.close();
});

test("a tab without a Keepsake status reply offers to open X instead of a dead-end import", async () => {
  const dom = new JSDOM(html, {
    url: "chrome-extension://example/popup.html",
    runScripts: "outside-only",
  });
  dom.window.chrome = {
    storage: {
      local: {
        get: async () => ({ token: "a".repeat(64), queue: [] }),
      },
    },
    tabs: {
      query: async () => [{ id: 1 }],
      sendMessage: async () => {
        throw new Error("Content script not ready");
      },
    },
  };
  (dom.window as any).fetch = async () => ({
    ok: true,
    json: async () => ({}),
  });
  dom.window.eval(script);
  await tick();
  const doc = dom.window.document;
  assert.equal(doc.getElementById("open-x").hidden, false);
  assert.equal(doc.getElementById("backfill").hidden, true);
  assert.equal(
    doc.getElementById("library-status-text").textContent,
    "Connected",
  );
  dom.window.close();
});

test("library problems lead the popup without hiding queued saves", async () => {
  const load = (fetch) => {
    const dom = new JSDOM(html, {
      url: "chrome-extension://example/popup.html",
      runScripts: "outside-only",
    });
    dom.window.chrome = {
      storage: {
        local: {
          get: async () => ({
            token: "a".repeat(64),
            queue: [{}, {}],
            error: "Failed to fetch",
          }),
        },
      },
      tabs: {
        query: async () => [{ id: 1 }],
        sendMessage: async () => ({
          collection: "bookmark",
          state: { phase: "idle" },
          postIds: [],
        }),
      },
    };
    dom.window.fetch = fetch;
    dom.window.eval(script);
    return dom;
  };

  let dom = load(async () => {
    throw new TypeError("Failed to fetch");
  });
  await tick();
  let doc = dom.window.document;
  assert.equal(
    doc.getElementById("library-status-text").textContent,
    "Library offline",
  );
  assert.match(
    doc.getElementById("sync-error-text").textContent,
    /2 saves will sync/,
  );
  assert.equal(doc.getElementById("backfill").hidden, false);
  dom.window.close();

  dom = load(async () => ({ ok: false, status: 401 }));
  await tick();
  doc = dom.window.document;
  assert.equal(doc.getElementById("import-title").textContent, "Not syncing");
  assert.match(
    doc.getElementById("import-detail").textContent,
    /2 saves are waiting/,
  );
  assert.equal(doc.getElementById("backfill").hidden, true);
  doc.getElementById("open-settings").click();
  assert.equal(doc.getElementById("settings").hidden, false);
  assert.equal(doc.getElementById("settings-rejected").hidden, false);
  assert.equal(doc.getElementById("replace-form").hidden, false);
  dom.window.close();
});

test("on an X page that isn't Bookmarks or Likes, the popup navigates that tab in place", async () => {
  const updates = [];
  const dom = new JSDOM(html, {
    url: "chrome-extension://example/popup.html",
    runScripts: "outside-only",
  });
  dom.window.chrome = {
    storage: {
      local: { get: async () => ({ token: "a".repeat(64), queue: [] }) },
    },
    tabs: {
      query: async () => [{ id: 7 }],
      sendMessage: async () => ({
        collection: null,
        state: { phase: "idle" },
        postIds: [],
      }),
      update: async (id, props) => updates.push([id, props.url]),
    },
  };
  (dom.window as any).fetch = async () => ({
    ok: true,
    json: async () => ({}),
  });
  // The popup closes itself after navigating; keep the real close for teardown.
  const close = dom.window.close.bind(dom.window);
  dom.window.close = () => {};
  dom.window.eval(script);
  await tick();
  const link = dom.window.document.getElementById("open-x");
  assert.equal(link.textContent, "Go to X Bookmarks");
  link.click();
  await tick();
  assert.deepEqual(updates, [[7, "https://x.com/i/bookmarks"]]);
  close();
});
