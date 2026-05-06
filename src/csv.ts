import { mkdir, readFile, stat, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { formatDecimal } from "./math.js";
import type { PaperEvent } from "./paper.js";
import type { Opportunity } from "./types.js";

const header = [
  "timestamp",
  "direction",
  "notionalUsd",
  "grossOutUsd",
  "netOutUsd",
  "pnlUsd",
  "grossSpreadBps",
  "netSpreadBps",
  "entrySpyxAmount",
  "mexcAveragePrice",
  "raydiumEffectivePrice",
  "tokenUiMultiplier",
  "tokenScaleDragBps",
  "passesThreshold",
  "notes"
].join(",");

function escapeCsv(value: string): string {
  if (!/[",\n]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

export async function appendOpportunitiesCsv(path: string, opportunities: Opportunity[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const exists = await stat(path)
    .then(() => true)
    .catch(() => false);
  const needsHeader = exists ? await fileNeedsHeader(path) : true;

  const rows = opportunities.map((opportunity) =>
    [
      opportunity.timestamp,
      opportunity.direction,
      formatDecimal(opportunity.notionalUsd, 2),
      formatDecimal(opportunity.grossOutUsd, 8),
      formatDecimal(opportunity.netOutUsd, 8),
      formatDecimal(opportunity.pnlUsd, 8),
      formatDecimal(opportunity.grossSpreadBps, 2),
      formatDecimal(opportunity.netSpreadBps, 2),
      formatDecimal(opportunity.entrySpyxAmount, 10),
      opportunity.mexcAveragePrice ? formatDecimal(opportunity.mexcAveragePrice, 8) : "",
      opportunity.raydiumEffectivePrice ? formatDecimal(opportunity.raydiumEffectivePrice, 8) : "",
      formatDecimal(opportunity.tokenUiMultiplier, 9),
      formatDecimal(opportunity.tokenScaleDragBps, 2),
      String(opportunity.passesThreshold),
      escapeCsv(opportunity.notes.join("; "))
    ].join(",")
  );

  const content = `${needsHeader ? `${header}\n` : ""}${rows.join("\n")}\n`;
  await appendFile(path, content, "utf8");
}

const paperHeader = [
  "event",
  "id",
  "entryTimestamp",
  "resolvedAt",
  "direction",
  "model",
  "notionalUsd",
  "delayMs",
  "actualDelayMs",
  "entrySpyxAmount",
  "entryMarketSpreadBps",
  "entryNetSpreadBps",
  "entryMexcAveragePrice",
  "entryRaydiumEffectivePrice",
  "sellableSpyxAmount",
  "unsellableSpyxAmount",
  "grossOutUsd",
  "netOutUsd",
  "pnlUsd",
  "realizedSpreadBps",
  "exitMexcAveragePrice",
  "exitRaydiumEffectivePrice",
  "filled",
  "notes"
].join(",");

export async function appendPaperEventsCsv(path: string, events: PaperEvent[]): Promise<void> {
  if (events.length === 0) return;

  await mkdir(dirname(path), { recursive: true });
  const exists = await stat(path)
    .then(() => true)
    .catch(() => false);
  const needsHeader = exists ? await fileNeedsHeader(path, paperHeader) : true;

  const rows = events.map((event) => {
    const position = event.event === "OPEN" ? event.position : event.resolution.position;
    const resolution = event.event === "RESOLVE" ? event.resolution : undefined;

    return [
      event.event,
      position.id,
      position.entryTimestamp,
      resolution?.resolvedAt ?? "",
      position.direction,
      position.model,
      formatDecimal(position.notionalUsd, 2),
      String(position.delayMs),
      resolution ? String(resolution.actualDelayMs) : "",
      formatDecimal(position.entrySpyxAmount, 10),
      formatDecimal(position.entryMarketSpreadBps, 2),
      formatDecimal(position.entryNetSpreadBps, 2),
      position.entryMexcAveragePrice ? formatDecimal(position.entryMexcAveragePrice, 8) : "",
      position.entryRaydiumEffectivePrice ? formatDecimal(position.entryRaydiumEffectivePrice, 8) : "",
      resolution?.sellableSpyxAmount ? formatDecimal(resolution.sellableSpyxAmount, 10) : "",
      resolution?.unsellableSpyxAmount ? formatDecimal(resolution.unsellableSpyxAmount, 10) : "",
      resolution ? formatDecimal(resolution.grossOutUsd, 8) : "",
      resolution ? formatDecimal(resolution.netOutUsd, 8) : "",
      resolution ? formatDecimal(resolution.pnlUsd, 8) : "",
      resolution ? formatDecimal(resolution.realizedSpreadBps, 2) : "",
      resolution?.exitMexcAveragePrice ? formatDecimal(resolution.exitMexcAveragePrice, 8) : "",
      resolution?.exitRaydiumEffectivePrice ? formatDecimal(resolution.exitRaydiumEffectivePrice, 8) : "",
      resolution ? String(resolution.filled) : "",
      escapeCsv([...position.notes, ...(resolution?.notes ?? [])].join("; "))
    ].join(",");
  });

  const content = `${needsHeader ? `${paperHeader}\n` : ""}${rows.join("\n")}\n`;
  await appendFile(path, content, "utf8");
}

async function fileNeedsHeader(path: string, expectedHeader = header): Promise<boolean> {
  const content = await readFile(path, "utf8").catch(() => "");
  const firstLine = content.split("\n")[0];
  return firstLine !== expectedHeader;
}
