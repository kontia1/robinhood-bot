/**
 * Diag #3 — verifikasi setelah fix classify(srcType): breakdown kategori + yang lolos BUY.
 */
import { scanNow, ScanResult } from "../src/scanner/scanner.js";
import { evaluateEntry } from "../src/strategy/strategy-engine.js";

async function main() {
  const res = await scanNow(40, true);
  const byCat: Record<string, number> = {};
  for (const r of res) byCat[r.category] = (byCat[r.category] || 0) + 1;
  console.log("total:", res.length, "kategori:", JSON.stringify(byCat));

  // token yang kena "kategori lain" — apa cirinya?
  const others = res.filter((r) => r.category === "other");
  console.log(`\nother (${others.length}):`);
  for (const r of others.slice(0, 10)) {
    console.log(`  ${r.symbol} mc$${r.marketCap} vol$${r.volume} liq$${r.liquidity} prog=${r.progress} holders${r.holders} buys${r.buys}`);
  }

  // yang masuk kategori tapi ditolak filter — alasannya apa?
  const reasons: Record<string, number> = {};
  let pass = 0;
  const passList: string[] = [];
  for (const r of res) {
    const d = evaluateEntry(r);
    if (d.decision === "BUY") {
      pass++;
      passList.push(`${r.symbol}(${r.category})`);
    } else if (r.category !== "other") {
      const key = d.reason.split(" <")[0].split(" >")[0];
      reasons[key] = (reasons[key] || 0) + 1;
    }
  }
  console.log("\nreject reason (non-other):", reasons);
  console.log(`\nPASS BUY: ${pass}/${res.length}`);
  if (passList.length) console.log("lolos:", passList.join(", "));
}

main().catch((e) => { console.error(e); process.exit(1); });