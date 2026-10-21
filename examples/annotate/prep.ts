import type { Item } from "../../src/types.ts";
interface PreparedMedia {
  n: number;
  type: string;
  alt?: string;
  duplicateOf?: number;
  file?: string;
  error?: string;
}
// Build a run folder for the annotation pass: one folder per save with item.json, downscaled images and
// a 4-frame contact sheet per video, plus shard lists for parallel agents.
// Usage: node examples/annotate/prep.ts [--all] [--ids=a,b] [--shard-size=30]
// Default selection: active, non-demo saves that have no description yet.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DATA = resolve(process.env.KEEPSAKE_DATA_DIR || join(root, "data"));
const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const all = process.argv.includes("--all");
const only = arg("ids")?.split(",");
const shardSize = Number(arg("shard-size") || 30);

const db = new DatabaseSync(join(DATA, "keepsake.sqlite"), { readOnly: true });
const items = db
  .prepare("select body from items")
  .all()
  .map((r) => JSON.parse(r.body as string) as Item)
  .filter(
    (i) =>
      i.source !== "demo" && Object.values(i.signals).some((s) => s?.active),
  )
  .filter((i) => (only ? only.includes(i.id) : all || !i.description));

const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
const run = join(DATA, "annotate", stamp);
for (const d of ["items", "shards", "proposals"])
  mkdirSync(join(run, d), { recursive: true });
writeFileSync(join(run, "notes.md"), "");
writeFileSync(join(run, "newtags.txt"), "");

const sh = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
const probe = (f: string) => {
  const j = JSON.parse(
    sh("ffprobe", [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      f,
    ]).toString(),
  );
  const v = j.streams.find(
    (s: { codec_type: string }) => s.codec_type === "video",
  );
  return {
    duration: +(+j.format.duration || 0).toFixed(1),
    width: v?.width,
    height: v?.height,
    hasAudio: j.streams.some(
      (s: { codec_type: string }) => s.codec_type === "audio",
    ),
  };
};
// 16x16 grayscale signature: catches the same picture saved at several sizes.
const signature = (f: string) =>
  sh("ffmpeg", [
    "-v",
    "error",
    "-i",
    f,
    "-vf",
    "scale=16:16,format=gray",
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-",
  ]);
const near = (a: Buffer, b: Buffer) => {
  let d = 0;
  for (let i = 0; i < 256; i++) d += Math.abs(a[i] - b[i]);
  return d / 256 < 6;
};
const even = (x: number) => Math.max(2, Math.round(x / 2) * 2);
const decode = (t: string) =>
  t
    .replace(/&#x([0-9a-f]+);/gi, (_: string, h: string) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_: string, d: string) => String.fromCodePoint(+d))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
const fixUrls = (t: string) => t.replace(/(https?:\/\/)\s*\n\s*/g, "$1");

const weights: [number, string][] = [];
for (const item of items) {
  const dir = join(run, "items", item.id);
  mkdirSync(dir, { recursive: true });
  const media: PreparedMedia[] = [];
  const seen: { n: number; sig: Buffer }[] = [];
  let weight = 0.5;
  for (const [k, m] of (item.media || []).entries()) {
    const entry: PreparedMedia = { n: k + 1, type: m.type, alt: m.alt || "" };
    const src = m.local ? join(DATA, m.local.replace(/^\//, "")) : null;
    const out = join(dir, `m${k + 1}.jpg`);
    try {
      if (!src || !existsSync(src)) throw new Error("file missing");
      if (m.type === "video") {
        const p = probe(src);
        const wide = p.width / p.height > 1.3;
        const cw = wide ? 640 : 480;
        const ch = even(Math.min(640, (cw * p.height) / p.width));
        Object.assign(entry, p, {
          note: wide
            ? "contact sheet: 4 frames in a 2x2 grid, left-to-right then top-to-bottom, in time order"
            : "contact sheet: 4 frames in one row, left-to-right, in time order",
        });
        const times =
          p.duration > 0.5
            ? [0.08, 0.36, 0.64, 0.92].map((f) => (f * p.duration).toFixed(2))
            : ["0", "0", "0", "0"];
        const graph =
          times.map((_, i) => `[${i}:v]scale=${cw}:${ch}[c${i}]`).join(";") +
          `;[c0][c1][c2][c3]xstack=inputs=4:layout=${wide ? "0_0|w0_0|0_h0|w0_h0" : "0_0|w0_0|w0+w1_0|w0+w1+w2_0"}[o]`;
        sh("ffmpeg", [
          "-y",
          "-v",
          "error",
          ...times.flatMap((t) => ["-ss", t, "-i", src]),
          "-filter_complex",
          graph,
          "-map",
          "[o]",
          "-frames:v",
          "1",
          "-q:v",
          "4",
          out,
        ]);
        weight += 1.2;
      } else {
        const sig = signature(src);
        const dup = seen.find((x) => near(x.sig, sig));
        if (dup) {
          entry.duplicateOf = dup.n;
          media.push(entry);
          continue;
        }
        seen.push({ n: k + 1, sig });
        sh("ffmpeg", [
          "-y",
          "-v",
          "error",
          "-i",
          src,
          "-vf",
          "scale='min(1280,iw)':-2",
          "-frames:v",
          "1",
          "-q:v",
          "4",
          out,
        ]);
        weight += 1;
      }
      entry.file = `m${k + 1}.jpg`;
    } catch (e) {
      entry.error = String(e.stderr || e.message).slice(0, 160);
    }
    media.push(entry);
  }
  writeFileSync(
    join(dir, "item.json"),
    JSON.stringify(
      {
        id: item.id,
        url: item.url,
        author: item.author,
        postedAt: item.postedAt || null,
        title: item.title,
        text: fixUrls(item.text).slice(0, 1500),
        links: item.links,
        linkedPage: item.enrichment
          ? {
              title: item.enrichment.title,
              excerpt: decode(item.enrichment.text).slice(0, 500),
            }
          : null,
        folders: (item.folders || []).map((f) => f.name || f.id),
        inferredTags: item.tags,
        category: item.classification?.category || null,
        scope: item.scope || null,
        media,
      },
      null,
      1,
    ),
  );
  weights.push([weight, item.id]);
}

// Balance shards by media count so agents finish at about the same time.
const count = Math.max(1, Math.ceil(items.length / shardSize));
const shards = Array.from({ length: count }, () => ({
  ids: [] as string[],
  total: 0,
}));
for (const [w, id] of weights.sort((a, b) => b[0] - a[0])) {
  const s = shards.reduce((a, b) => (b.total < a.total ? b : a));
  s.ids.push(id);
  s.total += w;
}
const names: string[] = [];
if (items.length)
  shards.forEach((s, k) => {
    const name = `shard-${String(k + 1).padStart(2, "0")}`;
    names.push(name);
    writeFileSync(
      join(run, "shards", name + ".txt"),
      s.ids.sort().join("\n") + "\n",
    );
  });
console.log(
  JSON.stringify({ runDir: run, items: items.length, shards: names }, null, 2),
);
