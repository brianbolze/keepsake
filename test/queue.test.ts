import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
const code = readFileSync(
  new URL("../extension/dist/background.js", import.meta.url),
  "utf8",
);
const tick = () => new Promise((r) => setTimeout(r, 20));
function setup(fetcher, initial = {}) {
  let handler;
  const state = { token: "a".repeat(64), queue: [], ...initial };
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
      getURL: (_path?: string) => "chrome-extension://" + "a".repeat(32) + "/",
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: {
        addListener(fn) {
          handler = fn;
        },
      },
    },
  };
  vm.runInNewContext(code, {
    chrome,
    fetch: fetcher,
    TextEncoder,
    AbortSignal,
    URL,
    console,
  });
  const send = (item) =>
    new Promise<any>((r) =>
      handler(
        { type: "capture", item },
        { tab: { id: 1 }, url: "https://x.com/home" },
        r,
      ),
    );
  const sync = () =>
    new Promise<any>((r) =>
      handler(
        { type: "sync" },
        { url: chrome.runtime.getURL("popup.html") },
        r,
      ),
    );
  return { state, send, sync };
}
const post = (n) => ({
  url: `https://x.com/person/status/${n}`,
  text: "A useful saved post",
  kind: "bookmark",
  active: true,
  observedAt: new Date().toISOString(),
});
test("offline batching respects encoded size and drains all long saves", async () => {
  const batches = [];
  const queue = Array.from({ length: 50 }, (_, n) => ({
    ...post(n),
    text: "字".repeat(14000),
  }));
  const f = setup(
    async (_url, opts) => {
      const size = new TextEncoder().encode(opts.body).length;
      batches.push(size);
      assert.ok(size <= 220000);
      return { ok: true };
    },
    { queue },
  );
  await f.sync();
  assert.ok(batches.length > 1);
  assert.equal(f.state.queue.length, 0);
});
test("a network stall cannot prevent a second save from reaching durable queue", async () => {
  let finish;
  const f = setup(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  assert.equal((await f.send(post(1))).ok, true);
  await tick();
  const second = await Promise.race([
    f.send(post(2)),
    new Promise((r) => setTimeout(() => r("blocked"), 200)),
  ]);
  assert.notEqual(second, "blocked");
  assert.equal(f.state.queue.length, 2);
  finish({ ok: false, status: 500 });
  await tick();
});
test("an updated unsave is not removed by acknowledgment of an older in-flight save", async () => {
  let finish;
  let calls = 0;
  const f = setup(() => {
    calls++;
    return calls === 1
      ? new Promise((r) => {
          finish = r;
        })
      : Promise.resolve({ ok: false, status: 500 });
  });
  await f.send(post(1));
  await tick();
  await f.send({ ...post(1), active: false });
  finish({ ok: true });
  await tick();
  assert.equal(f.state.queue.length, 1);
  assert.equal(f.state.queue[0].active, false);
});
