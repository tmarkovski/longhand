/**
 * Shipped sources must not import "@longhand/*": external consumers install
 * the whole repo as one git package ("longhand" with subpath exports), where
 * workspace aliases don't resolve — cross-package imports in src/ have to be
 * relative. Workspace tests all pass either way, so this tripwire is the
 * only thing standing between an innocent-looking "fix" and a broken
 * `npm install github:tmarkovski/longhand`. Tests and scripts are exempt
 * (they aren't shipped — see the root package.json "files" allowlist).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SHIPPED_SRC = ["ink-core", "ink-graves", "ink-calligrapher", "ink-render"];

describe("git-installable package", () => {
  it("has no workspace-alias imports in shipped sources", () => {
    const packages = fileURLToPath(new URL("../..", import.meta.url));
    const offenders: string[] = [];
    for (const name of SHIPPED_SRC) {
      const dir = `${packages}${name}/src`;
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".ts")) continue;
        const source = readFileSync(`${dir}/${file}`, "utf8");
        const line = source.split("\n").findIndex((text) => text.includes("@longhand/"));
        if (line >= 0) offenders.push(`${name}/src/${file}:${line + 1}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("root exports all resolve to files the pack includes", () => {
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const manifest = JSON.parse(readFileSync(`${root}package.json`, "utf8")) as {
      files: string[];
      exports: Record<string, string>;
    };
    for (const target of Object.values(manifest.exports)) {
      const relative = target.replace(/^\.\//, "");
      // statSync throws (fails the test) if the target was moved/renamed.
      expect(statSync(`${root}${relative}`).size).toBeGreaterThan(0);
      expect(
        manifest.files.some((allowed) => relative.startsWith(`${allowed}/`)),
        `${target} is exported but not in the "files" allowlist`,
      ).toBe(true);
    }
  });
});
