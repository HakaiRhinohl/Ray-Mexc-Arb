import { Decimal } from "decimal.js";
import { formatDecimal } from "./math.js";
import type { Opportunity } from "./types.js";
import type { PaperPosition, PaperResolution } from "./paper.js";

export type TelegramConfig = {
  enabled: boolean;
  botToken?: string;
  chatId?: string;
  opportunityAlerts: boolean;
  hourlyReports: boolean;
  startupMessage: boolean;
  minNetSpreadBps: number;
  alertCooldownMs: number;
  reportIntervalMs: number;
};

type ActiveOpportunity = {
  key: string;
  startedAtMs: number;
  lastSeenAtMs: number;
  best: Opportunity;
};

type EndedOpportunity = {
  key: string;
  durationMs: number;
  best: Opportunity;
};

export class TelegramNotifier {
  private readonly active = new Map<string, ActiveOpportunity>();
  private readonly ended: EndedOpportunity[] = [];
  private readonly alertLastSentAt = new Map<string, number>();
  private nextReportAtMs: number;
  private scans = 0;
  private failedScans = 0;
  private raydium429s = 0;
  private opportunityRows = 0;
  private opportunityEventsStarted = 0;
  private bestNetSpreadBps?: Decimal;
  private bestMarketSpreadBps?: Decimal;
  private bestOpportunity?: Opportunity;
  private bestNetSpreadSum = new Decimal(0);
  private bestNetSpreadSamples = 0;
  private paperOpened = 0;
  private paperResolved = 0;
  private paperWins = 0;
  private paperLosses = 0;
  private paperPnl = new Decimal(0);

  constructor(private readonly config: TelegramConfig) {
    this.nextReportAtMs = Date.now() + Math.max(60_000, config.reportIntervalMs);
  }

  get configured(): boolean {
    return Boolean(this.config.enabled && this.config.botToken && this.config.chatId);
  }

  async sendStartup(args: {
    paperMode: boolean;
    mexcSymbol: string;
    tradeSizesUsd: readonly number[];
    directions: readonly string[];
    scanIntervalMs: number;
  }): Promise<void> {
    if (!this.config.startupMessage) return;
    await this.send(
      [
        "SPYx monitor started",
        `Mode: ${args.paperMode ? "paper" : "scan"}`,
        `Symbol: ${args.mexcSymbol}`,
        `Sizes: ${args.tradeSizesUsd.map((value) => `$${value}`).join(", ")}`,
        `Directions: ${args.directions.join(", ")}`,
        `Scan interval: ${formatDuration(args.scanIntervalMs)}`,
        `Telegram min net: ${this.config.minNetSpreadBps} bps`
      ].join("\n")
    );
  }

  async recordScan(args: {
    opportunities: Opportunity[];
    nowMs: number;
    scanIntervalMs: number;
  }): Promise<void> {
    this.scans += 1;

    const best = args.opportunities.reduce((winner, current) =>
      current.netSpreadBps.gt(winner.netSpreadBps) ? current : winner
    );
    this.bestNetSpreadSum = this.bestNetSpreadSum.plus(best.netSpreadBps);
    this.bestNetSpreadSamples += 1;
    if (!this.bestNetSpreadBps || best.netSpreadBps.gt(this.bestNetSpreadBps)) {
      this.bestNetSpreadBps = best.netSpreadBps;
      this.bestOpportunity = best;
    }
    if (!this.bestMarketSpreadBps || best.grossSpreadBps.gt(this.bestMarketSpreadBps)) {
      this.bestMarketSpreadBps = best.grossSpreadBps;
    }

    const qualifying = args.opportunities.filter((opportunity) =>
      opportunity.netSpreadBps.gte(this.config.minNetSpreadBps) && opportunity.notes.length === 0
    );
    this.opportunityRows += qualifying.length;
    this.updateOpportunityDurations(qualifying, args.nowMs, args.scanIntervalMs);

    if (this.config.opportunityAlerts && qualifying.length > 0) {
      await this.sendOpportunityAlerts(qualifying, args.nowMs);
    }
  }

  recordScanFailure(error: unknown): void {
    this.failedScans += 1;
    const message = error instanceof Error ? error.message : String(error);
    if (/429|1015|rate limited/i.test(message)) this.raydium429s += 1;
  }

  recordRateLimitWarning(message: string): void {
    if (/429|1015|rate limited|too many requests/i.test(message)) this.raydium429s += 1;
  }

  recordPaperOpened(positions: PaperPosition[]): void {
    this.paperOpened += positions.length;
  }

  recordPaperResolved(resolutions: PaperResolution[]): void {
    this.paperResolved += resolutions.length;
    for (const resolution of resolutions) {
      this.paperPnl = this.paperPnl.plus(resolution.pnlUsd);
      if (resolution.pnlUsd.gte(0)) this.paperWins += 1;
      else this.paperLosses += 1;
    }
  }

  async maybeSendHourlyReport(nowMs: number): Promise<void> {
    if (!this.config.hourlyReports || nowMs < this.nextReportAtMs) return;
    await this.send(this.renderReport(nowMs));
    this.resetWindow(nowMs);
  }

  async flushFinalReport(nowMs: number): Promise<void> {
    if (!this.config.hourlyReports) return;
    if (this.scans === 0 && this.failedScans === 0) return;
    await this.send(this.renderReport(nowMs, "Final report"));
    this.resetWindow(nowMs);
  }

  private updateOpportunityDurations(opportunities: Opportunity[], nowMs: number, scanIntervalMs: number): void {
    const currentKeys = new Set<string>();
    for (const opportunity of opportunities) {
      const key = opportunityKey(opportunity);
      currentKeys.add(key);
      const active = this.active.get(key);
      if (!active) {
        this.active.set(key, {
          key,
          startedAtMs: nowMs,
          lastSeenAtMs: nowMs,
          best: opportunity
        });
        this.opportunityEventsStarted += 1;
        continue;
      }

      active.lastSeenAtMs = nowMs;
      if (opportunity.netSpreadBps.gt(active.best.netSpreadBps)) active.best = opportunity;
    }

    for (const [key, active] of this.active) {
      if (currentKeys.has(key)) continue;
      this.ended.push({
        key,
        durationMs: Math.max(scanIntervalMs, active.lastSeenAtMs - active.startedAtMs + scanIntervalMs),
        best: active.best
      });
      this.active.delete(key);
    }
  }

  private async sendOpportunityAlerts(opportunities: Opportunity[], nowMs: number): Promise<void> {
    const bestByKey = new Map<string, Opportunity>();
    for (const opportunity of opportunities) {
      const key = opportunityKey(opportunity);
      const previous = bestByKey.get(key);
      if (!previous || opportunity.netSpreadBps.gt(previous.netSpreadBps)) bestByKey.set(key, opportunity);
    }

    for (const [key, opportunity] of bestByKey) {
      const lastSentAt = this.alertLastSentAt.get(key) ?? 0;
      if (nowMs - lastSentAt < this.config.alertCooldownMs) continue;
      this.alertLastSentAt.set(key, nowMs);
      await this.send(renderOpportunityAlert(opportunity));
    }
  }

  private renderReport(nowMs: number, title = "Hourly report"): string {
    const avgBest = this.bestNetSpreadSamples > 0
      ? this.bestNetSpreadSum.div(this.bestNetSpreadSamples)
      : new Decimal(0);
    const activeDurations = [...this.active.values()].map((active) => nowMs - active.startedAtMs);
    const endedDurations = this.ended.map((event) => event.durationMs);
    const longestDuration = Math.max(0, ...activeDurations, ...endedDurations);
    const activeBest = [...this.active.values()].sort((left, right) =>
      right.best.netSpreadBps.cmp(left.best.netSpreadBps)
    )[0];

    return [
      `SPYx ${title}`,
      `Window: ${formatDuration(this.config.reportIntervalMs)}`,
      `Scans: ${this.scans} ok, ${this.failedScans} failed`,
      `Raydium 429/rate-limit: ${this.raydium429s}`,
      `Opportunity rows: ${this.opportunityRows}`,
      `Opportunity events: ${this.opportunityEventsStarted} started, ${this.ended.length} ended, ${this.active.size} active`,
      `Longest opportunity: ${longestDuration > 0 ? formatDuration(longestDuration) : "none"}`,
      `Best net: ${this.bestNetSpreadBps ? formatDecimal(this.bestNetSpreadBps, 2) : "n/a"} bps`,
      `Avg best net/scan: ${formatDecimal(avgBest, 2)} bps`,
      `Best market: ${this.bestMarketSpreadBps ? formatDecimal(this.bestMarketSpreadBps, 2) : "n/a"} bps`,
      this.bestOpportunity ? `Best route: ${renderCompactOpportunity(this.bestOpportunity)}` : "Best route: n/a",
      activeBest ? `Best active: ${renderCompactOpportunity(activeBest.best)} for ${formatDuration(nowMs - activeBest.startedAtMs)}` : "Best active: none",
      `Paper live-adjusted: ${this.paperOpened} opened, ${this.paperResolved} resolved, ${this.paperWins} wins, ${this.paperLosses} losses, pnl=$${formatDecimal(this.paperPnl, 4)}`
    ].join("\n");
  }

  private resetWindow(nowMs: number): void {
    this.ended.length = 0;
    this.scans = 0;
    this.failedScans = 0;
    this.raydium429s = 0;
    this.opportunityRows = 0;
    this.opportunityEventsStarted = 0;
    this.bestNetSpreadBps = undefined;
    this.bestMarketSpreadBps = undefined;
    this.bestOpportunity = undefined;
    this.bestNetSpreadSum = new Decimal(0);
    this.bestNetSpreadSamples = 0;
    this.paperOpened = 0;
    this.paperResolved = 0;
    this.paperWins = 0;
    this.paperLosses = 0;
    this.paperPnl = new Decimal(0);
    this.nextReportAtMs = nowMs + Math.max(60_000, this.config.reportIntervalMs);
  }

  private async send(text: string): Promise<void> {
    if (!this.config.enabled) return;
    if (!this.config.botToken || !this.config.chatId) {
      console.warn("Telegram enabled but TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing");
      return;
    }

    try {
      const response = await fetch(`https://api.telegram.org/bot${this.config.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: this.config.chatId,
          text,
          disable_web_page_preview: true
        })
      });

      if (!response.ok) {
        const body = await response.text();
        console.warn(`Telegram send failed: ${response.status} ${response.statusText}: ${body.slice(0, 300)}`);
      }
    } catch (error) {
      console.warn(`Telegram send failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function renderOpportunityAlert(opportunity: Opportunity): string {
  return [
    "SPYx opportunity",
    renderCompactOpportunity(opportunity),
    `Gross out: $${formatDecimal(opportunity.grossOutUsd, 4)}`,
    `Net out: $${formatDecimal(opportunity.netOutUsd, 4)}`,
    `Expected pnl: $${formatDecimal(opportunity.pnlUsd, 4)}`,
    `MEXC px: ${opportunity.mexcAveragePrice ? formatDecimal(opportunity.mexcAveragePrice, 4) : "n/a"}`,
    `Ray raw px: ${opportunity.raydiumEffectivePrice ? formatDecimal(opportunity.raydiumEffectivePrice, 4) : "n/a"}`
  ].join("\n");
}

function renderCompactOpportunity(opportunity: Opportunity): string {
  return [
    opportunity.direction,
    `$${formatDecimal(opportunity.notionalUsd, 2)}`,
    `market=${formatDecimal(opportunity.grossSpreadBps, 2)} bps`,
    `net=${formatDecimal(opportunity.netSpreadBps, 2)} bps`
  ].join(" ");
}

function opportunityKey(opportunity: Opportunity): string {
  return `${opportunity.direction}:${formatDecimal(opportunity.notionalUsd, 2)}`;
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}
