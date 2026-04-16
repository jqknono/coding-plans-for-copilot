"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..");

function listVsixFiles() {
  const command = process.platform === "win32" ? "cmd.exe" : "npx";
  const args =
    process.platform === "win32"
      ? ["/d", "/s", "/c", "npx @vscode/vsce ls"]
      : ["@vscode/vsce", "ls"];
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.error || result.stderr || result.stdout);

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/\\/g, "/"));
}

test("VSIX package excludes local workspace artifacts", () => {
  const files = listVsixFiles();

  const forbiddenPatterns = [
    /^temp\.log$/,
    /^temp\//,
    /^\.claude\//,
    /^\.playwright-mcp\//,
    /^assets\/discussions\//,
    /^assets\/openrouter-provider-metrics\.json$/,
    /^assets\/openrouter-provider-plans\.json$/,
    /^assets\/provider-pricing\.json$/,
  ];

  for (const file of files) {
    assert.equal(
      forbiddenPatterns.some((pattern) => pattern.test(file)),
      false,
      `unexpected file in VSIX package: ${file}`,
    );
  }
});
