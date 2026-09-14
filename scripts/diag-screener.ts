/**
 * Diag screener — jalankan scanNow + evaluateEntry, print breakdown reject reason.
 * Dipakai buat jawab: "banyak token bagus ga muncul di notif — bug apa filter?"
 */
import { scanNow, classify, ScanResult } from "../src/scanner/scanner.js";
import { evaluateEntry } from "../src/strategy/strategy-engine.js";
import { getSettings } from "../src/settings/index.js";
import * as gmgn from "../src/chain/gmgn.js";

async function main() {
  const s = getSettings();
  console.log("=== SETTINGS ===");
  console.log(JSON.stringify(s.filters, null, 0));
  console.log("mode:", s.mode, "scanSource:", s.scanSource, "trendingInterval:", s.trendingInterval);

  console.log("\n=== SCAN (force) ===");
  const res = await scanNow(40, true);
  console.log(`total hasil: ${res.length}`);

  const byCat: Record<string, number> = {};
  for (const r of res) byCat[r.category] = (byCat[r.category] || 0) + 1;
  console.log("kategori:", JSON.stringify(byCat));

  if (!res.length) {
    // cek GMGN raw langsung
    console.log("\n=== GMGN RAW ===");
    try {
      const t = await gmgn.marketTrenches({ limit: 10 });
      console.log("trenches keys:", Object.keys(t));
      for (const k of ["new_creation", "near_completion", "completed"]) {
        const arr = (t as any)[k] || [];
        console.log(`${k}: ${arr.length}`);
        if (arr[0]) console.log("  sample:", JSON.stringify(arr[0]).slice(0, 500));
      }
      const tr = await gmgn.marketTrending("1m", 10);
      console.log("trending count:", tr.length);
      if (tr[0]) console.log("  sample:", JSON.stringify(tr[0]).slice(0, 500));
    } catch (e: any) {
      console.log("gmgn err:", (e?.message || String(e)).slice(0, 300));
    }
    return;
  }

  // breakdown reject reasons
  const reasons: Record<string, number> = {};
  let pass = 0;
  for (const r of res) {
    const d = evaluateEntry(r);
    if (d.decision === "BUY") {
      pass++;
      console.log(`\n✅ BUY ${r.symbol} (${r.category}) mc$${r.marketCap} vol$${r.volume} liq$${r.liquidity} holders${r.holders} buys${r.buys} kol${r.kol} degen${r.smartDegen} top10${r.top10HolderPct} tax${r.buyTax}/${r.sellTax} prog${r.progress} age${r.ageHours.toFixed(2)}h`);
    } else {
      const key = d.reason.split(" <")[0].split(" >")[0].split(" melebihi")[0];
      reasons[key] = (reasons[key] || 0) + 1;
    }
  }
  console.log("\n=== REJECT SUMMARY ===");
  console.log(reasons);
  console.log(`\nPASS BUY: ${pass}/${res.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});