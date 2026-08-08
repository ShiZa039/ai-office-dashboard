import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  PersistedTokenState,
  TokenScanner,
  emptyTotals,
  incomingTokens,
  projectDirSlug,
} from '../src/tokenUsage';

// --- projectDirSlug ---

assert.strictEqual(
  projectDirSlug('D:\\Code projects\\claude-office-dashboard'),
  'D--Code-projects-claude-office-dashboard',
  'every non-alphanumeric character becomes a dash',
);
assert.strictEqual(
  projectDirSlug('/home/me/app'),
  '-home-me-app',
  'posix paths slug the same way',
);

// --- helpers ---

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'office-tokens-'));
const root = path.join(tmp, 'projects');
const cwd = path.join(tmp, 'work', 'app');
const otherCwd = path.join(tmp, 'work', 'other');
const projectDir = path.join(root, projectDirSlug(cwd));
const otherDir = path.join(root, projectDirSlug(otherCwd));
fs.mkdirSync(projectDir, { recursive: true });
fs.mkdirSync(otherDir, { recursive: true });

let clock = Date.parse('2026-08-08T10:00:00.000Z');

interface EntryOpts {
  session: string;
  cwd?: string;
  id?: string;
  requestId?: string;
  input?: number;
  output?: number;
  cacheCreate?: number;
  cacheRead?: number;
  model?: string;
}

function entry(o: EntryOpts): string {
  clock += 1000;
  return (
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(clock).toISOString(),
      sessionId: o.session,
      cwd: o.cwd ?? cwd,
      requestId: o.requestId ?? 'req-' + (o.id ?? 'x'),
      message: {
        id: o.id ?? 'msg-1',
        model: o.model ?? 'claude-opus-5',
        usage: {
          input_tokens: o.input ?? 0,
          output_tokens: o.output ?? 0,
          cache_creation_input_tokens: o.cacheCreate ?? 0,
          cache_read_input_tokens: o.cacheRead ?? 0,
        },
      },
    }) + '\n'
  );
}

function write(file: string, ...lines: string[]): void {
  fs.writeFileSync(file, lines.join(''), 'utf-8');
}

function append(file: string, ...lines: string[]): void {
  fs.appendFileSync(file, lines.join(''), 'utf-8');
}

const sessionA = path.join(projectDir, 'aaaa-1111.jsonl');
const sessionB = path.join(projectDir, 'bbbb-2222.jsonl');

async function main(): Promise<void> {
  // --- a plain scan sums usage and splits incoming from outgoing ---

  write(
    sessionA,
    JSON.stringify({ type: 'user', sessionId: 'aaaa-1111', cwd }) + '\n',
    entry({ session: 'aaaa-1111', id: 'm1', input: 10, output: 100, cacheCreate: 20, cacheRead: 300 }),
    entry({ session: 'aaaa-1111', id: 'm2', input: 5, output: 50, cacheCreate: 0, cacheRead: 400 }),
  );

  const scanner = new TokenScanner(root);
  scanner.setCwdFilter([cwd]);
  await scanner.scan();

  let snap = scanner.snapshot('aaaa-1111');
  assert.deepStrictEqual(
    snap.total,
    { input: 15, output: 150, cacheCreate: 20, cacheRead: 700 },
    'usage blocks summed',
  );
  assert.strictEqual(snap.session?.id, 'aaaa-1111', 'requested session found');
  assert.strictEqual(incomingTokens(snap.total), 735, 'incoming = prompt + both caches');

  // --- the same message written twice is counted once ---

  append(
    sessionA,
    entry({ session: 'aaaa-1111', id: 'm2', input: 5, output: 50, cacheRead: 400 }),
  );
  await scanner.scan();
  snap = scanner.snapshot('aaaa-1111');
  assert.strictEqual(snap.total.output, 150, 'duplicate messageId:requestId ignored');

  // --- only new bytes are re-read; older entries are not double counted ---

  append(
    sessionA,
    entry({ session: 'aaaa-1111', id: 'm3', input: 1, output: 7, cacheRead: 10 }),
  );
  await scanner.scan();
  snap = scanner.snapshot('aaaa-1111');
  assert.strictEqual(snap.total.output, 157, 'incremental append counted exactly once');

  // --- a line still being written is picked up only once it is complete ---

  fs.appendFileSync(sessionA, '{"type":"assistant","message":{"usage":{"output_to', 'utf-8');
  await scanner.scan();
  assert.strictEqual(scanner.snapshot(null).total.output, 157, 'partial line ignored');
  fs.appendFileSync(
    sessionA,
    'kens":3},"id":"m4"},"sessionId":"aaaa-1111","cwd":' + JSON.stringify(cwd) + ',"requestId":"req-m4"}\n',
    'utf-8',
  );
  await scanner.scan();
  assert.strictEqual(scanner.snapshot(null).total.output, 160, 'line counted once completed');

  // --- other projects stay out of the totals ---

  write(
    path.join(otherDir, 'cccc-3333.jsonl'),
    entry({ session: 'cccc-3333', cwd: otherCwd, id: 'o1', output: 999, cacheRead: 999 }),
  );
  await scanner.scan();
  assert.strictEqual(scanner.snapshot(null).total.output, 160, 'another project is not counted');

  // --- session slice vs project total, and the newest-session fallback ---

  write(
    sessionB,
    entry({ session: 'bbbb-2222', id: 'n1', output: 40, cacheRead: 60 }),
  );
  await scanner.scan();
  snap = scanner.snapshot('bbbb-2222');
  assert.strictEqual(snap.session?.totals.output, 40, 'session slice excludes other sessions');
  assert.strictEqual(snap.total.output, 200, 'project total spans every session');
  assert.strictEqual(
    scanner.snapshot(null).session?.id,
    'bbbb-2222',
    'unknown session id falls back to the most recently active one',
  );
  assert.strictEqual(
    scanner.snapshot('not-a-session-of-this-project').session?.id,
    'bbbb-2222',
    'a session from another project falls back too',
  );

  // --- synthetic (local error) messages carry no real spend ---

  append(
    sessionB,
    entry({ session: 'bbbb-2222', id: 'syn', model: '<synthetic>', output: 5000 }),
  );
  await scanner.scan();
  assert.strictEqual(scanner.snapshot(null).total.output, 200, 'synthetic messages skipped');

  // --- a pruned transcript keeps its tokens, and only counts once ---

  const state = scanner.getState();
  fs.rmSync(sessionB);

  const revived = new TokenScanner(root, state);
  revived.setCwdFilter([cwd]);
  await revived.scan();
  assert.strictEqual(
    revived.snapshot(null).total.output,
    200,
    'tokens of a deleted transcript are retired, not lost',
  );
  await revived.scan();
  assert.strictEqual(
    revived.snapshot(null).total.output,
    200,
    'a retired transcript is not retired a second time',
  );

  // --- another project's persisted files survive a scan that never saw them ---
  // (workspaceState can carry entries written while a different folder was open)

  const foreignFile = path.join(otherDir, 'cccc-3333.jsonl');
  const shared = {
    version: 1,
    retired: revived.getState().retired,
    files: {
      ...revived.getState().files,
      [foreignFile]: [
        {
          cwd: otherCwd.replace(/\\/g, '/').toLowerCase(),
          session: 'cccc-3333',
          totals: { input: 0, output: 999, cacheCreate: 0, cacheRead: 999 },
        },
      ],
    },
  } as PersistedTokenState;

  const scoped = new TokenScanner(root, shared);
  scoped.setCwdFilter([cwd]);
  await scoped.scan();
  assert.strictEqual(
    scoped.snapshot(null).total.output,
    200,
    "a foreign project's persisted tokens never reach this project's total",
  );
  assert.ok(
    Object.keys(scoped.getState().files).includes(foreignFile),
    "files outside the window's filter are carried over, not retired",
  );

  // --- a truncated/replaced file is re-read from the start ---

  write(sessionA, entry({ session: 'aaaa-1111', id: 'fresh', output: 3 }));
  await revived.scan();
  const after = revived.snapshot(null).total.output;
  assert.strictEqual(after, 43, 'shrunken file rescanned from zero (3 fresh + 40 retired)');

  // --- an unusable persisted state is ignored rather than fatal ---

  const bogus = { version: 7, retired: {}, files: {} } as unknown as PersistedTokenState;
  const clean = new TokenScanner(root, bogus);
  clean.setCwdFilter([cwd]);
  await clean.scan();
  assert.strictEqual(clean.snapshot(null).total.output, 3, 'unknown state version discarded');

  // --- no filter counts every project ---

  const global = new TokenScanner(root);
  await global.scan();
  assert.strictEqual(global.snapshot(null).total.output, 1002, 'unfiltered scan spans all projects');

  assert.deepStrictEqual(
    emptyTotals(),
    { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
    'emptyTotals is zeroed',
  );

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('All tokenUsage tests passed.');
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
