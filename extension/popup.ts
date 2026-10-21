import type { CaptureInput } from "../src/types.ts";
import type { ImportCounts, ImportReport, StorageState } from "./types.ts";
function $<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
const LIBRARY = "http://127.0.0.1:47821";
let view = "main";
let refreshing = false;
let checkedImport: {
  run: string | null | undefined;
  seen: number;
  at: number;
  counts: ImportCounts | null;
} = { run: null, seen: -1, at: 0, counts: null };
// Live library reachability, probed on open and every 10s: ok | offline | rejected.
let library: {
  state: "ok" | "offline" | "rejected" | null;
  at: number;
  token?: string;
} = { state: null, at: 0 };
let queued = 0;
let onX = false;

function message(id: string, text?: string | null) {
  $(id).textContent = text || "";
  $(id).hidden = !text;
}

function show(id: string, visible: boolean) {
  $(id).hidden = !visible;
}

function ago(iso: string) {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  const days = Math.floor(seconds / 86400);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

function showView(paired: boolean) {
  const settings = paired && view === "settings";
  show("setup", !paired);
  show("main", paired && !settings);
  show("settings", settings);
  show("settings-open", paired && !settings);
  show("settings-back", settings);
  show("mark", !settings);
  show("title", settings);
  show("library-status", paired && !settings && !!library.state);
  $("title").textContent = settings ? "Settings" : "Keepsake";
  const rejected = library.state === "rejected";
  show("settings-status", !rejected);
  show("settings-rejected", rejected);
}

async function probe(token: string) {
  if (library.token === token && Date.now() - library.at < 10000) return;
  library.token = token;
  library.at = Date.now();
  try {
    const response = await fetch(LIBRARY + "/api/status", {
      headers: { Authorization: "Bearer " + token },
    });
    library.state = response.ok
      ? "ok"
      : response.status === 401
        ? "rejected"
        : "offline";
  } catch {
    library.state = "offline";
  }
}

function renderLibrary(
  queue: CaptureInput[],
  lastSync: string | undefined,
  error: string | null | undefined,
  importing: boolean,
) {
  const state = library.state;
  $("library-status").className = `library-status ${state || ""}`;
  $("library-status-text").textContent =
    state === "rejected"
      ? "Token rejected"
      : state === "offline"
        ? "Library offline"
        : "Connected";

  const waiting = queue.length;
  const saves = `${waiting} ${waiting === 1 ? "save" : "saves"}`;
  queued = waiting;
  // Offline and rejected states explain the queue elsewhere; mid-import the
  // panel's counts lead, so the footer stays quiet.
  $("sync-status").textContent =
    state !== "ok" || importing
      ? ""
      : waiting
        ? `${saves} queued · syncing soon`
        : lastSync
          ? `Synced ${ago(lastSync)}`
          : "Nothing to sync yet";
  show("sync", waiting > 0 && state === "ok" && !importing);
  show("sync-row", !!$("sync-status").textContent);
  // The library link would open a refused connection while it's down.
  show("library-link", state !== "offline");
  show("footer", !!$("sync-status").textContent || state !== "offline");

  const offline = state === "offline";
  $("sync-error").classList.toggle("warn", offline);
  $("sync-error").classList.toggle("error", !offline);
  const problem = offline
    ? importing
      ? "" // The chip and the import stats already say it; the probe retries.
      : waiting
        ? `Can’t reach your library. Start it, then retry — ${saves} will sync.`
        : "Can’t reach your library. Start it, then retry — new saves will sync."
    : state === "rejected"
      ? ""
      : // Network errors are stale once the probe succeeds; anything else is real.
        error && !/fetch|network|pair with/i.test(error)
        ? error
        : "";
  $("sync-error-text").textContent = problem;
  show("sync-error", !!problem);
}

// Folder names keep their case; the built-in collections read as nouns.
function inSentence(label: string) {
  return /^(Bookmarks|Likes)$/.test(label) ? label.toLowerCase() : label;
}

function collectionLabel(collection?: string | null) {
  return collection === "like" ? "Likes" : "Bookmarks";
}

function renderImport(
  report: ImportReport | null,
  counts: ImportCounts | null = null,
) {
  const state = report?.state;
  const collection = report?.collection;
  const phase = state?.phase || "idle";
  const label = state?.label || collectionLabel(collection);
  const button = $<HTMLButtonElement>("backfill");
  const title = $("import-title");
  const detail = $("import-detail");
  const started = phase !== "idle" && !!state?.startedAt;
  const showProgress = !!collection && started;

  const rejected = library.state === "rejected";
  show("open-settings", rejected);
  show("open-x", !collection && !rejected);
  // A status reply means this tab is already on X, so go there in place.
  onX = !!report;
  $<HTMLAnchorElement>("open-x").textContent = onX
    ? "Go to X Bookmarks"
    : "Open X Bookmarks ↗";
  show("backfill", !!collection && !rejected);
  const upToDate =
    phase === "done" && state!.reason === "end" && counts?.new === 0;
  show("import-progress", showProgress && !rejected && !upToDate);
  show("progress-row", phase === "running");
  $("import-progress").classList.toggle("running", phase === "running");
  button.className = library.state === "offline" ? "" : "primary";
  button.disabled = false;

  if (showProgress) {
    show("import-count-row", !!counts);
    if (counts) $("import-count").textContent = counts.new.toLocaleString();
    $("import-count-label").textContent = "new";
    $("progress-fill").style.width = `${Math.min(state!.scrolls, 100)}%`;
    $("scroll-count").textContent = `${state!.scrolls} of 100 scrolls`;
    $("import-stats").textContent = `${state!.seen} seen · ${
      counts
        ? `${counts.existing} already in library`
        : library.state === "offline"
          ? "kept locally until your library is back"
          : "checking for new…"
    }`;
  }

  if (rejected) {
    title.textContent = "Not syncing";
    detail.textContent = `Your library rejected this browser’s token${
      queued
        ? `, so ${queued} ${queued === 1 ? "save is" : "saves are"} waiting to sync`
        : ""
    }.`;
    return;
  }
  if (!collection) {
    title.textContent = "Saving as you browse X";
    detail.textContent =
      "New likes and bookmarks save automatically. To import older ones, open Bookmarks or Likes on X, then click the Keepsake icon again.";
    return;
  }
  if (phase === "running") {
    title.textContent = `Importing ${label}…`;
    detail.textContent = "Keep this tab open while Keepsake scrolls.";
    button.textContent = "Stop";
    button.className = "";
  } else if (phase === "paused") {
    title.textContent = "Import stopped";
    detail.textContent = "Everything found so far is kept.";
    button.textContent = "Continue from here";
  } else if (phase === "done" && state!.reason === "limit") {
    title.textContent = "Reached 100 scrolls";
    detail.textContent = "There may be more. Everything found so far is kept.";
    button.textContent = "Continue from here";
  } else if (phase === "done" && state!.reason === "page-changed") {
    title.textContent = "Import stopped";
    detail.textContent = "The X page changed during the import.";
    button.textContent = `Import ${label}`;
  } else if (phase === "done") {
    title.textContent = upToDate ? "Up to date" : "Import complete";
    detail.textContent = upToDate
      ? `Checked ${state!.seen} ${inSentence(label)} — nothing new.`
      : `X has no more ${inSentence(label)} to load.`;
    button.textContent = "Import again";
    button.className = "";
  } else {
    title.textContent = `Import your ${label}`;
    detail.textContent =
      "Brings in older saves, including ones from your phone.";
    button.textContent = `Import ${label}`;
  }
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const {
      token,
      queue = [],
      lastSync,
      error,
    } = await chrome.storage.local.get<StorageState>([
      "token",
      "queue",
      "lastSync",
      "error",
    ]);
    // Unpaired, a 401 still proves the library is running.
    await probe(token || "");
    showView(!!token);
    const setupOffline = !token && library.state === "offline";
    show("setup-offline", setupOffline);
    $("pair").className = setupOffline ? "" : "primary";
    $("setup-library-link").classList.toggle("inert", setupOffline);
    $("setup-library-link").tabIndex = setupOffline ? -1 : 0;
    if (!token) return;

    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const report = tab?.id
      ? await chrome.tabs
          .sendMessage(tab.id!, { type: "backfillStatus" })
          .catch(() => null)
      : null;
    renderLibrary(queue, lastSync, error, report?.state?.phase === "running");
    const run = report?.state?.startedAt;
    const postIds = report?.postIds;
    if (run !== checkedImport.run)
      checkedImport = { run, seen: -1, at: 0, counts: null };
    const current =
      checkedImport.seen === postIds?.length ? checkedImport.counts : null;
    renderImport(report, current);
    if (run && Array.isArray(postIds) && postIds.length <= 5000) {
      const now = Date.now();
      if (
        checkedImport.seen !== postIds.length ||
        (checkedImport.counts?.pending && now - checkedImport.at > 2000)
      ) {
        try {
          const response = await fetch(LIBRARY + "/api/import/check", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + token,
            },
            body: JSON.stringify({
              startedAt: report.state.since || run,
              postIds,
            }),
          });
          if (!response.ok) throw new Error("Import check unavailable");
          checkedImport = {
            run,
            seen: postIds.length,
            at: now,
            counts: await response.json(),
          };
          renderImport(report, checkedImport.counts);
        } catch {
          renderImport(report, null);
        }
      }
    }
  } finally {
    refreshing = false;
  }
}

async function saveToken(inputId: string, messageId: string) {
  const token = $<HTMLInputElement>(inputId).value.trim();
  if (!/^[a-f0-9]{64}$/.test(token)) {
    message(
      messageId,
      "That doesn’t look like a pairing token. Copy it again from your library and paste the whole thing.",
    );
    return;
  }
  try {
    let response;
    try {
      response = await fetch(LIBRARY + "/api/status", {
        headers: { Authorization: "Bearer " + token },
      });
    } catch {
      throw new Error("Can’t reach your library. Is it running?");
    }
    if (!response.ok) throw new Error("Your library didn’t accept that token.");
    await chrome.storage.local.set({ token, error: null });
    $<HTMLInputElement>(inputId).value = "";
    message(messageId, "");
    view = "main";
    library = { state: null, at: 0 };
    showView(true);
    await refresh();
    void chrome.runtime.sendMessage({ type: "sync" }).catch(() => {});
  } catch (error) {
    message(messageId, error.message);
  }
}

$("pair").onclick = () => saveToken("token", "setup-message");
$<HTMLInputElement>("token").onkeydown = (event) => {
  if (event.key === "Enter") $("pair").click();
};
$("replace-token").onclick = () =>
  saveToken("replacement-token", "settings-message");
function openReplaceForm() {
  show("replace-open", false);
  show("replace-form", true);
  $("replacement-token").focus();
}
$("replace-open").onclick = openReplaceForm;
$("settings-open").onclick = $("open-settings").onclick = () => {
  view = "settings";
  show("replace-open", true);
  show("replace-form", false);
  showView(true);
  if (library.state === "rejected") openReplaceForm();
};
$("settings-back").onclick = () => {
  view = "main";
  message("settings-message", "");
  showView(true);
};
$("disconnect").onclick = async () => {
  await chrome.storage.local.remove(["token", "error"]);
  $<HTMLInputElement>("replacement-token").value = "";
  view = "main";
  library = { state: null, at: 0 };
  showView(false);
  await refresh();
};
$("sync").onclick = $("retry").onclick = async () => {
  library.at = 0;
  await chrome.runtime.sendMessage({ type: "sync" });
  await refresh();
};
$<HTMLAnchorElement>("open-x").onclick = async (event) => {
  if (!onX) return;
  event.preventDefault();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.tabs.update(tab.id!, {
    url: $<HTMLAnchorElement>("open-x").href,
  });
  window.close();
};
$<HTMLButtonElement>("backfill").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const response = await chrome.tabs.sendMessage(tab.id!, {
      type: "backfill",
    });
    message("action-message", response.state ? "" : response.message);
    await refresh();
  } catch {
    message("action-message", "Reload this X tab once, then try again.");
  }
};

void refresh();
setInterval(() => void refresh(), 1000);
