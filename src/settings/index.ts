import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_FILE = process.env.SETTINGS_FILE
  ? path.resolve(process.env.SETTINGS_FILE)
  : path.resolve(__dirname, "../../settings.json");

export interface FilterSettings {
  minLiquidity: number; // USD
  minVolume: number; // USD (24h)
  minVolume5m: number; // USD; 0 = off — skip token mati (volume 5 menit terakhir nol)
  minBuyPressure: number; // 0..1
  maxTop10HolderPct: number; // 0..100
  minHolders: number; // 0 = off
  minAgeHours: number; // 0 = off
  maxAgeHours: number; // 0 = off
  max5mChangePct: number; // 0 = off
  max1hChangePct: number; // 0 = off
  minBuys24h: number; // 0 = off
  minCalloutCount: number; // 0 = off; proxy utk "dev keluar duit promosi" (token di-callout channel)
  minKol: number; // 0 = off; minimal KOL / renowned wallet count (smart money pelacak)
  minSmartDegen: number; // 0 = off; minimal smart degen wallet count
  minFees: number; // 0 = off; minimal total LP fees (native units) — proxy volume organik
  minMcapUsd: number; // 0 = off; batas bawah market cap (skip token terlalu kecil)
  maxMcapUsd: number; // 0 = off; batas atas market cap (anti beli token udah pump)
  blockWashTrading: boolean;
  blockCreatorClose: boolean;
  /** Cegah masuk token yang sama kalau masih di-hold (toggle). */
  blockDuplicateToken: boolean;
  /** Anti-dupe ticker+nama: cuma beli original pertama muncul, skip copycat (toggle). */
  blockDuplicateTickerName: boolean;
  /** Cooldown re-entry setelah token di-close (jam). 0 = off. */
  reEntryCooldownHours: number;
  // bonding-curve category toggles (trenches)
  enableNewBonding: boolean; // progress >=15% && mc <= 10k
  enableBondingRadar: boolean; // progress 35-99% && mc >= 10k
  enableMomentum: boolean; // mc >= 10k && volume moving
  // security flags (server-side fields from trenches)
  blockHoneypot: boolean;
  requireOpenSource: boolean;
  requireRenounced: boolean;
  maxTaxPct: number; // 0 = off; reject if buy/sell tax > this
}

export interface BotSettings {
  mode: "dry-run" | "live";
  scanIntervalMs: number;
  /** Data source buat auto-scan: trenches (bonding curve) / trending (market hot) / both. */
  scanSource: "trenches" | "trending" | "both";
  /** Interval trending dipakai saat scanSource pakai trending. */
  trendingInterval: "1m" | "5m" | "1h" | "6h" | "24h";
  /** Auto trade on/off — off = scan + rekomendasi tetap jalan, tapi nggak eksekusi buy. */
  autoTrade: boolean;
  riskCap: "LOW" | "MEDIUM" | "HIGH";
  /** Ukuran posisi dalam ETH (native). Override USD — beli pakai jumlah ETH tetap. */
  positionSizeEth: number;
  stopLossPct: number;
  trailingStopPct: number;
  slippagePct: number;
  maxPositions: number;
  /** TP ladder global (SINGLE TP mechanism) — tiap level: profit % + % posisi awal yang dijual. */
  tpLadder: { pct: number; frac: number }[];
  /** Sisa posisi setelah semua level TP jadi moonbag (default false = close di level terakhir). */
  tpMoonbag: boolean;
  filters: FilterSettings;
  watchWallets: string[]; // wallets to monitor for buys (label biasa, no FOMO)
}

const DEFAULTS: BotSettings = {
  mode: "dry-run",
  scanIntervalMs: 60_000,
  scanSource: "both",
  trendingInterval: "1h",
  autoTrade: true,
  riskCap: "LOW",
  positionSizeEth: 0.05,
  stopLossPct: -15,
  trailingStopPct: 10,
  slippagePct: 20,
  maxPositions: 3,
  tpLadder: [],
  tpMoonbag: false,
  watchWallets: [],
  filters: {
    minLiquidity: 10_000,
    minVolume: 5_000,
    minVolume5m: 0,
    minBuyPressure: 0.6,
    maxTop10HolderPct: 50,
    minHolders: 0,
    minAgeHours: 0,
    maxAgeHours: 0,
    max5mChangePct: 0,
    max1hChangePct: 0,
    minBuys24h: 0,
    minCalloutCount: 0,
    minKol: 0,
    minSmartDegen: 0,
    minFees: 0,
    minMcapUsd: 0,
    maxMcapUsd: 0,
    blockWashTrading: false,
    blockCreatorClose: false,
    blockDuplicateToken: true,
    blockDuplicateTickerName: true,
    reEntryCooldownHours: 24,
    enableNewBonding: true,
    enableBondingRadar: true,
    enableMomentum: true,
    blockHoneypot: true,
    requireOpenSource: false,
    requireRenounced: false,
    maxTaxPct: 10,
  },
};

let cache: BotSettings | null = null;

function load(): BotSettings {
  if (cache) return cache;
  if (!fs.existsSync(SETTINGS_FILE)) {
    cache = { ...DEFAULTS, filters: { ...DEFAULTS.filters } };
    persist(cache);
    return cache;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    cache = {
      ...DEFAULTS,
      ...raw,
      filters: { ...DEFAULTS.filters, ...(raw.filters || {}) },
    };
  } catch {
    cache = { ...DEFAULTS, filters: { ...DEFAULTS.filters } };
  }
  return cache!;
}

function persist(s: BotSettings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
  cache = s;
}

export function getSettings(): BotSettings {
  return load();
}

export const get = getSettings;

/** Generic setter for a top-level numeric field. Clamps to sane bounds. */
export function setNumeric(key: keyof BotSettings, value: number): BotSettings {
  const s = load();
  if (key === "stopLossPct") {
    // SL user ketik positif (misal 15) → simpan negatif (-15) biar ga perlu ketik minus
    const v = clampNumeric(key, Math.abs(value));
    (s as any)[key] = -Math.abs(v);
  } else {
    (s as any)[key] = clampNumeric(key, value);
  }
  persist(s);
  return s;
}

export function setMode(mode: "dry-run" | "live"): BotSettings {
  const s = load();
  s.mode = mode === "live" ? "live" : "dry-run";
  persist(s);
  return s;
}

export function setRiskCap(risk: "LOW" | "MEDIUM" | "HIGH"): BotSettings {
  const s = load();
  s.riskCap = risk;
  persist(s);
  return s;
}

/** Cycle scan source: trenches → trending → both → trenches… */
export function setScanSource(next?: "trenches" | "trending" | "both"): BotSettings {
  const s = load();
  if (next) {
    s.scanSource = next;
  } else {
    const order: BotSettings["scanSource"][] = ["trenches", "trending", "both"];
    s.scanSource = order[(order.indexOf(s.scanSource) + 1) % order.length]!;
  }
  persist(s);
  return s;
}

/** Cycle trending interval. */
export function setTrendingInterval(next?: BotSettings["trendingInterval"]): BotSettings {
  const s = load();
  if (next) {
    s.trendingInterval = next;
  } else {
    const order: BotSettings["trendingInterval"][] = ["1m", "5m", "1h", "6h", "24h"];
    s.trendingInterval = order[(order.indexOf(s.trendingInterval) + 1) % order.length]!;
  }
  persist(s);
  return s;
}

/** Toggle auto trade on/off. */
export function setAutoTrade(next?: boolean): BotSettings {
  const s = load();
  s.autoTrade = next ?? !s.autoTrade;
  persist(s);
  return s;
}

/** Set default global TP ladder (partial take profit utk SEMUA posisi). */
export function setTpLadder(ladder: { pct: number; frac: number }[]): BotSettings {
  const s = load();
  const clean = (ladder || [])
    .filter((l) => Number.isFinite(l.pct) && Number.isFinite(l.frac) && l.pct > 0 && l.frac > 0)
    .sort((a, b) => a.pct - b.pct);
  // total jual per level dihitung dari POSISI AWAL; pastikan gak lebih dari 100%
  let total = 0;
  const valid: { pct: number; frac: number }[] = [];
  for (const l of clean) {
    total += l.frac;
    if (total > 101) break; // toleransi float
    valid.push(l);
  }
  s.tpLadder = valid;
  persist(s);
  return s;
}

/** Toggle moonbag (hold sisa setelah semua level TP). */
export function setTpMoonbag(on: boolean): BotSettings {
  const s = load();
  s.tpMoonbag = !!on;
  persist(s);
  return s;
}

/** Clear TP ladder global (kembali ke TP global full close). */
export function clearTpLadder(): BotSettings {
  return setTpLadder([]);
}

export function setFilter(key: keyof FilterSettings, value: number): BotSettings {
  const s = load();
  (s.filters as any)[key] = clampNumeric(key, value);
  persist(s);
  return s;
}

/** Set boolean filter flags (blockWashTrading / blockCreatorClose). */
export function setFilterBool(key: keyof FilterSettings, value: boolean): BotSettings {
  const s = load();
  (s.filters as any)[key] = !!value;
  persist(s);
  return s;
}

const BOUNDS: Record<string, [number, number]> = {
  scanIntervalMs: [10_000, 600_000],
  positionSizeEth: [0.0001, 100],
  stopLossPct: [1, 90],
  trailingStopPct: [1, 90],
  slippagePct: [0, 100],
  maxPositions: [1, 20],
  minLiquidity: [0, 1_000_000],
  minVolume: [0, 1_000_000],
  minVolume5m: [0, 100_000],
  minBuyPressure: [0, 1],
  maxTop10HolderPct: [0, 100],
  minHolders: [0, 1_000_000],
  minAgeHours: [0, 24 * 365],
  maxAgeHours: [0, 24 * 365],
  max5mChangePct: [0, 1000],
  max1hChangePct: [0, 1000],
  minBuys24h: [0, 100_000],
  minCalloutCount: [0, 10_000],
  minKol: [0, 10_000],
  minSmartDegen: [0, 10_000],
  minFees: [0, 1_000_000],
  minMcapUsd: [0, 1_000_000_000],
  maxMcapUsd: [0, 1_000_000_000],
  reEntryCooldownHours: [0, 24 * 30],
  maxTaxPct: [0, 100],
};

function clampNumeric(key: string, value: number): number {
  const [lo, hi] = BOUNDS[key] || [-Infinity, Infinity];
  return Math.min(hi, Math.max(lo, value));
}

export function describe(key: string): string {
  const names: Record<string, string> = {
    scanIntervalMs: "Scan interval",
    riskCap: "Risk cap",
    scanSource: "Sumber data scan",
    trendingInterval: "Interval trending",
    positionSizeEth: "Position size (ETH)",
    stopLossPct: "Stop loss",
    trailingStopPct: "Trailing stop",
    slippagePct: "Slippage %",
    maxPositions: "Max positions",
    minLiquidity: "Min liquidity",
    minVolume: "Min volume 24h",
    minVolume5m: "Min volume 5m (anti token mati)",
    minBuyPressure: "Min buy pressure",
    maxTop10HolderPct: "Max top10 holders",
    minHolders: "Min holders",
    minAgeHours: "Min umur token (jam)",
    maxAgeHours: "Max umur token (jam)",
    max5mChangePct: "Max pump 5m (%)",
    max1hChangePct: "Max pump 1h (%)",
    minBuys24h: "Min buys 24h",
    minCalloutCount: "Min callout (promosi)",
    minKol: "Min KOL (smart money)",
    minSmartDegen: "Min smart degen",
    minFees: "Min LP fees (native)",
    minMcapUsd: "Min market cap (USD)",
    maxMcapUsd: "Max market cap (USD)",
    blockWashTrading: "Blokir wash trading",
    blockCreatorClose: "Blokir creator closed",
    blockDuplicateToken: "Blokir token double (masih di-hold)",
    blockDuplicateTickerName: "Anti-dupe ticker+nama (original saja)",
    reEntryCooldownHours: "Cooldown re-entry (jam, 0=off)",
    enableNewBonding: "New Bonding (progress 15%+ MC ≤10k)",
    enableBondingRadar: "Bonding Radar (progress 35-99% MC ≥10k)",
    enableMomentum: "Momentum (MC ≥10k + vol)",
    blockHoneypot: "Blokir honeypot",
    requireOpenSource: "Wajib open source",
    requireRenounced: "Wajib renounced",
    maxTaxPct: "Max tax (%)",
  };
  return names[key] || key;
}

export function settingsFilePath(): string {
  return SETTINGS_FILE;
}

// ---------- watch wallets ----------

const WATCH_FILE = path.resolve(__dirname, "../../watch.json");

export interface WatchEntry {
  address: string;
  label: string; // default: short address — no FOMO labels
  addedAt: number;
}

export function listWatchedWallets(): WatchEntry[] {
  try {
    if (fs.existsSync(WATCH_FILE)) {
      const arr = JSON.parse(fs.readFileSync(WATCH_FILE, "utf8"));
      if (Array.isArray(arr)) return arr as WatchEntry[];
    }
  } catch { /* ignore */ }
  return [];
}

function saveWallets(w: WatchEntry[]) {
  fs.writeFileSync(WATCH_FILE, JSON.stringify(w, null, 2), { mode: 0o600 });
}

/** Add a wallet to watch. Returns ok + error when invalid/duplicate. */
export function addWatchWallet(address: string, label?: string): { ok: boolean; error?: string } {
  const a = address.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) return { ok: false, error: "Format alamat tidak valid (harus 0x + 40 hex)" };
  const w = listWatchedWallets();
  if (w.some((x) => x.address === a)) return { ok: false, error: "Wallet sudah ada di watchlist" };
  w.push({ address: a, label: (label || a.slice(0, 10)).trim(), addedAt: Date.now() });
  saveWallets(w);
  return { ok: true };
}

export function removeWatchWallet(address: string): boolean {
  const a = address.trim().toLowerCase();
  const w = listWatchedWallets();
  const next = w.filter((x) => x.address !== a);
  if (next.length === w.length) return false;
  saveWallets(next);
  return true;
}

export function watchWalletsFile(): string {
  return WATCH_FILE;
}

// ---------- config presets ----------
// Preset = snapshot BotSettings lengkap (termasuk filters), disimpan sebagai
// file JSON per nama di folder presets/. Load preset = langsung ganti seluruh
// config aktif — cocok buat swap cepat config 1/2/3 tanpa atur ulang.

const PRESETS_DIR = path.resolve(__dirname, "../../presets");

function presetPath(name: string): string {
  const safe = String(name).trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40);
  return path.join(PRESETS_DIR, `${safe}.json`);
}

export function listPresets(): string[] {
  try {
    if (!fs.existsSync(PRESETS_DIR)) return [];
    return fs
      .readdirSync(PRESETS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
  } catch {
    return [];
  }
}

/** Simpan snapshot seluruh settings sekarang sebagai preset bernama. */
export function savePreset(name: string): { ok: boolean; error?: string } {
  const n = String(name).trim();
  if (!n) return { ok: false, error: "Nama preset kosong" };
  const s = load();
  fs.mkdirSync(PRESETS_DIR, { recursive: true });
  const data = JSON.stringify({ ...s, filters: { ...s.filters } }, null, 2);
  fs.writeFileSync(presetPath(n), data, { mode: 0o600 });
  return { ok: true };
}

/** Load preset: ganti seluruh settings (termasuk filters) dari preset file. */
export function loadPreset(name: string): { ok: boolean; error?: string } {
  const p = presetPath(name);
  if (!fs.existsSync(p)) return { ok: false, error: `Preset "${name}" tidak ada` };
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as BotSettings;
    const merged: BotSettings = {
      ...DEFAULTS,
      ...raw,
      filters: { ...DEFAULTS.filters, ...(raw.filters || {}) },
    };
    // scanSource/trendingInterval validasi
    if (!["trenches", "trending", "both"].includes(merged.scanSource)) {
      merged.scanSource = "both";
    }
    if (!["1m", "5m", "1h", "6h", "24h"].includes(merged.trendingInterval)) {
      merged.trendingInterval = "1h";
    }
    persist(merged);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: "Gagal baca preset: " + (e.message || String(e)) };
  }
}

export function deletePreset(name: string): { ok: boolean; error?: string } {
  const p = presetPath(name);
  if (!fs.existsSync(p)) return { ok: false, error: `Preset "${name}" tidak ada` };
  try {
    fs.unlinkSync(p);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: "Gagal hapus: " + (e.message || String(e)) };
  }
}