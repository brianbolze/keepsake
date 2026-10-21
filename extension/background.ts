import type { StorageState } from "./types.ts";
import type { CaptureInput } from "../src/types.ts";
const ENDPOINT = "http://127.0.0.1:47821";
let serial: Promise<unknown> = Promise.resolve(),
  draining = false;
function lock<T>(fn: () => Promise<T>): Promise<T> {
  const task = serial.then(fn);
  serial = task.catch(() => {});
  return task;
}
async function badge() {
  const { queue = [] } = await chrome.storage.local.get<StorageState>("queue");
  await chrome.action.setBadgeText({
    text: queue.length ? String(queue.length) : "",
  });
}
async function flush() {
  if (draining) return;
  draining = true;
  try {
    for (let round = 0; round < 20; round++) {
      const { token, queue = [] } = await lock(() =>
        chrome.storage.local.get<StorageState>(["token", "queue"]),
      );
      if (!token || !queue.length) break;
      const batch: CaptureInput[] = [];
      for (const item of queue.slice(0, 50)) {
        if (
          new TextEncoder().encode(JSON.stringify({ items: [...batch, item] }))
            .length > 220000
        )
          break;
        batch.push(item);
      }
      if (!batch.length)
        throw new Error(
          "A queued save exceeds the local size limit. Export extension storage before clearing it.",
        );
      const res = await fetch(ENDPOINT + "/api/capture", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
        body: JSON.stringify({ items: batch }),
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok)
        throw new Error(
          res.status === 401
            ? "Pair with your local library first."
            : `Local library returned ${res.status}`,
        );
      const delivered = new Set(batch.map((i) => JSON.stringify(i)));
      await lock(async () => {
        const { queue: current = [] } =
          await chrome.storage.local.get<StorageState>("queue");
        await chrome.storage.local.set({
          queue: current.filter((i) => !delivered.has(JSON.stringify(i))),
          lastSync: new Date().toISOString(),
          error: null,
        });
      });
    }
  } catch (e) {
    await chrome.storage.local.set({ error: e.message });
  } finally {
    draining = false;
    await badge();
  }
}
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("sync", { periodInMinutes: 1 });
  chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("sync", { periodInMinutes: 1 });
  void flush();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "sync") void flush();
});
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  const trustedPopup = sender.url?.startsWith(chrome.runtime.getURL(""));
  if (
    msg.type === "capture" &&
    sender.tab &&
    /^https:\/\/(x|twitter)\.com\//.test(sender.url || "")
  ) {
    lock(async () => {
      const { queue = [] } =
        await chrome.storage.local.get<StorageState>("queue");
      const item = msg.item as CaptureInput;
      if (
        !item ||
        !/^https:\/\/(x|twitter)\.com\/[^\s]+\/status\/\d+/.test(item.url) ||
        !["like", "bookmark"].includes(item.kind || "")
      )
        throw new Error("Invalid capture");
      const clean: CaptureInput &
        Required<Pick<CaptureInput, "media" | "folders">> = {
        url: item.url,
        text: String(item.text || "").slice(0, 14000),
        title: String(item.title || "").slice(0, 250),
        author: String(item.author || "").slice(0, 120),
        postedAt:
          typeof item.postedAt === "string"
            ? item.postedAt.slice(0, 80)
            : undefined,
        links: Array.isArray(item.links)
          ? item.links
              .filter((u: unknown) => typeof u === "string" && u.length < 2000)
              .slice(0, 10)
          : [],
        folders: Array.isArray(item.folders)
          ? item.folders
              .slice(0, 100)
              .filter((f: { id?: string }) => /^\d+$/.test(f?.id || ""))
              .map((f) => ({
                id: f.id,
                name: String(f.name || "").slice(0, 120),
              }))
          : [],
        media: Array.isArray(item.media)
          ? item.media.slice(0, 12).map((m) => ({
              type: m.type === "video" ? "video" : "image",
              url: typeof m.url === "string" ? m.url.slice(0, 2000) : undefined,
              poster:
                typeof m.poster === "string"
                  ? m.poster.slice(0, 2000)
                  : undefined,
              alt: String(m.alt || "").slice(0, 500),
            }))
          : [],
        kind: item.kind,
        active: item.active !== false,
        observedAt: item.observedAt,
      };
      const at = queue.findIndex(
        (i) => i.url === clean.url && i.kind === clean.kind,
      );
      if (at >= 0) {
        clean.postedAt ||= queue[at].postedAt;
        clean.folders = [
          ...new Map(
            [...(queue[at].folders || []), ...clean.folders].map((f) => [
              f.id,
              {
                ...f,
                name:
                  f.name ||
                  queue[at].folders?.find((previous) => previous.id === f.id)
                    ?.name ||
                  "",
              },
            ]),
          ).values(),
        ].slice(0, 100);
        clean.media = [
          ...new Map(
            [...(queue[at].media || []), ...clean.media].map((m) => [
              m.poster || m.url || m.type,
              {
                ...m,
                url:
                  m.url ||
                  queue[at].media?.find(
                    (old) =>
                      (m.poster && m.poster === old.poster) ||
                      (m.url && m.url === old.url),
                  )?.url,
              },
            ]),
          ).values(),
        ].slice(0, 12);
        queue[at] = clean;
      } else queue.push(clean);
      await chrome.storage.local.set({ queue });
      await badge();
    })
      .then(() => {
        respond({ ok: true });
        void flush();
      })
      .catch((e) => respond({ error: e.message }));
    return true;
  }
  if (msg.type === "sync" && trustedPopup) {
    flush()
      .then(() => respond({ ok: true }))
      .catch((e) => respond({ error: e.message }));
    return true;
  }
});
