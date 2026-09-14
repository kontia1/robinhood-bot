import { getSettings } from "../src/settings/index.js";
import { scanNow } from "../src/scanner/scanner.js";
import { evaluateEntry } from "../src/strategy/strategy-engine.js";

async function main() {
  const results = await scanNow(30, true);
  const s = getSettings();
  const f = s.filters;
  console.log("total:", results.length, "| current minBuyPressure:", f.minBuyPressure);
  for (const th of [0.7, 0.65, 0.6, 0.55, 0.5]) {
    const pass = [];
    for (const r of results) {
      const total = r.buys + r.sells;
      const bp = total > 0 ? r.buys / total : 0;
      // simulasi: ganti threshold buy pressure aja, sisanya pakai evaluateEntry biasa
      const bak = f.minBuyPressure;
      (f as any).minBuyPressure = th;
      const d = evaluateEntry(r);
      (f as any).minBuyPressure = bak;
      if (d.decision === "BUY") pass.push(r.symbol);
    }
    console.log(`buyPressure >= ${th}: ${pass.length} lolos ${pass.slice(0,12).join(", ")}`);
  }
}
main().catch(e => { console.error("FAIL:", e?.message || e); process.exit(1); });
