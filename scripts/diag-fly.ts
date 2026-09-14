/** Kenapa FLY muncul terus padahal ada token lain yang lebih rame? */
import dotenv from "dotenv";
dotenv.config();
import { scanNow } from "../src/scanner/scanner.js";
import { evaluateEntry } from "../src/strategy/strategy-engine.js";

async function main() {
  const res = await scanNow(40, true);
  console.log("total:", res.length);
  const fly = res.find((r) => r.symbol.toLowerCase() === "fly");
  if (fly) {
    const d = evaluateEntry(fly);
    console.log(`FLY ${fly.address} cat=${fly.category} risk=${fly.risk}`);
    console.log(`  mc=${fly.marketCap} vol=${fly.volume} liq=${fly.liquidity} buys=${fly.buys} sells=${fly.sells} holders=${fly.holders} kol=${fly.kol} degen=${fly.smartDegen} top10=${fly.top10HolderPct} age=${fly.ageHours.toFixed(1)}h callout=${fly.calloutCount} tg=${fly.tgCallCount} fees=${fly.fees}`);
    console.log("  decision:", d.decision, "|", d.reason);
    // waktu asli: liat created_timestamp buat umur
    console.log("  price:", fly.price, "1h:", fly.priceChange1h);
  } else {
    console.log("FLY ga ada di scan ini");
  }

  console.log("\n=== TOKEN PANAS (vol>5k, non-other) urut volume ===");
  const hot = res
    .filter((r) => r.category !== "other" && r.volume > 5000)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 15);
  for (const r of hot) {
    const d = evaluateEntry(r);
    console.log(
      `${r.symbol.padEnd(14)} vol ${String(Math.round(r.volume)).padStart(7)} mc ${String(Math.round(r.marketCap)).padStart(8)} buys ${String(r.buys).padStart(4)}/sells ${String(r.sells).padStart(4)} liq ${String(Math.round(r.liquidity)).padStart(7)} hold ${String(r.holders).padStart(5)} kol${r.kol} deg${r.smartDegen} age${r.ageHours.toFixed(1)}h risk ${r.risk.padEnd(6)} => ${d.decision} ${d.reason.slice(0, 80)}`
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });