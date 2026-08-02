import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventWatcher } from '../src/eventWatcher';
import { AgentEvent } from '../src/types';

/**
 * Integration tests for EventWatcher against real files in a temp dir,
 * using a short poll interval instead of the 1s production default.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'office-watcher-'));

function eventLine(session: string): string {
  return `{"ts":"T","event":"agent_start","agent":"a","session":"${session}"}\n`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for: ${what}`);
    }
    await sleep(10);
  }
}

function collect(): { events: AgentEvent[]; sink: (batch: AgentEvent[]) => void } {
  const events: AgentEvent[] = [];
  return { events, sink: (batch) => events.push(...batch) };
}

async function main(): Promise<void> {
  // --- replay of pre-existing content on start ---
  {
    const file = path.join(tmp, 'replay.jsonl');
    // Two complete lines plus a partial trailing line without newline.
    fs.writeFileSync(file, eventLine('s1') + eventLine('s2') + '{"ts":"T3"');
    const { events, sink } = collect();
    const w = new EventWatcher(file, sink, { pollMs: 50 });
    w.start();
    assert.strictEqual(events.length, 2, 'replay delivers the two complete lines');
    assert.strictEqual(events[0].session, 's1');
    assert.strictEqual(events[1].session, 's2');
    // The partial trailing line is held as leftover; completing it delivers it.
    fs.appendFileSync(file, ',"event":"session_stop","session":"s3"}\n');
    await waitFor(() => events.length === 3, 'leftover line delivered once completed');
    assert.strictEqual(events[2].event, 'session_stop');
    assert.strictEqual(events[2].session, 's3');
    w.stop();
  }

  // --- incremental append reading ---
  {
    const file = path.join(tmp, 'append.jsonl');
    const { events, sink } = collect();
    const w = new EventWatcher(file, sink, { pollMs: 50 });
    w.start();
    fs.appendFileSync(file, eventLine('a1'));
    await waitFor(() => events.length === 1, 'first append');
    fs.appendFileSync(file, eventLine('a2') + eventLine('a3'));
    await waitFor(() => events.length === 3, 'second append');
    assert.deepStrictEqual(
      events.map((e) => e.session),
      ['a1', 'a2', 'a3'],
      'appends delivered in order',
    );
    w.stop();
  }

  // --- a line split across two writes is delivered once ---
  {
    const file = path.join(tmp, 'split.jsonl');
    const { events, sink } = collect();
    const w = new EventWatcher(file, sink, { pollMs: 50 });
    w.start();
    const line = eventLine('split1');
    fs.appendFileSync(file, line.slice(0, 20));
    await sleep(200); // several poll ticks with an incomplete line
    assert.strictEqual(events.length, 0, 'incomplete line is not delivered');
    fs.appendFileSync(file, line.slice(20));
    await waitFor(() => events.length === 1, 'completed line delivered');
    assert.strictEqual(events[0].session, 'split1');
    await sleep(150);
    assert.strictEqual(events.length, 1, 'line delivered exactly once');
    w.stop();
  }

  // --- multi-byte UTF-8 split across a chunk boundary is not mangled ---
  {
    const file = path.join(tmp, 'utf8.jsonl');
    const { events, sink } = collect();
    const w = new EventWatcher(file, sink, { pollMs: 50 });
    w.start();
    const text = 'привет мир';
    const line = `{"ts":"T","event":"agent_start","agent":"a","task":"${text}","session":"u1"}\n`;
    const buf = Buffer.from(line, 'utf-8');
    // Split inside the multi-byte 'п' (2 bytes in UTF-8).
    const cut = buf.indexOf(Buffer.from('п', 'utf-8')) + 1;
    assert.ok(cut > 0, 'cyrillic text present in the line');
    fs.appendFileSync(file, buf.subarray(0, cut));
    await sleep(150);
    assert.strictEqual(events.length, 0, 'partial multi-byte line not delivered');
    fs.appendFileSync(file, buf.subarray(cut));
    await waitFor(() => events.length === 1, 'utf-8 line delivered');
    assert.strictEqual(
      (events[0] as unknown as Record<string, unknown>).task,
      text,
      'cyrillic task survives the chunk boundary',
    );
    w.stop();
  }

  // --- file truncation resets offsets and re-reads ---
  {
    const file = path.join(tmp, 'trunc.jsonl');
    fs.writeFileSync(file, eventLine('t1') + eventLine('t2'));
    const { events, sink } = collect();
    const w = new EventWatcher(file, sink, { pollMs: 50 });
    w.start();
    assert.strictEqual(events.length, 2, 'replay before truncation');
    // Rewrite with fewer bytes than the old size: detected as truncation.
    fs.writeFileSync(file, eventLine('t3'));
    await waitFor(() => events.length === 3, 're-read after truncation');
    assert.strictEqual(events[2].session, 't3', 'new content read from the start');
    w.stop();
  }

  // --- file deletion + re-creation re-reads from scratch ---
  {
    const file = path.join(tmp, 'recreate.jsonl');
    fs.writeFileSync(file, eventLine('d1'));
    const { events, sink } = collect();
    const w = new EventWatcher(file, sink, { pollMs: 50 });
    w.start();
    assert.strictEqual(events.length, 1, 'replay before deletion');
    await sleep(120); // let a poll tick record the original file identity
    fs.unlinkSync(file);
    await sleep(120); // ticks against a missing file (ENOENT) must not break it
    fs.writeFileSync(file, eventLine('d2'));
    await waitFor(() => events.length === 2, 'recreated file read from scratch');
    assert.strictEqual(events[1].session, 'd2', 'content of the new file delivered');
    w.stop();
  }

  // --- rotation on start when the file exceeds the cap ---
  {
    const file = path.join(tmp, 'rotate.jsonl');
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) {
      lines.push(eventLine(`r${i}`));
    }
    fs.writeFileSync(file, lines.join(''));
    const before = fs.statSync(file).size;
    assert.ok(before > 1024, 'precondition: log exceeds the rotation cap');

    const { events, sink } = collect();
    const w = new EventWatcher(file, sink, {
      pollMs: 50,
      rotateBytes: 1024,
      rotateKeepBytes: 300,
    });
    w.start();
    w.stop();

    const after = fs.statSync(file).size;
    assert.ok(after <= 300, `rotated log fits the keep cap (got ${after})`);
    assert.ok(after > 0, 'rotation keeps the newest lines');
    // Every kept line is complete JSON — the partial first line was dropped.
    const kept = fs.readFileSync(file, 'utf-8').trimEnd().split('\n');
    for (const l of kept) {
      JSON.parse(l); // throws on a partial line
    }
    assert.strictEqual(events.length, kept.length, 'replay matches the rotated content');
    assert.strictEqual(events[events.length - 1].session, 'r59', 'newest line kept');
  }

  // --- a log under the cap is left untouched ---
  {
    const file = path.join(tmp, 'no-rotate.jsonl');
    const content = eventLine('n1') + eventLine('n2');
    fs.writeFileSync(file, content);
    const { events, sink } = collect();
    const w = new EventWatcher(file, sink, {
      pollMs: 50,
      rotateBytes: 1024,
      rotateKeepBytes: 300,
    });
    w.start();
    w.stop();
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), content, 'small log not rotated');
    assert.strictEqual(events.length, 2, 'small log fully replayed');
  }
}

main()
  .then(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('All eventWatcher tests passed.');
  })
  .catch((err) => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
    console.error(err);
    process.exit(1);
  });
