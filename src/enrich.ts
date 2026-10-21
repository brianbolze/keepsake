import type { Enrichment } from "./types.ts";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
export function publicIPv4(ip: string) {
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0)) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19))
  );
}
export async function fetchPage(
  raw: string,
  depth = 0,
  signal = AbortSignal.timeout(15000),
): Promise<Enrichment> {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  )
    throw new Error("Only public HTTPS pages can be enriched");
  if (depth > 4) throw new Error("Too many redirects");
  signal.throwIfAborted();
  const addresses = await Promise.race([
    lookup(url.hostname, { all: true, family: 4 }),
    new Promise<never>((_, reject) =>
      signal.addEventListener(
        "abort",
        () => reject(new Error("Page fetch deadline exceeded")),
        { once: true },
      ),
    ),
  ]);
  signal.throwIfAborted();
  if (!addresses.length || addresses.some((a) => !publicIPv4(a.address)))
    throw new Error("Private network destinations are blocked");
  const response = await new Promise<{ redirect?: string; html?: string }>(
    (resolve, reject) => {
      const req = https.get(
        url,
        {
          signal,
          headers: {
            "User-Agent": "Keepsake/0.1 (personal saved-link index)",
            Accept: "text/html,text/plain",
          },
          lookup: (_h, opts, cb) =>
            opts.all
              ? cb(null, [addresses[0]])
              : cb(null, addresses[0].address, 4),
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
              reject(new Error("Invalid redirect URL"));
            }
            return;
          }
          if (res.statusCode !== 200) {
            res.destroy();
            reject(new Error(`Page returned ${res.statusCode}`));
            return;
          }
          if (!/text\/(html|plain)/.test(res.headers["content-type"] || "")) {
            res.destroy();
            reject(new Error("Page is not HTML or text"));
            return;
          }
          let size = 0;
          const parts: Buffer[] = [];
          res.on("data", (p) => {
            size += p.length;
            if (size > 1_500_000) req.destroy(new Error("Page exceeds 1.5 MB"));
            else parts.push(p);
          });
          res.on("end", () =>
            resolve({ html: Buffer.concat(parts).toString("utf8") }),
          );
        },
      );
      req.setTimeout(10000, () =>
        req.destroy(new Error("Page fetch timed out")),
      );
      req.on("error", reject);
    },
  );
  if (response.redirect) return fetchPage(response.redirect, depth + 1, signal);
  const decode = (s: string) =>
    s
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ");
  const title = decode(
    response.html!.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "",
  )
    .trim()
    .slice(0, 250);
  const html = response.html!.replace(
    /<(script|style|nav|header|footer|svg)\b[^>]*>[\s\S]*?<\/\1>/gi,
    " ",
  );
  const text = decode(html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "))
    .trim()
    .slice(0, 10000);
  return { url: url.href, title, text, fetchedAt: new Date().toISOString() };
}
