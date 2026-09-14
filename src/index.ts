import { config } from "./config/index.js";
import { startBot, stopBot, sendAdmin } from "./notifications/telegram.js";
import * as gmgn from "./chain/gmgn.js";
import { EventIngestor } from "./chain/events.js";
import { AutoEngine } from "./auto/index.js";
import * as walletMgr from "./wallet/index.js";
import { getSettings } from "./settings/index.js";

let shuttingDown = false;
let engine: AutoEngine | null = null;
let ingestor: EventIngestor | null = null;

async function main() {
  console.log("===== Robinhood Chain Bot =====");
  console.log(`Mode:   ${config.mode}`);
  console.log(`Chain:  ${config.chain}`);
  console.log(`RPC:    ${config.rpcUrl.replace(/\/v2\/.*/, "/v2/…")}`);
  console.log(`CLI:    ${config.gmgn.cliPath} (exists: ${gmgn.isCliAvailable()})`);

  if (!config.gmgn.apiKey) {
    console.warn("⚠️  GMGN_API_KEY kosong — pastikan ~/.config/gmgn/.env terisi.");
  }

  // sanity RPC check
  try {
    const { createPublicClient, http } = await import("viem");
    const client = createPublicClient({
      transport: http(config.rpcUrl),
    });
    const chainId = await client.getChainId();
    console.log(`RPC chainId: ${chainId}`);
  } catch (e: any) {
    console.warn("RPC check gagal (non-fatal):", e.message || String(e));
  }

  await startBot();
  console.log("[main] Telegram bot aktif. Auto-engine start…");

  engine = new AutoEngine(sendAdmin, walletMgr.getActiveWallet()?.address);
  await engine.start();
  console.log("[main] Auto-engine aktif. Ctrl+C untuk stop.");

  // WebSocket event ingestor — real-time block trigger (default OFF: boros CU Alchemy, scan timer 60s udah cukup)
  if (config.rpcUrl && config.eventsWsEnabled) {
    ingestor = new EventIngestor({
      rpcHttpUrl: config.rpcUrl,
      rpcWsUrl: config.rpcWsUrl,
      onBlock: (block) => {
        engine?.triggerScan();
      },
      onError: (err) => console.log("[events] ingestor error:", err?.message || err),
    });
    const ok = await ingestor.start();
    if (!ok) console.log("[events] ingestor nonaktif — fallback ke interval polling.");
  }

  const cleanup = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nShutting down…");
    await ingestor?.stop().catch(() => {});
    engine?.stop();
    await stopBot().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});