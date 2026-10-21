import test from "node:test";
import sharp from "sharp";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { App } from "../src/app.ts";
import { createServer } from "../src/server.ts";

test("local media requires auth and supports seek ranges without traversal", async () => {
  const store = new Store(
    mkdtempSync(join(tmpdir(), "keepsake-media-serving-")),
  );
  const folder = join(store.dir, "media");
  mkdirSync(folder);
  const name = "a".repeat(64) + ".mp4";
  writeFileSync(join(folder, name), "0123456789");
  const port = 48765,
    server = createServer(new App(store), { port });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${port}`,
    headers = { Authorization: "Bearer " + store.getSetting("token") };
  try {
    assert.equal((await fetch(`${base}/media/${name}`)).status, 401);
    const r = await fetch(`${base}/media/${name}`, {
      headers: { ...headers, Range: "bytes=2-5" },
    });
    assert.equal(r.status, 206);
    assert.equal(await r.text(), "2345");
    assert.equal(r.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(r.headers.get("content-type"), "video/mp4");
    const tail = await fetch(`${base}/media/${name}`, {
      headers: { ...headers, Range: "bytes=-3" },
    });
    assert.equal(await tail.text(), "789");
    assert.equal(
      (
        await fetch(`${base}/media/${name}`, {
          headers: { ...headers, Range: "bytes=30-40" },
        })
      ).status,
      416,
    );
    const photo = "b".repeat(64) + ".png";
    await sharp({
      create: { width: 2000, height: 1000, channels: 3, background: "#369" },
    })
      .png()
      .toFile(join(folder, photo));
    const small = await fetch(`${base}/media/${photo}?thumb=1`, { headers });
    assert.equal(small.headers.get("content-type"), "image/webp");
    const meta = await sharp(Buffer.from(await small.arrayBuffer())).metadata();
    assert.deepEqual([meta.width, meta.height], [640, 320]);
    assert.equal(
      (await fetch(`${base}/media/${photo}`, { headers })).headers.get(
        "content-type",
      ),
      "image/png",
    );
    const clip = await fetch(`${base}/media/${name}?thumb=1`, { headers });
    assert.equal(await clip.text(), "0123456789", "videos are served as is");
    assert.equal(
      (await fetch(`${base}/media/%2e%2e%2fkeepsake.sqlite`, { headers }))
        .status,
      404,
    );
  } finally {
    await new Promise((r) => server.close(r));
    store.db.close();
  }
});
test("recapture preserves downloaded media and rejects forged local paths", () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "keepsake-media-store-")));
  const data = {
    url: "https://x.com/test/status/123",
    kind: "bookmark",
    media: [
      {
        type: "image" as const,
        url: "https://pbs.twimg.com/media/example.jpg",
        local: "/etc/passwd",
      },
    ],
  };
  const first = store.capture(data);
  assert.equal(first.media[0].local, undefined);
  first.media[0].local = "/media/" + "a".repeat(64) + ".jpg";
  first.media[0].status = "saved";
  store.put(first);
  store.capture(data);
  assert.equal(store.get(first.id).media[0].status, "saved");
  assert.equal(store.get(first.id).media[0].local, first.media[0].local);
  store.db.close();
});

test("a refreshed link-card preview replaces the old one and keeps post images", () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "keepsake-card-")));
  const card = (id) =>
    `https://pbs.twimg.com/card_img/${id}/abc?format=jpg&name=small`;
  const photo = {
    type: "image" as const,
    url: "https://pbs.twimg.com/media/p.jpg",
  };
  const data = (id) => ({
    url: "https://x.com/test/status/321",
    kind: "bookmark",
    media: [photo, { type: "image" as const, url: card(id) }],
  });
  const first = store.capture(data("100"));
  first.media.forEach((m) => (m.status = "saved"));
  store.put(first);
  assert.equal(store.capture(data("100")).media[1].status, "saved");
  const urls = (item) => item.media.map((m) => m.url);
  assert.deepEqual(urls(store.capture(data("200"))), [
    photo.url,
    card("200").replace("small", "orig"),
  ]);
  assert.equal(
    store.capture({ ...data("200"), media: [photo] }).media.length,
    2,
    "a capture that saw no card keeps the saved one",
  );
  store.db.close();
});

test("a direct source learned after a poster-only capture is processed", () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "keepsake-upgrade-")));
  const data = {
    url: "https://x.com/test/status/456",
    kind: "bookmark",
    media: [
      {
        type: "video" as const,
        poster: "https://pbs.twimg.com/ext_tw_video_thumb/a.jpg",
      },
    ],
  };
  const item = store.capture(data);
  item.media[0].status = "partial";
  store.put(item);
  const updated = store.capture({
    ...data,
    media: [{ ...data.media[0], url: "https://video.twimg.com/demo.mp4" }],
  });
  assert.equal(updated.media[0].status, undefined);
  store.db.close();
});

test("media recovery replaces unresolved placeholders and retries transient errors", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "keepsake-recovery-")));
  const first = store.capture({
    url: "https://x.com/test/status/789",
    kind: "bookmark",
    media: [
      {
        type: "video" as const,
        poster: "https://pbs.twimg.com/ext_tw_video_thumb/old.jpg",
      },
    ],
  });
  let attempts = 0,
    resolves = 0;
  const app = new App(store, undefined, {
    resolvePostMedia: async () => {
      resolves++;
      return [
        {
          type: "video" as const,
          url: "https://video.twimg.com/demo.mp4",
          poster: "https://pbs.twimg.com/ext_tw_video_thumb/new.jpg",
        },
      ];
    },
    downloadMedia: async (media) => {
      attempts++;
      return media.map((m) =>
        attempts === 1
          ? { ...m, status: "error", error: "Temporary network error" }
          : {
              ...m,
              status: "saved",
              local: "/media/" + "b".repeat(64) + ".mp4",
            },
      );
    },
  });
  await app.processMedia();
  let record = store.get(first.id);
  assert.equal(record.media.length, 1);
  assert.equal(
    record.media[0].poster,
    "https://pbs.twimg.com/ext_tw_video_thumb/new.jpg",
  );
  assert.ok(record.mediaRetryAt > Date.now());
  await app.processMedia();
  assert.equal(attempts, 1);
  store.put({ ...record, mediaRetryAt: 0 });
  await app.processMedia();
  assert.equal(attempts, 2);
  assert.equal(resolves, 1);
  assert.equal(store.get(first.id).media[0].status, "saved");
  store.db.close();
});
