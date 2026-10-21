import type { Media } from "./types.ts";
import type { IncomingMessage } from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, lstat, unlink, rename } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import { publicIPv4 } from "./enrich.ts";

// Generous guards against a runaway download, not storage budgets.
export const QUOTA = 200 * 1024 ** 3;
export const LIMITS = { image: 100 * 1024 ** 2, video: 4 * 1024 ** 3 };
const DEADLINES = { image: 60000, video: 30 * 60000 };
const FORMATS: Record<Media["type"], Record<string, string>> = {
  image: {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
  },
  video: { "video/mp4": "mp4", "video/webm": "webm" },
};
function mediaURL(raw: unknown, type: Media["type"]) {
  if (typeof raw !== "string" || raw.length > 3000)
    throw new Error("Invalid media URL");
  const url = new URL(raw);
  const host = type === "image" ? "pbs.twimg.com" : "video.twimg.com";
  const authority = raw.match(/^https:\/\/([^/?#]+)/i)?.[1];
  if (
    url.protocol !== "https:" ||
    authority?.toLowerCase() !== host ||
    url.hostname !== host ||
    url.username ||
    url.password ||
    url.port
  )
    throw new Error(
      "Media must use the approved X HTTPS host without credentials or ports",
    );
  url.hash = "";
  // X serves each post image at several sizes from one URL; always keep the original.
  if (
    type === "image" &&
    url.searchParams.has("name") &&
    /^\/(media|card_img|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//.test(
      url.pathname,
    )
  )
    url.searchParams.set("name", "orig");
  return url.href;
}
// X reissues a link-card preview under a new ID over time, so a card is replaced rather than accumulated.
export function cardId(media: Media) {
  return media?.type === "image"
    ? media.url?.match(/^https:\/\/pbs\.twimg\.com\/card_img\/(\d+)\//)?.[1]
    : undefined;
}
export function normalizeMedia(raw: unknown): Media[] {
  if (!Array.isArray(raw)) return [];
  const output: Media[] = [],
    seen = new Set();
  for (const entry of raw.slice(0, 48)) {
    if (!entry || !["image", "video"].includes(entry.type)) continue;
    const item: Media = { type: entry.type };
    try {
      item.url = mediaURL(entry.url, entry.type);
    } catch {}
    try {
      item.poster = mediaURL(entry.poster, "image");
    } catch {}
    if (entry.type === "image" && !item.url) continue;
    if (typeof entry.alt === "string" && entry.alt)
      item.alt = entry.alt.slice(0, 1000);
    const key = JSON.stringify([item.type, item.url, item.poster]);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
    if (output.length === 12) break;
  }
  return output;
}
async function resolvePublic(hostname: string, signal: AbortSignal) {
  signal.throwIfAborted();
  let abort;
  try {
    const addresses = await Promise.race([
      lookup(hostname, { all: true, family: 4 }),
      new Promise<never>((_, reject) => {
        abort = () => reject(new Error("Media download deadline exceeded"));
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
    signal.throwIfAborted();
    if (!addresses.length || addresses.some((a) => !publicIPv4(a.address)))
      throw new Error("Private media destinations are blocked");
    return addresses[0];
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}
async function responseFor(
  raw: string,
  type: Media["type"],
  signal: AbortSignal,
  depth = 0,
): Promise<IncomingMessage> {
  if (depth > 4) throw new Error("Too many media redirects");
  const url = new URL(mediaURL(raw, type));
  const address = await resolvePublic(url.hostname, signal);
  const response = await new Promise<{
    redirect?: string;
    stream?: IncomingMessage;
  }>((resolve, reject) => {
    const req = https.get(
      url,
      {
        signal,
        headers: {
          "User-Agent": "Keepsake/0.1",
          Accept: Object.keys(FORMATS[type]).join(", "),
        },
        lookup: (_host, opts, cb) =>
          opts.all ? cb(null, [address]) : cb(null, address.address, 4),
      },
      (res) => {
        res.on("error", reject);
        if (
          res.statusCode! >= 300 &&
          res.statusCode! < 400 &&
          res.headers.location
        ) {
          res.destroy();
          try {
            resolve({ redirect: new URL(res.headers.location, url).href });
          } catch {
            reject(new Error("Invalid media redirect"));
          }
        } else if (res.statusCode !== 200) {
          res.destroy();
          reject(new Error(`Media returned ${res.statusCode}`));
        } else {
          resolve({ stream: res });
        }
      },
    );
    req.on("error", reject);
  });
  return response.redirect
    ? responseFor(response.redirect, type, signal, depth + 1)
    : response.stream!;
}
async function diskUsage(folder: string) {
  let used = 0;
  for (const name of await readdir(folder)) {
    const stat = await lstat(join(folder, name));
    if (!stat.isFile()) throw new Error("Unexpected entry in media directory");
    used += stat.size;
  }
  return used;
}
async function saveURL(raw: string, type: Media["type"], dir: string) {
  const url = mediaURL(raw, type),
    folder = join(dir, "media");
  const hash = createHash("sha256").update(url).digest("hex");
  const gate = new DatabaseSync(join(dir, "media-quota.sqlite"));
  let locked = false,
    temporary,
    stream;
  try {
    // A separate SQLite lock enforces the disk cap across CLI and daemon processes, and releases on crash.
    gate.exec("PRAGMA busy_timeout=100; BEGIN IMMEDIATE");
    locked = true;
    for (const ext of Object.values(FORMATS[type])) {
      const name = hash + "." + ext;
      try {
        const stat = await lstat(join(folder, name));
        if (!stat.isFile() || stat.size > LIMITS[type] || stat.size === 0)
          throw new Error("Invalid cached media file");
        return "/media/" + name;
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    const available = QUOTA - (await diskUsage(folder));
    if (available <= 0) throw new Error("The media quota is full");
    const signal = AbortSignal.timeout(DEADLINES[type]);
    stream = await responseFor(url, type, signal);
    const mime = String(stream.headers["content-type"] || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const ext = Object.hasOwn(FORMATS[type], mime)
      ? FORMATS[type][mime]
      : undefined;
    if (!ext) throw new Error("Unsupported media content type");
    const maximum = Math.min(LIMITS[type], available);
    const declared = stream.headers["content-length"];
    if (
      declared !== undefined &&
      (!/^\d+$/.test(declared) || Number(declared) > maximum)
    )
      throw new Error("Media exceeds the size or disk limit");
    let bytes = 0;
    const bound = new Transform({
      transform(chunk, _encoding, cb) {
        bytes += chunk.length;
        if (bytes > maximum)
          cb(new Error("Media exceeds the size or disk limit"));
        else cb(null, chunk);
      },
    });
    const name = hash + "." + ext;
    temporary = join(folder, "." + hash + "." + randomUUID() + ".part");
    await pipeline(
      stream,
      bound,
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    if (!bytes) throw new Error("Media response is empty");
    await rename(temporary, join(folder, name));
    temporary = undefined;
    return "/media/" + name;
  } finally {
    stream?.destroy();
    if (temporary) await unlink(temporary).catch(() => {});
    if (locked) gate.exec("ROLLBACK");
    gate.close();
  }
}
export async function downloadMedia(media: Media[], dir: string) {
  const items = normalizeMedia(media);
  await mkdir(join(dir, "media"), { recursive: true, mode: 0o700 });
  const output: Media[] = [];
  for (const item of items) {
    const result = { ...item },
      errors: string[] = [];
    for (const [source, target, type] of [
      ["url", "local", item.type],
      ["poster", "posterLocal", "image"],
    ] as const) {
      if (!item[source]) continue;
      try {
        result[target] = await saveURL(item[source]!, type, dir);
      } catch (e) {
        errors.push(
          e.code === "ERR_SQLITE_ERROR" && /locked/.test(e.message)
            ? "Media downloader is busy; retry later"
            : e.message,
        );
      }
    }
    result.status = result.local
      ? "saved"
      : result.posterLocal
        ? "partial"
        : errors.length
          ? "error"
          : "unavailable";
    if (errors.length) result.error = errors.join("; ").slice(0, 500);
    else if (!item.url)
      result.error =
        "Video bytes were not available; open the original post to play it";
    output.push(result);
  }
  return output;
}
// Small WebP copies for the library grid, made on first request and cached in data/thumbs.
const thumbnails = new Map();
export function thumbnail(dir: string, name: string) {
  const [hash, ext] = name.split(".");
  if (!Object.values(FORMATS.image).includes(ext))
    return Promise.reject(new Error("Not an image"));
  const folder = join(dir, "thumbs"),
    file = join(folder, hash + ".webp");
  if (!thumbnails.has(file))
    thumbnails.set(
      file,
      (async () => {
        try {
          if ((await lstat(file)).size) return file;
        } catch {}
        await mkdir(folder, { recursive: true, mode: 0o700 });
        const temporary = join(folder, "." + hash + "." + randomUUID());
        try {
          await sharp(join(dir, "media", name))
            .rotate()
            .resize({ width: 640, withoutEnlargement: true })
            .webp({ quality: 80 })
            .toFile(temporary);
          await rename(temporary, file);
        } catch (e) {
          await unlink(temporary).catch(() => {});
          throw e;
        }
        return file;
      })().finally(() => thumbnails.delete(file)),
    );
  return thumbnails.get(file);
}
// Deletes downloaded files no record points to, such as thumbnails replaced by originals.
export async function pruneMedia(
  dir: string,
  referenced: (string | undefined)[],
  minAge = 3600000,
) {
  const folder = join(dir, "media"),
    keep = new Set(referenced);
  const gate = new DatabaseSync(join(dir, "media-quota.sqlite"));
  let locked = false,
    removed = 0;
  try {
    gate.exec("PRAGMA busy_timeout=100; BEGIN IMMEDIATE");
    locked = true;
    for (const name of await readdir(folder)) {
      if (!/^[a-f0-9]{64}\.[a-z0-9]+$/.test(name) || keep.has("/media/" + name))
        continue;
      // A fresh file may belong to a download whose record is not written yet.
      if (Date.now() - (await lstat(join(folder, name))).mtimeMs < minAge)
        continue;
      await unlink(join(folder, name));
      removed++;
    }
    const hashes = new Set(
      (await readdir(folder)).map((name) => name.split(".")[0]),
    );
    for (const name of await readdir(join(dir, "thumbs")).catch(() => []))
      if (!hashes.has(name.split(".")[0]))
        await unlink(join(dir, "thumbs", name));
  } finally {
    if (locked) gate.exec("ROLLBACK");
    gate.close();
  }
  return removed;
}
