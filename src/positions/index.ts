import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSettings } from "../settings/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Posisi dipisah per mode: dry-run vs live — biar PnL & posisi ga ketuker. */
function posFile(): string {
  const mode = getSettings().mode === "live" ? "live" : "dryrun";
  return path.resolve(__dirname, `../../positions.${mode}.json`);
}

/** Satu level TP partial: profit % dari entry + berapa bagian posisi yang dijual di level itu. */
export interface TpPlanLevel {
  pct: number; // profit % (mis. 30 = +30%) — FROM ENTRY
  frac: number; // persen (0-100) dari SISA posisi yang dijual pas level ini kena
  triggered: boolean;
  triggeredAt?: number;
  exitPrice?: number;
  realizedUsd?: number;
}

export interface Position {
  id: string;
  tokenAddress: string;
  symbol: string;
  name: string;
  entryPrice: number;
  sizeUsd: number;
  openedAt: number;
  status: "open" | "closed";
  closeReason?: string;
  exitPrice?: number;
  closedAt?: number;
  pnlUsd?: number;
  pnlPct?: number;
  /** TP ladder (partial take profit). Kosong = perilaku lama (TP global close semua). */
  tpPlan?: TpPlanLevel[];
  /** Sisa posisi yang belum kejual (0..1 dari sizeUsd). 1 = masih utuh. */
  remainingFrac?: number;
  /** PnL USD yang udah ke-realize dari partial TP (belum termasuk sisa yang masih open). */
  realizedUsd?: number;
  /** Kalau true: setelah semua level TP kena, sisa tetap di-hold (moonbag). */
  moonbag?: boolean;
  /** User sengaja matiin TP ladder di posisi ini — catch-up global skip (opt-out manual). */
  tpOptOut?: boolean;
}

let cache: Position[] | null = null;
let cacheMode: string | null = null;

function load(): Position[] {
  const mode = getSettings().mode === "live" ? "live" : "dryrun";
  // mode ganti → file beda → cache harus direset biar ga nyampur
  if (cacheMode !== mode) {
    cache = null;
    cacheMode = mode;
  }
  if (cache) return cache;
  if (!fs.existsSync(posFile())) {
    cache = [];
    return cache;
  }
  try {
    cache = JSON.parse(fs.readFileSync(posFile(), "utf8"));
  } catch {
    cache = [];
  }
  return cache!;
}

function persist(ps: Position[]) {
  fs.writeFileSync(posFile(), JSON.stringify(ps, null, 2), { mode: 0o600 });
  cache = ps;
}

export function openPosition(p: Omit<Position, "id" | "status" | "openedAt">): Position {
  const ps = load();
  const pos: Position = {
    ...p,
    id: "p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    openedAt: Date.now(),
    status: "open",
  };
  // default global TP ladder dari settings.json — semua posisi baru langsung pakai partial TP
  const s = getSettings();
  if (Array.isArray(s.tpLadder) && s.tpLadder.length) {
    pos.tpPlan = s.tpLadder.map((l) => ({ pct: l.pct, frac: l.frac, triggered: false }));
    pos.remainingFrac = 1;
    if (s.tpMoonbag) pos.moonbag = true;
  }
  ps.push(pos);
  persist(ps);
  return pos;
}

export function closePosition(addr: string, reason: string, exitPrice: number): Position | null {
  const ps = load();
  const idx = ps.findIndex((p) => p.tokenAddress.toLowerCase() === addr.toLowerCase() && p.status === "open");
  if (idx === -1) return null;
  const pos = ps[idx];
  const rem = pos.remainingFrac ?? 1;
  const pct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
  // PnL final = realized (dari partial TP) + sisa yang masih open
  const finalPct = pct * rem;
  const finalUsd = (finalPct / 100) * pos.sizeUsd;
  pos.status = "closed";
  pos.closeReason = reason;
  pos.exitPrice = exitPrice;
  pos.closedAt = Date.now();
  pos.pnlPct = finalPct + (pos.realizedUsd ? (pos.realizedUsd / pos.sizeUsd) * 100 : 0);
  pos.pnlUsd = finalUsd + (pos.realizedUsd || 0);
  pos.remainingFrac = 0;
  persist(ps);
  return pos;
}

/**
 * Set / replace TP ladder (partial take profit plan) untuk posisi open.
 * Level diurutkan ascending by pct. Level yang udah triggered dipertahankan.
 */
export function setTpPlan(addr: string, plan: TpPlanLevel[], moonbag?: boolean): { ok: boolean; error?: string } {
  const ps = load();
  const pos = ps.find((p) => p.tokenAddress.toLowerCase() === addr.toLowerCase() && p.status === "open");
  if (!pos) return { ok: false, error: "Posisi tidak ditemukan / sudah closed" };
  if (!plan.length) return { ok: false, error: "TP plan kosong" };
  const totalFrac = plan.filter((l) => !l.triggered).reduce((s, l) => s + l.frac, 0);
  if (totalFrac > 100) return { ok: false, error: `Total jual ${totalFrac.toFixed(0)}% melebihi 100%` };
  // pct harus strictly naik biar ladder jelas
  const sorted = [...plan].sort((a, b) => a.pct - b.pct);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.pct <= sorted[i - 1]!.pct) return { ok: false, error: "Level TP harus urut naik (% profit)" };
  }
  // merge: keep triggered dari plan lama kalau set ulang
  const old = pos.tpPlan || [];
  const merged = sorted.map((l) => {
    const prev = old.find((o) => Math.abs(o.pct - l.pct) < 0.01 && o.triggered);
    return prev ? { ...l, triggered: true, triggeredAt: prev.triggeredAt, exitPrice: prev.exitPrice } : { ...l, triggered: false };
  });
  pos.tpPlan = merged;
  pos.remainingFrac = pos.remainingFrac ?? 1;
  if (typeof moonbag === "boolean") pos.moonbag = moonbag;
  pos.tpOptOut = false; // manual plan = keluar dari opt-out
  persist(ps);
  return { ok: true };
}

/** List semua level TP yang belum kena, urut dari yang paling dekat (pct terkecil). */
export function pendingTpLevels(addr: string): TpPlanLevel[] {
  const pos = listOpen().find((p) => p.tokenAddress.toLowerCase() === addr.toLowerCase());
  if (!pos?.tpPlan) return [];
  return pos.tpPlan.filter((l) => !l.triggered).sort((a, b) => a.pct - b.pct);
}

/** Hapus semua level TP & reset posisi ke mode normal (full-close TP global). */
export function clearTpPlan(addr: string): { ok: boolean; error?: string } {
  const ps = load();
  const pos = ps.find((p) => p.tokenAddress.toLowerCase() === addr.toLowerCase() && p.status === "open");
  if (!pos) return { ok: false, error: "Posisi tidak ditemukan" };
  delete pos.tpPlan;
  delete pos.moonbag;
  pos.remainingFrac = 1;
  pos.realizedUsd = 0;
  pos.tpOptOut = true; // jangan ke-apply ulang sama catch-up global
  persist(ps);
  return { ok: true };
}

/**
 * Dipanggil pas satu level TP tercapai: mark level triggered, kurangi sisa posisi,
 * akumulasi realized PnL. Return info untuk notifikasi, atau null kalau level ga valid.
 */
export function onTpTriggered(
  addr: string,
  levelPct: number,
  exitPrice: number
): { ok: boolean; error?: string; level?: TpPlanLevel; soldFrac?: number; remainingFrac?: number; realizedUsd?: number; pctGain?: number } {
  const ps = load();
  const pos = ps.find((p) => p.tokenAddress.toLowerCase() === addr.toLowerCase() && p.status === "open");
  if (!pos) return { ok: false, error: "Posisi tidak ditemukan" };
  const level = pos.tpPlan?.find((l) => Math.abs(l.pct - levelPct) < 0.01 && !l.triggered);
  if (!level) return { ok: false, error: `Level TP +${levelPct}% tidak ada / sudah kena` };
  const rem = pos.remainingFrac ?? 1;
  const soldFrac = rem * (level.frac / 100);
  const pctGain = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
  const realizedUsd = (pctGain / 100) * pos.sizeUsd * soldFrac;
  level.triggered = true;
  level.triggeredAt = Date.now();
  level.exitPrice = exitPrice;
  level.realizedUsd = realizedUsd;
  pos.remainingFrac = Math.max(0, rem - soldFrac);
  pos.realizedUsd = (pos.realizedUsd || 0) + realizedUsd;
  persist(ps);
  return { ok: true, level, soldFrac, remainingFrac: pos.remainingFrac, realizedUsd, pctGain };
}

/** Sisa fraksi (0..1) posisi yang masih open. */
export function remainingFraction(addr: string): number {
  const pos = listOpen().find((p) => p.tokenAddress.toLowerCase() === addr.toLowerCase());
  return pos?.remainingFrac ?? 1;
}

export function listOpen(): Position[] {
  return load().filter((p) => p.status === "open");
}

export function listClosed(): Position[] {
  return load().filter((p) => p.status === "closed");
}

export function isHolding(addr: string): boolean {
  return listOpen().some((p) => p.tokenAddress.toLowerCase() === addr.toLowerCase());
}

export function stats(): { open: number; closed: number; win: number; loss: number; totalPnlUsd: number; dailyPnlUsd: number; dayWin: number; dayLoss: number } {
  const ps = load();
  const open = ps.filter((p) => p.status === "open").length;
  const closed = ps.filter((p) => p.status === "closed");
  const win = closed.filter((p) => (p.pnlPct || 0) > 0).length;
  const loss = closed.filter((p) => (p.pnlPct || 0) < 0).length;
  const totalPnlUsd = closed.reduce((s, p) => s + (p.pnlUsd || 0), 0);
  // daily = closed today (WIB-ish: since server local midnight)
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayClosed = closed.filter((p) => (p.closedAt || 0) >= startOfToday.getTime());
  const dailyPnlUsd = todayClosed.reduce((s, p) => s + (p.pnlUsd || 0), 0);
  const dayWin = todayClosed.filter((p) => (p.pnlPct || 0) > 0).length;
  const dayLoss = todayClosed.filter((p) => (p.pnlPct || 0) < 0).length;
  return { open, closed: closed.length, win, loss, totalPnlUsd, dailyPnlUsd, dayWin, dayLoss };
}

export function recentClosed(limit = 20): Position[] {
  return load()
    .filter((p) => p.status === "closed")
    .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0))
    .slice(0, limit);
}