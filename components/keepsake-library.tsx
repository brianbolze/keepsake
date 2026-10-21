"use client";

import type { LibraryItem, SaveKind } from "../src/types.ts";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Bookmark,
  ChevronDown,
  ChevronRight,
  Grid2X2,
  Heart,
  Layers,
  List,
  Play,
  Quote,
  Search,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ConnectDialog } from "@/components/connect-dialog";
import { ItemDialog } from "@/components/item-dialog";
import { Picker, optionName, options } from "@/components/picker";
import { useLibrary, useRecoverMedia, useSearch, useStatus } from "@/lib/api";
import {
  capitalize,
  dateText,
  domain,
  isX,
  safeMedia,
  splitPost,
} from "@/lib/format";
import { browse, facets, groupItems, scopeLabel } from "@/lib/library-view";
import { useDebounced, useLibraryView } from "@/lib/use-library-view";

const SIDEBAR_TOPICS = 12;
const filterLabels = {
  category: "Category",
  topic: "Topic",
  folder: "X folder",
  media: "Media",
  added: "Added",
  scope: "Work or personal",
};
const empty: LibraryItem[] = [];
const related = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);
function Artwork({
  item,
  index,
  list,
}: {
  item: LibraryItem;
  index: number;
  list?: boolean;
}) {
  const media = item.media?.find(
    (m) => safeMedia(m.posterLocal) || safeMedia(m.local),
  );
  const image =
    media &&
    (safeMedia(media.posterLocal) ||
      (media.type === "image" && safeMedia(media.local)));
  const video = item.media?.some((m) => m.type === "video");
  const link = item.links?.find((url) => !isX(url));
  // Text-only posts skip artwork in the grid; the list keeps a placeholder to align rows.
  if (!media && !video && !link && !list) return null;
  return (
    <div className={`art art-${index % 6}`}>
      {image ? (
        <img
          src={`${image}?thumb=1`}
          alt={media.alt || item.title}
          loading="lazy"
        />
      ) : media?.type === "video" && safeMedia(media.local) ? (
        <video
          muted
          preload="metadata"
          src={`${safeMedia(media.local)}#t=0.1`}
        />
      ) : link ? (
        <span className="art-word">{domain(link)}</span>
      ) : (
        <Quote size={22} className="art-icon" aria-hidden="true" />
      )}
      {video && (
        <span className="video-mark" aria-label="Video">
          <Play size={12} fill="currentColor" />
        </span>
      )}
    </div>
  );
}
// Grid cards span as many 4px rows as their content needs (masonry), keeping DOM order.
function useRowSpan(list?: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (list) {
      node.style.gridRowEnd = "";
      return;
    }
    const fit = () => {
      node.style.gridRowEnd = `span ${Math.ceil((node.offsetHeight + 16) / 4)}`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    return () => observer.disconnect();
  }, [list]);
  return ref;
}
function ItemCard({
  item,
  index,
  list,
  onOpen,
}: {
  item: LibraryItem;
  index: number;
  list?: boolean;
  onOpen: (item: LibraryItem) => void;
}) {
  const { head, rest } = splitPost(item);
  const ref = useRowSpan(list);
  return (
    <Card
      ref={ref}
      className={`find-card ${list ? "list-card" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(item)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(item);
        }
      }}
    >
      <Artwork item={item} index={index} list={list} />
      <div className="find-body">
        <h3>{head}</h3>
        {rest && <p className="find-excerpt">{rest}</p>}
        {item.tags?.length > 0 && (
          <div className="find-tags">
            {item.tags.slice(0, 2).map((tag) => (
              <Badge key={tag} variant="secondary">
                {tag}
              </Badge>
            ))}
          </div>
        )}
        <div className="find-foot">
          <span className="find-author">{item.author || domain(item.url)}</span>
          <span>{item.postedAt ? dateText(item.postedAt) : ""}</span>
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            aria-label="Open original"
            title="Open original"
            onClick={(event) => event.stopPropagation()}
          >
            <ArrowUpRight size={14} />
          </a>
        </div>
      </div>
    </Card>
  );
}
export function KeepsakeLibrary() {
  const ui = useLibraryView();
  const { query, kind, filters, sort, group, view, visible, closed } = ui;
  const [selected, setSelected] = useState<LibraryItem | null>(null);
  const [pairOpen, setPairOpen] = useState(false);
  const [dismissed, setDismissed] = useState<Error | null>(null);
  const libraryData = useLibrary();
  const library = libraryData.data?.items || empty;
  const { data: status } = useStatus();
  const recover = useRecoverMedia();
  // Typing ranks by keywords on this Mac; submitting asks Jev to rank by meaning.
  const typed = query.trim();
  const settled = useDebounced(typed, 120);
  const semantic = !!typed && ui.asked === typed;
  const term =
    !semantic && settled && related(typed, settled) ? settled : typed;
  const search = useSearch(term, semantic);
  // SWR keeps the previous results while the next query loads; show them only if the
  // query was extended or shortened, not replaced.
  const found =
    term && search.data && related(search.data.query, term)
      ? search.data
      : null;
  const items = found?.items || library;
  const activeQuery = found?.query || "";
  const mode = found?.mode === "jev" ? "jev" : "local";
  const coverage = mode === "jev" ? found?.coverage : null;
  const fallback = !!found?.warning && mode === "local";
  const asking = semantic && search.isLoading;
  const problem = [libraryData.error, search.error, recover.error].find(
    Boolean,
  );
  const error = problem && problem !== dismissed ? problem.message : "";
  const allFacets = useMemo(() => facets(library), [library]);
  const kindCounts = useMemo(
    () => ({
      all: library.length,
      bookmark: library.filter((item) => item.signals?.bookmark?.active).length,
      like: library.filter((item) => item.signals?.like?.active).length,
    }),
    [library],
  );
  const results = useMemo(
    () =>
      browse(items, {
        kind,
        ...filters,
        sort: activeQuery ? "relevance" : sort,
      }),
    [items, kind, filters, activeQuery, sort],
  );
  const groups = useMemo(() => groupItems(results, group), [results, group]);
  // The topic is shown as the page heading, so it isn't repeated as a chip.
  const chipFilters = Object.entries(filters).filter(
    ([key, value]) => value !== "all" && key !== "topic",
  );
  const filterCount = chipFilters.length;
  const topic = filters.topic !== "all" ? filters.topic : null;
  const ranked = mode === "jev" && typed === activeQuery;
  const narrowed =
    Object.entries(filters).some(([k, v]) => k !== "topic" && v !== "all") ||
    !!activeQuery;
  const baseCount = library.filter(
    (item) =>
      (kind === "all" || item.signals?.[kind as SaveKind]?.active) &&
      (!topic || item.tags?.includes(topic)),
  ).length;
  const kindName =
    kind === "bookmark" ? "Bookmarks" : kind === "like" ? "Likes" : null;
  const heading = topic ? capitalize(topic) : kindName || "Your library";
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img
            src="/brand/wordmark.webp"
            alt="Keepsake"
            width="800"
            height="191"
            className="brand-wordmark"
          />
        </div>
        <nav className="main-nav" aria-label="Library">
          {(
            [
              ["all", <Grid2X2 size={16} />, "Everything"],
              ["bookmark", <Bookmark size={16} />, "Bookmarks"],
              ["like", <Heart size={16} />, "Likes"],
            ] as [string, React.ReactNode, string][]
          ).map(([value, icon, name]) => (
            <button
              key={value}
              className={kind === value ? "nav-active" : ""}
              aria-current={kind === value ? "page" : undefined}
              onClick={() => ui.setKind(value)}
            >
              {icon}
              <span>{name}</span>
              <small>{kindCounts[value as keyof typeof kindCounts]}</small>
            </button>
          ))}
        </nav>
        {allFacets.topics.length > 0 && (
          <>
            <div className="nav-label">Topics</div>
            <nav className="topic-nav" aria-label="Topics">
              {allFacets.topics
                .slice(0, SIDEBAR_TOPICS)
                .map(([name, count]) => (
                  <button
                    key={name}
                    className={filters.topic === name ? "topic-active" : ""}
                    aria-pressed={filters.topic === name}
                    onClick={() =>
                      ui.setFilter(
                        "topic",
                        filters.topic === name ? "all" : name,
                      )
                    }
                  >
                    <span>{capitalize(name)}</span>
                    <small>{count}</small>
                  </button>
                ))}
            </nav>
          </>
        )}
        <div className="sidebar-bottom">
          <p>
            <span
              className={`live-dot ${status?.extensionLastSeen ? "" : "off"}`}
            />
            {status?.extensionLastSeen
              ? `Chrome synced ${new Date(status.extensionLastSeen).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
              : "Chrome not connected"}
          </p>
          <p>Jev spend ${Number(status?.cost || 0).toFixed(2)} of $20</p>
          <button onClick={() => setPairOpen(true)}>
            {status?.extensionLastSeen
              ? "Show pairing token"
              : "Connect Chrome & agents"}
          </button>
        </div>
      </aside>
      <main className="main">
        <div className="page-head">
          <h1>{heading}</h1>
          {topic && (
            <>
              {kindName && <span className="count">in {kindName}</span>}
              <button
                className="head-clear"
                aria-label={`Show all topics`}
                title="Show all topics"
                onClick={() => ui.setFilter("topic", "all")}
              >
                <X size={16} />
              </button>
            </>
          )}
        </div>
        <form
          className="search-row"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            if (ranked) return;
            // Asking again after Jev was unavailable repeats the request.
            if (semantic) search.mutate();
            else ui.ask();
          }}
        >
          <Search size={18} aria-hidden="true" />
          <Input
            aria-label="Search your saves"
            value={query}
            onChange={(event) => ui.type(event.target.value)}
            placeholder="Search, or ↵ to ask Jev"
          />
          {query && (
            <button
              type="button"
              className="search-clear"
              aria-label="Clear search"
              onClick={() => ui.type("")}
            >
              <X size={15} />
            </button>
          )}
          <Button
            type="submit"
            className="ask-jev"
            hidden={!query.trim()}
            variant={ranked ? "secondary" : "default"}
            disabled={ranked || asking}
            aria-label="Ask Jev"
            title="Rank your saves by meaning (uses Jev budget)"
          >
            <Sparkles size={15} aria-hidden="true" />
            <span>{ranked ? "Ranked" : asking ? "Asking…" : "Ask Jev"}</span>
          </Button>
        </form>
        <div className="toolbar">
          <Popover>
            <PopoverTrigger render={<Button variant="outline" size="sm" />}>
              <SlidersHorizontal size={14} /> Filter
              {filterCount > 0 && (
                <span className="filter-count">{filterCount}</span>
              )}
            </PopoverTrigger>
            <PopoverContent align="start" className="filter-panel">
              <div className="filter-heading">
                <strong>Filter</strong>
                <Button variant="ghost" size="sm" onClick={ui.clearFilters}>
                  Reset
                </Button>
              </div>
              <Picker
                label="Work or personal"
                value={filters.scope}
                onChange={(v) => ui.setFilter("scope", v)}
                values={options.scope}
              />
              <Picker
                label="Category"
                value={filters.category}
                onChange={(v) => ui.setFilter("category", v)}
                values={[["all", "All categories"], ...allFacets.categories]}
              />
              {allFacets.topics.length > SIDEBAR_TOPICS && (
                <Picker
                  label="Topic"
                  value={filters.topic}
                  onChange={(v) => ui.setFilter("topic", v)}
                  values={[["all", "All topics"], ...allFacets.topics]}
                />
              )}
              {allFacets.folders.length > 0 && (
                <Picker
                  label="X folder"
                  value={filters.folder}
                  onChange={(v) => ui.setFilter("folder", v)}
                  values={[["all", "All folders"], ...allFacets.folders]}
                />
              )}
              <Picker
                label="Media"
                value={filters.media}
                onChange={(v) => ui.setFilter("media", v)}
                values={options.media}
              />
              <Picker
                label="Added"
                value={filters.added}
                onChange={(v) => ui.setFilter("added", v)}
                values={options.added}
              />
            </PopoverContent>
          </Popover>
          {activeQuery ? (
            <Picker
              inline
              disabled
              label="Sort"
              value="relevance"
              values={[["relevance", "Best match"]]}
            />
          ) : (
            <Picker
              inline
              label="Sort"
              value={sort}
              onChange={ui.setSort}
              values={options.sort}
            />
          )}
          <Picker
            inline
            className="group-picker"
            label="Group"
            value={group}
            onChange={ui.setGroup}
            values={options.group}
          />
          <span className="result-meta" role="status">
            {narrowed && `${results.length} of ${baseCount}`}
            {mode === "jev" && (
              <span
                className="ranked"
                title={
                  coverage && !coverage.complete
                    ? `Jev scored the ${coverage.candidates} likeliest of ${coverage.library} saves`
                    : undefined
                }
              >
                <Sparkles size={12} aria-hidden="true" /> Ranked by Jev
              </span>
            )}
            {fallback && (
              <span className="fallback">
                Keyword matches · Jev unavailable
              </span>
            )}
          </span>
          <div className="view-switch" role="group" aria-label="Layout">
            <Button
              size="icon-sm"
              variant={view === "grid" ? "secondary" : "ghost"}
              aria-label="Grid view"
              aria-pressed={view === "grid"}
              onClick={() => ui.setView("grid")}
            >
              <Grid2X2 size={15} />
            </Button>
            <Button
              size="icon-sm"
              variant={view === "list" ? "secondary" : "ghost"}
              aria-label="List view"
              aria-pressed={view === "list"}
              onClick={() => ui.setView("list")}
            >
              <List size={15} />
            </Button>
          </div>
        </div>
        {filterCount > 0 && (
          <div className="active-filters">
            {chipFilters.map(([key, value]) => (
              <button key={key} onClick={() => ui.setFilter(key, "all")}>
                {filterLabels[key as keyof typeof filterLabels]}:{" "}
                {key === "scope"
                  ? scopeLabel(value)
                  : key === "media" || key === "added"
                    ? optionName(options[key], value)
                    : value}{" "}
                <X size={12} aria-label="Remove" />
              </button>
            ))}
            {filterCount > 1 && (
              <button className="clear-filter" onClick={ui.clearFilters}>
                Clear filters
              </button>
            )}
          </div>
        )}
        {error && (
          <div className="notice" role="status">
            <span>{error}</span>
            <button
              aria-label="Dismiss"
              onClick={() => setDismissed(problem || null)}
            >
              <X size={14} />
            </button>
          </div>
        )}
        {group === "folder" && !allFacets.folders.length && (
          <div className="notice">
            No X folders imported yet. Open a bookmark folder on X and choose
            “Import this page” in the extension.
          </div>
        )}
        {!results.length ? (
          <div className="empty">
            <Layers size={22} aria-hidden="true" />
            <h3>
              {library.length ? "Nothing matches." : "Nothing saved yet."}
            </h3>
            {library.length && activeQuery && mode === "local" && !fallback ? (
              <>
                <p>
                  No saves contain those words. Press ↵ to ask Jev, which
                  searches by meaning.
                </p>
              </>
            ) : library.length ? (
              <>
                <p>Try fewer filters or different words.</p>
                <Button variant="outline" onClick={ui.reset}>
                  Clear all
                </Button>
              </>
            ) : (
              <>
                <p>
                  Connect the Chrome extension, then like or bookmark a post on
                  X.
                </p>
                <Button onClick={() => setPairOpen(true)}>
                  Connect Chrome
                </Button>
              </>
            )}
          </div>
        ) : (
          <div className={group === "none" ? `cards ${view}` : "groups"}>
            {groups.map(({ name, items: members }) =>
              group === "none" ? (
                members
                  .slice(0, visible)
                  .map((item, index) => (
                    <ItemCard
                      key={item.id}
                      item={item}
                      index={index}
                      list={view === "list"}
                      onOpen={setSelected}
                    />
                  ))
              ) : (
                <section key={name} className="collection-group">
                  <button
                    className="group-heading"
                    onClick={() => ui.toggleGroup(name)}
                    aria-expanded={!closed.includes(name)}
                  >
                    {closed.includes(name) ? (
                      <ChevronRight size={17} />
                    ) : (
                      <ChevronDown size={17} />
                    )}
                    <span>{capitalize(name)}</span>
                    <small>{members.length}</small>
                  </button>
                  {!closed.includes(name) && (
                    <div className={`cards ${view}`}>
                      {members.slice(0, visible).map((item, index) => (
                        <ItemCard
                          key={item.id}
                          item={item}
                          index={index}
                          list={view === "list"}
                          onOpen={setSelected}
                        />
                      ))}
                    </div>
                  )}
                </section>
              ),
            )}
          </div>
        )}
        {groups.some(({ items: members }) => members.length > visible) && (
          <div className="more">
            <Button variant="outline" onClick={ui.showMore}>
              Show more{group !== "none" ? " in each group" : ""}
            </Button>
          </div>
        )}
        <footer>
          <span>Your library is stored on this Mac.</span>
          <div>
            <button
              onClick={() => recover.trigger()}
              disabled={recover.isMutating || !!recover.data}
            >
              {recover.data
                ? `${recover.data.queued} posts queued`
                : "Recover missing media"}
            </button>
            <a href="/api/export" target="_blank" rel="noreferrer">
              Export JSON
            </a>
          </div>
        </footer>
      </main>
      <ItemDialog selected={selected} onClose={() => setSelected(null)} />
      <ConnectDialog open={pairOpen} onOpenChange={setPairOpen} />
    </div>
  );
}
