import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export async function appendJournal(stateDir: string, event: string, payload: Record<string, unknown>): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...payload
  });
  await appendFile(join(stateDir, "journal.jsonl"), `${line}\n`, "utf8");
}
