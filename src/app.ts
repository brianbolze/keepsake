import type { SearchOptions, Item } from "./types.ts";
import type { Store } from "./store.ts";
import { downloadMedia, normalizeMedia, pruneMedia } from "./media.ts";
import { resolvePostMedia } from "./resolve-media.ts";
import { Jev } from "./jev.ts";
import { fetchPage } from "./enrich.ts";
import { effectiveTags } from "./store.ts";
import { matches } from "../lib/library-view.ts";
const MINUTE = 60 * 1000,
  HOUR = 60 * MINUTE;
export class App {
  store: Store;
  jev: Jev;
  downloadMedia: typeof downloadMedia;
  resolvePostMedia: typeof resolvePostMedia;
  working: boolean;
  mediaWorking = false;
  scopeWorking = false;
  scopeError: string | null = null;
  jevFailures: number;
  jevRetryAt: number;
  constructor(
    store: Store,
    key: string | undefined = undefined,
    mediaTools: {
      downloadMedia?: typeof downloadMedia;
      resolvePostMedia?: typeof resolvePostMedia;
    } = {},
  ) {
    this.downloadMedia = mediaTools.downloadMedia || downloadMedia;
    this.resolvePostMedia = mediaTools.resolvePostMedia || resolvePostMedia;
    this.store = store;
    this.jev = new Jev(store, key);
    this.working = false;
    this.jevFailures = 0;
    this.jevRetryAt = 0;
  }
  // Failed Jev calls keep their budget reservation, so an outage must not become a retry loop.
  jevPaused() {
    return this.jevRetryAt > Date.now();
  }
  jevFailed() {
    this.jevFailures++;
    this.jevRetryAt =
      Date.now() + Math.min(6 * HOUR, 5 * MINUTE * 2 ** (this.jevFailures - 1));
  }
  jevSucceeded() {
    this.jevFailures = 0;
    this.jevRetryAt = 0;
  }
  async processMedia(limit = 50) {
    if (this.mediaWorking) return;
    this.mediaWorking = true;
    try {
      const pending = this.store
        .list()
        .filter(
          (i) =>
            (!i.mediaRetryAt || i.mediaRetryAt < Date.now()) &&
            (i.mediaResolvePending ||
              (i.media || []).some(
                (m) =>
                  !m.status ||
                  (m.error &&
                    ((m.url && !m.local) || (m.poster && !m.posterLocal)) &&
                    (i.mediaAttempts || 0) < 3),
              )),
        )
        .slice(0, limit);
      for (const snapshot of pending) {
        let media = snapshot.media || [];
        let resolutionError,
          resolvedVideos = false;
        if (
          snapshot.mediaResolvePending ||
          media.some((m) => m.type === "video" && !m.status)
        ) {
          try {
            const resolved = normalizeMedia(
              await this.resolvePostMedia(snapshot.url),
            );
            if (resolved.length) {
              resolvedVideos = true;
              media = [
                ...media.filter((m) => m.type !== "video"),
                ...resolved,
              ].slice(0, 12);
            } else
              resolutionError =
                "No public downloadable video found. Re-import the X page for images and previews.";
          } catch (e) {
            resolutionError = e.message;
          }
        }
        try {
          const saved = await this.downloadMedia(media, this.store.dir);
          const latest = this.store.get(snapshot.id);
          if (latest) {
            const replaced = new Set(
              resolvedVideos
                ? (snapshot.media || [])
                    .filter((m) => m.type === "video")
                    .map((m) => JSON.stringify(m))
                : [],
            );
            const merged = (latest.media || []).filter(
              (m) => !replaced.has(JSON.stringify(m)),
            );
            for (const m of saved) {
              const at = merged.findIndex(
                (old) =>
                  (m.poster && old.poster === m.poster) ||
                  (m.url && old.url === m.url),
              );
              if (at >= 0) merged[at] = { ...merged[at], ...m };
              else merged.push(m);
            }
            this.store.put({
              ...latest,
              media: merged.filter((m) => m.url || m.poster).slice(0, 12),
              mediaResolvePending: false,
              mediaError: resolutionError,
              mediaAttempts: (snapshot.mediaAttempts || 0) + 1,
              mediaRetryAt: saved.some((m) => m.error)
                ? Date.now() + 300000
                : undefined,
            });
          }
        } catch (e) {
          const latest = this.store.get(snapshot.id);
          if (latest)
            this.store.put({
              ...latest,
              mediaError: e.message,
              mediaRetryAt: Date.now() + 300000,
            });
        }
      }
      const items = this.store.list();
      if (
        !items.some(
          (i) => i.mediaResolvePending || i.media?.some((m) => !m.status),
        )
      )
        await pruneMedia(
          this.store.dir,
          items.flatMap((i) =>
            (i.media || []).flatMap((m) => [m.local, m.posterLocal]),
          ),
        ).catch(() => {});
    } finally {
      this.mediaWorking = false;
    }
  }
  async process(limit = 20) {
    void this.processMedia();
    void this.processScopes().catch((error) => {
      this.scopeError = error.message;
    });
    if (this.working) return { busy: true };
    this.working = true;
    let done = 0;
    try {
      for (const item of this.store
        .list()
        .filter(
          (i) => !i.classification && (!i.retryAt || i.retryAt < Date.now()),
        )
        .slice(0, limit)) {
        if (!this.jev.key || this.jevPaused()) break;
        try {
          const link = item.links.find(
            (u) => !["x.com", "twitter.com"].includes(new URL(u).hostname),
          );
          if (link && !item.enrichment) {
            try {
              item.enrichment = await fetchPage(link);
            } catch (e) {
              item.enrichmentError = e.message;
            }
          }
          item.classification = await this.jev.classify(item);
          item.tags = Object.entries(item.classification.topics)
            .filter(([, p]) => p >= 0.7)
            .map(([t]) => t);
          if (item.scopeSource !== "manual") {
            item.scope = item.classification.scope;
            item.scopeSource = "jev";
            item.scopeConfidence = item.classification.scopeConfidence;
            item.scopeAt = new Date().toISOString();
          }
          delete item.error;
          delete item.retryAt;
          delete item.attempts;
          this.jevSucceeded();
          done++;
        } catch (e) {
          item.error = e.message;
          item.attempts = (item.attempts || 0) + 1;
          item.retryAt =
            Date.now() +
            Math.min(24 * HOUR, 5 * MINUTE * 2 ** (item.attempts - 1));
          this.jevFailed();
        }
        // A user may toggle a save while enrichment is in flight. Merge with the newest captured record.
        const latest = this.store.get(item.id);
        if (latest?.text === item.text)
          this.store.put({
            ...latest,
            enrichment: item.enrichment,
            enrichmentError: item.enrichmentError,
            classification: item.classification,
            tags: item.tags,
            error: item.error,
            retryAt: item.retryAt,
            attempts: item.attempts,
            ...(latest.scopeSource === "manual"
              ? {}
              : {
                  scope: item.scope,
                  scopeSource: item.scopeSource,
                  scopeConfidence: item.scopeConfidence,
                  scopeAt: item.scopeAt,
                }),
          });
      }
    } finally {
      this.working = false;
    }
    return { processed: done };
  }
  async processScopes(limit = 20) {
    if (this.scopeWorking || !this.jev.key || this.jevPaused())
      return { processed: 0 };
    this.scopeWorking = true;
    try {
      const pending = this.store
        .list()
        .filter(
          (item) =>
            item.classification &&
            !item.scopeSource &&
            Object.values(item.signals).some((signal) => signal?.active),
        )
        .slice(0, Math.max(1, Math.min(20, limit)));
      if (!pending.length) return { processed: 0 };
      let classified;
      try {
        classified = await this.jev.classifyScopes(pending);
      } catch (error) {
        this.jevFailed();
        throw error;
      }
      this.jevSucceeded();
      let processed = 0;
      for (const result of classified) {
        const snapshot = pending.find((item) => item.id === result.id);
        const latest = this.store.get(result.id);
        if (!latest || latest.scopeSource || latest.text !== snapshot?.text)
          continue;
        this.store.put({
          ...latest,
          scope: result.scope,
          scopeSource: "jev",
          scopeConfidence: result.scopeConfidence,
          scopeAt: new Date().toISOString(),
        });
        processed++;
      }
      this.scopeError = null;
      return { processed };
    } finally {
      this.scopeWorking = false;
    }
  }
  // `filters` takes the library's own filter names: kind, tag, category, folder, media, scope, added (days).
  async search(
    query: string,
    {
      semantic = false,
      deep = false,
      limit = 12,
      includeRemoved = false,
      ...filters
    }: SearchOptions = {},
  ) {
    const start = Date.now();
    query = String(query || "").slice(0, 500);
    const filter = (i: Item) =>
      (includeRemoved || Object.values(i.signals).some((s) => s?.active)) &&
      matches({ ...i, tags: effectiveTags(i) }, filters);
    const keyword = this.store.candidates(query).filter(filter);
    let items = keyword;
    let mode = "keyword",
      warning,
      candidates = items.length;
    const eligible = this.store.list().filter(filter);
    if (semantic && query) {
      try {
        let pool;
        if (deep || eligible.length <= 28) pool = eligible;
        else {
          const affinity = await this.jev.queryTopics(query);
          const semanticCandidates = [...eligible]
            .sort((a, b) => {
              const score = (i: Item) =>
                Math.max(
                  0,
                  ...Object.entries(i.classification?.topics || {}).map(
                    ([t, p]) => p * (affinity[t] || 0),
                  ),
                );
              return score(b) - score(a);
            })
            .slice(0, 24);
          pool = [
            ...new Map(
              [
                ...items.slice(0, 20),
                ...semanticCandidates,
                ...eligible.slice(0, 4),
              ].map((i) => [i.id, i]),
            ).values(),
          ];
        }
        candidates = pool.length;
        const ranked: (Item & { relevance: number })[] = [];
        for (let n = 0; n < pool.length; n += 24)
          ranked.push(...(await this.jev.rank(query, pool.slice(n, n + 24))));
        items = ranked
          .sort((a, b) => b.relevance - a.relevance)
          .filter((i) => i.relevance >= 0.35);
        mode = "jev";
        if (candidates < eligible.length)
          warning = `Jev ranked ${candidates} candidates from ${eligible.length} saved resources using keywords and inferred topics. Use --deep in the CLI or deep:true in MCP to scan every item.`;
      } catch (e) {
        warning = e.message;
        items = keyword;
      }
    }
    return {
      query,
      mode,
      warning,
      ms: Date.now() - start,
      total: items.length,
      coverage: {
        candidates,
        library: eligible.length,
        complete: mode === "jev" ? candidates === eligible.length : undefined,
      },
      items: items.slice(0, Math.max(1, Math.min(2000, Number(limit) || 12))),
    };
  }
}
