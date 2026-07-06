/**
 * Discover the project's agent roster from `<folder>/.claude/agents/**\/*.md`
 * so the dashboard shows the team (idle) immediately after opening a project,
 * before any events arrive. No vscode imports — unit-testable.
 */
import * as fs from 'fs';
import * as path from 'path';

const MAX_DEPTH = 4;
const MAX_FILES = 300;

/** Extract the `name:` field from YAML frontmatter; fall back to the filename. */
export function agentNameFromFile(filePath: string, content: string): string {
  if (content.startsWith('---')) {
    const end = content.indexOf('\n---', 3);
    const frontmatter = end > 0 ? content.slice(0, end) : content.slice(0, 2000);
    const match = frontmatter.match(/^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m);
    if (match) return match[1].trim();
  }
  return path.basename(filePath).replace(/\.md$/i, '');
}

/** Collect agent names from every workspace folder's `.claude/agents` tree. */
export function discoverProjectAgents(folders: string[]): string[] {
  const names = new Set<string>();
  let filesSeen = 0;

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || filesSeen >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (filesSeen >= MAX_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        filesSeen++;
        try {
          const content = fs.readFileSync(full, 'utf-8');
          const name = agentNameFromFile(full, content);
          if (name) names.add(name);
        } catch {
          // unreadable file — skip
        }
      }
    }
  };

  for (const folder of folders) {
    walk(path.join(folder, '.claude', 'agents'), 0);
  }
  return [...names].sort();
}
