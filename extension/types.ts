import type { CaptureInput } from "../src/types.ts";
export interface StorageState {
  token?: string;
  queue?: CaptureInput[];
  lastSync?: string;
  error?: string | null;
}
export interface ImportCounts {
  new: number;
  existing: number;
  pending: number;
}
export interface ImportState {
  phase: string;
  label: string;
  path: string;
  scrolls: number;
  seen: number;
  reason: string;
  startedAt: string | null;
  updatedAt: number | null;
  since?: string;
}
export interface ImportReport {
  collection: string | null;
  state: ImportState;
  postIds: string[];
}
