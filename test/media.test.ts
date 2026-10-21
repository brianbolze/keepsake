import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { mkdtemp, rm, readFile, readdir, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeMedia,
  downloadMedia,
  pruneMedia,
  LIMITS,
  QUOTA,
} from "../src/media.ts";

const image = "https://pbs.twimg.com/media/example.jpg";
const video = "https://video.twimg.com/ext_tw_video/example.mp4";

test("media normalization retains only bounded X-hosted descriptors", () => {
  const invalid = [
    "http://pbs.twimg.com/a",
    "https://pbs.twimg.com:443/a",
    "https://pbs.twimg.com:8080/a",
    "https://user@pbs.twimg.com/a",
    "https://pbs.twimg.com.evil.test/a",
    "https://video.twimg.com/a",
    "file:///a",
    "data:image/png,a",
    "https://127.0.0.1/a",
  ];
  assert.deepEqual(
    normalizeMedia(invalid.map((url) => ({ type: "image", url }))),
    [],
  );
  assert.deepEqual(
    normalizeMedia([
      { type: "image", url: image, local: "/etc/passwd", alt: "hello" },
      { type: "video", url: "blob:https://x.com/123", poster: image },
    ]),
    [
      { type: "image", url: image, alt: "hello" },
      { type: "video", poster: image },
    ],
  );
  assert.equal(
    normalizeMedia(
      Array.from({ length: 100 }, (_, n) => ({
        type: "image",
        url: image + "?n=" + n,
      })),
    ).length,
    12,
  );
  assert.equal(
    normalizeMedia([
      { type: "image", url: image },
      { type: "image", url: image },
    ]).length,
    1,
  );
  assert.deepEqual(
    normalizeMedia([
      { type: "image", url: image + "?format=jpg&name=small" },
      { type: "image", url: image + "?format=jpg&name=900x900" },
      {
        type: "image",
        url: "https://pbs.twimg.com/card_img/1/a?format=jpg&name=small",
      },
    ]).map((m) => m.url),
    [
      image + "?format=jpg&name=orig",
      "https://pbs.twimg.com/card_img/1/a?format=jpg&name=orig",
    ],
    "post images and link-card previews resolve to one original each",
  );
});

test("media downloads enforce redirects, MIME, byte limits, quota, pinning and cache", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "keepsake-media-"));
  let reply: {
      body?: Buffer[];
      status?: number;
      headers?: Record<string, string>;
    } = {},
    address = "8.8.8.8",
    requests = 0;
  const originalLookup = dns.lookup;
  dns.lookup = (async () => [
    { address, family: 4 },
  ]) as unknown as typeof dns.lookup;
  syncBuiltinESMExports();
  const network = t.mock.method(https, "get", (_url, options, callback) => {
    requests++;
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.headers.Authorization, undefined);
    options.lookup("pbs.twimg.com", {}, (error, ip) => {
      assert.equal(error, null);
      assert.equal(ip, address);
    });
    const req = new EventEmitter();
    queueMicrotask(() => {
      const res = Object.assign(
        Readable.from(reply.body || [Buffer.from("image fixture")]),
        { statusCode: 200, headers: {} },
      );
      res.statusCode = reply.status || 200;
      res.headers = reply.headers || { "content-type": "image/jpeg" };
      callback(res);
    });
    return req;
  });
  const capture = (suffix = "", type: "image" | "video" = "image") =>
    downloadMedia(
      [{ type, url: (type === "image" ? image : video) + suffix }],
      dir,
    );
  try {
    let result = (await capture())[0];
    assert.equal(result.status, "saved");
    assert.match(result.local, /^\/media\/[a-f0-9]{64}\.jpg$/);
    assert.equal(
      (await readFile(join(dir, result.local))).toString(),
      "image fixture",
    );
    const count = requests;
    await capture();
    assert.equal(requests, count, "cache avoids network");

    address = "127.0.0.1";
    result = (await capture("?private"))[0];
    assert.match(result.error, /Private/);
    assert.equal(requests, count);
    address = "8.8.8.8";
    reply = {
      status: 302,
      headers: { location: "https://evil.example/file.jpg" },
    };
    result = (await capture("?redirect"))[0];
    assert.match(result.error, /approved X/);
    assert.equal(requests, count + 1);
    reply = { status: 302, headers: { location: "http://[" } };
    result = (await capture("?broken"))[0];
    assert.match(result.error, /Invalid media redirect/);
    reply = { headers: { "content-type": "image/svg+xml" } };
    result = (await capture("?svg"))[0];
    assert.match(result.error, /content type/);
    reply = { headers: { "content-type": "constructor" } };
    result = (await capture("?prototype"))[0];
    assert.match(result.error, /content type/);
    reply = {
      headers: {
        "content-type": "image/png",
        "content-length": String(LIMITS.image + 1),
      },
    };
    result = (await capture("?declared"))[0];
    assert.match(result.error, /size or disk/);
    reply = { body: [Buffer.alloc(LIMITS.image), Buffer.from("extra")] };
    result = (await capture("?stream"))[0];
    assert.match(result.error, /size or disk/);
    assert.ok(
      (await readdir(join(dir, "media"))).every(
        (name) => !name.endsWith(".part"),
      ),
      "failed downloads leave no partial files",
    );
    reply = {
      headers: {
        "content-type": "video/mp4",
        "content-length": String(LIMITS.video + 1),
      },
    };
    result = (await capture("?too-big", "video"))[0];
    assert.match(result.error, /size or disk/);
    reply = {};
    result = (await downloadMedia([{ type: "video", poster: image }], dir))[0];
    assert.equal(result.status, "partial");
    assert.ok(result.posterLocal);
    assert.equal(result.local, undefined);
    assert.equal(await pruneMedia(dir, []), 0, "fresh files are kept");
    assert.equal(await pruneMedia(dir, [result.posterLocal], 0), 0);
    assert.equal(await pruneMedia(dir, [], 0), 1);
    assert.deepEqual(await readdir(join(dir, "media")), []);
    const otherDownloader = new DatabaseSync(join(dir, "media-quota.sqlite"));
    otherDownloader.exec("BEGIN IMMEDIATE");
    try {
      const before = requests;
      result = (await capture("?concurrent"))[0];
      assert.match(result.error, /busy/);
      assert.equal(
        requests,
        before,
        "another process cannot bypass quota serialization",
      );
    } finally {
      otherDownloader.exec("ROLLBACK");
      otherDownloader.close();
    }
    const filler = await open(join(dir, "media", "quota-fixture"), "w");
    await filler.truncate(QUOTA);
    await filler.close();
    const before = requests;
    result = (await capture("?quota"))[0];
    assert.match(result.error, /quota/);
    assert.equal(requests, before);
  } finally {
    network.mock.restore();
    dns.lookup = originalLookup;
    syncBuiltinESMExports();
    await rm(dir, { recursive: true, force: true });
  }
});
