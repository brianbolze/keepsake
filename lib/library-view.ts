import type { Item, LibraryItem, Filters, SaveKind } from "../src/types.ts";
type ViewItem = Item | LibraryItem;
export function scopeLabel(scope?: string | null) {
  return scope === "work"
    ? "Work"
    : scope === "personal"
      ? "Personal/Social"
      : "Unsorted";
}

export function categoryOf(item: ViewItem) {
  return item.classification?.category || "Uncategorized";
}

export function facets(items: ViewItem[]) {
  const count = (values: string[]) => {
    const counts = new Map<string, number>();
    for (const value of values)
      if (value) counts.set(value, (counts.get(value) || 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  return {
    categories: count(items.map(categoryOf)),
    topics: count(items.flatMap((item) => item.tags || [])),
    folders: count(
      items.flatMap((item) =>
        (item.folders || []).map((folder) => folder.name || folder.id),
      ),
    ),
  };
}

// The filters shared by the library and by agent search (CLI, MCP, HTTP).
export const filterKeys = [
  "kind",
  "tag",
  "category",
  "topic",
  "folder",
  "media",
  "added",
  "scope",
];
export function matches(item: ViewItem, filters: Filters, now = Date.now()) {
  const on = (key: keyof Filters) =>
    filters[key] && filters[key] !== "all" && filters[key];
  const tags = item.tags || [];
  const media = on("media");
  if (on("kind") && !item.signals[filters.kind as SaveKind]?.active)
    return false;
  if (on("tag") && !tags.includes(filters.tag!)) return false;
  if (on("topic") && !tags.includes(filters.topic!)) return false;
  if (on("category") && categoryOf(item) !== filters.category) return false;
  if (
    on("folder") &&
    !(item.folders || []).some((f) => (f.name || f.id) === filters.folder)
  )
    return false;
  if (media === "none" && (item.media || []).length) return false;
  if (
    media &&
    media !== "none" &&
    !(item.media || []).some((m) => m.type === media)
  )
    return false;
  if (on("scope") && (item.scope || "unsorted") !== filters.scope) return false;
  if (
    on("added") &&
    (Date.parse(item.createdAt) || 0) < now - Number(filters.added) * 86400000
  )
    return false;
  return true;
}

// `sort: "relevance"` keeps the order the items arrived in, which is how search results are ranked.
export function browse<T extends ViewItem>(items: T[], filters: Filters) {
  const { sort = "recent", now = Date.now() } = filters;
  const date = (value?: string | null) => Date.parse(value || "") || 0;
  const found = items.filter((item) => matches(item, filters, now));
  if (sort === "relevance") return found;
  return found.sort((a, b) => {
    if (sort === "oldest") return date(a.createdAt) - date(b.createdAt);
    if (sort === "posted-new" || sort === "posted-old") {
      const first = date(a.postedAt);
      const second = date(b.postedAt);
      if (!first) return 1;
      if (!second) return -1;
      return sort === "posted-new" ? second - first : first - second;
    }
    if (sort === "title") return a.title.localeCompare(b.title);
    return date(b.createdAt) - date(a.createdAt);
  });
}

export function groupItems<T extends ViewItem>(items: T[], group: string) {
  if (group === "none") return [{ name: "", items }];
  const groups = new Map<string, T[]>();
  for (const item of items) {
    let names;
    if (group === "category") names = [categoryOf(item)];
    else if (group === "folder")
      names = [
        ...new Set(
          item.folders?.length
            ? item.folders.map((folder) => folder.name || folder.id)
            : ["No X folder"],
        ),
      ];
    else if (group === "scope") names = [scopeLabel(item.scope)];
    else if (group === "signal") {
      const bookmark = item.signals.bookmark?.active;
      const like = item.signals.like?.active;
      names = [
        bookmark && like
          ? "Bookmarked & liked"
          : bookmark
            ? "Bookmarks"
            : like
              ? "Likes"
              : "Other saves",
      ];
    } else if (group === "month") {
      const date = new Date(item.createdAt);
      names = [
        Number.isFinite(date.getTime())
          ? date.toLocaleDateString(undefined, {
              month: "long",
              year: "numeric",
            })
          : "Unknown date",
      ];
    } else names = ["Other"];
    for (const name of names) {
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name)!.push(item);
    }
  }
  return [...groups].map(([name, members]) => ({ name, items: members }));
}
