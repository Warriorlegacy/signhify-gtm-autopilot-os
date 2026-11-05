import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IcpDraft } from "@/lib/intake";
import {
  INTAKE_PROMPT_VERSION,
  LocalStore,
  SUPABASE_NOT_WIRED_NOTE,
  type IntakeResultInput,
} from "@/lib/store";

const draft: IcpDraft = {
  positioning: "Positioning as stated on the page itself: \"Boards for studios\"",
  claims_cited: true,
  prompt_version: "icp-baseline-v1",
  audiences: [
    {
      name: "Small agencies (2–10 people)",
      evidence: ["f1"],
      pains: [{ text: "Approvals live in scattered threads.", evidence: ["f1"] }],
    },
  ],
};

function intakeInput(url: string): IntakeResultInput {
  return {
    url,
    fetched_at: "2026-11-05T00:00:00.000Z",
    facts: [{ id: "f1", kind: "title", text: "Boards for studios" }],
    icp_draft: draft,
    provider: "deterministic-baseline",
    extraction_quality: "ok",
    warnings: [],
  };
}

describe("LocalStore", () => {
  let dir: string;
  let store: LocalStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "gtm-store-test-"));
    store = new LocalStore(dir);
  });

  afterEach(() => {
    delete process.env.SUPABASE_URL;
  });

  it("round-trips a saved product profile through the JSON file", async () => {
    const input = intakeInput("https://example.com/");
    const saved = await store.saveProductProfile("default", input);

    expect(saved.id).toBeTruthy();
    expect(saved.workspace_slug).toBe("default");
    expect(saved.prompt_version).toBe(INTAKE_PROMPT_VERSION);
    expect(saved.prompt_version).toBe("intake-v1");
    // source_packet is the raw intake result, untouched.
    expect(saved.source_packet).toEqual(input);

    const listed = await store.listProductProfiles(10);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(saved);

    // And it is really on disk, not just in memory: a fresh instance sees it.
    const reopened = new LocalStore(dir);
    expect(await reopened.listProductProfiles(10)).toHaveLength(1);
  });

  it("lists newest first and honours the limit", async () => {
    await store.saveProductProfile("default", intakeInput("https://one.example/"));
    await store.saveProductProfile("default", intakeInput("https://two.example/"));
    const all = await store.listProductProfiles(10);
    expect(all.map((p) => p.url)).toEqual(["https://two.example/", "https://one.example/"]);
    expect(await store.listProductProfiles(1)).toHaveLength(1);
  });

  it("persists pipeline runs alongside profiles in the same file", async () => {
    const profile = await store.saveProductProfile(
      "default",
      intakeInput("https://example.com/"),
    );
    const run = await store.logPipelineRun({
      workspaceSlug: "default",
      stage: "intake",
      status: "succeeded",
      durationMs: 123.6,
      provider: "deterministic-baseline",
      profileId: profile.id,
    });
    expect(run.duration_ms).toBe(124);
    expect(run.profile_id).toBe(profile.id);
    expect(run.note).toBeNull(); // no SUPABASE_URL in the test env

    const onDisk = JSON.parse(await readFile(path.join(dir, "store.json"), "utf8")) as {
      product_profiles: unknown[];
      pipeline_runs: Array<{ stage: string; status: string }>;
    };
    expect(onDisk.product_profiles).toHaveLength(1);
    expect(onDisk.pipeline_runs).toHaveLength(1);
    expect(onDisk.pipeline_runs[0]).toMatchObject({ stage: "intake", status: "succeeded" });
  });

  it("stamps the not-wired note on run records when SUPABASE_URL is present", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    const run = await store.logPipelineRun({
      workspaceSlug: "default",
      stage: "intake",
      status: "succeeded",
      durationMs: 10,
      provider: "deterministic-baseline",
    });
    expect(run.note).toBe(SUPABASE_NOT_WIRED_NOTE);
  });

  it("starts empty when no store file exists yet", async () => {
    expect(await store.listProductProfiles(5)).toEqual([]);
  });
});
