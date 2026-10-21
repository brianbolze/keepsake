"use client";

import type { Scope, Item, ItemList, SearchResult } from "../src/types.ts";

// Server data for the library. SWR owns fetching, caching and refresh; components read these hooks.
import useSWR, { useSWRConfig } from "swr";
import useSWRMutation from "swr/mutation";

export async function api<T = unknown>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...options });
  const result = await response.json();
  if (!response.ok) {
    const error = Object.assign(new Error(result.error || "Request failed"), {
      status: response.status,
    });
    throw error;
  }
  return result;
}
const post = <T>(path: string, body: unknown) =>
  api<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const swrConfig = {
  fetcher: api,
  // A refused or invalid request will not succeed on a second try.
  shouldRetryOnError: (error: Error & { status?: number }) =>
    !((error.status || 0) >= 400 && (error.status || 0) < 500),
  errorRetryCount: 3,
};

interface Status {
  items: number;
  active: number;
  cost: number;
  calls: number;
  notes: string;
  jev: boolean;
  working: boolean;
  mediaWorking: boolean;
  mediaPending: number;
  mediaSaved: number;
  scopePending: number;
  scopeWorking: boolean;
  scopeError: string | null;
  budget: number;
  extensionLastSeen: string | null;
}
const live = { refreshInterval: 15000 };
export const useLibrary = () => useSWR<ItemList, Error>("/api/library", live);
export const useStatus = () => useSWR<Status, Error>("/api/status", live);
export const usePairToken = (wanted: boolean) =>
  useSWR<{ token: string }, Error>(wanted ? "/api/pair" : null);

const itemKey = (id?: string) =>
  id ? `/api/items/${encodeURIComponent(id)}` : null;
export const useItem = (id?: string) => useSWR<Item, Error>(itemKey(id));

// Keyword search is local and free, so it refreshes like any other read. A Jev ranking costs
// budget, so it is fetched once per query and then served from the cache.
export function useSearch(term: string, semantic: boolean) {
  return useSWR<SearchResult, Error>(
    term
      ? `/api/search?${new URLSearchParams(semantic ? { q: term, semantic: "1", limit: "100" } : { q: term, limit: "2000" })}`
      : null,
    {
      keepPreviousData: true,
      ...(semantic && {
        revalidateOnFocus: false,
        revalidateOnReconnect: false,
        revalidateIfStale: false,
        shouldRetryOnError: false,
      }),
    },
  );
}

const isList = (key: unknown) =>
  key === "/api/library" ||
  (typeof key === "string" && key.startsWith("/api/search?"));
// Saves the label, then patches the open item and every cached list holding it, with no refetch.
export function useSetScope(id?: string) {
  const { mutate, cache } = useSWRConfig();
  return useSWRMutation<
    Pick<Item, "id" | "scope" | "scopeSource">,
    Error,
    string | null,
    Scope
  >(
    itemKey(id),
    (key: string, { arg: scope }: { arg: Scope }) =>
      post<Pick<Item, "id" | "scope" | "scopeSource">>(`${key}/scope`, {
        scope,
      }),
    {
      throwOnError: false,
      revalidate: false,
      populateCache: (saved, item) => ({ ...item, ...saved }),
      onSuccess: (saved) =>
        mutate(
          // Leave lists that are still loading alone, or their response would be discarded.
          (key) =>
            typeof key === "string" && isList(key) && !!cache.get(key)?.data,
          (list: ItemList | undefined) =>
            list && {
              ...list,
              items: list.items.map((item) =>
                item.id === id ? { ...item, ...saved } : item,
              ),
            },
          { revalidate: false },
        ),
    },
  );
}
export const useRecoverMedia = () =>
  useSWRMutation<{ queued: number }, Error>(
    "/api/media/recover",
    (key: string) => post<{ queued: number }>(key, {}),
    {
      throwOnError: false,
    },
  );
