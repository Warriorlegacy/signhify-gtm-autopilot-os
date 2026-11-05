import { getStore, type StoredProductProfile } from "@/lib/store";
import IntakeForm from "./intake-form";

// Reads the local store per request — recent profiles must be current.
export const dynamic = "force-dynamic";

async function recentProfiles(): Promise<StoredProductProfile[]> {
  try {
    return await getStore().listProductProfiles(10);
  } catch {
    return []; // a broken store file must not take the landing page down
  }
}

export default async function HomePage() {
  const profiles = await recentProfiles();

  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "48px 20px 80px" }}>
      <p style={{ letterSpacing: 2, fontSize: 12, color: "#8ab4ff", margin: 0 }}>
        SIGNHIFY STUDIO — FLAGSHIP BUILD, DAY 2
      </p>
      <h1 style={{ fontSize: 36, lineHeight: 1.15, margin: "10px 0 8px" }}>
        GTM Autopilot OS
      </h1>
      <p style={{ color: "#aeb8c4", marginTop: 0, maxWidth: 640 }}>
        Give it a product URL. It builds the audience engine — ICP, content calendar,
        carousels and reel scripts — with a human approval gate before anything
        publishes. This page is step one: <strong>URL in, cited ICP draft out</strong> —
        and since Day 2, every intake is stored, below.
      </p>

      <IntakeForm />

      <section style={{ marginTop: 48 }}>
        <h2 style={{ marginBottom: 6 }}>Recent intakes</h2>
        <p style={{ color: "#7d8898", fontSize: 13, marginTop: 0 }}>
          Persisted product profiles (local JSON store today; the same Store
          interface will sit on Supabase later).
        </p>
        {profiles.length === 0 ? (
          <p style={{ color: "#aeb8c4" }}>
            No product profiles yet — run an intake above and it will be stored here.
          </p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {profiles.map((profile) => (
              <li
                key={profile.id}
                style={{
                  border: "1px solid #2a3342",
                  borderRadius: 10,
                  padding: "12px 16px",
                  marginBottom: 10,
                  background: "#10141c",
                }}
              >
                <div style={{ fontSize: 15, wordBreak: "break-all" }}>{profile.url}</div>
                <div style={{ color: "#aeb8c4", fontSize: 13, marginTop: 4 }}>
                  fetched {new Date(profile.fetched_at).toLocaleString()} · provider:{" "}
                  {profile.provider} · audiences: {profile.icp_draft.audiences.length} ·
                  facts: {profile.facts.length} · extraction:{" "}
                  {profile.extraction_quality}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
