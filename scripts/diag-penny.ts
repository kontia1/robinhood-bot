/** Tes risk.checkEntry untuk PENNY sesuai state yang ada sekarang. */
import dotenv from "dotenv";
dotenv.config();
import * as risk from "../src/risk/risk-manager.js";
import * as positions from "../src/positions/index.js";
import { getSettings } from "../src/settings/index.js";

async function main() {
  const s = getSettings();
  console.log("mode:", s.mode, "| reEntryCooldownHours:", s.filters.reEntryCooldownHours, "| blockDuplicateToken:", s.filters.blockDuplicateToken);
  const addr = "0x29e90b3e74dc905e77b1c6f63dc04a156f9b8085" as any; // PENNY (dari cooldown)
  const penny = positions.listOpen().filter((p) => p.symbol.toUpperCase().includes("PENNY"));
  console.log("open PENNY positions:", penny.length, penny.map((p) => p.tokenAddress));
  const closed = positions.listClosed().filter((p) => p.tokenAddress.toLowerCase() === addr.toLowerCase());
  console.log("closed PENNY:", closed.length);
  for (const c of closed.slice(-2)) {
    console.log(`  ${c.symbol} closed ${new Date(c.closedAt || 0).toISOString()} reason=${c.closeReason}`);
  }
  const now = Date.now();
  for (const c of closed.slice(-2)) {
    const h = (now - (c.closedAt || 0)) / 3600000;
    console.log("  since close:", h.toFixed(3), "h");
  }
  console.log("\ncheckEntry result:", JSON.stringify(risk.checkEntry(addr, 0.0005)));
}

main().catch((e) => { console.error(e); process.exit(1); });