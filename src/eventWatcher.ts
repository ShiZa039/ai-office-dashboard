import * as fs from 'fs';
import * as path from 'path';
import { parseLines } from './eventParser';
import { AgentEvent } from './types';

// Log rotation caps: on start() a log larger than DEFAULT_ROTATE_BYTES is
// truncated to its last DEFAULT_ROTATE_KEEP_BYTES, so the startup replay
// stays bounded no matter how long the extension was not running.
const DEFAULT_ROTATE_BYTES = 5 * 1024 * 1024; // 5 MB
const DEFAULT_ROTATE_KEEP_BYTES = 1 * 1024 * 1024; // 1 MB

export interface EventWatcherOptions {
  /** Poll interval for the stat fallback (fs.watch is unreliable on Windows). */
  pollMs?: number;
  /** Rotate the log on start() once it exceeds this many bytes. */
  rotateBytes?: number;
  /** How many tail bytes to keep when rotating. */
  rotateKeepBytes?: number;
}

/**
 * Watches a JSONL file for new lines appended at the end.
 * Uses fs.watch + periodic stat to detect changes reliably on Windows.
 */
export class EventWatcher {
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastSize = 0;
  /** Identity of the file at the last successful stat, to detect replacement. */
  private lastFileId: { dev: number; ino: number } | null = null;
  /**
   * Bytes after the last newline seen so far. With several hooks appending
   * concurrently we can read the file mid-write; the incomplete trailing line
   * is kept here (as bytes, so multi-byte UTF-8 never splits) and prepended
   * to the next read instead of being dropped.
   */
  private leftover: Buffer = Buffer.alloc(0);
  private filePath: string;
  private onEvents: (events: AgentEvent[]) => void;
  private pollMs: number;
  private rotateBytes: number;
  private rotateKeepBytes: number;

  constructor(
    filePath: string,
    onEvents: (events: AgentEvent[]) => void,
    options: EventWatcherOptions = {},
  ) {
    this.filePath = filePath;
    this.onEvents = onEvents;
    this.pollMs = options.pollMs ?? 1000;
    this.rotateBytes = options.rotateBytes ?? DEFAULT_ROTATE_BYTES;
    this.rotateKeepBytes = options.rotateKeepBytes ?? DEFAULT_ROTATE_KEEP_BYTES;
  }

  start(): void {
    // Ensure file exists
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, '');
    }

    this.rotateIfNeeded();

    // Read existing content (complete lines only — see readNewLines)
    const stat = fs.statSync(this.filePath);
    if (stat.size > 0) {
      const content = fs.readFileSync(this.filePath);
      const lastNewline = content.lastIndexOf(0x0a);
      this.leftover =
        lastNewline === -1 ? content : Buffer.from(content.subarray(lastNewline + 1));
      if (lastNewline !== -1) {
        const events = parseLines(content.subarray(0, lastNewline + 1).toString('utf-8'));
        if (events.length > 0) {
          this.onEvents(events);
        }
      }
    }
    this.lastSize = stat.size;
    this.lastFileId = { dev: stat.dev, ino: stat.ino };

    // Watch for changes (may not fire reliably on Windows)
    try {
      this.watcher = fs.watch(this.filePath, () => {
        this.readNewLines();
      });
    } catch {
      // fs.watch can fail on some platforms
    }

    // Polling fallback
    this.pollTimer = setInterval(() => {
      this.readNewLines();
    }, this.pollMs);
  }

  /**
   * Truncate an overgrown log to its last rotateKeepBytes, dropping the first
   * (likely partial) line so every kept line is complete JSONL. Synchronous:
   * runs once on the startup path, before the initial replay.
   */
  private rotateIfNeeded(): void {
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.size <= this.rotateBytes) {
        return;
      }
      const content = fs.readFileSync(this.filePath);
      let tail = content.subarray(Math.max(0, content.length - this.rotateKeepBytes));
      const firstNewline = tail.indexOf(0x0a);
      tail = firstNewline === -1 ? Buffer.alloc(0) : tail.subarray(firstNewline + 1);
      fs.writeFileSync(this.filePath, tail);
    } catch {
      // Never let a failed rotation break startup; the replay bounds itself
      // to complete lines anyway.
    }
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private readNewLines(): void {
    try {
      const stat = fs.statSync(this.filePath);
      // Deleted and recreated between ticks (new inode): drop all offsets so
      // the new file is read from the start. (A missing file throws ENOENT
      // above and is retried on the next tick.)
      if (
        this.lastFileId !== null &&
        (stat.dev !== this.lastFileId.dev || stat.ino !== this.lastFileId.ino)
      ) {
        this.lastSize = 0;
        this.leftover = Buffer.alloc(0);
      }
      this.lastFileId = { dev: stat.dev, ino: stat.ino };

      if (stat.size <= this.lastSize) {
        // File was truncated or unchanged
        if (stat.size < this.lastSize) {
          this.lastSize = 0;
          this.leftover = Buffer.alloc(0);
        }
        return;
      }

      const fd = fs.openSync(this.filePath, 'r');
      const buffer = Buffer.alloc(stat.size - this.lastSize);
      fs.readSync(fd, buffer, 0, buffer.length, this.lastSize);
      fs.closeSync(fd);

      this.lastSize = stat.size;

      // Only lines terminated by \n are complete; hold the rest for next read.
      const chunk = Buffer.concat([this.leftover, buffer]);
      const lastNewline = chunk.lastIndexOf(0x0a);
      if (lastNewline === -1) {
        this.leftover = chunk;
        return;
      }
      this.leftover = Buffer.from(chunk.subarray(lastNewline + 1));

      const events = parseLines(chunk.subarray(0, lastNewline + 1).toString('utf-8'));
      if (events.length > 0) {
        this.onEvents(events);
      }
    } catch {
      // File might be temporarily locked, retry on next change
    }
  }
}
