/**
 * lib/store.ts — persistence for intake results and pipeline runs.
 *
 * Mirrors the db/schema.sql concepts (product_profiles + pipeline_runs)
 * behind one Store interface, so a Supabase-backed implementation can be
 * dropped in later without touching the routes.
 *
 * Day 2 state, honestly: the only implementation is LocalStore, backed by
 * a JSON file under .data/. When SUPABASE_URL is present in the
 * environment, a warning is logged and every pipeline run record carries
 * the SUPABASE_NOT_WIRED_NOTE — the local store is still what actually
 * persists. No half-wired Supabase client exists in this codebase.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExtractionQuality, Fact, IcpDraft } from "./intake";

/** Prompt version stamped on stored product profiles (the intake step). */
export const INTAKE_PROMPT_VERSION = "intake-v1";

/** Single-tenant local workspace until auth/workspaces are wired. */
export const DEFAULT_WORKSPACE_SLUG = "default";

export const SUPABASE_NOT_WIRED_NOTE =
  "SUPABASE_URL is set but the Supabase store is not wired yet (Day 2); this run was persisted to the local JSON store.";

/* ------------------------------ records ----------------------------- */

/** The intake route's response body — what saveProductProfile consumes. */
export interface IntakeResultInput {
  url: string;
  fetched_at: string;
  facts: Fact[];
  icp_draft: IcpDraft;
  provider: string;
  extraction_quality?: ExtractionQuality;
  warnings?: string[];
}

export interface StoredProductProfile {
  id: string;
  workspace_slug: string;
  url: string;
  fetched_at: string;
  facts: Fact[];
  icp_draft: IcpDraft;
  provider: string;
  extraction_quality: ExtractionQuality;
  warnings: string[];
  /** The raw intake result, exactly as the route produced it (schema: source_packet). */
  source_packet: IntakeResultInput;
  prompt_version: string;
  stored_at: string;
}

export interface PipelineRunInput {
  workspaceSlug: string;
  stage: string; // 'intake' | 'topics' | 'packs' | 'publish' | 'insights'
  status: "succeeded" | "failed";
  durationMs: number;
  provider?: string | null;
  profileId?: string;
  error?: string;
  note?: string;
}

export interface StoredPipelineRun {
  id: string;
  workspace_slug: string;
  stage: string;
  status: "succeeded" | "failed";
  duration_ms: number;
  provider: string | null;
  profile_id: string | null;
  error: string | null;
  note: string | null;
  recorded_at: string;
}

/* ---------------------------- interface ----------------------------- */

export interface Store {
  saveProductProfile(
    workspaceSlug: string,
    intakeResult: IntakeResultInput,
  ): Promise<StoredProductProfile>;
  logPipelineRun(run: PipelineRunInput): Promise<StoredPipelineRun>;
  listProductProfiles(limit: number): Promise<StoredProductProfile[]>;
}

/* ---------------------------- LocalStore ---------------------------- */

interface StoreFile {
  version: 1;
  product_profiles: StoredProductProfile[];
  pipeline_runs: StoredPipelineRun[];
}

const EMPTY_STORE: StoreFile = { version: 1, product_profiles: [], pipeline_runs: [] };

export class LocalStore implements Store {
  private readonly filePath: string;
  /** Serialises read-modify-write cycles inside this process. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir?: string) {
    const dir =
      dataDir ?? process.env.GTM_DATA_DIR ?? path.join(process.cwd(), ".data");
    this.filePath = path.join(dir, "store.json");
  }

  private async readAll(): Promise<StoreFile> {
    let text: string;
    try {
      text = await fs.readFile(this.filePath, "utf8");
    } catch {
      return structuredClone(EMPTY_STORE); // no file yet — an empty store
    }
    try {
      const parsed = JSON.parse(text) as Partial<StoreFile>;
      return {
        version: 1,
        product_profiles: Array.isArray(parsed.product_profiles)
          ? parsed.product_profiles
          : [],
        pipeline_runs: Array.isArray(parsed.pipeline_runs) ? parsed.pipeline_runs : [],
      };
    } catch {
      // A corrupt store file must not take intake down with it: move it
      // aside (best effort) and start from empty, loudly.
      const aside = `${this.filePath}.corrupt-${Date.now()}`;
      await fs.rename(this.filePath, aside).catch(() => undefined);
      console.warn(`[store] Corrupt store file moved aside to ${aside}; starting empty.`);
      return structuredClone(EMPTY_STORE);
    }
  }

  private async writeAll(data: StoreFile): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(tmp, this.filePath); // atomic replace on the same filesystem
  }

  private async mutate<T>(fn: (data: StoreFile) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const data = await this.readAll();
      const result = await fn(data);
      await this.writeAll(data);
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async saveProductProfile(
    workspaceSlug: string,
    intakeResult: IntakeResultInput,
  ): Promise<StoredProductProfile> {
    const profile: StoredProductProfile = {
      id: randomUUID(),
      workspace_slug: workspaceSlug,
      url: intakeResult.url,
      fetched_at: intakeResult.fetched_at,
      facts: intakeResult.facts,
      icp_draft: intakeResult.icp_draft,
      provider: intakeResult.provider,
      extraction_quality: intakeResult.extraction_quality ?? "ok",
      warnings: intakeResult.warnings ?? [],
      source_packet: intakeResult,
      prompt_version: INTAKE_PROMPT_VERSION,
      stored_at: new Date().toISOString(),
    };
    await this.mutate(async (data) => {
      data.product_profiles.push(profile);
    });
    return profile;
  }

  async logPipelineRun(run: PipelineRunInput): Promise<StoredPipelineRun> {
    // Presence check only — the Supabase store is deliberately NOT wired
    // yet; until it is, the local store persists and the record says so.
    const note =
      run.note ??
      (process.env.SUPABASE_URL ? SUPABASE_NOT_WIRED_NOTE : null);
    const record: StoredPipelineRun = {
      id: randomUUID(),
      workspace_slug: run.workspaceSlug,
      stage: run.stage,
      status: run.status,
      duration_ms: Math.max(0, Math.round(run.durationMs)),
      provider: run.provider ?? null,
      profile_id: run.profileId ?? null,
      error: run.error ?? null,
      note,
      recorded_at: new Date().toISOString(),
    };
    await this.mutate(async (data) => {
      data.pipeline_runs.push(record);
    });
    return record;
  }

  async listProductProfiles(limit: number): Promise<StoredProductProfile[]> {
    const data = await this.readAll();
    return [...data.product_profiles]
      .sort((a, b) => b.stored_at.localeCompare(a.stored_at))
      .slice(0, Math.max(0, limit));
  }
}

/* ----------------------------- factory ------------------------------ */

let cachedStore: Store | null = null;

/** Process-wide store instance. LocalStore today; Supabase store later. */
export function getStore(): Store {
  if (!cachedStore) {
    if (process.env.SUPABASE_URL) {
      console.warn(
        "[store] SUPABASE_URL is set, but the Supabase store is not wired yet — using the local JSON store.",
      );
    }
    cachedStore = new LocalStore();
  }
  return cachedStore;
}
