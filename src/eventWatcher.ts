import * as fs from 'fs';
import * as path from 'path';
import { parseLines } from './eventParser';
import { AgentEvent } from './types';

/**
 * Watches a JSONL file for new lines appended at the end.
 * Uses fs.watch + periodic stat to detect changes reliably on Windows.
 */
export class EventWatcher {
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastSize = 0;
  /**
   * Bytes after the last newline seen so far. With several hooks appending
   * concurrently we can read the file mid-write; the incomplete trailing line
   * is kept here (as bytes, so multi-byte UTF-8 never splits) and prepended
   * to the next read instead of being dropped.
   */
  private leftover: Buffer = Buffer.alloc(0);
  private filePath: string;
  private onEvents: (events: AgentEvent[]) => void;

  constructor(filePath: string, onEvents: (events: AgentEvent[]) => void) {
    this.filePath = filePath;
    this.onEvents = onEvents;
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

    // Watch for changes (may not fire reliably on Windows)
    try {
      this.watcher = fs.watch(this.filePath, () => {
        this.readNewLines();
      });
    } catch {
      // fs.watch can fail on some platforms
    }

    // Polling fallback — check every 1 second
    this.pollTimer = setInterval(() => {
      this.readNewLines();
    }, 1000);
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
