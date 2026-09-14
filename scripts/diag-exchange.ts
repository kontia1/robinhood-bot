/** Cek field exchange + quote_address_type di raw GMGN trenches robinhood. */
import dotenv from "dotenv";
dotenv.config();
import * as gmgn from "../src/chain/gmgn.js";

async function main() {
  const t = await gmgn.marketTrenches({ limit: 10 });
  for (const k of ["new_creation", "near_completion", "completed"]) {
    const arr = (t as any)[k] || [];
    console.log("==", k, "(", arr.length, ")");
    for (const tok of arr.slice(0, 5)) {
      console.log(
        `  ${tok.symbol.padEnd(14)} exchange=${String(tok.exchange).padEnd(12)} quote_type=${String(tok.quote_address_type).padEnd(8)} quote=${String(tok.quote_address).slice(0, 10)} price=${tok.price} mc=${Math.round(tok.market_cap)} vol=${Math.round(tok.volume_24h)} progress=${tok.progress}`
      );
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });