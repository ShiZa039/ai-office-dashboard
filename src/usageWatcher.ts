// noqa: secret
import { spawn } from 'child_process';
import * as vscode from 'vscode';

export interface UsageBlock {
  isActive: boolean;
  costUSD: number;
  totalTokens: number;
  remainingMinutes: number | null;
  burnRateUsdPerHour: number | null;
}

export interface UsageWeekly {
  week: string;
  totalCost: number;
  opusCost: number;
}

export interface UsageLimits {
  block: number;
  weekly: number;
  weeklyOpus: number;
}

export interface UsageSnapshot {
  fetchedAt: string;
  block: UsageBlock | null;
  weekly: UsageWeekly | null;
  limits: UsageLimits;
}

export class UsageWatcher {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(
    private log: vscode.OutputChannel,
    private onUpdate: (snapshot: UsageSnapshot) => void,
    private onError: (message: string) => void,
  ) {}

  start(): void {
    this.tick();
    const pollSec = this.getPollSeconds();
    this.timer = setInterval(() => this.tick(), pollSec * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  restart(): void {
    this.stop();
    this.start();
  }

  private getPollSeconds(): number {
    const v = vscode.workspace
      .getConfiguration('aiOffice')
      .get<number>('usage.pollSeconds', 90);
    return Math.max(30, v);
  }

  private getLimits(): UsageLimits {
    const cfg = vscode.workspace.getConfiguration('aiOffice');
    return {
      block: cfg.get<number>('usage.limitBlockUsd', 0),
      weekly: cfg.get<number>('usage.limitWeeklyUsd', 0),
      weeklyOpus: cfg.get<number>('usage.limitWeeklyOpusUsd', 0),
    };
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const [block, weekly] = await Promise.all([
        this.fetchBlock(),
        this.fetchWeekly(),
      ]);
      this.onUpdate({
        fetchedAt: new Date().toISOString(),
        block,
        weekly,
        limits: this.getLimits(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.appendLine(`[usage] error: ${msg}`);
      this.onError(msg);
    } finally {
      this.inFlight = false;
    }
  }

  private async fetchBlock(): Promise<UsageBlock | null> {
    const raw = await this.runCcusage(['blocks', '--active', '--json']);
    const parsed = JSON.parse(raw) as { blocks?: Array<Record<string, unknown>> };
    const blocks = parsed.blocks ?? [];
    if (blocks.length === 0) {
      return { isActive: false, costUSD: 0, totalTokens: 0, remainingMinutes: null, burnRateUsdPerHour: null };
    }
    const b = blocks[0];
    const projection = (b.projection as { remainingMinutes?: number } | undefined) ?? undefined;
    const burn = (b.burnRate as { costPerHour?: number } | undefined) ?? undefined;
    return {
      isActive: Boolean(b.isActive),
      costUSD: Number(b.costUSD ?? 0),
      totalTokens: Number(b.totalTokens ?? 0),
      remainingMinutes: projection?.remainingMinutes ?? null,
      burnRateUsdPerHour: burn?.costPerHour ?? null,
    };
  }

  private async fetchWeekly(): Promise<UsageWeekly | null> {
    const raw = await this.runCcusage(['weekly', '--json', '--order', 'desc']);
    const parsed = JSON.parse(raw) as { weekly?: Array<Record<string, unknown>> };
    const weeks = parsed.weekly ?? [];
    if (weeks.length === 0) return null;
    const current = this.pickCurrentWeek(weeks);
    if (!current) return null;
    const breakdowns =
      (current.modelBreakdowns as Array<{ modelName?: string; cost?: number }> | undefined) ?? [];
    const opusCost = breakdowns
      .filter((m) => typeof m.modelName === 'string' && m.modelName.toLowerCase().includes('opus'))
      .reduce((sum, m) => sum + Number(m.cost ?? 0), 0);
    return {
      week: String(current.week ?? ''),
      totalCost: Number(current.totalCost ?? 0),
      opusCost,
    };
  }

  private pickCurrentWeek(weeks: Array<Record<string, unknown>>): Record<string, unknown> | null {
    const now = new Date();
    const monday = new Date(now);
    const day = monday.getUTCDay();
    const diff = day === 0 ? 6 : day - 1;
    monday.setUTCDate(monday.getUTCDate() - diff);
    monday.setUTCHours(0, 0, 0, 0);
    const mondayIso = monday.toISOString().slice(0, 10);
    const match = weeks.find((w) => String(w.week ?? '').startsWith(mondayIso));
    return match ?? weeks[0] ?? null;
  }

  private runCcusage(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
      const full = ['--yes', 'ccusage@latest', ...args];
      const child = spawn(cmd, full, {
        // Node >= 20.12 refuses to spawn .cmd/.bat directly without a shell on
        // Windows (CVE-2024-27980 fix) -> 'spawn EINVAL'. All args here are
        // code-controlled (no user input), so shell quoting is not a concern.
        shell: process.platform === 'win32',
        windowsHide: true,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      });
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('ccusage timed out after 30s'));
      }, 30_000);
      // noqa: secret
      child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf-8'); });
      // noqa: secret
      child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf-8'); });
      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(`ccusage exited ${code}: ${stderr.trim().slice(0, 200)}`));
          return;
        }
        const idx = stdout.indexOf('{');
        if (idx < 0) {
          reject(new Error('ccusage produced no JSON output'));
          return;
        }
        resolve(stdout.slice(idx));
      });
    });
  }
}
