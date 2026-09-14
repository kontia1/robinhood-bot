/**
 * Scanner pipeline — pulls data from GMGN Trenches (bonding-curve staged),
 * classifies tokens into categories (new-bonding / bonding-radar / momentum),
 * scores + risk-ranks, stores results.
 * Scanner NEVER trades. Trade decisions happen in strategy/risk/execution layers.
 */
import * as gmgn from "../chain/gmgn.js";
import { config } from "../config/index.js";
import { getSettings } from "../settings/index.js";
import * as dupe from "../dupe/blocklist.js";

let lastBackoffLoggedAt = 0;

export type BondingCategory = "new-bonding" | "bonding-radar" | "momentum" | "other";

export interface ScanResult {
  address: string;
  name: string;
  symbol: string;
  price: number;
  priceChange1h: number;
  volume: number;
  liquidity: number;
  marketCap: number;
  buys: number;
  sells: number;
  holders: number;
  top10HolderPct: number | null;
  kol: number; // renowned / KOL wallet count (smart money pelacak)
  smartDegen: number; // smart degen wallet count
  fees: number; // total LP fees (native units) — proxy volume organik
  ageHours: number;
  washTrading: boolean;
  creatorClose: boolean;
  progress: number; // bonding curve 0..1
  category: BondingCategory;
  honeypot: boolean;
  openSource: boolean;
  renounced: boolean;
  buyTax: number;
  sellTax: number;
  calloutCount: number; // token di-callout channel/grup (promosi berbayar ≈ dev keluar duit)
  tgCallCount: number;
  visitingCount: number;
  signals: string[];
  risk: "LOW" | "MEDIUM" | "HIGH";
}

let lastScan: ScanResult[] = [];
let lastScanAt = 0;

const SCAN_INTERVAL_MS = config.scheduler.scanIntervalMs || 60_000;
const MAX_SCAN_ITEMS = 40;

/** Rule thresholds (matches user spec). */
const RULES = {
  newBonding: { minProgress: 0.15, maxMc: 10_000 },
  bondingRadar: { minProgress: 0.35, maxProgress: 0.99, minMc: 10_000 },
  momentumMc: 10_000,
  momentumVol: 5_000, // "ada gerakan volume" — min 24h volume USD
};

/** Classify a trenches token into a bonding category using the user rules. */
export function classify(t: gmgn.TrenchesToken, srcType?: string): BondingCategory {
  const p = t.progress ?? 0;
  const mc = t.market_cap || 0;
  const vol = t.volume_24h || 0;
  // 1) Type eksplisit dari GMGN trenches — sumber paling akurat (robinhood
  //    bonding curve ramp cepat: new_creation progress ~0.0001, near_completion ~0.2,
  //    jadi rule berbasis angka di bawah sering salah kategorikan → "other" → ke-reject
  //    padahal token valid (vol 20-50K, holders ribuan).
  if (srcType === "new_creation") return "new-bonding";
  if (srcType === "near_completion") return "bonding-radar";
  if (srcType === "completed") return "momentum";
  // 2) Fallback rule-based (tanpa type — trending dll): pake volume sebagai gerbang
  //    utama untuk momentum (bukan mc), biar token completed tapi mcap kecil tetap masuk.
  if (p >= 0.99 && vol >= RULES.momentumVol) return "momentum";
  if (p >= RULES.newBonding.minProgress && p < 0.99 && mc <= RULES.newBonding.maxMc) return "new-bonding";
  if (p >= RULES.bondingRadar.minProgress && p < 0.99 && mc >= RULES.bondingRadar.minMc) return "bonding-radar";
  if (mc >= RULES.momentumMc && vol >= RULES.momentumVol) return "momentum";
  return "other";
}

function toNum(x: unknown): number {
  const n = typeof x === "number" ? x : Number(x ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function fromTrenches(t: gmgn.TrenchesToken, nowMs: number, srcType?: string): ScanResult {
  const cats = classify(t, srcType);
  return {
    address: t.address,
    name: t.name,
    symbol: t.symbol,
    price: toNum(t.price),
    priceChange1h: 0, // trenches doesn't give 1h change; keep 0 (momentum uses volume)
    volume: toNum(t.volume_24h),
    liquidity: toNum(t.liquidity),
    marketCap: toNum(t.market_cap),
    buys: toNum(t.buys_24h ?? 0),
    sells: toNum(t.sells_24h ?? 0),
    holders: toNum(t.holder_count),
    top10HolderPct: t.top_10_holder_rate != null ? Math.round(toNum(t.top_10_holder_rate) * 100) : null,
    kol: toNum(t.renowned_count ?? 0),
    smartDegen: toNum(t.smart_degen_count ?? 0),
    fees: toNum(t.total_fee ?? 0),
    ageHours: ageHoursOf(t, nowMs),
    washTrading: !!t.is_wash_trading,
    creatorClose: String(t.creator_token_status || "").toLowerCase().includes("close"),
    progress: toNum(t.progress),
    category: cats,
    honeypot: String(t.is_honeypot || "").toLowerCase() === "yes",
    openSource: String(t.open_source || "").toLowerCase() === "yes",
    renounced: String(t.owner_renounced || "").toLowerCase() === "yes",
    buyTax: toNum(t.buy_tax ?? t.total_buy_tax ?? 0),
    sellTax: toNum(t.sell_tax ?? t.total_sell_tax ?? 0),
    calloutCount: toNum(t.callout_count ?? 0),
    tgCallCount: toNum(t.tg_call_count ?? 0),
    visitingCount: toNum(t.visiting_count ?? 0),
    signals: deriveSignals(t, cats),
    risk: riskLevel(t, srcType),
  };
}

export async function scanNow(limit: number = MAX_SCAN_ITEMS, force = false): Promise<ScanResult[]> {
  const now = Date.now();
  if (!force && lastScan.length && now - lastScanAt < SCAN_INTERVAL_MS) {
    return lastScan;
  }
  // GMGN lagi rate-limit backoff → skip scan tanpa spam log (sekali tiap periode).
  if (gmgn.inBackoff()) {
    if (lastBackoffLoggedAt !== gmgn.backoffSecs()) {
      console.log(`[scanner] GMGN backoff ${gmgn.backoffSecs()}s — scan data kosong sampai reset`);
      lastBackoffLoggedAt = gmgn.backoffSecs();
    }
    // tetap update lastScanAt biar interval ga numpuk
    lastScan = [];
    lastScanAt = now;
    return [];
  }
  const s = getSettings();
  const source = s.scanSource || "both";
  const nowMs = Date.now();
  const byAddr = new Map<string, ScanResult>();

  // source 1: trenches (bonding-curve staged)
    if (source === "trenches" || source === "both") {
      try {
        const trenches = await gmgn.marketTrenches({ limit });
        for (const [type, arr] of Object.entries(trenches)) {
          for (const t of arr) {
            const r = fromTrenches(t, nowMs, type);
            byAddr.set(r.address.toLowerCase(), r);
          }
        }
      } catch (e: any) {
      // GMGN sering RATE_LIMIT_BANNED — skip source, jangan throw biar scan & bot tetap hidup
      console.log(`[scanner] trenches gagal (${(e?.message || String(e)).slice(0, 120)}) — skip`);
    }
  }

  // source 2: trending (market hot, window interval)
  if (source === "trending" || source === "both") {
    try {
      const iv = s.trendingInterval || "1h";
      const trend = await gmgn.marketTrending(iv, limit);
      for (const raw of trend) {
        const shim = trendingToTrenchesLike(raw);
        const r = fromTrenches(shim, nowMs);
        // trending punya 1h change real; trenches hardcode 0 — pakai yang dari trending
        const chg = toNum((raw as any).price_change_percent1h ?? (raw as any).price_change_percent);
        if (Number.isFinite(chg)) r.priceChange1h = chg;
        const addr = r.address.toLowerCase();
        const existing = byAddr.get(addr);
        if (existing) {
          // merge: trending = data market yang lebih fresh (price/1h/volume/konsentrasi)
          existing.priceChange1h = r.priceChange1h || existing.priceChange1h;
          if (r.kol > existing.kol) existing.kol = r.kol;
          if (r.smartDegen > existing.smartDegen) existing.smartDegen = r.smartDegen;
          if (r.fees > existing.fees) existing.fees = r.fees;
        } else {
          byAddr.set(addr, r);
        }
      }
    } catch (e: any) {
      console.log(`[scanner] trending gagal (${(e?.message || String(e)).slice(0, 120)}) — skip`);
    }
  }

  let results = [...byAddr.values()];

    // Anti-dupe: kalau toggle ON, cuma simpan token original pertama muncul per
    // kombinasi ticker+nama. Copycat (address beda, ticker+nama sama) di-skip.
    if (getSettings().filters.blockDuplicateTickerName) {
      let dupes = 0;
      const kept: ScanResult[] = [];
      for (const r of results) {
        const verdict = dupe.checkAndRegister(r.address, r.symbol, r.name);
        if (verdict === "duplicate") {
          dupes++;
          continue;
        }
        kept.push(r);
      }
      if (dupes > 0) console.log(`[scanner] anti-dupe: skip ${dupes} copycat (ticker+nama udah ada)`);
      results = kept;
    }

  lastScan = results;
  lastScanAt = now;
  return results;
}

/**
 * Normalize GMGN trending token → shape yang dimengerti fromTrenches/classify/
 * computeScore/deriveSignals/riskLevel. Trending tidak punya bonding progress,
 * jadi progress=1 dan security flags dinormalisasi dari boolean/string.
 */
function trendingToTrenchesLike(t: gmgn.TrendingToken): gmgn.TrenchesToken {
  const yn = (v: unknown): string => {
    if (v == null || v === "") return "";
    if (typeof v === "boolean") return v ? "yes" : "no";
    if (typeof v === "number") return v ? "yes" : "no";
    const s = String(v).toLowerCase();
    return s === "1" ? "yes" : s === "0" ? "no" : s;
  };
  const num = (v: unknown, d = 0): number => {
    const n = typeof v === "number" ? v : Number(v ?? d);
    return Number.isFinite(n) ? n : d;
  };
  const anyT = t as any;
  const honeypot = anyT.is_honeypot;
  return {
    address: t.address,
    symbol: t.symbol,
    name: t.name,
    price: t.price,
    market_cap: anyT.market_cap,
    liquidity: anyT.liquidity,
    volume_24h: anyT.volume,
    swaps_24h: anyT.swaps,
    buys_24h: anyT.buys,
    sells_24h: anyT.sells,
    holder_count: anyT.holder_count,
    top_10_holder_rate: anyT.top_10_holder_rate,
    progress: 1,
    status: 1,
    created_timestamp: anyT.creation_timestamp ?? anyT.open_timestamp ?? 0,
    open_timestamp: anyT.open_timestamp ?? 0,
    launchpad: anyT.launchpad_platform ?? anyT.launchpad ?? "",
    is_honeypot: yn(honeypot) || "unknown",
    open_source: yn(anyT.open_source),
    owner_renounced: yn(anyT.owner_renounced),
    buy_tax: num(anyT.buy_tax ?? anyT.total_buy_tax),
    sell_tax: num(anyT.sell_tax ?? anyT.total_sell_tax),
    total_buy_tax: num(anyT.total_buy_tax),
    total_sell_tax: num(anyT.total_sell_tax),
    entrapment_ratio: num(anyT.entrapment_ratio),
    creator_token_status: String(anyT.creator_token_status ?? (anyT.creator_close ? "close" : "")),
    is_wash_trading: !!anyT.is_wash_trading,
    // fields tambahan dari trending yang dibaca scoring/signals
    renowned_count: num(anyT.renowned_count),
    smart_degen_count: num(anyT.smart_degen_count),
    total_fee: num(anyT.gas_fee ?? anyT.total_fee),
    callout_count: num(anyT.callout_count),
    tg_call_count: num(anyT.tg_call_count),
    visiting_count: num(anyT.visiting_count),
  } as gmgn.TrenchesToken;
}

/** Token age in hours from creation/open timestamp (handles s or ms). */
function ageHoursOf(t: gmgn.TrenchesToken, nowMs: number): number {
  const ts = t.created_timestamp ?? t.open_timestamp ?? 0;
  if (!ts) return 0;
  const ms = ts > 1e12 ? ts : ts * 1000;
  if (!ms || ms <= 0) return 0;
  return Math.max(0, (nowMs - ms) / 3_600_000);
}

function deriveSignals(t: gmgn.TrenchesToken, cat: BondingCategory): string[] {
  const sig: string[] = [];
  if (cat === "new-bonding") sig.push("🆕 New bonding");
  else if (cat === "bonding-radar") sig.push("🎯 Bonding radar");
  else if (cat === "momentum") sig.push("🚀 Momentum");
  if (t.volume_24h > 30_000) sig.push("💧 Volume tinggi");
  if (t.buys_24h > 0 && t.swaps_24h > 0 && t.buys_24h / t.swaps_24h > 0.6) sig.push("🟢 Tekanan beli");
  if (t.holder_count > 1000) sig.push("👥 Holder naik");
  if (t.top_10_holder_rate < 0.2) sig.push("🐋 Konsentrasi rendah");
  const kol = Number(t.renowned_count || 0);
  const sd = Number(t.smart_degen_count || 0);
  if (kol >= 5) sig.push(`🤑 KOL ramai (${kol})`);
  else if (kol >= 1) sig.push(`🤑 KOL ${kol}`);
  if (sd >= 5) sig.push(`🧠 Smart degen aktif (${sd})`);
  const fees = Number(t.total_fee || 0);
  if (fees >= 1) sig.push(`💰 Fees ${fees >= 10 ? fees.toFixed(0) : fees.toFixed(1)} (~organik)`);
  if (String(t.is_honeypot || "").toLowerCase() === "no") sig.push("🛡️ Aman honeypot");
  if (String(t.owner_renounced || "").toLowerCase() === "yes") sig.push("🔓 Renounced");
  // promo paid ≈ dev keluar duit — tanda niat
  const calls = Number(t.callout_count || 0) + Number(t.tg_call_count || 0);
  if (calls >= 3) sig.push(`📢 Promo aktif (${calls} callout)`);
  else if (calls > 0) sig.push(`📢 Callout ${calls}`);
  return sig;
}

function riskLevel(t: gmgn.TrenchesToken, srcType?: string): "LOW" | "MEDIUM" | "HIGH" {
  if (String(t.is_honeypot || "").toLowerCase() === "yes") return "HIGH";
  if (!!t.is_wash_trading) return "HIGH";
  if (toNum(t.top_10_holder_rate) > 0.5) return "HIGH";
  const liq = toNum(t.liquidity);
  const holders = toNum(t.holder_count);
  const vol = toNum(t.volume_24h);
  // Bonding curve belum selesai (new_creation/near_completion): liquidity $0-1k itu NORMAL
  // karena pool-nya belum ke-isi penuh — jangan nilai HIGH cuma gara-gara liq kecil.
  // Yang beneran jeblok: token mati (0 vol + 0 holder).
  if (srcType === "new_creation" || srcType === "near_completion") {
    if (vol === 0 && holders === 0) return "HIGH";
    if (holders < 20 && vol < 500) return "MEDIUM";
    return "LOW";
  }
  // completed / trending: ini pool beneran — liq kecil = berbahaya
  if (liq < 3_000) return "HIGH";
  if (holders < 20) return "MEDIUM";
  return "LOW";
}

export function getLastScan(): ScanResult[] {
  return lastScan;
}

export function isScanStale(ms: number): boolean {
  return !lastScanAt || Date.now() - lastScanAt > ms;
}