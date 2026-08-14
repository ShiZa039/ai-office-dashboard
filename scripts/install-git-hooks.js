#!/usr/bin/env node
/**
 * Points git at the repo's own `hooks/` directory and makes `git push` carry
 * annotated tags. Runs from `npm install` (the `prepare` script), so a fresh
 * clone gets the release tagging without anyone remembering a setup step.
 *
 * Silent no-op outside a git checkout — `npm ci` in CI must not fail here.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

function git(...args) {
  return execFileSync('git', args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
}

try {
  // `.git` is a directory in a normal clone and a file in a worktree.
  if (!fs.existsSync(path.join(repoRoot, '.git'))) process.exit(0);
  git('rev-parse', '--git-dir');
} catch {
  process.exit(0);
}

try {
  git('config', 'core.hooksPath', 'hooks');
  git('config', 'push.followTags', 'true');
  console.log('git hooks: core.hooksPath=hooks, push.followTags=true');
} catch (err) {
  // A missing git binary or a locked config is not worth failing an install.
  console.warn(`git hooks: skipped (${err.message})`);
}
