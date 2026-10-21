import test from "node:test";
import assert from "node:assert/strict";
import { parsePostMedia, resolvePostMedia } from "../src/resolve-media.ts";
import { LIMITS } from "../src/media.ts";

const video = (height, extra = {}) => ({
  url: `https://video.twimg.com/ext_tw_video/vid/1920x${height}/clip.mp4?tag=12`,
  height,
  protocol: "https",
  ...extra,
});

test("resolver selects the highest-resolution MP4 and an allowed full poster URL", () => {
  const result = parsePostMedia({
    title: "A saved demo",
    formats: [
      video(720),
      video(1080),
      video(2160),
      video(1080, {
        url: "https://video.twimg.com/large.mp4",
        filesize: LIMITS.video + 1,
        tbr: 9999,
      }),
    ],
    thumbnails: [
      { url: "https://pbs.twimg.com/media/a.jpg?name=large", width: 1000 },
      { url: "https://evil.example/poster.jpg", width: 9999 },
    ],
  });
  assert.deepEqual(result, [
    {
      type: "video",
      url: video(2160).url,
      poster: "https://pbs.twimg.com/media/a.jpg?name=large",
      alt: "A saved demo",
    },
  ]);
});

test("resolver rejects unsafe formats, unknown dimensions, HLS, and oversized files", () => {
  for (const url of [
    "http://video.twimg.com/a.mp4",
    "https://video.twimg.com.evil.example/a.mp4",
    "https://video.twimg.com@127.0.0.1/a.mp4",
    "https://video.twimg.com:444/a.mp4",
    "https://video.twimg.com/a.m3u8",
    "file:///tmp/a.mp4",
    "https://video.twimg.com/a.mp4\n",
  ]) {
    assert.deepEqual(parsePostMedia({ formats: [video(720, { url })] }), []);
  }
  assert.deepEqual(
    parsePostMedia({
      formats: [
        { url: "https://video.twimg.com/unknown.mp4" },
        video(720, { filesize: LIMITS.video + 1 }),
        video(720, { protocol: "m3u8_native" }),
        video(720, { vcodec: "none" }),
      ],
    }),
    [],
  );
  assert.equal(
    parsePostMedia({ formats: [video(720, { height: undefined })] })[0].type,
    "video",
  );
});

test("resolver supports multiple videos, deduplicates, and caps results", () => {
  const entries = Array.from({ length: 20 }, (_, i) => ({
    formats: [video(720, { url: `https://video.twimg.com/${i}.mp4` })],
  }));
  assert.equal(
    parsePostMedia({ entries: [entries[0], ...entries] }).length,
    12,
  );
  assert.deepEqual(parsePostMedia(null), []);
});

test("resolver runs only canonical post input with bounded, credential-free arguments", async () => {
  let called = false;
  const result = await resolvePostMedia("https://x.com/designer/status/123", {
    runner: async (binary, args, options) => {
      called = true;
      assert.match(binary, /yt-dlp$/);
      for (const flag of [
        "--ignore-config",
        "--no-playlist",
        "--skip-download",
        "--dump-single-json",
        "--no-warnings",
      ])
        assert.ok(args.includes(flag));
      assert.deepEqual(args.slice(-2), [
        "--",
        "https://x.com/i/web/status/123",
      ]);
      assert.equal(args.includes("--cookies"), false);
      assert.equal(args.includes("--cookies-from-browser"), false);
      assert.equal(options.shell, false);
      assert.equal(options.timeout, 45000);
      assert.equal(options.maxBuffer, 2 * 1024 * 1024);
      assert.equal(options.killSignal, "SIGKILL");
      return { stdout: JSON.stringify({ formats: [video(720)] }) };
    },
  });
  assert.equal(called, true);
  assert.equal(result.length, 1);
  for (const input of [
    null,
    "--exec touch /tmp/owned",
    "https://x.com/a/status/123;echo owned",
    "https://x.com/a/status/123?url=http://localhost",
    "https://x.com@127.0.0.1/a/status/123",
    "http://x.com/a/status/123",
    "https://evil.example/a/status/123",
    "https://x.com/a/status/123\n",
  ]) {
    await assert.rejects(
      resolvePostMedia(input, {
        runner: () => {
          throw new Error("Must not launch");
        },
      }),
      /canonical HTTPS X/,
    );
  }
});

test("resolver reports bounded process and parse failures without leaking stderr", async () => {
  for (const [error, message] of [
    [{ code: "ENOENT" }, /requires yt-dlp/],
    [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, /2 MB/],
    [{ killed: true }, /45 seconds/],
    [{ message: "private stderr" }, /Public X video resolution failed/],
  ]) {
    await assert.rejects(
      resolvePostMedia("https://x.com/i/web/status/123", {
        runner: async () => {
          throw error;
        },
      }),
      message,
    );
  }
  await assert.rejects(
    resolvePostMedia("https://x.com/i/web/status/123", {
      runner: async () => ({ stdout: "not json" }),
    }),
    /invalid JSON/,
  );
  await assert.rejects(
    resolvePostMedia("https://x.com/i/web/status/123", {
      runner: async () => ({ stdout: "a".repeat(2 * 1024 * 1024 + 1) }),
    }),
    /2 MB/,
  );
});
