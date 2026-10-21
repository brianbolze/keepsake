import type { App } from "./app.ts";
import type { Item, CaptureInput, Scope, Filters } from "./types.ts";
import http from "node:http";
import { createReadStream, statSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { effectiveTags } from "./store.ts";
import { thumbnail } from "./media.ts";
import { filterKeys } from "../lib/library-view.ts";
// What the library needs to draw a card; search results use the same shape.
const summary = (item: Item) => ({
  id: item.id,
  url: item.url,
  title: item.title,
  text: item.text.slice(0, 600),
  author: item.author,
  links: item.links,
  media: (item.media || []).map((media) => ({
    type: media.type,
    local: media.local,
    posterLocal: media.posterLocal,
    alt: media.alt,
  })),
  classification: item.classification
    ? { category: item.classification.category }
    : null,
  scope: item.scope || null,
  scopeSource: item.scopeSource || null,
  tags: effectiveTags(item),
  description: item.description?.text || null,
  folders: item.folders || [],
  signals: item.signals,
  source: item.source,
  createdAt: item.createdAt,
  postedAt: item.postedAt,
  relevance: item.relevance,
  matched: item.matched,
});
function same(a: unknown, b: string) {
  return (
    typeof a === "string" &&
    /^[a-f0-9]{64}$/.test(a) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
export function createServer(
  app: App,
  {
    port = 47821,
    nextHandler,
    remoteHost,
  }: {
    port?: number;
    nextHandler?: (
      req: http.IncomingMessage,
      res: http.ServerResponse,
    ) => Promise<unknown>;
    remoteHost?: string;
  } = {},
) {
  const token = app.store.getSetting("token")!;
  const local = `http://127.0.0.1:${port}`;
  // Optional tailnet name served by `tailscale serve`; the socket stays on loopback.
  const remote = remoteHost ? `https://${remoteHost}` : null;
  return http.createServer(async (req, res) => {
    const reply = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const isRemote = !!remote && req.headers.host === remoteHost;
    if (req.headers.host !== `127.0.0.1:${port}` && !isRemote)
      return reply(403, { error: "Invalid host" });
    const origin = req.headers.origin,
      extension = /^chrome-extension:\/\/[a-p]{32}$/.test(origin || "");
    if (origin && origin !== local && origin !== remote && !extension)
      return reply(403, { error: "Origin denied" });
    if (extension) {
      res.setHeader("Access-Control-Allow-Origin", origin!);
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization",
      );
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.writeHead(204);
      return res.end();
    }
    let url;
    try {
      url = new URL(req.url!, local);
    } catch {
      return reply(400, { error: "Invalid request URL" });
    }
    if (
      nextHandler &&
      !url.pathname.startsWith("/api/") &&
      !url.pathname.startsWith("/media/")
    ) {
      if (url.pathname === "/")
        res.setHeader(
          "Set-Cookie",
          `keepsake=${token}; HttpOnly; SameSite=Strict; Path=/`,
        );
      const nonce = randomBytes(16).toString("base64");
      const csp = `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${process.env.KEEPSAKE_DEV === "1" ? " 'unsafe-eval'" : ""}; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
      req.headers["content-security-policy"] = csp;
      req.headers["x-nonce"] = nonce;
      res.setHeader("Content-Security-Policy", csp);
      return nextHandler(req, res).catch(() => {
        if (!res.headersSent) reply(500, { error: "Library unavailable" });
        else res.destroy();
      });
    }
    const bearer = req.headers.authorization?.replace(/^Bearer /, "");
    const cookie = req.headers.cookie
      ?.split("; ")
      .find((s) => s.startsWith("keepsake="))
      ?.slice(9);
    if (!(same(bearer, token) || (!extension && same(cookie, token))))
      return reply(401, { error: "Pair Keepsake with the local token first" });
    if (!["GET", "HEAD", "POST"].includes(req.method || ""))
      return reply(405, { error: "Method not allowed" });
    if (
      req.method === "POST" &&
      !bearer &&
      (origin !== local || req.headers["sec-fetch-site"] === "cross-site")
    )
      return reply(403, { error: "Local origin required" });
    try {
      if (
        ["GET", "HEAD"].includes(req.method || "") &&
        url.pathname.startsWith("/media/")
      ) {
        const name = url.pathname.slice(7);
        if (!/^[a-f0-9]{64}\.(jpg|jpeg|png|webp|gif|avif|mp4|webm)$/.test(name))
          return reply(404, { error: "Not found" });
        let file = join(app.store.dir, "media", name);
        let size;
        try {
          size = statSync(file).size;
        } catch {
          return reply(404, { error: "Media not downloaded" });
        }
        let ext = name.split(".").pop();
        // The grid asks for a small copy; anything that cannot be resized is served as is.
        if (url.searchParams.get("thumb") === "1")
          try {
            file = await thumbnail(app.store.dir, name);
            size = statSync(file).size;
            ext = "webp";
          } catch {}
        const mime = {
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          png: "image/png",
          webp: "image/webp",
          gif: "image/gif",
          avif: "image/avif",
          mp4: "video/mp4",
          webm: "video/webm",
        }[ext as "jpg"];
        let start = 0,
          end = size - 1;
        if (req.headers.range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          if (!match || (!match[1] && !match[2])) {
            res.setHeader("Content-Range", `bytes */${size}`);
            return reply(416, { error: "Invalid range" });
          }
          if (!match[1]) start = Math.max(0, size - Number(match[2]));
          else {
            start = Number(match[1]);
            if (match[2]) end = Math.min(end, Number(match[2]));
          }
          if (
            start > end ||
            start >= size ||
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end)
          ) {
            res.setHeader("Content-Range", `bytes */${size}`);
            return reply(416, { error: "Invalid range" });
          }
          res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
        }
        res.writeHead(req.headers.range ? 206 : 200, {
          "Content-Type": mime,
          "Content-Length": end - start + 1,
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, max-age=31536000, immutable",
        });
        if (req.method === "HEAD") return res.end();
        const stream = createReadStream(file, { start, end });
        stream.on("error", () => res.destroy());
        res.on("close", () => stream.destroy());
        return stream.pipe(res);
      }
      let body: CaptureInput & {
        items?: CaptureInput[];
        scope?: Scope;
        startedAt?: string;
        postIds?: string[];
      } = {} as CaptureInput;
      if (req.method === "POST") {
        if (!req.headers["content-type"]?.startsWith("application/json"))
          return reply(415, { error: "JSON required" });
        let length = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 250000)
            return reply(413, { error: "Payload too large" });
          chunks.push(chunk);
        }
        body = JSON.parse(Buffer.concat(chunks).toString());
      }
      if (req.method === "GET" && url.pathname === "/api/status")
        return reply(200, {
          ...app.store.stats(),
          jev: !!app.jev.key,
          working: app.working,
          mediaWorking: !!app.mediaWorking,
          mediaPending: app.store
            .list()
            .filter(
              (i) => i.mediaResolvePending || i.media?.some((m) => !m.status),
            ).length,
          mediaSaved: app.store
            .list()
            .flatMap((i) => i.media || [])
            .filter((m) => m.local).length,
          scopePending: app.store
            .list()
            .filter(
              (item) =>
                item.classification &&
                !item.scopeSource &&
                Object.values(item.signals).some((signal) => signal.active),
            ).length,
          scopeWorking: !!app.scopeWorking,
          scopeError: app.scopeError || null,
          budget: 20,
          extensionLastSeen: app.store.getSetting("extensionLastSeen") || null,
        });
      if (req.method === "GET" && url.pathname === "/api/pair")
        return isRemote
          ? reply(403, { error: "Pair from this Mac" })
          : reply(200, { token });
      if (req.method === "GET" && url.pathname === "/api/library")
        return reply(200, {
          items: app.store
            .list()
            .filter((item) =>
              Object.values(item.signals).some((signal) => signal.active),
            )
            .map(summary),
        });
      if (req.method === "GET" && url.pathname === "/api/search") {
        const filters: Filters = {};
        for (const key of filterKeys)
          if (url.searchParams.get(key))
            filters[key as keyof Omit<Filters, "now">] =
              url.searchParams.get(key)!;
        const result = await app.search(url.searchParams.get("q") || "", {
          ...filters,
          semantic: url.searchParams.get("semantic") === "1",
          limit: Number(url.searchParams.get("limit") || 50),
          includeRemoved: url.searchParams.get("removed") === "1",
        });
        return reply(200, { ...result, items: result.items.map(summary) });
      }
      if (req.method === "GET" && url.pathname === "/api/export")
        return reply(200, { version: 1, items: app.store.list() });
      if (req.method === "GET" && url.pathname.startsWith("/api/items/")) {
        const item = app.store.get(url.pathname.split("/").pop()!);
        return reply(
          item ? 200 : 404,
          item
            ? { ...item, tags: effectiveTags(item), inferredTags: item.tags }
            : { error: "Not found" },
        );
      }
      const scopeRoute = /^\/api\/items\/([a-f0-9]{20})\/scope$/.exec(
        url.pathname,
      );
      if (req.method === "POST" && scopeRoute) {
        if (!["work", "personal", null].includes(body.scope as Scope))
          return reply(400, { error: "Invalid scope" });
        const item = app.store.setScope(scopeRoute[1], body.scope!);
        return reply(
          item ? 200 : 404,
          item
            ? { id: item.id, scope: item.scope, scopeSource: item.scopeSource }
            : { error: "Not found" },
        );
      }
      if (req.method === "POST" && url.pathname === "/api/import/check") {
        const startedAt = Date.parse(body.startedAt || "");
        if (
          !Number.isFinite(startedAt) ||
          !Array.isArray(body.postIds) ||
          body.postIds.length > 5000 ||
          body.postIds.some(
            (id) => typeof id !== "string" || !/^\d{1,30}$/.test(id),
          )
        )
          return reply(400, { error: "Invalid import check" });
        const counts = { new: 0, existing: 0, pending: 0 };
        for (const postId of new Set(body.postIds)) {
          const id = createHash("sha256")
            .update(`https://x.com/i/web/status/${postId}`)
            .digest("hex")
            .slice(0, 20);
          const item = app.store.get(id!);
          if (!item) counts.pending++;
          else if (Date.parse(item.createdAt) >= startedAt) counts.new++;
          else counts.existing++;
        }
        return reply(200, counts);
      }
      if (req.method === "POST" && url.pathname === "/api/capture") {
        const input = Array.isArray(body.items) ? body.items : [body];
        if (input.length > 100) throw new Error("At most 100 items per batch");
        const ids = input.map((i) => app.store.capture(i).id);
        if (extension)
          app.store.setSetting("extensionLastSeen", new Date().toISOString());
        reply(200, { saved: ids.length, ids });
        void app.process();
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/media/recover") {
        let queued = 0;
        for (const item of app.store.list()) {
          if (
            item.source === "demo" ||
            !/^https:\/\/x\.com\/i\/web\/status\/\d+$/.test(item.url) ||
            !Object.values(item.signals).some((s) => s.active)
          )
            continue;
          if (item.media?.some((m) => m.type === "video" && m.local)) continue;
          app.store.put({
            ...item,
            mediaResolvePending: true,
            mediaAttempts: 0,
            mediaRetryAt: undefined,
          });
          queued++;
        }
        reply(202, { queued });
        void app.processMedia();
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/process") {
        reply(202, { started: true });
        void app.process();
        return;
      }
      return reply(404, { error: "Not found" });
    } catch (e) {
      reply(400, { error: e.message });
    }
  });
}
