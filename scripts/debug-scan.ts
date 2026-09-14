import "dotenv/config";
import { getSettings } from "../src/settings/index.js";
import { scanNow } from "../src/scanner/scanner.js";
import { evaluateEntry } from "../src/strategy/strategy-engine.js";
import * as risk from "../src/risk/risk-manager.js";

const fmtK = (n: number | null | undefined): string => {
  if (n == null || Number.isNaN(n)) return "?";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + n.toFixed(0);
};

async function main() {
  const s = getSettings();
  const f = s.filters;
  console.log("=== SETTINGS ===");
  console.log(`mode=${s.mode} autoTrade=${s.autoTrade} source=${s.scanSource} trend=${s.trendingInterval}`);
  console.log(`riskCap=${s.riskCap} posSize=${s.positionSizeEth} maxPos=${s.maxPositions}`);
  console.log(`filters: liq>${f.minLiquidity} vol>${f.minVolume} vol5m>${f.minVolume5m} mcap ${f.minMcapUsd}-${f.maxMcapUsd} ` +
    `age ${f.minAgeHours}-${f.maxAgeHours}h liq>${f.minLiquidity} top10<=${f.maxTop10HolderPct} minHolders=${f.minHolders} ` +
    `minBuys=${f.minBuys24h} callout>${f.minCalloutCount} KOL>${f.minKol} degen>${f.minSmartDegen} fees>${f.minFees} ` +
    `tax<=${f.maxTaxPct} 1h<=${f.max1hChangePct}% reqOpenSrc=${f.requireOpenSource} reqRenounced=${f.requireRenounced} nomax1h=${!f.max1h}`);

  console.log("\n### AMBIL SCAN (fresh)...");
  const results = await scanNow(30, true);
  console.log("total token:", results.length);
  const sorted = [...results].sort((a, b) => b.volume - a.volume);
  const candidates = [];
  for (const r of sorted.slice(0, 25)) {
    const d = evaluateEntry(r);
    console.log(`\n${r.symbol}  ${r.address.slice(0,6)}…${r.address.slice(-4)}`);
    console.log(`   cat=${r.category} prog=${(r.progress*100).toFixed(0)}% age=${r.ageHours.toFixed(1)}h risk=${r.risk}`);
    console.log(`   MC=${fmtK(r.marketCap)} vol24h=${fmtK(r.volume)} liq=${fmtK(r.liquidity)}`);
    console.log(`   buys=${r.buys} sells=${r.sells} holders=${r.holders} top10=${r.top10HolderPct}% KOL=${r.kol} degen=${r.smartDegen} fees=${r.fees} tax=${r.buyTax}/${r.sellTax}% 1h=${r.priceChange1h.toFixed(1)}%`);
    console.log(`   wash=${r.washTrading} creatorClose=${r.creatorClose} honeypot=${r.honeypot} openSrc=${r.openSource} renounced=${r.renounced} callout=${r.calloutCount}+${r.tgCallCount}`);
    console.log(`   → ${d.decision}: ${d.reason}`);
    if (d.decision === "BUY") {
      const rc = risk.checkEntry(r.address, s.positionSizeEth);
      console.log(`   risk: ${rc.ok ? "OK" : "GAGAL: " + rc.reason}`);
      if (rc.ok) candidates.push(r.symbol);
    }
  }
  console.log("\n### KANDIDAT LOLOS:", candidates.length ? candidates.join(", ") : "(tidak ada)");
}
main().catch(e => { console.error("FAIL:", e?.message || e); process.exit(1); });