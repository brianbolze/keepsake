import type { ImportState } from "./types.ts";
import type { Media, CaptureInput } from "../src/types.ts";
(() => {
  const sent = new Map();
  let scheduled = false,
    backfill = false;
  const pending = new Map();
  let importRun = 0;
  let importSeen = new Set<string>();
  // Posts on screen are captured as the page loads, before Import is clicked.
  let pagePath = location.pathname,
    pageSince = new Date().toISOString();
  let importState: ImportState = {
    phase: "idle",
    label: "",
    path: "",
    scrolls: 0,
    seen: 0,
    reason: "",
    startedAt: null,
    updatedAt: null,
  };
  function collection() {
    const path = location.pathname;
    if (/^\/i\/bookmarks(?:\/|$)/.test(path)) return "bookmark";
    if (/^\/i\/history\/bookmarks(?:\/|$)/.test(path)) return "bookmark";
    if (path.endsWith("/likes")) return "like";
    if (!/^\/i\/history(?:\/|$)/.test(path)) return null;
    const selected = document.querySelector(
      '[role="tab"][aria-selected="true"]',
    );
    const label = selected?.textContent?.trim().toLowerCase();
    if (label?.includes("bookmark")) return "bookmark";
    if (label?.includes("like")) return "like";
    return "history";
  }
  function folders() {
    const match = location.pathname.match(
      /^\/i\/(?:history\/)?bookmarks\/(\d+)/,
    );
    if (!match) return [];
    const name = document
      .querySelector('[role="tab"][aria-selected="true"]')
      ?.textContent?.trim();
    return [{ id: match[1], name: (name || "").slice(0, 120) }];
  }
  function mediaFrom(article: Element) {
    const media: Media[] = [];
    const valid = (raw: string | undefined, host: string) => {
      try {
        const u = new URL(raw!);
        return u.protocol === "https:" &&
          u.hostname === host &&
          !u.username &&
          !u.password &&
          !u.port
          ? u.href
          : undefined;
      } catch {
        return undefined;
      }
    };
    for (const video of article.querySelectorAll("video")) {
      const url = valid(
        video.currentSrc || video.src || video.querySelector("source")?.src,
        "video.twimg.com",
      );
      const poster = valid(video.poster, "pbs.twimg.com");
      media.push({ type: "video", url, poster, alt: "Video from saved post" });
    }
    for (const img of article.querySelectorAll<HTMLImageElement>(
      'img[src*="pbs.twimg.com"]',
    )) {
      const url = valid(img.currentSrc || img.src, "pbs.twimg.com");
      if (
        !url ||
        /\/(profile_images|profile_banners|emoji)\//.test(new URL(url).pathname)
      )
        continue;
      if (
        !/\/(media|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb|card_img)\//.test(
          new URL(url).pathname,
        )
      )
        continue;
      if (media.some((m) => m.poster === url)) continue;
      if (/video_thumb/.test(new URL(url).pathname)) {
        media.push({
          type: "video",
          poster: url,
          alt: img.alt || "Video from saved post",
        });
      } else
        media.push({
          type: "image",
          url,
          alt: img.alt || "Image from saved post",
        });
    }
    return [
      ...new Map(media.map((m) => [m.url || m.poster || m.type, m])).values(),
    ].slice(0, 12);
  }
  function extract(article: Element) {
    const time = article.querySelector("time");
    const anchor = time?.closest('a[href*="/status/"]');
    if (!anchor) return null;
    const url = new URL(anchor.getAttribute("href")!, location.origin);
    const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
    if (!match) return null;
    const tweet = article.querySelector<HTMLElement>(
      '[data-testid="tweetText"]',
    );
    const card = article.querySelector<HTMLElement>(
      '[data-testid="card.wrapper"]',
    );
    const text = [tweet?.innerText, card?.innerText].filter(Boolean).join("\n");
    const links = [
      ...article.querySelectorAll<HTMLAnchorElement>("a[href]"),
    ].flatMap((a) => {
      try {
        const u = new URL(a.href);
        if (
          u.protocol !== "https:" ||
          ["x.com", "twitter.com"].includes(u.hostname)
        )
          return [];
        const title = a.getAttribute("title");
        return [title?.startsWith("https://") ? title : u.href];
      } catch {
        return [];
      }
    });
    return {
      url: `https://x.com/${match[1]}/status/${match[2]}`,
      text,
      title: text.split("\n")[0].slice(0, 110) || `Post by @${match[1]}`,
      author: "@" + match[1],
      postedAt: time!.dateTime || undefined,
      links: [...new Set(links)],
      folders: folders(),
      media: mediaFrom(article),
    };
  }
  function send(item: CaptureInput, kind: string, active: boolean) {
    const key = item.url + ":" + kind;
    const signature = JSON.stringify([
      active,
      item.text,
      item.author,
      item.postedAt,
      item.links,
      item.folders,
      item.media,
    ]);
    if (sent.get(key) === signature) return;
    const observedAt = new Date().toISOString();
    sent.set(key, signature);
    chrome.runtime.sendMessage(
      { type: "capture", item: { ...item, kind, active, observedAt } },
      (response) => {
        if (chrome.runtime.lastError || !response?.ok) sent.delete(key);
      },
    );
  }
  function scan() {
    scheduled = false;
    if (location.pathname !== pagePath) {
      pagePath = location.pathname;
      pageSince = new Date().toISOString();
    }
    const visible = new Set();
    document
      .querySelectorAll('article[data-testid="tweet"]')
      .forEach((article) => {
        const item = extract(article);
        if (!item) return;
        visible.add(item.url);
        if (backfill && location.pathname === importState.path) {
          importSeen.add(item.url);
          importState.seen = importSeen.size;
          importState.updatedAt = Date.now();
        }
        for (const [kind, on, off] of [
          ["like", "unlike", "like"],
          ["bookmark", "removeBookmark", "bookmark"],
        ]) {
          const active = !!article.querySelector(`[data-testid="${on}"]`),
            inactive = !!article.querySelector(`[data-testid="${off}"]`);
          const key = item.url + ":" + kind,
            intent = pending.get(key);
          if (intent) {
            if (Date.now() - intent.at > 15000) pending.delete(key);
            else if (
              (intent.active && active) ||
              (!intent.active && inactive)
            ) {
              send(item, kind, intent.active);
              pending.delete(key);
            }
            continue;
          }
          if (active) send(item, kind, true);
          else if (inactive && sent.has(key)) send(item, kind, false);
        }
        // Bookmarks pages establish membership even when X hides the bookmark button.
        if (
          collection() === "bookmark" &&
          !article.querySelector('[data-testid="bookmark"]') &&
          !pending.has(item.url + ":bookmark")
        )
          send(item, "bookmark", true);
      });
    for (const [key, intent] of pending) {
      if (Date.now() - intent.at > 15000 || intent.path !== location.pathname) {
        pending.delete(key);
        continue;
      }
      if (
        !intent.active &&
        intent.kind === "bookmark" &&
        intent.collection === "bookmark" &&
        collection() === "bookmark" &&
        !visible.has(intent.item.url) &&
        Date.now() - intent.at >= 1000
      ) {
        send(intent.item, intent.kind, false);
        pending.delete(key);
      }
    }
  }
  function lastPostUrl() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    return articles.length
      ? articles[articles.length - 1]
          .querySelector("time")
          ?.closest('a[href*="/status/"]')
          ?.getAttribute("href")
      : null;
  }
  function nextFrame() {
    return new Promise<void>((resolve) =>
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(() => resolve())
        : setTimeout(resolve, 16),
    );
  }
  document.addEventListener(
    "click",
    (event) => {
      if (!event.isTrusted) return;
      const button = (event.target as Element).closest(
        '[data-testid="like"],[data-testid="unlike"],[data-testid="bookmark"],[data-testid="removeBookmark"]',
      );
      const article = button?.closest('article[data-testid="tweet"]');
      if (!article) return;
      const item = extract(article);
      if (!item) return;
      const test = (button as HTMLElement).dataset.testid || "",
        kind = ["like", "unlike"].includes(test) ? "like" : "bookmark";
      pending.set(item.url + ":" + kind, {
        active: test === "like" || test === "bookmark",
        at: Date.now(),
        item,
        kind,
        path: location.pathname,
        collection: collection(),
      });
      setTimeout(scan, 1500);
    },
    true,
  );
  new MutationObserver(() => {
    if (!scheduled) {
      scheduled = true;
      setTimeout(scan, 400);
    }
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "data-testid",
      "aria-pressed",
      "aria-selected",
      "src",
      "srcset",
      "poster",
    ],
  });
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg.type === "backfillStatus") {
      respond({
        collection: collection(),
        state: importState,
        postIds: [...importSeen]
          .map((url) => url.match(/\/status\/(\d+)$/)?.[1])
          .filter(Boolean),
      });
      return;
    }
    if (msg.type === "backfill") {
      if (backfill) {
        backfill = false;
        importRun++;
        importState = {
          ...importState,
          phase: "paused",
          reason: "paused",
          updatedAt: Date.now(),
        };
        respond({ message: "Import paused.", state: importState });
        return;
      }
      const startingCollection = collection();
      if (!startingCollection) {
        respond({
          message: "Open your X bookmarks or your own Likes page first.",
        });
        return;
      }
      backfill = true;
      const run = ++importRun;
      const startingPath = location.pathname;
      const selected = document
        .querySelector('[role="tab"][aria-selected="true"]')
        ?.textContent?.trim();
      importSeen = new Set();
      importState = {
        phase: "running",
        label:
          folders().length && selected
            ? selected.slice(0, 120)
            : startingCollection === "like"
              ? "Likes"
              : startingCollection === "bookmark"
                ? "Bookmarks"
                : "History",
        path: startingPath,
        scrolls: 0,
        seen: 0,
        reason: "",
        startedAt: new Date().toISOString(),
        since: location.pathname === pagePath ? pageSince : undefined,
        updatedAt: Date.now(),
      };
      scan();
      respond({
        message: "Importing as X loads your saves.",
        state: importState,
      });
      (async () => {
        let previous: string | null = null,
          stalled = 0,
          reason = "limit";
        for (let n = 0; n < 100 && backfill && run === importRun; n++) {
          if (
            location.pathname !== startingPath ||
            collection() !== startingCollection
          ) {
            reason = "page-changed";
            break;
          }
          scan();
          const lastUrl = lastPostUrl();
          const progress = `${window.scrollY}:${lastUrl}`;
          stalled = progress === previous ? stalled + 1 : 0;
          if (stalled >= 5) {
            reason = "end";
            break;
          }
          previous = progress;
          const beforeY = window.scrollY;
          window.scrollBy(0, Math.max(innerHeight * 0.8, 500));
          importState.scrolls = n + 1;
          importState.updatedAt = Date.now();
          await nextFrame();
          await nextFrame();
          scan();
          if (window.scrollY === beforeY && lastPostUrl() === lastUrl)
            await new Promise<void>((resolve) => {
              const observer = new MutationObserver(() => {
                if (window.scrollY !== beforeY || lastPostUrl() !== lastUrl)
                  finish();
              });
              const finish = () => {
                observer.disconnect();
                clearTimeout(timeout);
                resolve();
              };
              observer.observe(document.documentElement, {
                childList: true,
                subtree: true,
              });
              const timeout = setTimeout(finish, 1800);
            });
        }
        if (run !== importRun) return;
        backfill = false;
        scan();
        importState = {
          ...importState,
          phase: "done",
          reason,
          updatedAt: Date.now(),
        };
      })();
    }
  });
  scan();
})();
