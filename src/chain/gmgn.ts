import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { config } from "../config/index.js";

const execFileAsync = promisify(execFile);

// ---------- GMGN rate-limit backoff ----------
// Begitu kena 429/RATE_LIMIT_BANNED, jangan sentuh GMGN lagi sampai waktu reset —
// tiap request ekstra memperpanjang ban (+5s s/d 5 menit). Semua panggilan
// berikutnya fast-fail dengan throw singkat, jadi bot tidak mem-bully endpoint.
let until = 0;
let reason = "";
let lastCallAt = 0;
/** Gap minimal antar panggilan GMGN (ms) — cegah burst yang memicu rate-limit. */
const MIN_CALL_GAP = 1_500;
/** Tidur singkat utility. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Apakah GMGN lagi di-backoff (rate-limit)? */
export function inBackoff(): boolean {
  return Date.now() < until;
}

/** Sisa detik backoff (0 = siap). */
export function backoffSecs(): number {
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

function setBackoff(ms: number, why: string) {
  until = Date.now() + ms;
  reason = why;
  console.log(`[gmgn] rate-limit backoff ${Math.ceil(ms / 1000)}s (${why})`);
}

/** Parse "Rate limit resets at 2026-09-09 15:29:21 GMT+08:00" → epoch ms. */
function parseResetAt(msg: string): number | null {
  const m = msg.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s*(GMT[+-]\d{2}:?\d{2})/i);
  if (!m) return null;
  const iso = m[1].replace(" ", "T") + m[2].replace("GMT", ""); // 2026-09-09T15:29:21+08:00
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

/** "~289s remaining" atau "~170s remaining" → duration ms. */
function parseRemainingSecs(msg: string): number | null {
  const m = msg.match(/~?(\d+)\s*s\s*(?:remaining)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n * 1000 : null;
}

const RATE_RE = /429|RATE_LIMIT|rate limit|temporarily banned|too many requests|ban/i;

export interface GmgnResult<T = unknown> {
  code: number;
  data: T;
  msg?: string;
}

/** Run a gmgn-cli command and return parsed JSON. */
export async function gmgn<T = any>(
  args: string[],
  opts: { raw?: boolean; timeoutMs?: number } = {}
): Promise<T> {
  // Fast-fail selama backoff — TIDAK menyentuh CLI sama sekali.
  if (inBackoff()) {
    throw new Error(`gmgn rate-limit backoff ${backoffSecs()}s (${reason})`);
  }
  // Rate gate: jaga jarak minimal antar panggilan (cegah burst paralel —
  // mis. monitor 5 posisi → 5 call bersamaan — yang memicu ban).
  while (true) {
    const wait = lastCallAt + MIN_CALL_GAP - Date.now();
    if (wait <= 0) break;
    await sleep(wait);
  }
  lastCallAt = Date.now();
  const cli = config.gmgn.cliPath;
  const finalArgs = [...args];
  if (opts.raw) finalArgs.push("--raw");
  const env = {
    ...process.env,
    GMGN_API_KEY: config.gmgn.apiKey,
    GMGN_PRIVATE_KEY: config.gmgn.privateKeyPem,
    GMGN_ALLOW_AUTOMATED_TRADES: "1", // explicit — CLI butuh ini + --yes buat non-interactive swap
    HOME: os.homedir(),
  };
  const { stdout } = await execFileAsync(cli, finalArgs, {
    env,
    timeout: opts.timeoutMs ?? 60000,
    maxBuffer: 10 * 1024 * 1024,
  }).catch((err: any) => {
    // execFile reject = CLI exit non-zero (misal 429 rate limit / no route) — bawa stderr biar ketahuan
    const stderr = String(err?.stderr || "").replace(/\s+/g, " ").trim().slice(0, 800);
    const full = `${err?.message || err} | stderr: ${stderr}`;
    if (RATE_RE.test(full)) {
      // Hitung durasi backoff dari pesan error GMGN
      const resetAt = parseResetAt(stderr) || parseResetAt(full);
      const remain = parseRemainingSecs(stderr) || parseRemainingSecs(full);
      const ms = resetAt ? Math.max(5_000, resetAt - Date.now() + 10_000) : remain || 300_000;
      // Jangan pakai awal stderr (sering cuma header "⚠️ Swap — confirmation required"
      // yang SELALU dicetak CLI walau sukses) — cari kalimat rate-limit aslinya.
      const rateMatch = full.match(/429[^|]*|RATE_LIMIT[^|]{0,120}|rate limit[^|]{0,120}|temporarily banned[^|]{0,80}|too many requests[^|]{0,80}/i);
      setBackoff(ms, (rateMatch ? rateMatch[0] : full.slice(-240)).slice(0, 200));
    }
    throw new Error(`gmgn-cli gagal: ${err?.message || err}${stderr ? " | stderr: " + stderr : ""}`);
  });
  const parsed = JSON.parse(stdout);
  if (parsed && typeof parsed === "object" && "code" in parsed && parsed.code !== 0) {
    throw new Error(`gmgn error ${parsed.code}: ${parsed.msg || parsed.error || JSON.stringify(parsed)}`);
  }
  return (parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed) as T;
}

// ---------- market ----------

export interface TrendingToken {
  address: string;
  name: string;
  symbol: string;
  price: number;
  price_change_percent: number;
  price_change_percent1m: number;
  price_change_percent5m: number;
  price_change_percent1h: number;
  volume: number;
  liquidity: number;
  market_cap: number;
  swaps: number;
  buys: number;
  sells: number;
  holder_count: number;
  top_10_holder_rate: number;
  open_timestamp: number;
  creation_timestamp: number;
  launchpad: string;
  launchpad_platform: string;
  launchpad_status: string;
  twitter_username: string;
  website: string;
  telegram: string;
  burn_ratio: number;
  burn_status: string;
  creator: string;
  creator_token_status: string;
  creator_close: boolean;
  hot_level: number;
  is_wash_trading: boolean;
  image_dup: string;
  cto_flag: number;
  [key: string]: unknown;
}

export function marketTrending(interval: string, limit = 20): Promise<TrendingToken[]> {
  // GMGN returns { rank: [...] } inside data for trending
  return gmgn<any>([
    "market", "trending",
    "--chain", config.chain,
    "--interval", interval,
    "--limit", String(limit),
    "--raw",
  ]).then((d) => {
    const arr = Array.isArray(d) ? d : d?.rank || d?.data || [];
    return arr as TrendingToken[];
  });
}

// ---------- trenches (bonding-curve categories) ----------

export type TrenchesType = "new_creation" | "near_completion" | "completed";

export interface TrenchesToken {
  address: string;
  symbol: string;
  name: string;
  price: number;
  market_cap: number;
  liquidity: number;
  volume_24h: number;
  swaps_24h: number;
  buys_24h: number;
  sells_24h: number;
  holder_count: number;
  top_10_holder_rate: number;
  progress: number; // bonding curve 0..1
  status: number;
  created_timestamp: number;
  open_timestamp: number;
  launchpad: string;
  is_honeypot: string; // "yes" | "no" | "unknown"
  open_source: string; // "yes" | "no" | ""
  owner_renounced: string; // "yes" | "no" | "unknown"
  buy_tax: number;
  sell_tax: number;
  total_buy_tax: number;
  total_sell_tax: number;
  entrapment_ratio: number;
  creator_token_status: string;
  is_wash_trading: boolean;
  [key: string]: unknown;
}

/**
 * Trenches = bonding-curve staged list. Can query per category:
 * new_creation / near_completion / completed.
 * Server-side min/max filter keeps the payload small.
 */
export async function marketTrenches(opts: {
  types?: TrenchesType[];
  minProgress?: number;
  maxProgress?: number;
  minMarketCap?: number;
  maxMarketCap?: number;
  minVolume24h?: number;
  limit?: number;
} = {}): Promise<Record<TrenchesType, TrenchesToken[]>> {
  const args = ["market", "trenches", "--chain", config.chain, "--raw"];
  const types = opts.types || ["new_creation", "near_completion", "completed"];
  for (const t of types) args.push("--type", t);
  if (opts.limit) args.push("--limit", String(opts.limit));
  if (opts.minProgress != null) args.push("--min-progress", String(opts.minProgress));
  if (opts.maxProgress != null) args.push("--max-progress", String(opts.maxProgress));
  if (opts.minMarketCap != null) args.push("--min-marketcap", String(opts.minMarketCap));
  if (opts.maxMarketCap != null) args.push("--max-marketcap", String(opts.maxMarketCap));
  if (opts.minVolume24h != null) args.push("--min-volume-24h", String(opts.minVolume24h));
  const d = await gmgn<any>(args, { timeoutMs: 90_000 });
  return {
    new_creation: (d?.new_creation || []) as TrenchesToken[],
    near_completion: (d?.near_completion || []) as TrenchesToken[],
    completed: (d?.completed || []) as TrenchesToken[],
  };
}

export function tokenInfo(address: string): Promise<any> {
  return gmgn<any>(["token", "info", "--chain", config.chain, "--address", address, "--raw"]);
}

export function tokenSecurity(address: string): Promise<any> {
  return gmgn<any>(["token", "security", "--chain", config.chain, "--address", address, "--raw"]);
}

export function tokenPool(address: string): Promise<any> {
  return gmgn<any>(["token", "pool", "--chain", config.chain, "--address", address, "--raw"]);
}

/** Quote token address for a token's main pool. Native (0x000..0) = ETH quote. */
export async function quoteTokenOf(address: string): Promise<{ symbol: string; address: string }> {
  try {
    const pool = await tokenPool(address);
    const q = pool?.pool ?? pool?.data ?? pool;
    const addr = q?.quote_address ? String(q.quote_address) : "";
    const native = addr === "" || /^0x0{40}$/i.test(addr) || addr.toLowerCase() === "0x0000000000000000000000000000000000000000";
    return { symbol: native ? "ETH" : String(q?.quote_symbol || "quote"), address: native ? NATIVE_TOKEN[config.chain] || "0x0000000000000000000000000000000000000000" : addr };
  } catch {
    // pool lookup can fail; default to native ETH quote
    return { symbol: "ETH", address: NATIVE_TOKEN[config.chain] || "0x0000000000000000000000000000000000000000" };
  }
}

export function tokenHolders(address: string, limit = 20): Promise<any> {
  return gmgn<any>([
    "token", "holders", "--chain", config.chain, "--address", address,
    "--limit", String(limit), "--raw",
  ]);
}

export function marketKline(address: string, resolution = "1h", from?: number, to?: number): Promise<any> {
  const args = [
    "market", "kline", "--chain", config.chain, "--address", address,
    "--resolution", resolution, "--raw",
  ];
  if (from) args.push("--from", String(from));
  if (to) args.push("--to", String(to));
  return gmgn<any>(args);
}

/** Signal types 1–21. Default: all. Group JSON optional. */
export function marketSignal(groupJson?: string, limit = 10): Promise<any> {
  const args = ["market", "signal", "--chain", config.chain, "--raw"];
  if (groupJson) args.push("--groups", groupJson);
  return gmgn<any>(args);
}

export function searchTokens(query: string, limit = 10): Promise<any> {
  return gmgn<any>([
    "market", "search", "--query", query, "--chain", config.chain,
    "--limit", String(limit), "--raw",
  ]);
}

// ---------- portfolio ----------

export function walletHoldings(address: string, limit = 20): Promise<any> {
  return gmgn<any>([
    "portfolio", "holdings", "--chain", config.chain, "--wallet", address,
    "--limit", String(limit), "--raw",
  ]);
}

export function walletActivity(address: string, limit = 10): Promise<any> {
  return gmgn<any>([
    "portfolio", "activity", "--chain", config.chain, "--wallet", address,
    "--limit", String(limit), "--raw",
  ], { timeoutMs: 90_000 });
}

/** Smart money trades (track.smartmoney) — recent buys by tracked wallets. */
export function trackSmartMoney(limit = 30, side?: "buy" | "sell"): Promise<any> {
  const args = ["track", "smartmoney", "--chain", config.chain, "--limit", String(limit), "--raw"];
  if (side) args.push("--side", side);
  return gmgn<any>(args, { timeoutMs: 90_000 });
}

/** Follow-wallet trades (track.follow-wallet) — optional wallet filter. */
export function trackFollowWallet(wallet?: string, limit = 30): Promise<any> {
  const args = ["track", "follow-wallet", "--chain", config.chain, "--limit", String(limit), "--raw"];
  if (wallet) args.push("--wallet", wallet);
  return gmgn<any>(args, { timeoutMs: 90_000 });
}

export function isCliAvailable(): boolean {
  return fs.existsSync(config.gmgn.cliPath);
}

export function cliHelp(): string {
  return config.gmgn.cliPath;
}

// ---------- swap (execution) ----------

export interface SwapParams {
  chain?: string;
  from?: string; // wallet address (must match API key binding)
  inputToken: string;
  outputToken: string;
  /** raw amount in smallest unit, OR percent (0-100) when input is native/currency */
  amount?: string;
  percent?: number;
  slippage?: number; // e.g. 30 = 30%
  minOutput?: string;
  conditionOrders?: string; // JSON string
  useAutoSlippage?: boolean;
}

export function swapQuote(params: SwapParams): Promise<any> {
  const args = ["swap", "quote", "--chain", params.chain || config.chain];
  if (params.from) args.push("--from", params.from);
  if (params.inputToken) args.push("--input-token", params.inputToken);
  if (params.outputToken) args.push("--output-token", params.outputToken);
  if (params.amount) args.push("--amount", params.amount);
  if (params.percent != null) args.push("--percent", String(params.percent));
  if (params.slippage != null) args.push("--slippage", String(params.slippage));
  if (params.minOutput) args.push("--min-output", params.minOutput);
  args.push("--raw");
  return gmgn<any>(args, { timeoutMs: 90_000 });
}

export function executeSwap(params: SwapParams): Promise<any> {
  const args = ["swap", "--chain", params.chain || config.chain];
  if (params.from) args.push("--from", params.from);
  if (params.inputToken) args.push("--input-token", params.inputToken);
  if (params.outputToken) args.push("--output-token", params.outputToken);
  if (params.amount) args.push("--amount", params.amount);
  if (params.percent != null) args.push("--percent", String(params.percent));
  if (params.slippage != null) args.push("--slippage", String(params.slippage));
  if (params.minOutput) args.push("--min-output", params.minOutput);
  if (params.conditionOrders) args.push("--condition-orders", params.conditionOrders);
  args.push("--yes", "--raw");
  return gmgn<any>(args, { timeoutMs: 120_000 });
}

/** Native currency address for EVM chains used by GMGN (ETH/BNB). */
export const NATIVE_TOKEN = {
  robinhood: "0x0000000000000000000000000000000000000000", // native
  base: "0x0000000000000000000000000000000000000000",
  bsc: "0x0000000000000000000000000000000000000000",
  eth: "0x0000000000000000000000000000000000000000",
} as Record<string, string>;

export function isNativeToken(addr: string): boolean {
  if (!addr) return true;
  const a = addr.toLowerCase();
  return (
    a === "0x0000000000000000000000000000000000000000" ||
    a === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" ||
    a === "native"
  );
}