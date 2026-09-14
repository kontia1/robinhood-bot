/**
 * Diag #4 — breakdown risk HIGH: kenapa 151 token HIGH? Cek korelasi = liq kecil di bonding curve.
 */
import { scanNow } from "../src/scanner/scanner.js";
import { evaluateEntry } from "../src/strategy/strategy-engine.js";
import type { ScanResult } from "../src/scanner/scanner.js";

async function main() {
  const res = await scanNow(40, true);
  const high = res.filter((r) => r.risk === "HIGH");
  const nonHigh = res.filter((r) => r.risk !== "HIGH");
  console.log(`total ${res.length} | HIGH ${high.length} | non-HIGH ${nonHigh.length}`);
  console.log("\n=== ciri HIGH (10 sample) ===");
  for (const r of high.slice(0, 10)) {
    console.log(`  ${r.symbol} (${r.category}) liq$${r.liquidity} mc$${r.marketCap} vol$${r.volume} holders${r.holders} honeypot=${r.honeypot} wash=${r.washTrading} top10=${r.top10HolderPct} prog=${r.progress}`);
  }
  // apa yang bikin HIGH? cek threshold mana
  let liqLow = 0, hon = 0, wash = 0, top10 = 0, holderLow = 0;
  for (const r of high) {
    if (r.liquidity < 3000) liqLow++;
    if (r.honeypot) hon++;
    if (r.washTrading) wash++;
    if (r.top10HolderPct != null && r.top10HolderPct > 50) top10++;
    if (r.holders < 20) holderLow++;
  }
  console.log("\npenyebab HIGH:", JSON.stringify({ liqLow_under3k: liqLow, honeypot: hon, wash: wash, top10_gt50: top10, holders_lt20: holderLow }));
  // distribusi liq pada HIGH non-honeypot/wash
  const liqs = high.filter((r) => !r.honeypot && !r.wash).map((r) => r.liquidity).sort((a, b) => a - b);
  console.log("\nliq HIGH (non hon/wash): min", liqs[0], "median", liqs[Math.floor(liqs.length / 2)], "p90", liqs[Math.floor(liqs.length * 0.9)], "max", liqs[liqs.length - 1]);
  // kategori HIGH vs non
  const byCatH: Record<string, number> = {}, byCatN: Record<string, number> = {};
  for (const r of high) byCatH[r.category] = (byCatH[r.category] || 0) + 1;
  for (const r of nonHigh) byCatN[r.category] = (byCatN[r.category] || 0) + 1;
  console.log("HIGH byCat:", JSON.stringify(byCatH));
  console.log("non-HIGH byCat:", JSON.stringify(byCatN));
}

main().catch((e) => { console.error(e); process.exit(1); });