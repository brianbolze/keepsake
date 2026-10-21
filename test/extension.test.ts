import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
const script = readFileSync(
  new URL("../extension/dist/capture.js", import.meta.url),
  "utf8",
);
const pause = () => new Promise((r) => setTimeout(r, 500));
function fixture({
  path = "/home",
  like = "like",
  bookmark = "bookmark",
  selectedTab = "",
} = {}) {
  const dom = new JSDOM(
    `<div role="tab" aria-selected="true">${selectedTab}</div><article data-testid="tweet"><a href="/designer/status/1234"><time datetime="2025-09-20T12:34:56.000Z">Sep 20</time></a><div data-testid="tweetText">A fantastic React animation library</div><a href="https://t.co/test" title="https://motion.dev">motion.dev</a><button data-testid="${like}"></button><button data-testid="${bookmark}"></button></article>`,
    { url: "https://x.com" + path, runScripts: "outside-only" },
  );
  const messages = [];
  let onMessage;
  dom.window.scrollBy = () => {};
  dom.window.chrome = {
    runtime: {
      sendMessage: (m, cb) => {
        messages.push(m);
        cb({ ok: true });
      },
      onMessage: {
        addListener: (fn) => {
          onMessage = fn;
        },
      },
    },
  };
  (dom.window.HTMLElement.prototype as any).__defineGetter__(
    "innerText",
    function () {
      return this.textContent;
    },
  );
  let click;
  const add = dom.window.document.addEventListener.bind(dom.window.document);
  dom.window.document.addEventListener = (type, fn, ...args) => {
    if (type === "click") click = fn;
    return add(type, fn, ...args);
  };
  dom.window.eval(script);
  return {
    dom,
    messages,
    importPage: () => {
      let response;
      onMessage({ type: "backfill" }, {}, (r) => {
        response = r;
      });
      return response;
    },
    importStatus: () => {
      let response;
      onMessage({ type: "backfillStatus" }, {}, (r) => {
        response = r;
      });
      return response;
    },
    click: (target) => click({ isTrusted: true, target }),
  };
}
test("ordinary feed posts are not captured", () => {
  const { dom, messages } = fixture();
  assert.equal(messages.length, 0);
  dom.window.close();
});
test("liked posts capture with resolved links and no repeated duplicates", async () => {
  const { dom, messages } = fixture({ like: "unlike" });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].item.kind, "like");
  assert.equal(messages[0].item.author, "@designer");
  assert.equal(messages[0].item.postedAt, "2025-09-20T12:34:56.000Z");
  assert.deepEqual([...messages[0].item.links], ["https://motion.dev"]);
  dom.window.document.querySelector<HTMLElement>("article").append("changed");
  await pause();
  assert.equal(messages.length, 1);
  dom.window.close();
});
test("import scrolls again promptly after capturing advanced content", async () => {
  const { dom, importPage, importStatus } = fixture({
    path: "/i/bookmarks",
    bookmark: "removeBookmark",
  });
  let y = 0;
  Object.defineProperty(dom.window, "scrollY", { get: () => y });
  dom.window.scrollBy = () => {
    y += 500;
  };
  importPage();
  await new Promise((r) => setTimeout(r, 220));
  assert.ok(importStatus().state.scrolls >= 2);
  importPage();
  dom.window.close();
});
test("import resumes when X adds another post at the end of loaded content", async () => {
  const { dom, importPage, importStatus } = fixture({
    path: "/i/bookmarks",
    bookmark: "removeBookmark",
  });
  importPage();
  await new Promise((r) => setTimeout(r, 80));
  dom.window.document
    .querySelector<HTMLElement>("article")
    .insertAdjacentHTML(
      "afterend",
      '<article data-testid="tweet"><a href="/creator/status/5678"><time datetime="2025-09-21T12:00:00Z">Sep 21</time></a><div data-testid="tweetText">Another saved post</div><button data-testid="removeBookmark"></button></article>',
    );
  await new Promise((r) => setTimeout(r, 130));
  assert.ok(importStatus().state.scrolls >= 2);
  assert.equal(importStatus().state.seen, 2);
  importPage();
  dom.window.close();
});
test("bookmark toggles capture confirmed active state and preserve unbookmark event", async () => {
  const { dom, messages } = fixture();
  const b = dom.window.document.querySelector<HTMLElement>(
    '[data-testid="bookmark"]',
  );
  b.dataset.testid = "removeBookmark";
  await pause();
  assert.equal(messages[0].item.active, true);
  b.dataset.testid = "bookmark";
  await pause();
  assert.equal(messages[1].item.active, false);
  dom.window.close();
});
test("bookmark removal on bookmarks page is not immediately recaptured", async () => {
  const { dom, messages } = fixture({
    path: "/i/bookmarks",
    bookmark: "removeBookmark",
  });
  const b = dom.window.document.querySelector<HTMLElement>(
    '[data-testid="removeBookmark"]',
  );
  b.dataset.testid = "bookmark";
  await pause();
  assert.equal(messages.at(-1).item.active, false);
  assert.equal(messages.length, 2);
  dom.window.close();
});
test("unsent captures retry after delivery failure", async () => {
  const { dom, messages } = fixture();
  let attempts = 0;
  dom.window.chrome.runtime.sendMessage = (m, cb) => {
    attempts++;
    messages.push(m);
    cb(attempts === 1 ? { error: "storage unavailable" } : { ok: true });
  };
  dom.window.document.querySelector<HTMLElement>(
    '[data-testid="like"]',
  ).dataset.testid = "unlike";
  await pause();
  dom.window.document.querySelector<HTMLElement>("article").append("again");
  await pause();
  assert.equal(attempts, 2);
  dom.window.close();
});
test("unbookmark survives the article disappearing before the next scan", async () => {
  const { dom, messages, click } = fixture({
    path: "/i/bookmarks",
    bookmark: "removeBookmark",
  });
  click(
    dom.window.document.querySelector<HTMLElement>(
      '[data-testid="removeBookmark"]',
    ),
  );
  dom.window.document.querySelector<HTMLElement>("article").remove();
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(messages.length, 2);
  assert.equal(messages.at(-1).item.active, false);
  dom.window.close();
});

for (const selectedTab of ["Bookmarks", "Likes", ""]) {
  test(`history import accepts ${selectedTab || "unrecognized tab markup"}`, () => {
    const { dom, importPage } = fixture({ path: "/i/history", selectedTab });
    assert.match(importPage().message, /Importing/);
    assert.match(importPage().message, /paused/);
    dom.window.close();
  });
}
test("history bookmarks membership does not leak into likes tab", async () => {
  const { dom, messages } = fixture({
    path: "/i/history",
    selectedTab: "Likes",
    bookmark: "hidden",
  });
  assert.equal(messages.length, 0);
  dom.window.document.querySelector<HTMLElement>('[role="tab"]').textContent =
    "Bookmarks";
  await pause();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].item.kind, "bookmark");
  dom.window.close();
});
test("import still rejects the ordinary home feed", () => {
  const { dom, importPage } = fixture();
  assert.match(importPage().message, /Open your X bookmarks/);
  dom.window.close();
});

test("import progress survives closing and reopening the popup", () => {
  const { dom, importPage, importStatus } = fixture({
    path: "/i/bookmarks",
    bookmark: "removeBookmark",
  });
  assert.equal(importStatus().state.phase, "idle");
  importPage();
  const running = importStatus().state;
  assert.equal(running.phase, "running");
  assert.equal(running.seen, 1);
  assert.equal(running.scrolls, 1);
  assert.equal(running.label, "Bookmarks");
  assert.ok(running.startedAt);
  // Posts captured on page load, before Import, still count as new.
  assert.ok(running.since <= running.startedAt);
  assert.deepEqual(Array.from(importStatus().postIds), ["1234"]);
  importPage();
  assert.equal(importStatus().state.phase, "paused");
  assert.equal(importStatus().state.scrolls, 1);
  dom.window.close();
});

test("folder page imports and attaches its name and ID", () => {
  const { dom, messages, importPage } = fixture({
    path: "/i/history/bookmarks/2081807089559855564",
    selectedTab: "Design",
    bookmark: "hidden",
  });
  assert.equal(messages[0].item.kind, "bookmark");
  assert.equal(messages[0].item.folders[0].name, "Design");
  assert.equal(messages[0].item.folders[0].id, "2081807089559855564");
  assert.match(importPage().message, /Importing/);
  importPage();
  dom.window.close();
});

test("captures post images and blob-video posters, excluding avatars", async () => {
  const { dom, messages } = fixture({ like: "unlike" });
  dom.window.document
    .querySelector<HTMLElement>("article")
    .insertAdjacentHTML(
      "beforeend",
      `<img src="https://pbs.twimg.com/profile_images/avatar.jpg"><img src="https://pbs.twimg.com/media/design.jpg" alt="Design preview"><video src="blob:https://x.com/temp" poster="https://pbs.twimg.com/ext_tw_video_thumb/demo.jpg"></video>`,
    );
  await pause();
  const media = messages.at(-1).item.media;
  assert.equal(media.length, 2);
  assert.ok(
    media.some((m) => m.type === "image" && m.alt === "Design preview"),
  );
  assert.ok(media.some((m) => m.type === "video" && !m.url && m.poster));
  dom.window.close();
});
