"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..");
const expectedVsixFiles = [
  "README.md",
  "package.nls.zh-cn.json",
  "package.nls.json",
  "package.json",
  "LICENSE",
  "CHANGELOG.md",
  "out/extension.js",
  "assets/icon.png",
];
const expectedVsixFileSet = [...expectedVsixFiles].sort();

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

test("VSIX package only includes explicitly allowed files", () => {
  const files = listVsixFiles();

  assert.deepEqual([...files].sort(), expectedVsixFileSet);
});

test("VSIX package ignores new files unless they are allowlisted", () => {
  const canaryPath = path.join(repoRoot, "vsix-unlisted-canary.txt");
  fs.writeFileSync(canaryPath, "This file must never be packaged.\n");

  try {
    const files = listVsixFiles();
    assert.equal(files.includes("vsix-unlisted-canary.txt"), false);
    assert.deepEqual([...files].sort(), expectedVsixFileSet);
  } finally {
    fs.rmSync(canaryPath, { force: true });
  }
});
