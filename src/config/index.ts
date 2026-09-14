import "dotenv/config";
import path from "node:path";
import os from "node:os";

function envStr(key: string, fallback = ""): string {
  return process.env[key] || fallback;
}

export const config = {
  mode: (envStr("MODE", "dry-run") === "live" ? "live" : "dry-run") as "dry-run" | "live",
  chain: envStr("CHAIN_ID", "robinhood"),
  // RPC/WS di-derive dari ALCHEMY_API_KEY — cukup 1 key di .env, gak perlu tulis URL 1-1.
  // Override eksplisit tetap dihormati kalau RPC_URL / RPC_WS_URL di-set.
  rpcUrl: envStr("RPC_URL") || (envStr("ALCHEMY_API_KEY") ? `https://robinhood-mainnet.g.alchemy.com/v2/${envStr("ALCHEMY_API_KEY")}` : ""),
  rpcWsUrl: envStr("RPC_WS_URL") || (envStr("ALCHEMY_API_KEY") ? `wss://robinhood-mainnet.g.alchemy.com/v2/${envStr("ALCHEMY_API_KEY")}` : ""),
  // WebSocket newHeads — chain ini ~0.2s/block (~750K notif/hari ke Alchemy!). Scan udah
  // di-throttle scanIntervalMs (60s), jadi WS cuma buang compute unit tanpa tambah frekuensi scan.
  // Default MATI. Nyalakan dengan EVENTS_WS_ENABLED=true kalau butuh trigger realtime.
  eventsWsEnabled: envStr("EVENTS_WS_ENABLED", "false") === "true",
  gmgn: {
    apiKey: envStr("GMGN_API_KEY"),
    privateKeyPem: envStr("GMGN_PRIVATE_KEY"),
    cliPath: path.resolve("node_modules/.bin/gmgn-cli"),
    dataDir: envStr("GMGN_DATA_DIR", path.join(os.homedir(), ".config", "gmgn")),
  },
  uniswap: {
    apiKey: envStr("UNISWAP_API_KEY"),
    baseUrl: envStr("UNISWAP_API_URL", "https://trade-api.gateway.uniswap.org/v1"),
  },
  telegram: {
    token: envStr("TELEGRAM_BOT_TOKEN"),
    chatId: envStr("TELEGRAM_CHAT_ID"),
    allowedIds: envStr("TELEGRAM_ALLOWED_IDS")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number),
  },
  scheduler: {
    scanIntervalMs: Number(envStr("SCAN_INTERVAL_MS", "60000")),
    managementIntervalMs: Number(envStr("MANAGEMENT_INTERVAL_MS", "30000")),
  },
};

export function isAllowedTelegramId(id: number): boolean {
  if (!config.telegram.allowedIds.length) return true;
  return config.telegram.allowedIds.includes(id);
}