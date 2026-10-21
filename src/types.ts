/** Captured observations stay separate from curated and inferred metadata. */
export type SaveKind = "like" | "bookmark" | "manual";
export type Scope = "work" | "personal" | null;
export interface Signal {
  active: boolean;
  at: string;
}
export interface Folder {
  id: string;
  name: string;
}
export interface Media {
  type: "image" | "video";
  url?: string;
  poster?: string;
  alt?: string;
  local?: string;
  posterLocal?: string;
  status?: string;
  error?: string;
}
export interface Classification {
  category: string;
  topics: Record<string, number>;
  scope?: Scope;
  scopeConfidence?: number;
  model?: string;
  at?: string;
}
export interface Enrichment {
  url: string;
  title: string;
  text: string;
  fetchedAt: string;
}
export interface TagEdits {
  add: string[];
  remove: string[];
  by: string;
  at: string | null;
}
export interface Description {
  text: string;
  by: string;
  at: string | null;
}
export interface Item {
  id: string;
  url: string;
  title: string;
  text: string;
  author: string;
  links: string[];
  signals: Partial<Record<SaveKind, Signal>>;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  source: string;
  postedAt?: string | null;
  postedAtSource?: "x-id" | "x-time" | null;
  folders?: Folder[];
  media?: Media[];
  tagEdits?: TagEdits;
  description?: Description;
  scope?: Scope;
  scopeSource?: "manual" | "jev" | null;
  scopeConfidence?: number | null;
  scopeAt?: string | null;
  classification?: Classification | null;
  enrichment?: Enrichment | null;
  enrichmentError?: string;
  mediaResolvePending?: boolean;
  mediaAttempts?: number;
  mediaRetryAt?: number;
  mediaError?: string;
  attempts?: number;
  retryAt?: number;
  error?: string;
  relevance?: number;
  confidence?: number;
  matched?: string[];
}
export interface CaptureInput {
  url: string;
  text?: string;
  title?: string;
  author?: string;
  links?: string[];
  kind?: string;
  active?: boolean;
  observedAt?: string;
  postedAt?: string | null;
  postedAtSource?: string | null;
  folders?: Folder[];
  media?: Media[];
  source?: string;
}
export interface Filters {
  kind?: string;
  tag?: string;
  category?: string;
  topic?: string;
  folder?: string;
  media?: string;
  added?: string;
  scope?: string;
  sort?: string;
  now?: number;
}
export interface SearchOptions extends Filters {
  semantic?: boolean;
  deep?: boolean;
  limit?: number;
  includeRemoved?: boolean;
}
// HTTP list entries contain shortened text and a plain description.
export type LibraryItem = Omit<
  Item,
  "description" | "classification" | "updatedAt"
> & {
  description?: string | null;
  classification?: Pick<Classification, "category"> | null;
};
export interface ItemList {
  items: LibraryItem[];
  total: number;
}
export interface SearchResult extends ItemList {
  query: string;
  mode: string;
  warning?: string;
  ms: number;
  coverage: { candidates: number; library: number; complete?: boolean };
}
