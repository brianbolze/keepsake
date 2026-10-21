"use client";

import { useEffect, useMemo, useReducer, useState } from "react";

export const noFilters = {
  category: "all",
  topic: "all",
  folder: "all",
  media: "all",
  added: "all",
  scope: "all",
};
interface ViewState {
  query: string;
  asked: string;
  kind: string;
  filters: typeof noFilters;
  sort: string;
  group: string;
  view: string;
  pages: number;
  closed: string[];
}
type ViewChange =
  Partial<ViewState> | ((state: ViewState) => Partial<ViewState>);
const initial: ViewState = {
  query: "",
  // The query sent to Jev; cleared by typing, so only pressing Enter spends Jev budget.
  asked: "",
  kind: "all",
  filters: noFilters,
  sort: "posted-new",
  group: "none",
  view: "grid",
  pages: 1,
  closed: [],
};
// Any change to what is being browsed starts again from the first page, unless it says otherwise.
function reducer(state: ViewState, change: ViewChange): ViewState {
  return {
    ...state,
    pages: 1,
    ...(typeof change === "function" ? change(state) : change),
  };
}

// How the library is being browsed: the search box, filters, sort, grouping, layout and paging.
export function useLibraryView() {
  const [state, change] = useReducer(reducer, initial);
  const actions = useMemo(
    () => ({
      type: (query: string) => change({ query, asked: "" }),
      ask: () => change((s) => ({ asked: s.query.trim() })),
      setKind: (kind: string) => change({ kind }),
      setFilter: (key: string, value: string | null) =>
        change((s) => ({ filters: { ...s.filters, [key]: value || "all" } })),
      clearFilters: () => change({ filters: noFilters }),
      setSort: (sort: string | null) => change({ sort: sort || "posted-new" }),
      setGroup: (group: string | null) =>
        change({ group: group || "none", closed: [] }),
      setView: (view: string) => change((s) => ({ view, pages: s.pages })),
      toggleGroup: (name: string) =>
        change((s) => ({
          pages: s.pages,
          closed: s.closed.includes(name)
            ? s.closed.filter((other) => other !== name)
            : [...s.closed, name],
        })),
      showMore: () => change((s) => ({ pages: s.pages + 1 })),
      reset: () =>
        change({ query: "", asked: "", kind: "all", filters: noFilters }),
    }),
    [],
  );
  return {
    ...state,
    ...actions,
    visible: state.pages * (state.group === "none" ? 60 : 12),
  };
}

export function useDebounced<T>(value: T, ms: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
