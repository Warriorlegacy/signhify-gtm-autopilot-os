import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assessExtraction, extractFacts } from "@/lib/intake";

function fixture(name: string): string {
  return readFileSync(path.join(__dirname, "fixtures", name), "utf8");
}

describe("extractFacts — Day 2 sources (OG / Twitter / JSON-LD / links)", () => {
  const facts = extractFacts(fixture("rich-meta-page.html"));

  it("extracts Open Graph facts (og:site_name; og:title deduped against <title>)", () => {
    const og = facts.filter((f) => f.kind === "og");
    expect(og.map((f) => f.text)).toContain("Nimbus");
    // og:title repeats the <title> text verbatim — it must not appear twice.
    const titled = facts.filter((f) => f.text.includes("Pipeline clarity for sales teams"));
    expect(titled).toHaveLength(1);
    expect(titled[0]?.kind).toBe("title");
  });

  it("dedupes identical og:description / twitter:description into one fact", () => {
    const matches = facts.filter((f) => f.text.startsWith("One pipeline board"));
    expect(matches).toHaveLength(1);
    expect(matches[0]?.kind).toBe("description");
  });

  it("extracts JSON-LD name and description as jsonld facts", () => {
    const jsonld = facts.filter((f) => f.kind === "jsonld");
    expect(jsonld.map((f) => f.text)).toContain("Nimbus CRM");
    expect(jsonld.some((f) => f.text.includes("Pipeline software"))).toBe(true);
  });

  it("keeps meaningful link anchors and drops nav generics", () => {
    const links = facts.filter((f) => f.kind === "link").map((f) => f.text);
    expect(links).toContain("Kanban pipeline boards for every deal stage");
    expect(links).toContain("Simple monthly pricing for small teams");
    expect(links).not.toContain("Learn more");
    expect(links).not.toContain("Click here");
    expect(links).not.toContain("Blog");
  });

  it("dedupes on normalised text (trailing full stop is not a new fact)", () => {
    const html = `<html><head>
      <title>Acme Boards for studios</title>
      <meta name="description" content="Acme Boards keeps every studio project on one board" />
      <meta property="og:description" content="Acme Boards keeps every studio project on one board." />
    </head><body></body></html>`;
    const deduped = extractFacts(html).filter((f) => f.text.startsWith("Acme Boards keeps"));
    expect(deduped).toHaveLength(1);
  });

  it("survives a broken JSON-LD block without losing the page", () => {
    const html = `<html><head><title>Broken LD</title>
      <script type="application/ld+json">{not valid json</script>
    </head><body><h1>Still readable</h1></body></html>`;
    const parsed = extractFacts(html);
    expect(parsed.some((f) => f.text === "Broken LD")).toBe(true);
    expect(parsed.some((f) => f.text === "Still readable")).toBe(true);
  });
});

describe("assessExtraction — thin handling", () => {
  it("flags a JS-heavy shell page as thin, with a plain-language warning", () => {
    const facts = extractFacts(fixture("js-heavy-page.html"));
    // Only the <title> survives: body is an empty #root plus scripts.
    expect(facts).toHaveLength(1);
    const assessment = assessExtraction(facts);
    expect(assessment.quality).toBe("thin");
    expect(assessment.warnings.length).toBeGreaterThanOrEqual(1);
    expect(assessment.warnings.join(" ")).toMatch(/no facts were invented/i);
  });

  it("flags a metadata-only page (SPA shell) as thin even with several facts", () => {
    const html = `<html><head>
      <title>Shell App — does things</title>
      <meta name="description" content="Shell App does useful things for busy teams everywhere." />
      <meta property="og:description" content="Useful things, done automatically for busy teams." />
      <meta property="og:site_name" content="Shell App" />
      <script type="application/ld+json">{"@type":"WebSite","name":"Shell App Site"}</script>
    </head><body><div id="root"></div></body></html>`;
    const facts = extractFacts(html);
    expect(facts.length).toBeGreaterThanOrEqual(4);
    const assessment = assessExtraction(facts);
    expect(assessment.quality).toBe("thin");
    expect(assessment.warnings.join(" ")).toMatch(/JavaScript/);
  });

  it("rates the Day 1 product fixture ok, with no warnings", () => {
    const facts = extractFacts(fixture("product-page.html"));
    const assessment = assessExtraction(facts);
    expect(assessment.quality).toBe("ok");
    expect(assessment.warnings).toEqual([]);
  });

  it("rates the rich-meta fixture ok (body content is readable)", () => {
    const facts = extractFacts(fixture("rich-meta-page.html"));
    expect(assessExtraction(facts).quality).toBe("ok");
  });
});
