/**
 * Diag #2 — dump raw GMGN trenches robinhood: field apa yang ada, apakah
 * progress/market_cap/volume_24h ke-populate sama CLI buat chain robinhood.
 */
import * as gmgn from "../src/chain/gmgn.js";
import { classify } from "../src/scanner/scanner.js";

async function main() {
  const t = await gmgn.marketTrenches({ limit: 5 });
  for (const k of ["new_creation", "near_completion", "completed"]) {
    const arr = (t as any)[k] || [];
    console.log(`\n===== ${k} (${arr.length}) =====`);
    for (const tok of arr.slice(0, 5)) {
      const keys = Object.keys(tok).join(",");
      console.log(`\n${tok.symbol} ${tok.address?.slice(0,10)}`);
      console.log("  keys:", keys);
      console.log("  price:", tok.price, "| mc:", tok.market_cap, "| liq:", tok.liquidity, "| vol24h:", tok.volume_24h, "| swaps:", tok.swaps_24h, "| buys:", tok.buys_24h, "| sells:", tok.sells_24h);
      console.log("  progress:", tok.progress, "| status:", tok.status, "| holders:", tok.holder_count, "| top10:", tok.top_10_holder_rate, "| created:", tok.created_timestamp, "| open:", tok.open_timestamp);
      console.log("  asli keys progress? ", ("progress" in tok), " mcap? ", ("market_cap" in tok), " vol? ", ("volume_24h" in tok));
    }
  }
  // histogram classification
  const hist: Record<string, number> = {};
  for (const k of ["new_creation", "near_completion", "completed"]) {
    for (const tok of (t as any)[k] || []) {
      const cat = classify(tok);
      hist[`${k}->${cat}`] = (hist[`${k}->${cat}`] || 0) + 1;
    }
  }
  console.log("\n=== CLASSIFY HISTOGRAM ===");
  console.log(hist);
}

main().catch((e) => console.error(e));