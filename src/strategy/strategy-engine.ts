/**
 * Strategy engine — converts scan result + settings into a BUY/HOLD/REJECT decision.
 * Pure logic, no trading. Trade decision is passed to Risk Manager then Executor.
 */
import { ScanResult } from "../scanner/scanner.js";
import { getSettings } from "../settings/index.js";

export type Decision = "BUY" | "REJECT";

export interface EntryDecision {
  decision: Decision;
  reason: string; // why BUY or why REJECT
  risk: string;
}

export function evaluateEntry(r: ScanResult): EntryDecision {
  const s = getSettings();
  const f = s.filters;
  const reasons: string[] = [];

  // bonding category toggle — only trade categories user enabled
  const catOn =
    (r.category === "new-bonding" && f.enableNewBonding) ||
    (r.category === "bonding-radar" && f.enableBondingRadar) ||
    (r.category === "momentum" && f.enableMomentum);
  if (r.category === "other") {
    return reject(`kategori lain (bukan bonding aktif)`);
  }
  if (!catOn) {
    return reject(`category ${r.category} nonaktif`);
  }

  // score gate — removed: filter jadi satu-satunya gate

  // risk cap
  const riskRank: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
  if (riskRank[r.risk] > riskRank[s.riskCap]) {
    return reject(`risk ${r.risk} melebihi cap ${s.riskCap}`);
  }

  // liquidity filter (USD)
  if (r.liquidity < f.minLiquidity) {
    return reject(`liquidity $${r.liquidity} < $${f.minLiquidity}`);
  }

  // security flags
  if (f.blockHoneypot && r.honeypot) {
    return reject(`honeypot`);
  }
  if (f.requireOpenSource && !r.openSource) {
    return reject(`open source`);
  }
  if (f.requireRenounced && !r.renounced) {
    return reject(`renounced`);
  }
  if (f.maxTaxPct > 0 && (r.buyTax > f.maxTaxPct || r.sellTax > f.maxTaxPct)) {
    return reject(`tax buy ${r.buyTax}% sell ${r.sellTax}% > ${f.maxTaxPct}%`);
  }

  // volume filter — momentum needs volume; others use it as floor too
  if (r.volume < f.minVolume) {
    return reject(`volume $${r.volume} < $${f.minVolume}`);
  }

  // buy pressure filter
  const total = r.buys + r.sells;
  const buyPressure = total > 0 ? r.buys / total : 0;
  if (buyPressure < f.minBuyPressure) {
    reasons.push(`buy pressure ${(buyPressure * 100).toFixed(0)}% < ${(f.minBuyPressure * 100).toFixed(0)}%`);
    return reject(reasons.join(", "));
  }

  // holder concentration filter
  const top10 = r.top10HolderPct;
  if (top10 != null && top10 > f.maxTop10HolderPct) {
    return reject(`top10 ${top10}% > ${f.maxTop10HolderPct}%`);
  }

  // min holders filter
  if (f.minHolders > 0 && r.holders < f.minHolders) {
    return reject(`holders ${r.holders} < ${f.minHolders}`);
  }

  // min buys (24h) — activity floor
  if (f.minBuys24h > 0 && r.buys < f.minBuys24h) {
    return reject(`buys24h ${r.buys} < ${f.minBuys24h}`);
  }

  // min callout — dev keluar duit buat promosi (niat)
  if (f.minCalloutCount > 0 && (r.calloutCount + r.tgCallCount) < f.minCalloutCount) {
    return reject(`callout ${r.calloutCount + r.tgCallCount} < ${f.minCalloutCount}`);
  }

  // smart-money filters — KOL / smart degen / organic fees (proxy volume asli)
  if (f.minKol > 0 && r.kol < f.minKol) {
    return reject(`KOL ${r.kol} < ${f.minKol}`);
  }
  if (f.minSmartDegen > 0 && r.smartDegen < f.minSmartDegen) {
    return reject(`smart degen ${r.smartDegen} < ${f.minSmartDegen}`);
  }
  if (f.minFees > 0 && r.fees < f.minFees) {
    return reject(`fees ${r.fees} < ${f.minFees}`);
  }

  // min market cap — skip token yang terlalu kecil / belum punya basis
  if (f.minMcapUsd > 0 && r.marketCap < f.minMcapUsd) {
    return reject(`mcap $${r.marketCap} < $${f.minMcapUsd}`);
  }

  // max market cap — anti beli token yang udah pump
  if (f.maxMcapUsd > 0 && r.marketCap > f.maxMcapUsd) {
    return reject(`mcap $${r.marketCap} > $${f.maxMcapUsd}`);
  }

  // token age filters (hours)
  if (f.minAgeHours > 0 && r.ageHours < f.minAgeHours) {
    return reject(`age ${r.ageHours.toFixed(1)}h < ${f.minAgeHours}h`);
  }
  if (f.maxAgeHours > 0 && r.ageHours > f.maxAgeHours) {
    return reject(`age ${r.ageHours.toFixed(1)}h > ${f.maxAgeHours}h`);
  }

  // already-pumped guards — avoid buying late into a pump
  if (f.max1hChangePct > 0 && r.priceChange1h > f.max1hChangePct) {
    return reject(`1h ${r.priceChange1h.toFixed(1)}% > ${f.max1hChangePct}%`);
  }

  // wash trading / creator-dump guards
  if (f.blockWashTrading && r.washTrading) {
    return reject(`wash trading`);
  }
  if (f.blockCreatorClose && r.creatorClose) {
    return reject(`creator closed`);
  }

  reasons.push(
    `${r.category}, ${r.progress >= 0 ? "progress " + Math.round(r.progress * 100) + "%" : ""}, ` +
    `liq $${r.liquidity}, vol $${r.volume}, risk ${r.risk}`
  );

  return { decision: "BUY", reason: reasons.join(" — "), risk: r.risk };
}

function reject(reason: string): EntryDecision {
  return { decision: "REJECT", reason, risk: "" };
}