"use client";

import { useState, type FormEvent } from "react";

interface Fact {
  id: string;
  kind: string;
  text: string;
}

interface IntakeResult {
  url: string;
  fetched_at: string;
  facts: Fact[];
  icp_draft: {
    positioning: string;
    audiences: Array<{
      name: string;
      pains: Array<{ text: string; evidence: string[] }>;
      evidence: string[];
    }>;
    claims_cited: boolean;
    prompt_version: string;
  };
  provider: string;
  extraction_quality: "ok" | "thin";
  warnings: string[];
  profile_id: string | null;
}

export default function IntakeForm() {
  const [url, setUrl] = useState("https://signhify.dpdns.org");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IntakeResult | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = (await res.json()) as IntakeResult & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <form
        onSubmit={onSubmit}
        style={{ display: "flex", gap: 8, margin: "28px 0", flexWrap: "wrap" }}
      >
        <input
          type="url"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://your-product.com"
          style={{
            flex: "1 1 380px",
            padding: "12px 14px",
            borderRadius: 8,
            border: "1px solid #2a3342",
            background: "#12161f",
            color: "#e8ecf1",
            fontSize: 15,
          }}
        />
        <button
          type="submit"
          disabled={loading}
          style={{
            padding: "12px 20px",
            borderRadius: 8,
            border: "none",
            background: loading ? "#3a4a63" : "#2f6fed",
            color: "#fff",
            fontSize: 15,
            cursor: loading ? "wait" : "pointer",
          }}
        >
          {loading ? "Fetching…" : "Build ICP draft"}
        </button>
      </form>

      {error && (
        <p style={{ color: "#ff9c9c", background: "#2a1416", padding: "12px 14px", borderRadius: 8 }}>
          {error}
        </p>
      )}

      {result && (
        <section>
          <p style={{ color: "#aeb8c4", fontSize: 13 }}>
            Fetched {result.url} at {result.fetched_at} · provider:{" "}
            <strong style={{ color: "#e8ecf1" }}>{result.provider}</strong> · prompt{" "}
            {result.icp_draft.prompt_version} · claims cited:{" "}
            {result.icp_draft.claims_cited ? "yes" : "no"} · extraction:{" "}
            <strong style={{ color: "#e8ecf1" }}>{result.extraction_quality}</strong>
            {result.profile_id ? (
              <>
                {" "}· stored profile <code style={{ color: "#8ab4ff" }}>{result.profile_id}</code>
              </>
            ) : (
              <> · not stored</>
            )}
          </p>

          {result.warnings.length > 0 && (
            <div
              style={{
                color: "#ffd9a0",
                background: "#241b0d",
                border: "1px solid #4a3817",
                padding: "12px 14px",
                borderRadius: 8,
                marginBottom: 16,
              }}
            >
              {result.warnings.map((warning) => (
                <p key={warning} style={{ margin: "4px 0" }}>
                  {warning}
                </p>
              ))}
            </div>
          )}

          <h2 style={{ marginBottom: 6 }}>Positioning</h2>
          <p style={{ marginTop: 0 }}>{result.icp_draft.positioning}</p>

          <h2 style={{ marginBottom: 6 }}>Audiences &amp; pains</h2>
          {result.icp_draft.audiences.map((audience) => (
            <div
              key={audience.name}
              style={{
                border: "1px solid #2a3342",
                borderRadius: 10,
                padding: "14px 16px",
                marginBottom: 12,
                background: "#10141c",
              }}
            >
              <h3 style={{ margin: "0 0 8px", fontSize: 17 }}>{audience.name}</h3>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {audience.pains.map((pain) => (
                  <li key={pain.text} style={{ marginBottom: 6 }}>
                    {pain.text}{" "}
                    <span style={{ color: "#8ab4ff", fontSize: 12 }}>
                      [evidence: {pain.evidence.join(", ")}]
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <h2 style={{ marginBottom: 6 }}>Source facts extracted from the page</h2>
          <ol style={{ paddingLeft: 20, color: "#c6cfdb" }}>
            {result.facts.map((fact) => (
              <li key={fact.id} style={{ marginBottom: 4 }}>
                <code style={{ color: "#8ab4ff" }}>{fact.id}</code>{" "}
                <em style={{ color: "#7d8898" }}>{fact.kind}</em> — {fact.text}
              </li>
            ))}
          </ol>

          <p style={{ color: "#7d8898", fontSize: 13 }}>
            Next in the demo sequence: approve the calendar built from this ICP →
            carousel studio → approval queue. Nothing publishes without an approval
            record — that rule is enforced in the data model (scheduled_posts
            requires an approval_id).
          </p>
        </section>
      )}
    </>
  );
}
