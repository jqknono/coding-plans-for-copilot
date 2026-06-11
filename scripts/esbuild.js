const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const outDir = 'out';

function collectFilesWithSuffix(rootDir, suffix) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const results = [];
  const pending = [rootDir];
  while (pending.length > 0) {
    const currentPath = pending.pop();
    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }

      if (entry.isFile() && entryPath.endsWith(suffix)) {
        results.push(entryPath);
      }
    }
  }

  return results.sort();
}

function createEntryPoints() {
  return ['src/extension.ts', 'src/test/runTest.ts', ...collectFilesWithSuffix(path.join('src', 'test'), '.test.ts')];
}

async function main() {
  // Keep copied runtime assets (for example out/i18n/*.json) in watch mode.
  // The watch task runs `copy-i18n` before this script, so deleting out/
  // here would remove those files and cause runtime lookup failures.
  if (!watch) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }

  const context = await esbuild.context({
    entryPoints: createEntryPoints(),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outdir: outDir,
    outbase: 'src',
    external: ['vscode'],
    sourcemap: !production,
    minify: production,
    sourcesContent: false,
    logLevel: 'info',
  });

  if (watch) {
    await context.watch();
    console.log('esbuild watch started');
    return;
  }

  await context.rebuild();
  await context.dispose();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
