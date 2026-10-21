"use client";

import type { LibraryItem } from "../src/types.ts";
import { useEffect } from "react";
import { ArrowUpRight } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Picker, options } from "@/components/picker";
import { useItem, useSetScope } from "@/lib/api";
import { categoryOf } from "@/lib/library-view";
import {
  capitalize,
  dateText,
  safeMedia,
  splitPost,
  vagueCategory,
} from "@/lib/format";

// The full record of one save. `selected` is the card's summary, shown until the record loads.
export function ItemDialog({
  selected,
  onClose,
}: {
  selected: LibraryItem | null;
  onClose: () => void;
}) {
  const { data: detail, error } = useItem(selected?.id);
  const setScope = useSetScope(selected?.id);
  const { reset } = setScope;
  // A failed save on one item must not show on the next.
  useEffect(() => reset(), [reset, selected?.id]);
  const post = splitPost(detail || selected || {});
  const longHead = post.head.length > 160;
  return (
    <Dialog
      open={!!selected}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="detail-dialog">
        <DialogHeader>
          <DialogTitle>
            {selected
              ? longHead
                ? `Post by ${(detail || selected)!.author || "unknown author"}`
                : post.head
              : ""}
          </DialogTitle>
          <div className="detail-byline">
            <DialogDescription>
              {detail ? (
                <>
                  {detail.author || "Unknown author"} ·{" "}
                  {dateText(detail.postedAt)}
                </>
              ) : (
                error?.message || "Loading the captured source…"
              )}
            </DialogDescription>
            {detail && (
              <a
                className={buttonVariants({ variant: "outline", size: "sm" })}
                href={detail.url}
                target="_blank"
                rel="noreferrer"
              >
                Open original <ArrowUpRight size={14} />
              </a>
            )}
          </div>
        </DialogHeader>
        {detail && (
          <div className="detail-body">
            {!!detail.media?.length && (
              <div
                className={`gallery ${detail.media.length === 1 ? "single" : ""}`}
              >
                {detail.media.map((m, index) => {
                  const local = safeMedia(m.local);
                  const poster = safeMedia(m.posterLocal);
                  return (
                    <figure key={index}>
                      {m.type === "video" && local ? (
                        <video
                          controls
                          playsInline
                          preload="metadata"
                          src={local}
                          poster={poster || undefined}
                        />
                      ) : local || poster ? (
                        <a
                          href={local || poster || undefined}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <img
                            src={local || poster || undefined}
                            alt={m.alt || detail.title}
                          />
                        </a>
                      ) : null}
                      <figcaption>
                        {local ? (
                          <a href={local} download>
                            Save a copy
                          </a>
                        ) : m.type === "video" ? (
                          <a href={detail.url} target="_blank" rel="noreferrer">
                            Watch on X
                          </a>
                        ) : (
                          "Download pending"
                        )}
                      </figcaption>
                    </figure>
                  );
                })}
              </div>
            )}
            {(longHead ? post.head : post.rest) && (
              <p className="post-text">
                {longHead ? detail.text.trim() : post.rest}
              </p>
            )}
            {detail.links?.length > 0 && (
              <section>
                <h4>Links</h4>
                <ul className="link-list">
                  {detail.links.map((link) => (
                    <li key={link}>
                      <a href={link} target="_blank" rel="noreferrer">
                        {link}
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {detail.enrichment?.text && (
              <section>
                <h4>From the linked page</h4>
                <p className="source-text">
                  {detail.enrichment.text.slice(0, 2500)}
                </p>
              </section>
            )}
            <section className="detail-meta">
              <h4>Details</h4>
              <dl>
                <dt>Work or personal</dt>
                <dd>
                  <Picker
                    inline
                    bare
                    label="Work or personal"
                    value={detail.scope || "unsorted"}
                    onChange={(scope) =>
                      setScope.trigger(
                        scope === "work" || scope === "personal" ? scope : null,
                      )
                    }
                    values={options.scope.filter(([v]) => v !== "all")}
                  />
                  {setScope.error ? (
                    <span className="scope-source">
                      {setScope.error.message}
                    </span>
                  ) : (
                    detail.scopeSource && (
                      <span className="scope-source">
                        {detail.scopeSource === "manual"
                          ? "Set by you"
                          : "Suggested by Jev"}
                      </span>
                    )
                  )}
                </dd>
                {detail.description?.text && (
                  <>
                    <dt>Description</dt>
                    <dd>{detail.description.text}</dd>
                  </>
                )}
                {detail.tags?.length > 0 && (
                  <>
                    <dt>Topics</dt>
                    <dd className="find-tags">
                      {detail.tags.map((t) => (
                        <Badge key={t} variant="secondary">
                          {t}
                        </Badge>
                      ))}
                    </dd>
                  </>
                )}
                {!!detail.folders?.length && (
                  <>
                    <dt>X folders</dt>
                    <dd>
                      {detail.folders.map((f) => f.name || f.id).join(", ")}
                    </dd>
                  </>
                )}
                {!vagueCategory(categoryOf(detail)) && (
                  <>
                    <dt>Category</dt>
                    <dd>{capitalize(categoryOf(detail))}</dd>
                  </>
                )}
                <dt>Added</dt>
                <dd>{dateText(detail.createdAt)}</dd>
              </dl>
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
