#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const packageJsonPath = path.join(repoRoot, 'package.json');
const changelogPath = path.join(repoRoot, 'CHANGELOG.md');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function runGit(args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8'
  });

  if (result.status !== 0) {
    if (options.optional) {
      return '';
    }

    const stderr = (result.stderr || '').trim();
    throw new Error(stderr || `git ${args.join(' ')} failed`);
  }

  return (result.stdout || '').trim();
}

function hasTag(tag) {
  const result = spawnSync('git', ['rev-parse', '--verify', `${tag}^{commit}`], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  return result.status === 0;
}

function getCurrentVersion() {
  const raw = fs.readFileSync(packageJsonPath, 'utf8');
  const pkg = JSON.parse(raw);
  if (!pkg.version || typeof pkg.version !== 'string') {
    throw new Error('package.json version is missing');
  }
  return pkg.version;
}

function ensureChangelogFile() {
  if (!fs.existsSync(changelogPath)) {
    fs.writeFileSync(
      changelogPath,
      '# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n',
      'utf8'
    );
  }
  return fs.readFileSync(changelogPath, 'utf8');
}

function findLatestRecordedVersion(content) {
  const matches = content.match(/^## \[(.+?)\] - \d{4}-\d{2}-\d{2}$/m);
  return matches ? matches[1] : null;
}

function getCommitSubjects(previousVersion) {
  const args = ['log', '--pretty=format:%s'];

  if (previousVersion) {
    const tagCandidates = [`v${previousVersion}`, previousVersion];
    const foundTag = tagCandidates.find((tag) => hasTag(tag));
    if (foundTag) {
      args.push(`${foundTag}..HEAD`);
    } else {
      args.push('-n', '20');
    }
  } else {
    args.push('-n', '20');
  }

  return runGit(args, { optional: true })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^merge\b/i.test(line))
    .filter((line) => !/^chore:\s*release\b/i.test(line))
    .filter((line) => !/^chore:\s*update (?:openrouter provider metrics|provider pricing)\b/i.test(line))
    .filter((line) => !/^chore:\s*update community crawler posts\b/i.test(line))
    .slice(0, 15);
}

function buildEntry(version, commits) {
  const date = new Date().toISOString().slice(0, 10);
  const lines = commits.length > 0 ? commits : ['Maintenance updates'];
  const bulletList = lines.map((line) => `- ${line}`).join('\n');
  return `## [${version}] - ${date}\n${bulletList}\n\n`;
}

function insertEntry(content, entry) {
  const firstVersionHeading = content.search(/^## \[/m);
  if (firstVersionHeading === -1) {
    const normalized = content.endsWith('\n') ? content : `${content}\n`;
    return `${normalized}${entry}`;
  }

  return `${content.slice(0, firstVersionHeading)}${entry}${content.slice(firstVersionHeading)}`;
}

function trimEntries(content, maxEntries = 10) {
  const firstVersionHeading = content.search(/^## \[/m);
  if (firstVersionHeading === -1) {
    return content;
  }

  const header = content.slice(0, firstVersionHeading);
  const entries = content
    .slice(firstVersionHeading)
    .split(/(?=^## \[)/m)
    .filter(Boolean);

  const trimmedEntries = entries.slice(0, maxEntries);
  return `${header}${trimmedEntries.join('')}`.replace(/\s*$/u, '\n');
}

function main() {
  const version = getCurrentVersion();
  const content = ensureChangelogFile();
  const versionRegex = new RegExp(`^## \\[${escapeRegExp(version)}\\] - `, 'm');

  if (versionRegex.test(content)) {
    const trimmedContent = trimEntries(content);
    if (trimmedContent !== content) {
      fs.writeFileSync(changelogPath, trimmedContent, 'utf8');
      console.log(`CHANGELOG trimmed to latest 10 entries for ${version}`);
      return;
    }

    console.log(`CHANGELOG already has version ${version}`);
    return;
  }

  const previousVersion = findLatestRecordedVersion(content);
  const commits = getCommitSubjects(previousVersion);
  const nextContent = trimEntries(insertEntry(content, buildEntry(version, commits)));
  fs.writeFileSync(changelogPath, nextContent, 'utf8');
  console.log(`CHANGELOG updated for ${version}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
