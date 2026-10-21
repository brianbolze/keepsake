import type { Media } from "./types.ts";
import type { ExecFileOptions } from "node:child_process";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { LIMITS } from "./media.ts";

const execute = promisify(execFile);
// launchd services get a minimal PATH, so check the usual install locations first.
const BINARY =
  process.env.KEEPSAKE_YT_DLP ||
  ["/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp"].find(existsSync) ||
  "yt-dlp";
const MAX_OUTPUT = 2 * 1024 * 1024;

function postUrl(raw: unknown) {
  if (typeof raw !== "string")
    throw new Error("A canonical HTTPS X post URL is required");
  const match = raw.match(
    /^https:\/\/x\.com\/(?:[A-Za-z0-9_]{1,15}\/status|i\/web\/status)\/([0-9]{1,30})$/,
  );
  if (!match) throw new Error("A canonical HTTPS X post URL is required");
  return `https://x.com/i/web/status/${match[1]}`;
}

function mediaUrl(raw: unknown, host: string, mp4 = false) {
  if (
    typeof raw !== "string" ||
    raw.length > 8192 ||
    /[\u0000-\u0020\u007f]/.test(raw)
  )
    return null;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.hostname !== host ||
      url.port ||
      url.username ||
      url.password ||
      url.hash
    )
      return null;
    if (mp4 && !/\.mp4$/i.test(url.pathname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function height(format: any) {
  if (Number.isFinite(format.height) && format.height > 0) return format.height;
  const dimensions = new URL(format.url).pathname.match(/\/(\d+)x(\d+)\//);
  return dimensions ? Number(dimensions[2]) : 0;
}

export function parsePostMedia(info: unknown) {
  const results: Media[] = [],
    seen = new Set();
  function visit(entry: any, depth = 0) {
    if (
      !entry ||
      typeof entry !== "object" ||
      depth > 3 ||
      results.length >= 12
    )
      return;
    if (Array.isArray(entry.entries)) {
      for (const child of entry.entries.slice(0, 100)) visit(child, depth + 1);
      return;
    }
    const candidates = [
      ...(Array.isArray(entry.formats) ? entry.formats : []),
      entry,
    ]
      .filter((format) => format && typeof format === "object")
      .map((format) => ({
        ...format,
        url: mediaUrl(format.url, "video.twimg.com", true),
      }))
      .filter((format) => {
        if (
          !format.url ||
          format.vcodec === "none" ||
          (format.protocol && format.protocol !== "https")
        )
          return false;
        const size = format.filesize ?? format.filesize_approx;
        return (
          height(format) > 0 &&
          (size == null ||
            (Number.isFinite(size) && size >= 0 && size <= LIMITS.video))
        );
      })
      .sort(
        (a, b) =>
          height(b) - height(a) || (Number(b.tbr) || 0) - (Number(a.tbr) || 0),
      );
    const best = candidates[0];
    if (!best || seen.has(best.url)) return;
    const thumbnails = [
      ...(Array.isArray(entry.thumbnails) ? entry.thumbnails : []),
      { url: entry.thumbnail },
    ]
      .filter((thumbnail) => thumbnail && typeof thumbnail === "object")
      .map((thumbnail) => ({
        ...thumbnail,
        url: mediaUrl(thumbnail.url, "pbs.twimg.com"),
      }))
      .filter((thumbnail) => thumbnail.url)
      .sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0));
    const poster = thumbnails[0]?.url;
    const alt =
      typeof entry.title === "string" ? entry.title.slice(0, 500) : undefined;
    seen.add(best.url);
    results.push({
      type: "video",
      url: best.url,
      ...(poster ? { poster } : {}),
      ...(alt ? { alt } : {}),
    });
  }
  visit(info);
  return results;
}

export async function resolvePostMedia(
  raw: string,
  {
    runner = execute,
  }: {
    runner?: (
      file: string,
      args: string[],
      options: ExecFileOptions & { encoding: "utf8" },
    ) => Promise<{ stdout: string }>;
  } = {},
) {
  const url = postUrl(raw);
  let stdout;
  try {
    ({ stdout } = await runner(
      BINARY,
      [
        "--ignore-config",
        "--no-plugin-dirs",
        "--no-remote-components",
        "--no-js-runtimes",
        "--no-cache-dir",
        "--no-playlist",
        "--skip-download",
        "--dump-single-json",
        "--no-warnings",
        "--socket-timeout",
        "10",
        "--retries",
        "0",
        "--extractor-retries",
        "0",
        "--use-extractors",
        "Twitter",
        "--",
        url,
      ],
      {
        encoding: "utf8",
        timeout: 45000,
        maxBuffer: MAX_OUTPUT,
        killSignal: "SIGKILL",
        shell: false,
        windowsHide: true,
      },
    ));
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error(
        "Video resolver requires yt-dlp on PATH (or set KEEPSAKE_YT_DLP)",
      );
    if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
      throw new Error("Video resolver exceeded its 2 MB output limit");
    if (error.killed || error.signal === "SIGKILL")
      throw new Error("Video resolver timed out after 45 seconds");
    throw new Error(
      "Public X video resolution failed; the post may be unavailable or require sign-in",
    );
  }
  if (typeof stdout !== "string" || Buffer.byteLength(stdout) > MAX_OUTPUT)
    throw new Error("Video resolver exceeded its 2 MB output limit");
  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new Error("Video resolver returned invalid JSON");
  }
  return parsePostMedia(info);
}
