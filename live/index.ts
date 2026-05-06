import { mkdir } from "node:fs/promises";
import { liveConfig } from "./config.js";
import { assertExecuteAllowed, buildPreflight, loadRiskPolicy } from "./risk.js";
import { runLiveProbe } from "./probe.js";
import { transferExistingSpyxToMexc } from "./transfer.js";
import { sellMexcSpyxMarket } from "./sell.js";
import { printLatestPnlReport } from "./report.js";

function renderStatus(ok: boolean): string {
  return ok ? "OK " : "NO ";
}

function printNextModules(): void {
  console.log("\nLive status:");
  console.log("1. Implemented: Raydium probe quote, transaction build/sign/send, optional SPYx transfer to MEXC.");
  console.log("2. Implemented: append-only live/state/journal.jsonl.");
  console.log("3. Implemented: MEXC signed deposit-history polling.");
  console.log("4. Implemented: one-shot MEXC SPYx market sell.");
  console.log("5. Still missing: full reconciler and restart-safe recovery for automatic multi-trade operation.");
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes("--check");
  const probeMode = process.argv.includes("--probe");
  const transferToMexcMode = process.argv.includes("--transfer-to-mexc");
  const sellMexcSpyxMode = process.argv.includes("--sell-mexc-spyx");
  const pnlReportMode = process.argv.includes("--pnl-report");
  const policy = await loadRiskPolicy(liveConfig.riskPolicyPath);
  await mkdir(liveConfig.stateDir, { recursive: true });

  const preflight = buildPreflight(liveConfig, policy);

  console.log("SPYx live mode preflight");
  console.log(`Mode:        ${liveConfig.mode}`);
  console.log(`Symbol:      ${liveConfig.mexcSymbol}`);
  console.log(`Directions:  ${liveConfig.allowedDirections.join(", ")}`);
  console.log(`Max trade:   $${liveConfig.maxTradeNotionalUsd}`);
  console.log(`Min spread:  ${liveConfig.minNetSpreadBps} bps`);
  if (probeMode) {
    console.log(`Probe size:  $${liveConfig.probeNotionalUsd}`);
    console.log(`Probe min:   ${liveConfig.probeMinNetSpreadBps} bps`);
  }
  if (transferToMexcMode) {
    console.log(`Transfer:    ${liveConfig.transferSpyxAmount ?? "full SPYx balance"}`);
  }
  if (sellMexcSpyxMode) {
    console.log(`MEXC sell:   ${liveConfig.sellSpyxAmount ?? "full free SPYx balance"}`);
  }
  console.log(`State dir:   ${liveConfig.stateDir}`);
  console.log(`Risk policy: ${liveConfig.riskPolicyPath}`);
  console.log("");

  for (const item of preflight) {
    console.log(`${renderStatus(item.ok)} ${item.name}: ${item.detail}`);
  }

  if (probeMode) {
    await runLiveProbe({ config: liveConfig, policy });
    return;
  }

  if (transferToMexcMode) {
    await transferExistingSpyxToMexc({ config: liveConfig, policy });
    return;
  }

  if (sellMexcSpyxMode) {
    await sellMexcSpyxMarket({ config: liveConfig, policy });
    return;
  }

  if (pnlReportMode) {
    await printLatestPnlReport(liveConfig);
    return;
  }

  if (checkOnly || liveConfig.mode === "plan") {
    printNextModules();
    return;
  }

  assertExecuteAllowed(liveConfig, policy, preflight);

  if (liveConfig.mode === "dry-run") {
    console.log("\nDry-run is armed, but execution adapters are intentionally not wired yet.");
    printNextModules();
    return;
  }

  throw new Error("Execute mode reached scaffold boundary. Wire adapters only after dry-run and reconciler are complete.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
