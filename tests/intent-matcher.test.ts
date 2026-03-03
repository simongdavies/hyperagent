import { describe, it, expect } from "vitest";
import { matchIntent, type SkillMatch } from "../src/agent/intent-matcher.js";
import type { Skill } from "../src/agent/skill-loader.js";

function makeSkill(
  name: string,
  triggers: string[],
  patterns: string[] = [],
): Skill {
  return {
    name,
    description: `Test skill: ${name}`,
    triggers,
    patterns,
    antiPatterns: [],
    guidance: "",
  };
}

const TEST_SKILLS = new Map<string, Skill>([
  [
    "pptx-expert",
    makeSkill("pptx-expert", [
      "presentation",
      "PPTX",
      "slides",
      "deck",
      "PowerPoint",
    ]),
  ],
  [
    "web-scraper",
    makeSkill("web-scraper", [
      "scrape",
      "extract",
      "crawl",
      "website",
      "HTML",
      "parse",
    ]),
  ],
  [
    "data-processor",
    makeSkill("data-processor", [
      "CSV",
      "JSON",
      "transform",
      "convert",
      "process",
      "filter",
    ]),
  ],
  [
    "report-builder",
    makeSkill("report-builder", ["report", "document", "generate", "summary"]),
  ],
]);

describe("intent-matcher", () => {
  it("should match exact trigger word", () => {
    const matches = matchIntent("Make a PPTX about AI", TEST_SKILLS);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].name).toBe("pptx-expert");
    expect(matches[0].matchedTriggers).toContain("PPTX");
  });

  it("should match case-insensitively", () => {
    const matches = matchIntent("create a powerpoint deck", TEST_SKILLS);
    expect(matches[0].name).toBe("pptx-expert");
    expect(matches[0].score).toBeGreaterThanOrEqual(2); // deck + PowerPoint
  });

  it("should match multiple skills", () => {
    const matches = matchIntent(
      "scrape a website and generate a report",
      TEST_SKILLS,
    );
    expect(matches.length).toBeGreaterThanOrEqual(2);
    const names = matches.map((m) => m.name);
    expect(names).toContain("web-scraper");
    expect(names).toContain("report-builder");
  });

  it("should return no matches for unrelated input", () => {
    const matches = matchIntent("what is 2 + 2?", TEST_SKILLS);
    expect(matches.length).toBe(0);
  });

  it("should rank by score (most matching triggers first)", () => {
    const matches = matchIntent(
      "Create a presentation with slides as a PowerPoint deck",
      TEST_SKILLS,
    );
    expect(matches[0].name).toBe("pptx-expert");
    expect(matches[0].score).toBeGreaterThanOrEqual(3);
  });

  it("should handle empty intent", () => {
    const matches = matchIntent("", TEST_SKILLS);
    expect(matches.length).toBe(0);
  });

  it("should handle skills with no triggers", () => {
    const skills = new Map<string, Skill>([
      ["empty-triggers", makeSkill("empty-triggers", [])],
    ]);
    const matches = matchIntent("anything", skills);
    expect(matches.length).toBe(0);
  });

  it("should match substring triggers in intent", () => {
    const matches = matchIntent(
      "I need to parse some HTML from a webpage",
      TEST_SKILLS,
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].name).toBe("web-scraper");
  });

  it("should handle data processing intent", () => {
    const matches = matchIntent(
      "transform this JSON data and filter the results",
      TEST_SKILLS,
    );
    expect(matches[0].name).toBe("data-processor");
    expect(matches[0].score).toBeGreaterThanOrEqual(2);
  });
});
