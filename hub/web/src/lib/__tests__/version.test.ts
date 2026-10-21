import { describe, expect, it } from "vitest";
import { compareVersions, excerpt, hasUnseenVersion, parseChangelog, stripTitle } from "../version";
import { CHANGELOG, CHANGELOG_BODY } from "../changelog";

describe("compareVersions", () => {
  it.each([
    ["0.6.0", "0.5.9", 1],
    ["0.5.9", "0.6.0", -1],
    ["0.6.0", "0.6.0", 0],
    ["v0.6.0", "0.6.0", 0],
    ["0.10.0", "0.9.0", 1],
    ["1.0", "1.0.0", 0],
    ["0.6.0-dev", "0.6.0", -1],
    ["0.6.0", "0.6.0-rc.1", 1],
    ["0.6.0-rc.1", "0.6.0-rc.2", -1],
    ["garbage", "0.0.0", 0],
  ])("%s vs %s → %i", (a, b, want) => {
    expect(compareVersions(a, b)).toBe(want);
  });
});

describe("hasUnseenVersion", () => {
  it("is true on first visit and after upgrades only", () => {
    expect(hasUnseenVersion("0.6.0", null)).toBe(true);
    expect(hasUnseenVersion("0.6.0", "")).toBe(true);
    expect(hasUnseenVersion("0.6.0", "0.5.3")).toBe(true);
    expect(hasUnseenVersion("0.6.0", "0.6.0")).toBe(false);
    expect(hasUnseenVersion("0.6.0", "0.7.0")).toBe(false);
  });
});

const MD = `# 更新日志

## v0.6.0 — 2026-10-21

### 新增
- 深色模式
- 数据统计

## [0.5.3] - 2026-09-30
- 修复

## v0.5.0
初版
`;

describe("parseChangelog", () => {
  it("splits on version headings, newest first", () => {
    const e = parseChangelog(MD);
    expect(e.map((x) => [x.version, x.date])).toEqual([
      ["0.6.0", "2026-10-21"],
      ["0.5.3", "2026-09-30"],
      ["0.5.0", null],
    ]);
    expect(e[0]!.body).toBe("### 新增\n- 深色模式\n- 数据统计");
    expect(e[2]!.body).toBe("初版");
  });

  it("ignores text before the first version and CRLF line endings", () => {
    expect(parseChangelog("intro\r\n## v1.2.3 — x\r\n- a\r\n")).toEqual([{ version: "1.2.3", date: "x", body: "- a" }]);
    expect(parseChangelog("# nothing")).toEqual([]);
  });
});

describe("stripTitle / excerpt", () => {
  it("removes the top-level title only", () => {
    expect(stripTitle(MD).startsWith("## v0.6.0")).toBe(true);
    expect(stripTitle("## v1.0.0\n- a")).toBe("## v1.0.0\n- a");
  });
  it("keeps bullets and sub-headings, capped", () => {
    expect(excerpt("### 新增\n- a\n说明文字\n- b\n1. c", 3)).toBe("### 新增\n- a\n- b");
  });
});

describe("bundled CHANGELOG.md", () => {
  it("has the current version as its newest entry", () => {
    expect(CHANGELOG.length).toBeGreaterThan(0);
    expect(CHANGELOG[0]!.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(CHANGELOG_BODY.startsWith("# ")).toBe(false);
  });
});
