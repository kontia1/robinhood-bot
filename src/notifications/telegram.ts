import { Telegraf, Markup } from "telegraf";
import type { Context } from "telegraf";
import { config, isAllowedTelegramId } from "../config/index.js";
import * as walletMgr from "../wallet/index.js";
import { createExecutor } from "../execution/executor.js";
import * as gmgn from "../chain/gmgn.js";
import { scanNow } from "../scanner/scanner.js";
import * as positions from "../positions/index.js";
import * as settings from "../settings/index.js";
import * as risk from "../risk/risk-manager.js";

const bot = new Telegraf(config.telegram.token);

// ---------- session-ish in-memory state (per chat) ----------
interface TokenChoice {
  symbol: string;
  name: string;
  address: string; // "" = native ETH
  amount: number;
  usd: number;
  decimals: number;
}
interface SendDraft {
  tokens: TokenChoice[] | null;
  token: TokenChoice | null;
  to: string;
  amount: number | null; // null = awaiting amount
}
interface ChatState {
  pendingDelete: string | null; // wallet address pending delete confirmation
  pendingSend: SendDraft | null;
  pendingInput: { kind: "setting" | "filter"; key: string; label: string; current: number } | null;
  /** message_id dari pesan pertanyaan "ketik nilai" — dihapus setelah input biar nggak numpuk. */
  pendingInputMsgId: number | null;
  pendingPresetName: string | null; // "new" → user ketik nama preset buat disimpen
  pendingPresetDel: string | null; // nama preset yang lagi dikonfirmasi hapus
  // pesan menu (Filter/Settings) yang sedang tampil — dipakai buat edit setelah input tanpa print baru
  filterMsgId: number | null;
  settingsMsgId: number | null;
  /** message_id pesan flow send yang lagi di-edit (token → tujuan → jumlah) */
  sendMsgId: number | null;
  /** target "usdg" | "eth" untuk sell-all — menunggu konfirmasi sebelum eksekusi */
  sellAllTarget: "usdg" | "eth" | null;
  /** TP ladder wizard: posisi yang lagi di-set level TP-nya. */
  pendingTp: { addr: string; stage: "pct" | "frac"; tmpPct?: number; msgId?: number } | null;
}

const states = new Map<number, ChatState>();
function getState(chatId: number): ChatState {
  if (!states.has(chatId)) states.set(chatId, { pendingDelete: null, pendingSend: null, pendingInput: null, pendingInputMsgId: null, pendingPresetName: null, pendingPresetDel: null, filterMsgId: null, settingsMsgId: null, sendMsgId: null, sellAllTarget: null, pendingTp: null });
  return states.get(chatId)!;
}

/** Edit pesan menu (Filter/Settings) berdasarkan id tersimpan; fallback ke reply baru kalau gagal. */
async function editMenuMessage(chatId: number, messageId: number | null, text: string, kb: () => any): Promise<boolean> {
  if (messageId == null) return false;
  try {
    await bot.telegram.editMessageText(chatId, messageId, undefined, text, { parse_mode: "Markdown", ...kb() });
    return true;
  } catch (e: any) {
    // "message is not modified" (nilai baru == nilai lama, teks identik) = sebenernya sukses — jangan fallback print baru
    if (/not modified/i.test(String(e?.message || e))) return true;
    return false;
  }
}

/** Hapus pesan pertanyaan (bot) + jawaban user — langsung, tanpa nunggu proses lain. */
async function cleanInputMessages(chatId: number, st: ChatState, userMsgId?: number | null): Promise<void> {
  if (st.pendingInputMsgId != null) {
    try {
      await bot.telegram.deleteMessage(chatId, st.pendingInputMsgId);
    } catch { /* noop — pesan mungkin sudah kehapus */ }
    st.pendingInputMsgId = null;
  }
  if (userMsgId != null) {
    try {
      await bot.telegram.deleteMessage(chatId, userMsgId);
    } catch { /* noop */ }
  }
}

/**
 * Setelah input nilai selesai: hapus pesan pertanyaan (punya bot) + hapus chat
 * jawaban user langsung, biar yang tersisa cuma menu filter/settings yang ter-update.
 * Nggak kirim konfirmasi apa pun. Kalau edit menu gagal, fallback kirim summary + keyboard.
 */
async function finishInputReply(
  chatId: number,
  st: ChatState,
  label: string,
  amt: number,
  menuEdited: boolean,
  summaryText: string,
  kb: () => any,
  userMsgId?: number | null
): Promise<void> {
  await cleanInputMessages(chatId, st, userMsgId);
  if (!menuEdited) {
    try {
      await bot.telegram.sendMessage(chatId, `✅ *${label}* = ${amt}\n\n` + summaryText, { parse_mode: "Markdown", ...kb() });
    } catch { /* noop */ }
  }
}

// ---------- auth ----------
bot.use(async (ctx, next) => {
  const from = ctx.from?.id;
  if (!from || !isAllowedTelegramId(from)) {
    await ctx.answerCbQuery("⛔ Akses ditolak").catch(() => {});
    return;
  }
  await next();
});

// ---------- formatting helpers ----------
function fmtUsd(n: number | undefined | null): string {
  if (n == null || Number.isNaN(n)) return "?";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}
function fmtPct(n: number | undefined | null): string {
  if (n == null || Number.isNaN(n)) return "?";
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}
/** Format jumlah token yang enak dibaca (1.2345, 0.0045, 12.34M). */
function fmtNumAmount(n: number | undefined | null): string {
  if (n == null || Number.isNaN(n)) return "?";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return n.toFixed(8).replace(/0+$/, "").replace(/\.$/, "") || "0";
}
/** Format jumlah ETH (0.000244, 0.05 dst) — biar nggak nampil $0.00. */
function fmtEthAmt(n: number | undefined | null): string {
  if (n == null || Number.isNaN(n)) return "?";
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  if (n >= 0.000001) return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "") || "0";
  return n.toExponential(4);
}
function fmtPrice(n: number | undefined | null): string {
  if (n == null || Number.isNaN(n)) return "?";
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  if (n >= 0.001) return n.toFixed(6);
  if (n >= 0.000001) return n.toFixed(8);
  return n.toExponential(4);
}
/** Escape Telegram Markdown (legacy) special chars in dynamic data. */
function escMd(s: unknown): string {
  return String(s ?? "").replace(/([_*[\]`])/g, "\\$1");
}

// ---------- keyboards ----------
// Full-width buttons — one button per row = biggest tap target, not cramped.
function bigRow(label: string, action: string) {
  return [Markup.button.callback(label, action)];
}

function mainKeyboard() {
  return Markup.inlineKeyboard([
    bigRow("📑 Position", "menu:positions"),
    bigRow("📈 PnL", "menu:pnl"),
    bigRow("👛 Wallet", "menu:wallet"),
    bigRow("⚙️ Settings", "menu:settings"),
    bigRow("🎯 Filter", "menu:filters"),
    bigRow("🗂️ Preset Config", "menu:presets"),
  ]);
}

/** Header utama — selalu sama di /start dan tiap tombol kembali ke main menu. */
function mainMenuText(): string {
  const s = settings.getSettings();
  return (
    "🚀 *Robinhood Chain Bot*\n" +
    "Mode: *" + (s.mode === "live" ? "LIVE" : "DRY-RUN") + "*\n" +
    "Chain: *" + config.chain + "*\n\n" +
    "Pilih menu di bawah:"
  );
}

function presetKeyboard() {
  const s = settings.getSettings();
  const presets = settings.listPresets();
  const rows: any[] = [];
  const cur = `📡 Source: ${s.scanSource} · Trend: ${s.trendingInterval}`;
  rows.push(bigRow(cur, "preset:cycle"));
  for (const name of presets) {
    rows.push([
      Markup.button.callback(`⬅️ Load ${name}`, `preset:load:${name}`),
      Markup.button.callback(`🗑️ Del ${name}`, `preset:del:${name}`),
    ]);
  }
  rows.push(bigRow("💾 Simpan sebagai preset baru", "preset:new"));
  rows.push(bigRow("⬅️ Kembali", "back:main"));
  return Markup.inlineKeyboard(rows);
}

function presetSummaryText(): string {
  const s = settings.getSettings();
  const presets = settings.listPresets();
  return (
    "🗂️ *Preset Config*\n" +
    "Simpan config cepat, pindah antar preset tanpa atur ulang.\n\n" +
    `📡 *Sumber data scan:* \`${s.scanSource}\`\n` +
    (s.scanSource !== "trenches" ? `⏱️ *Interval trending:* \`${s.trendingInterval}\`\n` : "") +
    `\nPreset tersimpan: ${presets.length ? presets.map((p) => `\`${p}\``).join(", ") : "_belum ada_"}\n\n` +
    "— Tap *Load* untuk ganti config\n" +
    "— Tap *Del* untuk hapus\n" +
    "— Tap *Simpan* untuk snapshot config sekarang\n\n" +
    "Ketuk baris pertama untuk ganti sumber data / interval.\n\n" +
    "_Source scan:_ `trenches` = bonding curve, `trending` = market hot window, `both` = gabung dua-duanya."
  );
}

/** Summary TP ladder untuk posisi (dipakai di menu TP). */
function tpSummaryText(pos: positions.Position): string {
  const plan = pos.tpPlan || [];
  const rem = Math.round((pos.remainingFrac ?? 1) * 100);
  let s = `🎯 *TP Ladder — ${escMd(pos.symbol)}*\n\n`;
  if (!plan.length) {
    s += "_Belum ada plan. Tambah level TP biar jual bertahap + sisa jadi moonbag._\n\n";
  } else {
    plan.forEach((l, i) => {
      s += `${i + 1}. +${l.pct}% → jual *${l.frac}%* dari posisi (100%) ${l.triggered ? "· ✅ done" : "· ⏳ pending"}\n`;
    });
    s += "\n";
  }
  s += `Sisa posisi: *${rem}%*${pos.moonbag ? " (moonbag 🧘)" : ""}`;
  const realized = (pos.realizedUsd || 0);
  if (realized) s += `\nRealized dari TP: *${realized >= 0 ? "+" : ""}${fmtEthAmt(realized)} ETH*`;
  return s;
}

/** Keyboard wizard TP ladder. */
function tpKeyboard(pos: positions.Position): any {
  const addr = pos.tokenAddress;
  const rows: any[] = [];
  rows.push(bigRow("➕ Tambah level TP", `tdp:add:${addr}`));
  if ((pos.tpPlan || []).length) {
    rows.push(bigRow("🧘 Hold sisa (moonbag)", `tdp:hold:${addr}`));
    rows.push(bigRow("✅ Selesai & simpan", `tdp:done:${addr}`));
    rows.push(bigRow("🗑️ Hapus plan", `tdp:clear:${addr}`));
  }
  rows.push(bigRow("⬅️ Kembali", "menu:positions"));
  return Markup.inlineKeyboard(rows);
}

/** Summary TP ladder global (dari settings) — dipakai di menu Settings. */
function tpGSummaryText(): string {
  const s = settings.getSettings();
  const ladder = s.tpLadder || [];
  let t = "🎯 *TP Ladder (global)* — default semua posisi\n\n";
  if (!ladder.length) {
    t += "_OFF — TP pakai setting global biasa (full close)._\n";
  } else {
    ladder.forEach((l, i) => t += `${i + 1}. +${l.pct}% → jual *${l.frac}%* dari posisi (100%)\n`);
    t += `\nSisa setelah semua level: ${s.tpMoonbag ? "🧘 *moonbag (di-hold)*" : "❌ *full close*"}`;
  }
  t += "\n\n_Level baru otomatis berlaku ke semua posisi (baru + yg belum punya plan)._\n" +
       "_Level = profit % dari entry. Jual % = porsi POSISI AWAL (100%) di level itu._";
  return t;
}

/** Keyboard wizard TP ladder global. */
function tpGKeyboard(): any {
  const s = settings.getSettings();
  const rows: any[] = [];
  rows.push(bigRow("➕ Tambah level TP", "tdp:gadd"));
  if ((s.tpLadder || []).length) {
    rows.push(bigRow(`🧘 Moonbag: ${s.tpMoonbag ? "ON 🧡" : "OFF (full close)"}`, "tdp:gmoon"));
    rows.push(bigRow("🗑️ Clear semua", "tdp:gclear"));
    rows.push(bigRow("✅ Selesai", "tdp:gdone"));
  }
  rows.push(bigRow("⬅️ Kembali", "menu:settings"));
  return Markup.inlineKeyboard(rows);
}

function walletKeyboard() {
  return Markup.inlineKeyboard([
    bigRow("➕ Generate Wallet", "wal:create"),
    bigRow("🔀 Switch Wallet", "wal:switch"),
    bigRow("📤 Send", "wal:send"),
    bigRow("💳 Balance", "wal:balance"),
    bigRow("🧹 Sell All (ke ETH/USDG)", "wal:sellall"),
    bigRow("🔑 Export Private Key", "wal:export"),
    bigRow("🗑️ Delete Wallet", "wal:delete"),
    bigRow("⬅️ Kembali", "back:main"),
  ]);
}

function settingsKeyboard() {
  const s = settings.getSettings();
  const rows: any[] = [];
  // one button per option; tap -> bot asks for manual input
  rows.push([Markup.button.callback(`🔄 Mode: ${s.mode === "live" ? "LIVE" : "DRY-RUN"}`, "set:mode")]);
  rows.push([Markup.button.callback(`🤖 Auto Trade: ${s.autoTrade ? "ON" : "OFF"}`, "set:auto")]);
  rows.push([Markup.button.callback(`⚠️ Risk cap: ${s.riskCap}`, "set:risk")]);
  rows.push([Markup.button.callback(`📡 Sumber: ${s.scanSource}`, "set:source")]);
  rows.push([Markup.button.callback(`⏱️ Trend interval: ${s.trendingInterval}`, "set:trendiv")]);
  rows.push([Markup.button.callback(`🕐 Scan interval: ${Math.round(s.scanIntervalMs / 1000)}s`, "set:input:scanIntervalMs")]);
  rows.push([Markup.button.callback(`💰 Position: ${s.positionSizeEth} ETH`, "set:input:positionSizeEth")]);
  rows.push([Markup.button.callback(`🛑 SL: ${s.stopLossPct}%`, "set:input:stopLossPct")]);
  rows.push([Markup.button.callback(`🎯 TP Ladder: ${s.tpLadder?.length ? s.tpLadder.map((l) => `+${l.pct}%→${l.frac}%`).join(" · ") : "OFF"}${s.tpMoonbag ? " 🧘" : ""}`, "tdp:gview")]);
  rows.push([Markup.button.callback(`🪢 Trailing: ${s.trailingStopPct}%`, "set:input:trailingStopPct")]);
  rows.push([Markup.button.callback(`💸 Slippage: ${s.slippagePct}%`, "set:input:slippagePct")]);
  rows.push([Markup.button.callback(`♐ Max positions: ${s.maxPositions}`, "set:input:maxPositions")]);
  rows.push(bigRow("⬅️ Kembali", "back:main"));
  return Markup.inlineKeyboard(rows);
}

function filtersKeyboard() {
  const f = settings.getSettings().filters;
  const rows: any[] = [];
  rows.push(bigRow(`📦 New Bonding: ${f.enableNewBonding ? "ON" : "OFF"}`, "fx:toggle:enableNewBonding"));
  rows.push(bigRow(`🎯 Bonding Radar: ${f.enableBondingRadar ? "ON" : "OFF"}`, "fx:toggle:enableBondingRadar"));
  rows.push(bigRow(`🚀 Momentum: ${f.enableMomentum ? "ON" : "OFF"}`, "fx:toggle:enableMomentum"));
  rows.push(bigRow(`💧 Min Liquidity: $${f.minLiquidity.toLocaleString()}`, "fx:input:minLiquidity"));
  rows.push(bigRow(`📊 Min Volume 24h: $${f.minVolume.toLocaleString()}`, "fx:input:minVolume"));
  rows.push(bigRow(`⚡ Min Vol 5m (anti mati): $${f.minVolume5m > 0 ? f.minVolume5m.toLocaleString() : "OFF"}`, "fx:input:minVolume5m"));
  rows.push(bigRow(`🛒 Min Buys 24h: ${f.minBuys24h > 0 ? f.minBuys24h.toLocaleString() : "OFF"}`, "fx:input:minBuys24h"));
  rows.push(bigRow(`📈 Max Pump 5m: ${f.max5mChangePct > 0 ? `${f.max5mChangePct}%` : "OFF"}`, "fx:input:max5mChangePct"));
  rows.push(bigRow(`📈 Max Pump 1h: ${f.max1hChangePct > 0 ? `${f.max1hChangePct}%` : "OFF"}`, "fx:input:max1hChangePct"));
  rows.push(bigRow(`🟢 Buy Pressure: ${Math.round(f.minBuyPressure * 100)}%`, "fx:input:minBuyPressure"));
  rows.push(bigRow(`🐋 Max Top10: ${f.maxTop10HolderPct}%`, "fx:input:maxTop10HolderPct"));
  rows.push(bigRow(`👥 Min Holders: ${f.minHolders > 0 ? f.minHolders.toLocaleString() : "OFF"}`, "fx:input:minHolders"));
  rows.push(bigRow(`📢 Min Callout: ${f.minCalloutCount > 0 ? f.minCalloutCount : "OFF"}`, "fx:input:minCalloutCount"));
  rows.push(bigRow(`🤑 Min KOL: ${f.minKol > 0 ? f.minKol : "OFF"}`, "fx:input:minKol"));
  rows.push(bigRow(`🧠 Min Smart Degen: ${f.minSmartDegen > 0 ? f.minSmartDegen : "OFF"}`, "fx:input:minSmartDegen"));
  rows.push(bigRow(`💰 Min LP Fees: ${f.minFees > 0 ? f.minFees : "OFF"}`, "fx:input:minFees"));
  rows.push(bigRow(`🏔️ Min Mcap: ${f.minMcapUsd > 0 ? "$" + f.minMcapUsd.toLocaleString() : "OFF"}`, "fx:input:minMcapUsd"));
  rows.push(bigRow(`🏔️ Max Mcap: ${f.maxMcapUsd > 0 ? "$" + f.maxMcapUsd.toLocaleString() : "OFF"}`, "fx:input:maxMcapUsd"));
  rows.push(bigRow(`🕐 Min Umur: ${f.minAgeHours > 0 ? `${f.minAgeHours}h` : "OFF"}`, "fx:input:minAgeHours"));
  rows.push(bigRow(`🕐 Max Umur: ${f.maxAgeHours > 0 ? `${f.maxAgeHours}h` : "OFF"}`, "fx:input:maxAgeHours"));
  rows.push(bigRow(`🔒 Max Tax: ${f.maxTaxPct > 0 ? `${f.maxTaxPct}%` : "OFF"}`, "fx:input:maxTaxPct"));
  rows.push(bigRow(`🧼 Blokir Wash: ${f.blockWashTrading ? "ON" : "OFF"}`, "fx:toggle:blockWashTrading"));
  rows.push(bigRow(`⛔ Blokir Creator Close: ${f.blockCreatorClose ? "ON" : "OFF"}`, "fx:toggle:blockCreatorClose"));
  rows.push(bigRow(`🔁 Blokir Token Double: ${f.blockDuplicateToken ? "ON" : "OFF"}`, "fx:toggle:blockDuplicateToken"));
  rows.push(bigRow(`⬆️ Anti-dupe Ticker+Nama: ${f.blockDuplicateTickerName ? "ON" : "OFF"}`, "fx:toggle:blockDuplicateTickerName"));
  rows.push(bigRow(`⏳ Re-entry Cooldown: ${f.reEntryCooldownHours > 0 ? `${f.reEntryCooldownHours}h` : "OFF"}`, "fx:input:reEntryCooldownHours"));
  rows.push(bigRow(`🛡️ Blokir Honeypot: ${f.blockHoneypot ? "ON" : "OFF"}`, "fx:toggle:blockHoneypot"));
  rows.push(bigRow(`🛠️ Wajib Open Source: ${f.requireOpenSource ? "ON" : "OFF"}`, "fx:toggle:requireOpenSource"));
  rows.push(bigRow(`🔓 Wajib Renounced: ${f.requireRenounced ? "ON" : "OFF"}`, "fx:toggle:requireRenounced"));
  rows.push(bigRow("⬅️ Kembali", "back:main"));
  return Markup.inlineKeyboard(rows);
}

// ---------- text builders ----------
function walletSummaryText(): string {
  const ws = walletMgr.listWallets();
  const active = walletMgr.getActiveWallet();
  let msg = "👋 *Wallet Manager*\n\n";
  if (ws.length === 0) msg += "Belum ada wallet.\n";
  else
    ws.forEach((w, i) => {
      msg += `${w.isActive ? "✅" : "•"} ${i + 1}. \`${w.address}\` (${w.label})\n`;
    });
  msg += "\nTotal: " + ws.length;
  if (active) msg += " | Active: `" + walletMgr.shortLabel(active.address) + "`";
  return msg;
}

async function cbAnswer(ctx: Context, text?: string) {
  try {
    await (text ? ctx.answerCbQuery(text) : ctx.answerCbQuery());
  } catch {
    /* ignore */
  }
}

function log(tag: string, msg: string) {
  console.log(`[${tag}] ${msg}`);
}

function walletMenuHint(): string {
  return "Ketik /start buat buka menu wallet.";
}

// settings summary builders

function settingsSummaryText(): string {
  const s = settings.getSettings();
  return (
    "⚙️ *Settings*\n" +
    "Edit langsung dari bot — tersimpan di `settings.json`\n\n" +
    `Mode: ${s.mode === "live" ? "🟢 LIVE" : "🟡 DRY-RUN"}\n` +
    `Auto trade: ${s.autoTrade ? "🟢 ON" : "🔴 OFF"}\n` +
    `Scan interval: ${Math.round(s.scanIntervalMs / 1000)}s\n` +
    `Sumber scan: ${s.scanSource}${s.scanSource !== "trenches" ? ` (trend ${s.trendingInterval})` : ""}\n` +
    `Risk cap: ${s.riskCap}\n` +
    `Position size: ${s.positionSizeEth} ETH\n` +
    `SL: ${s.stopLossPct}% | Trailing: ${s.trailingStopPct}%\n` +
    `TP Ladder: ${s.tpLadder?.length ? s.tpLadder.map((l) => `+${l.pct}%→${l.frac}%`).join(" · ") : "OFF"}${s.tpMoonbag ? " 🧘" : ""}\n` +
    `Slippage: ${s.slippagePct ?? 20}%\n` +
    `Max positions: ${s.maxPositions}\n\n` +
    "Tekan − / + untuk ubah."
  );
}

function filterSummaryText(): string {
  const f = settings.getSettings().filters;
  return (
    "🎯 *Filter Scanner*\n" +
    "Kategori aktif + ambang filter. Nilai 0 = OFF.\n\n" +
    `📦 New Bonding: ${f.enableNewBonding ? "ON" : "OFF"}\n` +
    `🎯 Bonding Radar: ${f.enableBondingRadar ? "ON" : "OFF"}\n` +
    `🚀 Momentum: ${f.enableMomentum ? "ON" : "OFF"}\n` +
    `🛡️ Honeypot: ${f.blockHoneypot ? "ON" : "OFF"} | OpenSrc: ${f.requireOpenSource ? "ON" : "OFF"} | Renounced: ${f.requireRenounced ? "ON" : "OFF"}\n` +
    `🔒 Max Tax: ${f.maxTaxPct > 0 ? `${f.maxTaxPct}%` : "OFF"}\n` +
    `💧 Min Liq: $${f.minLiquidity.toLocaleString()} | Min Vol: $${f.minVolume.toLocaleString()} | Vol5m: ${f.minVolume5m > 0 ? "$" + f.minVolume5m.toLocaleString() : "OFF"}\n` +
    `🟢 Buy Pressure: ${Math.round(f.minBuyPressure * 100)}% | Top10: ${f.maxTop10HolderPct}%\n` +
    `👥 Min Holder: ${f.minHolders > 0 ? f.minHolders.toLocaleString() : "OFF"} | Umur: ${f.minAgeHours > 0 ? `${f.minAgeHours}h` : "-"}/${f.maxAgeHours > 0 ? `${f.maxAgeHours}h` : "-"}\n` +
    `📢 Callout: ${f.minCalloutCount > 0 ? f.minCalloutCount : "OFF"} | 🤑 KOL: ${f.minKol > 0 ? f.minKol : "OFF"} | 🧠 Degen: ${f.minSmartDegen > 0 ? f.minSmartDegen : "OFF"}\n` +
    `💰 Min Fees: ${f.minFees > 0 ? f.minFees : "OFF"} | 🏔️ Min Mcap: ${f.minMcapUsd > 0 ? "$" + f.minMcapUsd.toLocaleString() : "OFF"} | 🏔️ Max Mcap: ${f.maxMcapUsd > 0 ? "$" + f.maxMcapUsd.toLocaleString() : "OFF"}\n` +
    `🧼 Wash: ${f.blockWashTrading ? "ON" : "OFF"} | CreatorClose: ${f.blockCreatorClose ? "ON" : "OFF"}\n` +
    `🔁 Token Double: ${f.blockDuplicateToken ? "ON" : "OFF"} | Re-entry: ${f.reEntryCooldownHours > 0 ? `${f.reEntryCooldownHours}h` : "OFF"}\n` +
    `⬆ Anti-dupe: ${f.blockDuplicateTickerName ? "ON — original saja" : "OFF"}`
  );
}

function watchlistText(): string {
  const w = settings.listWatchedWallets();
  if (!w.length) return "📭 *Watchlist* kosong.\n\nDaftarkan dengan `/watch <address> [label]`";
  let msg = "👁️ *Watchlist Wallet*\n\n";
  for (const [i, e] of w.entries()) {
    msg += `${i + 1}. \`${e.address}\` — ${e.label}\n`;
  }
  msg += "\nHapus: `/unwatch <address>`";
  return msg;
}

/** Edit the message instead of replying anew on +/- taps (less spam). */
export async function editReply(ctx: any, text: string, kb: () => any) {
  try {
    await ctx.editMessageText(text, { parse_mode: "Markdown", ...kb() });
  } catch (e: any) {
    // "message is not modified" = teks identik, sebenernya sukses — jangan print baru
    if (/not modified/i.test(String(e?.message || e))) return;
    try {
      await ctx.reply(text, { parse_mode: "Markdown", ...kb() });
    } catch {
      /* noop */
    }
  }
}

/**
 * Edit pesan callback yang lagi tampil in-place (pola tombol kembali).
 * Kalau edit gagal (pesan kehapus/dll), fallback reply baru. Return message id
 * pesan yang tampil (untuk dipakai edit berikutnya), atau null kalau gagal total.
 */
async function editInPlace(ctx: any, text: string, kb: () => any): Promise<number | null> {
  try {
    await ctx.editMessageText(text, { parse_mode: "Markdown", ...kb() });
    return (ctx.callbackQuery?.message as any)?.message_id ?? null;
  } catch (e: any) {
    // "message is not modified" = sebenernya sukses — tetap balikin message id pesan sekarang
    if (/not modified/i.test(String(e?.message || e))) {
      return (ctx.callbackQuery?.message as any)?.message_id ?? null;
    }
    try {
      const msg = await ctx.reply(text, { parse_mode: "Markdown", ...kb() });
      return (msg as any)?.message_id ?? null;
    } catch {
      return null;
    }
  }
}

// ---------- /start ----------
bot.start(async (ctx) => {
  await ctx.reply(mainMenuText(), { parse_mode: "Markdown", ...mainKeyboard() });
});

// ---------- inline handler ----------
bot.on("callback_query", async (ctx) => {
  const cb = (ctx.callbackQuery as any)?.data || "";
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const st = getState(chatId);

  try {
    // ===== PRESET CONFIG =====
    if (cb === "menu:presets") {
      await cbAnswer(ctx);
      await editInPlace(ctx, presetSummaryText(), () => presetKeyboard());
    }
    else if (cb === "preset:cycle") {
      // sadar single toggle: cycle source dulu, kalau sudah both → cycle interval
      const s = settings.getSettings();
      if (s.scanSource !== "both") {
        settings.setScanSource();
      } else {
        settings.setTrendingInterval();
      }
      await cbAnswer(ctx);
      await ctx.editMessageText(presetSummaryText(), {
        parse_mode: "Markdown",
        ...presetKeyboard(),
      }).catch(() => ctx.reply(presetSummaryText(), {
        parse_mode: "Markdown",
        ...presetKeyboard(),
      }));
    }
    else if (cb.startsWith("preset:load:")) {
      const name = cb.slice("preset:load:".length);
      const res = settings.loadPreset(name);
      if (!res.ok) {
        await cbAnswer(ctx, "⚠️ " + (res.error || "Gagal load"));
      } else {
        await cbAnswer(ctx, "✅ Config " + name + " dimuat");
        await editReply(ctx, presetSummaryText(), () => presetKeyboard());
      }
    }
    else if (cb.startsWith("preset:del:")) {
      const name = cb.slice("preset:del:".length);
      st.pendingPresetDel = name;
      await cbAnswer(ctx, "⚠️ Butuh konfirmasi");
      await editInPlace(
        ctx,
        `🗑️ *Yakin hapus preset \`${escMd(name)}\`?*\n\nConfig preset ini bakal hilang permanen.`,
        () => Markup.inlineKeyboard([
          [Markup.button.callback("✅ Ya, hapus", `preset:delc:${name}`)],
          [Markup.button.callback("❌ Batal", "preset:canceldel")],
        ])
      );
    }
    else if (cb === "preset:canceldel") {
      st.pendingPresetDel = null;
      await cbAnswer(ctx, "Dibatalkan");
      await editInPlace(ctx, presetSummaryText(), () => presetKeyboard());
    }
    else if (cb.startsWith("preset:delc:")) {
      const name = cb.slice("preset:delc:".length);
      st.pendingPresetDel = null;
      const res = settings.deletePreset(name);
      if (!res.ok) {
        await cbAnswer(ctx, "⚠️ " + (res.error || "Gagal hapus"));
      } else {
        await cbAnswer(ctx, "🗑️ Preset " + name + " dihapus");
        await editInPlace(ctx, presetSummaryText(), () => presetKeyboard());
      }
    }
    else if (cb === "preset:new") {
      st.pendingPresetName = "new";
      st.filterMsgId = (ctx.callbackQuery.message as any)?.message_id ?? st.filterMsgId;
      await cbAnswer(ctx, "Ketik nama preset");
      const q = await ctx.reply(
        "✏️ *Simpan preset baru*\n\nKetik nama preset (misal `1`, `2`, `3`, `aggresif`, `tenang`), atau /cancel.",
        { parse_mode: "Markdown" }
      );
      st.pendingInputMsgId = (q as any)?.message_id ?? null;
    }
    // ===== SCAN =====
    if (cb === "menu:scan") {
      await cbAnswer(ctx, "Scanning…");
      const results = await scanNow(10, true);
      if (!results.length) {
        await editInPlace(ctx, "⚠️ Tidak ada hasil scan.", () => mainKeyboard());
      } else {
        const lines = results.slice(0, 10).map((r, i) => {
          return `*${i + 1}. ${r.symbol}* — ${r.name}\n` +
            `MC: ${fmtUsd(r.marketCap)} | Vol: ${fmtUsd(r.volume)} | Liq: ${fmtUsd(r.liquidity)}\n` +
            `Price: $${r.price} (${fmtPct(r.priceChange1h)})\n` +
            `Buys: ${r.buys} | Sells: ${r.sells} | Holders: ${r.holders}`;
        });
        await editInPlace(ctx, "📊 *Hasil Scan*\n\n" + lines.join("\n\n"), () => mainKeyboard());
      }
    }
    // ===== TRENDING =====
    else if (cb === "menu:trending") {
      await cbAnswer(ctx, "Ambil trending…");
      try {
        const data = await gmgn.marketTrending("1h", 10);
        if (!data?.length) {
          await editInPlace(ctx, "⚠️ Trending kosong.", () => mainKeyboard());
        } else {
          const lines = (data as any[]).slice(0, 10).map((t, i) => {
            return `*${i + 1}. ${t.symbol}* — ${t.name}\n` +
              `MC: ${fmtUsd(t.market_cap)} | Vol: ${fmtUsd(t.volume)} | Liq: ${fmtUsd(t.liquidity)}\n` +
              `5m: ${fmtPct(t.price_change_percent5m)} | 1h: ${fmtPct(t.price_change_percent1h)}\n` +
              `Buys: ${t.buys} | Sells: ${t.sells} | Holders: ${t.holder_count}`;
          });
          await editInPlace(ctx, "🏆 *Trending (1h)*\n\n" + lines.join("\n\n"), () => mainKeyboard());
        }
      } catch (e: any) {
        await editInPlace(ctx, "⚠️ Gagal ambil trending: " + (e.message || String(e)), () => mainKeyboard());
      }
    }
    // ===== WALLET =====
    else if (cb === "menu:wallet") {
      const msg = walletSummaryText();
      await ctx.editMessageText(msg, {
        parse_mode: "Markdown",
        ...walletKeyboard(),
      }).catch(() => ctx.reply(msg, { parse_mode: "Markdown", ...walletKeyboard() }));
    }
    else if (cb === "back:wallet") {
      const msg = walletSummaryText();
      await ctx.editMessageText(msg, {
        parse_mode: "Markdown",
        ...walletKeyboard(),
      }).catch(() => ctx.reply(msg, { parse_mode: "Markdown", ...walletKeyboard() }));
    }
    else if (cb === "back:main") {
      const msg = mainMenuText();
      await ctx.editMessageText(msg, {
        parse_mode: "Markdown",
        ...mainKeyboard(),
      }).catch(() => ctx.reply(msg, { parse_mode: "Markdown", ...mainKeyboard() }));
    }
    else if (cb === "wal:create") {
      const w = walletMgr.createWallet();
      await cbAnswer(ctx, "✅ Wallet dibuat");
      log("wallet", "created " + w.address);
      await editInPlace(
        ctx,
        "✅ *Wallet Baru*\n\nAddress: `" + w.address + "`\nLabel: " + w.label + "\n\n" +
        "⚠️ *Simpan private key dengan aman!* Jangan pernah share ke siapa pun.",
        () => walletKeyboard()
      );
    }
    else if (cb === "wal:switch") {
      const ws = walletMgr.listWallets();
      if (ws.length < 2) {
        await cbAnswer(ctx, "⚠️ Cuma ada 1 wallet. Generate dulu.");
        return;
      }
      const rows = ws.map((w) => [
        Markup.button.callback(`${w.isActive ? "✅" : "•"} ${walletMgr.shortLabel(w.address)}`, `switch:${w.address}`),
      ]);
      rows.push([Markup.button.callback("⬅️ Back", "back:wallet")]);
      await editInPlace(ctx, "🔀 Pilih wallet aktif:", () => Markup.inlineKeyboard(rows));
    }
    else if (cb.startsWith("switch:")) {
      const addr = cb.slice(7);
      const ok = walletMgr.switchWallet(addr);
      await cbAnswer(ctx, ok ? "✅ Di-switch" : "⚠️ Gagal");
      if (ok) {
        const w = walletMgr.getActiveWallet();
        await editInPlace(ctx, "✅ *Wallet aktif:* `" + (w?.address || "") + "`", () => walletKeyboard());
      }
    }
    else if (cb === "wal:balance") {
      const active = walletMgr.getActiveWallet();
      if (!active) {
        await cbAnswer(ctx, "⚠️ Belum ada wallet. Generate dulu.");
        return;
      }
      await cbAnswer(ctx, "Menghitung balance…");
      try {
        // baca wallet langsung dari RPC/Alchemy — gak bergantung GMGN (sering rate-limited)
        const v3 = await import("../chain/uniswap-v3.js");
        const tokens = await v3.getWalletTokens(active.address);
        const list: any[] = tokens.map((t) => ({
          symbol: t.symbol,
          amount: Number(t.balance) / 10 ** t.decimals,
          usd_value: 0,
        }));
        let msg = `💳 *Balance — ${walletMgr.shortLabel(active.address)}*\n`;
        // native ETH (gas) — read directly from RPC
        try {
          const { createPublicClient, http, formatUnits } = await import("viem");
          const client = createPublicClient({ transport: http(config.rpcUrl) });
          const native = await client.getBalance({ address: active.address as `0x${string}` });
          msg += `\n⚡ ETH (gas): *${formatUnits(native, 18).slice(0, 8)}*`;
        } catch { /* RPC optional */ }
        msg += "\n";
        if (!list.length) {
          msg += "\nBelum ada holding token.";
        } else {
          let total = 0;
          for (const h of list.slice(0, 10)) {
            const usd = h.usd_value || h.value_usd || 0;
            total += usd;
            msg += `• ${h.symbol || h.token_symbol}: ${Number(h.amount || h.balance || 0).toPrecision(4)} ($${Number(usd).toFixed(2)})\n`;
          }
          msg += `\nTotal token USD: *$${total.toFixed(2)}*`;
        }
        await editInPlace(ctx, msg, () => walletKeyboard());
      } catch (e: any) {
        await editInPlace(ctx, "⚠️ Gagal ambil balance: " + (e.message || String(e)), () => walletKeyboard());
      }
    }
    else if (cb === "wal:sellall") {
      const active = walletMgr.getActiveWallet();
      if (!active) {
        await cbAnswer(ctx, "⚠️ Belum ada wallet.");
        return;
      }
      st.sellAllTarget = null;
      await cbAnswer(ctx, "Muat balance…");
      try {
        const v3 = await import("../chain/uniswap-v3.js");
        const tokens = await v3.getWalletTokens(active.address);
        const USDG = v3.USDG?.toLowerCase?.() || "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
        const sellable = (tokens || []).filter((t) => t.address.toLowerCase() !== USDG && t.balance > 0n);
        if (!sellable.length) {
          await editInPlace(ctx, "🧹 *Sell All*\n\nTidak ada token (selain USDG) untuk dijual.", () => walletKeyboard());
          return;
        }
        let msg = "🧹 *Sell All — pilih target*\n\n";
        sellable.forEach((t, i) => {
          msg += `${i + 1}. ${t.symbol || t.address.slice(0, 8)}: ${(Number(t.balance) / 10 ** (t.decimals || 18)).toPrecision(4)}\n`;
        });
        msg += `\nTotal ${sellable.length} token (USDG dilewati).\nSemua akan dijual ke salah satu target:`;
        await editInPlace(ctx, msg, () =>
          Markup.inlineKeyboard([
            bigRow("💰 USDG (stable)", "sellall:target:usdg"),
            bigRow("⚡ ETH (native)", "sellall:target:eth"),
            bigRow("⬅️ Batal", "back:wallet"),
          ])
        );
      } catch (e: any) {
        await editInPlace(ctx, "⚠️ Gagal muat token: " + (e.message || String(e)), () => walletKeyboard());
      }
    }
    else if (cb === "sellall:target:usdg" || cb === "sellall:target:eth") {
      const target = cb.split(":")[2] as "usdg" | "eth";
      st.sellAllTarget = target;
      const lbl = target === "usdg" ? "USDG" : "ETH";
      await cbAnswer(ctx, `Target: ${lbl} — konfirmasi?`);
      await editInPlace(
        ctx,
        `🧹 *Sell All — konfirmasi*\n\nJual semua token (kecuali USDG) → *${lbl}*.\n\n⚠️ Ini eksekusi on-chain, gas dibayar dari ETH balance.`,
        () => Markup.inlineKeyboard([
          bigRow("✅ Ya, jual semua", "sellall:confirm"),
          bigRow("⬅️ Ganti target", "wal:sellall"),
          bigRow("❌ Batal", "back:wallet"),
        ])
      );
    }
    else if (cb === "sellall:confirm") {
      const target = st.sellAllTarget;
      if (!target) {
        await cbAnswer(ctx, "⚠️ Pilih target dulu");
        return;
      }
      const active = walletMgr.getActiveWallet();
      if (!active) {
        await cbAnswer(ctx, "⚠️ Belum ada wallet.");
        return;
      }
      await cbAnswer(ctx, "Menjual semua…");
      const results: string[] = [];
      let okCount = 0;
      try {
        const v3 = await import("../chain/uniswap-v3.js");
        const uniApi = await import("../chain/uniswap-api.js");
        const tokens = await v3.getWalletTokens(active.address);
        const USDG = v3.USDG?.toLowerCase?.() ?? "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168".toLowerCase();
        const NATIVE = "0x0000000000000000000000000000000000000000";
        const targetAddr = target === "usdg" ? USDG : NATIVE;
        const sellable = (tokens || []).filter((t) => t.address.toLowerCase() !== USDG && t.balance > 0n);
        for (const t of sellable) {
          try {
            const res = await uniApi.sellToTarget(t.address as `0x${string}`, targetAddr as `0x${string}`, t.balance, Math.round((settings.getSettings().slippagePct ?? 20) * 100));
            if (res.ok) okCount++;
            results.push(`${t.symbol || t.address.slice(0, 8)}: ${res.ok ? "✅" : "❌ " + (res.error || "gagal")}`);
          } catch (e: any) {
            results.push(`${t.symbol || t.address.slice(0, 8)}: ❌ ${(e.message || String(e)).slice(0, 80)}`);
          }
        }
        const fails = results.filter((r) => r.includes("❌"));
        let msg = `🧹 *Sell All selesai* (target: ${target.toUpperCase()}) — OK ${okCount}/${results.length}\n\n` + results.join("\n");
        msg += fails.length ? `\n\n⚠️ ${fails.length} gagal — ${fails.slice(0, 3).join("; ")}` : "";
        await editInPlace(ctx, msg, () => walletKeyboard());
      } catch (e: any) {
        await editInPlace(ctx, "⚠️ Gagal eksekusi sell all: " + (e.message || String(e)), () => walletKeyboard());
      }
      st.sellAllTarget = null;
    }
    else if (cb === "wal:delete") {
      const ws = walletMgr.listWallets();
      if (ws.length <= 1) {
        await cbAnswer(ctx, "⚠️ Minimal 1 wallet wajib ada");
        return;
      }
      const rows = ws.map((w) => [
        Markup.button.callback(
          `🗑️ ${walletMgr.shortLabel(w.address)}${w.isActive ? " (aktif)" : ""}`,
          `del:${w.address}`
        ),
      ]);
      rows.push([Markup.button.callback("Batal", "back:wallet")]);
      await editInPlace(ctx, "🗑️ *Pilih wallet untuk dihapus:*", () => Markup.inlineKeyboard(rows));
    }
    else if (cb.startsWith("del:") && !cb.startsWith("del:confirm:") && cb !== "del:cancel") {
      const addr = cb.slice(4);
      st.pendingDelete = addr;
      await cbAnswer(ctx);
      await editInPlace(ctx,
        "⛔ *KONFIRMASI HAPUS WALLET*\n\nWallet: `" + addr + "`\n\n" +
        "Ini tidak bisa dibatalkan.",
        () => Markup.inlineKeyboard([
          [Markup.button.callback("✅ Ya, hapus", `del:confirm:${addr}`)],
          [Markup.button.callback("❌ Batal", "del:cancel")],
        ])
      );
    }
    else if (cb === "del:cancel") {
      st.pendingDelete = null;
      await cbAnswer(ctx, "Dibatalkan");
      await editInPlace(ctx, walletSummaryText(), () => walletKeyboard());
    }
    else if (cb.startsWith("del:confirm:")) {
      const addr = cb.slice("del:confirm:".length);
      st.pendingDelete = null;
      const res = walletMgr.deleteWallet(addr);
      if (!res.ok) {
        await cbAnswer(ctx, "⚠️ " + (res.error || "Gagal hapus"));
        await editInPlace(ctx, walletSummaryText(), () => walletKeyboard());
      } else {
        log("wallet", "deleted " + addr);
        await cbAnswer(ctx, "✅ Wallet dihapus");
        await editInPlace(ctx, "✅ Wallet dihapus.\n\n" + walletSummaryText() + "\n\n" + walletMenuHint(), () => walletKeyboard());
      }
    }
    else if (cb === "wal:export") {
      const active = walletMgr.getActiveWallet();
      if (!active) {
        await cbAnswer(ctx, "⚠️ Belum ada wallet.");
        return;
      }
      await cbAnswer(ctx);
      await editInPlace(
        ctx,
        "🔑 *Tampilkan Private Key?*\n\nWallet: `" + active.address + "`\n\n" +
        "⚠️ Private key = akses penuh ke wallet. Siapa pun yang lihat bisa tarik semua dana.\n\nHanya tampilkan di chat pribadi yang aman.",
        () => Markup.inlineKeyboard([
          [Markup.button.callback("🔑 Ya, tampilkan", "wal:export:show")],
          [Markup.button.callback("❌ Batal", "back:wallet")],
        ])
      );
    }
    else if (cb === "wal:export:show") {
      const active = walletMgr.getActiveWallet();
      if (!active) {
        await cbAnswer(ctx, "⚠️ Belum ada wallet.");
        return;
      }
      if (!active.privateKey) {
        await cbAnswer(ctx, "⚠️ Private key tidak tersedia");
        await editInPlace(ctx, "⚠️ Private key tidak tersedia di file wallet.", () => walletKeyboard());
        return;
      }
      await cbAnswer(ctx, "Siap…");
      await editInPlace(
        ctx,
        "🔑 *Private Key — " + walletMgr.shortLabel(active.address) + "*\n\n" +
        "Address: `" + active.address + "`\n\n" +
        "Private Key:\n`" + active.privateKey + "`\n\n" +
        "⚠️ *Rahasia!* Siapa pun yang pegang key ini bisa ambil semua dana. Jangan pernah share ke siapa pun.",
        () => walletKeyboard()
      );
    }
    else if (cb === "wal:send") {
      const active = walletMgr.getActiveWallet();
      if (!active) {
        await cbAnswer(ctx, "⚠️ Belum ada wallet.");
        return;
      }
      await cbAnswer(ctx, "Muat token…");
      try {
        // Token dari RPC/Alchemy (gak bergantung GMGN yang sering rate-limit), plus native ETH selalu #1
        const v3 = await import("../chain/uniswap-v3.js");
        const wtokens = await v3.getWalletTokens(active.address);
        const list: any[] = (wtokens || []).map((w) => ({
          symbol: w.symbol,
          name: w.symbol,
          token_address: w.address,
          address: w.address,
          amount: Number(w.balance) / 10 ** w.decimals,
          decimals: w.decimals,
          usd_value: 0,
        }));
        // Token #1 selalu native ETH, sisanya dari RPC holdings
        const tokens: TokenChoice[] = [
          { symbol: "ETH", name: "Native", address: "", amount: 0, usd: 0, decimals: 18 },
          ...list.map((h) => ({
            symbol: h.symbol || h.token_symbol || "?",
            name: h.name || h.token_name || "",
            address: (h.token_address || h.address || "").toLowerCase(),
            amount: Number(h.amount || h.balance || 0),
            usd: Number(h.usd_value || h.value_usd || 0),
            decimals: Number(h.decimals || h.token_decimals || 18),
          })),
        ];
        // native ETH balance + harga (WETH superchain standard ~ OP-stack)
        try {
          const { createPublicClient, http, formatUnits } = await import("viem");
          const client = createPublicClient({ transport: http(config.rpcUrl) });
          const native = await client.getBalance({ address: active.address as `0x${string}` });
          tokens[0].amount = Number(formatUnits(native, 18));
        } catch { /* RPC optional */ }
        // isi $ native ETH dari harga token WETH (0x4200..0006 = standard OP-stack)
        try {
          const weth = await gmgn.tokenInfo("0x4200000000000000000000000000000000000006");
          const px = Number((weth?.price as any)?.price ?? weth?.price ?? 0);
          if (px > 0) tokens[0].usd = tokens[0].amount * px;
        } catch { /* price optional */ }

        const totalUsd = tokens.reduce((s, t) => s + (t.usd || 0), 0);
        const lines = tokens
          .map((t, i) => `${i + 1}. ${t.symbol}${t.address ? "" : " ⚡"} — ${fmtNumAmount(t.amount)}${t.usd ? ` ($${t.usd.toFixed(2)})` : ""}`)
          .join("\n");
        st.pendingSend = { tokens, token: null, to: "", amount: null };
        const mid = await editInPlace(
          ctx,
          "📤 *Send — pilih token*\n\nDari: `" + active.address + "`\n" +
          "💰 *Total saldo: $" + totalUsd.toFixed(2) + "*\n\n" +
          lines + "\n\nKetik *nomor* token yang mau dikirim, atau /cancel.",
          () => Markup.inlineKeyboard([bigRow("⬅️ Kembali", "back:wallet")])
        );
        st.sendMsgId = mid ?? st.sendMsgId;
      } catch (e: any) {
        await editInPlace(ctx, "⚠️ Gagal muat token: " + (e.message || String(e)), () => walletKeyboard());
      }
    }
    else if (cb === "send:cancel") {
      await cbAnswer(ctx, "Dibatalkan");
      delete (globalThis as any).__sendPending;
      await editInPlace(ctx, walletSummaryText(), () => walletKeyboard());
    }
    else if (cb === "send:confirm") {
      const p = (globalThis as any).__sendPending;
      if (settings.getSettings().mode !== "live" || !p) {
        await cbAnswer(ctx, p ? "Dry-run — tidak ada tx" : "Tidak ada pending");
        await editInPlace(
          ctx,
          "✅ *SEND* (" + (p?.token || "token") + ")\n\n" +
          (p ? `Jumlah: ${p.amount} ${p.token}\nKe: \`${p.to}\`` : "Tidak ada transaksi pending.") +
          (settings.getSettings().mode === "live" ? "" : "\n\nDry-run — tidak ada tx asli."),
          () => walletKeyboard()
        );
        delete (globalThis as any).__sendPending;
        return;
      }
      await cbAnswer(ctx, "Mengirim…");
      const active = walletMgr.getActiveWallet();
      if (!active?.privateKey) {
        await cbAnswer(ctx, "⚠️ Private key tidak ada");
        await editInPlace(ctx, "⚠️ Wallet aktif tidak punya private key.", () => walletKeyboard());
        delete (globalThis as any).__sendPending;
        return;
      }
      try {
        const { createWalletClient, createPublicClient, http, parseUnits, encodeFunctionData } = await import("viem");
        const { privateKeyToAccount } = await import("viem/accounts");
        const account = privateKeyToAccount(active.privateKey as `0x${string}`);
        const publicClient = createPublicClient({ transport: http(config.rpcUrl) });
        const walletClient = createWalletClient({
          account,
          chain: { id: 4663, name: "Robinhood", nativeCurrency: { name: "Ethereum", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } } },
          transport: http(config.rpcUrl),
        });
        const amountWei = BigInt(Math.floor(p.amount * 10 ** p.decimals));
        let txHash: `0x${string}`;
        if (!p.address) {
          // native ETH
          txHash = await walletClient.sendTransaction({ to: p.to as `0x${string}`, value: amountWei });
        } else {
          // ERC-20 transfer
          const data = encodeFunctionData({
            abi: [{ name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [
              { name: "to", type: "address" }, { name: "amount", type: "uint256" },
            ], outputs: [{ name: "", type: "bool" }] }],
            args: [p.to as `0x${string}`, amountWei],
          });
          txHash = await walletClient.sendTransaction({ to: p.address as `0x${string}`, data, value: 0n });
        }
        // verifikasi di explorer RPC
        let receipt = null;
        try {
          receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
        } catch { /* receipt optional kalau lambat */ }
        const okStatus = receipt ? receipt.status === "success" : true;
        await editInPlace(
          ctx,
          (okStatus ? "✅ *SEND BERHASIL* " : "⚠️ *TX MINED* (status? cek explorer)\n") +
          "(" + p.token + ")\n\n" +
          `Jumlah: ${p.amount} ${p.token}\n` +
          `Ke: \`${p.to}\`\n\n` +
          "Tx: `" + txHash + "`",
          () => walletKeyboard()
        );
        log("send", `LIVE send ${p.amount} ${p.token} -> ${p.to} tx=${txHash} status=${receipt?.status || "unknown"}`);
      } catch (e: any) {
        await editInPlace(ctx, "⚠️ Gagal kirim: " + (e.shortMessage || e.message || String(e)), () => walletKeyboard());
      }
      delete (globalThis as any).__sendPending;
    }
    else if (cb === "menu:settings") {
      await cbAnswer(ctx);
      const mid = await editInPlace(ctx, settingsSummaryText(), () => settingsKeyboard());
      st.settingsMsgId = mid ?? st.settingsMsgId;
    }
    else if (cb === "tdp:gview") {
      await cbAnswer(ctx);
      const mid = await editInPlace(ctx, tpGSummaryText(), () => tpGKeyboard());
      st.settingsMsgId = mid ?? st.settingsMsgId;
    }
    else if (cb === "tdp:gadd") {
      const s = settings.getSettings();
      const last = (s.tpLadder || []).length ? Math.max(...(s.tpLadder || []).map((l) => l.pct)) : 0;
      st.pendingTp = { addr: "GLOBAL", stage: "pct" };
      await cbAnswer(ctx, "Ketik profit % TP");
      const q = await ctx.reply(
        `🎯 *TP Ladder (global)* — level baru\n\n` +
        "Ketik *profit %* target level ini (dari entry).\n" +
        "Contoh: `30` = jual di +30% dari harga entry.\n\n" +
        ((s.tpLadder || []).length ? "Level yang udah ada: " + (s.tpLadder || []).map((l) => `+${l.pct}%`).join(", ") + "\n" : "") +
        "Harus lebih tinggi dari level sebelumnya. /cancel untuk batal.",
        { parse_mode: "Markdown" }
      );
      st.pendingInputMsgId = (q as any)?.message_id ?? null;
    }
    else if (cb === "tdp:gmoon") {
      const s = settings.getSettings();
      settings.setTpMoonbag(!s.tpMoonbag);
      await cbAnswer(ctx, s.tpMoonbag ? "🧘 Moonbag OFF" : "🧘 Moonbag ON");
      await editInPlace(ctx, tpGSummaryText(), () => tpGKeyboard());
    }
    else if (cb === "tdp:gclear") {
      st.pendingTp = null;
      settings.clearTpLadder();
      await cbAnswer(ctx, "🗑️ TP ladder dihapus");
      await editInPlace(ctx, tpGSummaryText(), () => tpGKeyboard());
    }
    else if (cb === "tdp:gdone") {
      st.pendingTp = null;
      await cbAnswer(ctx, "Selesai");
      await editInPlace(ctx, settingsSummaryText(), () => settingsKeyboard());
    }
    else if (cb.startsWith("set:input:")) {
      const key = cb.slice("set:input:".length);
      const cur = (settings.getSettings() as any)[key] as number;
      st.pendingInput = { kind: "setting", key, label: settings.describe(key), current: cur };
      st.settingsMsgId = (ctx.callbackQuery.message as any)?.message_id ?? st.settingsMsgId;
      await cbAnswer(ctx);
      const q = await ctx.reply(
        `✏️ *${settings.describe(key)}* sekarang: ${cur}\n\n` +
        "Ketik nilai baru (angka), atau /cancel.",
        { parse_mode: "Markdown" }
      );
      st.pendingInputMsgId = (q as any)?.message_id ?? null;
    }
    else if (cb === "set:risk") {
      const s = settings.getSettings();
      const order: settings.BotSettings["riskCap"][] = ["LOW", "MEDIUM", "HIGH"];
      const next = order[(order.indexOf(s.riskCap) + 1) % order.length];
      settings.setRiskCap(next);
      await cbAnswer(ctx, "✅ Risk cap: " + next);
      await editReply(ctx, settingsSummaryText(), () => settingsKeyboard());
    }
    else if (cb === "set:source") {
      const next = settings.setScanSource();
      await cbAnswer(ctx, "✅ Sumber scan: " + next.scanSource);
      await editReply(ctx, settingsSummaryText(), () => settingsKeyboard());
    }
    else if (cb === "set:trendiv") {
      const next = settings.setTrendingInterval();
      await cbAnswer(ctx, "✅ Interval trending: " + next.trendingInterval);
      await editReply(ctx, settingsSummaryText(), () => settingsKeyboard());
    }
    else if (cb === "set:mode") {
      const s = settings.getSettings();
      const next = s.mode === "live" ? "dry-run" : "live";
      settings.setMode(next);
      await cbAnswer(ctx, "✅ Mode: " + next.toUpperCase());
      await editReply(ctx, settingsSummaryText(), () => settingsKeyboard());
    }
    else if (cb === "set:auto") {
      const next = settings.setAutoTrade();
      await cbAnswer(ctx, "🤖 Auto Trade: " + (next.autoTrade ? "ON" : "OFF"));
      await editReply(ctx, settingsSummaryText(), () => settingsKeyboard());
    }
    // ===== FILTERS =====
    else if (cb === "menu:filters") {
      await cbAnswer(ctx);
      const mid = await editInPlace(ctx, filterSummaryText(), () => filtersKeyboard());
      st.filterMsgId = mid ?? st.filterMsgId;
    }
    else if (cb.startsWith("fx:input:")) {
      const key = cb.slice("fx:input:".length);
      const cur = (settings.getSettings().filters as any)[key] as number;
      st.pendingInput = { kind: "filter", key, label: settings.describe(key), current: cur };
      // pesan callback saat ini = pesan menu filter yang punya tombol — id buat edit hasilnya
      st.filterMsgId = (ctx.callbackQuery.message as any)?.message_id ?? st.filterMsgId;
      await cbAnswer(ctx);
      const q = await ctx.reply(
        `👇 *${settings.describe(key)}* sekarang: ${cur}\n\n` +
        "Ketik nilai (angka saja), /cancel untuk batal.",
        { parse_mode: "Markdown" }
      );
      st.pendingInputMsgId = (q as any)?.message_id ?? null;
    }
    else if (cb.startsWith("fx:toggle:")) {
      const key = cb.slice("fx:toggle:".length) as keyof settings.FilterSettings;
      const cur = !!(settings.getSettings().filters as any)[key];
      settings.setFilterBool(key, !cur);
      st.filterMsgId = (ctx.callbackQuery.message as any)?.message_id ?? st.filterMsgId;
      await cbAnswer(ctx, `✅ ${settings.describe(key)}: ${!cur ? "ON" : "OFF"}`);
      await editReply(ctx, filterSummaryText(), () => filtersKeyboard());
    }
    else if (cb.startsWith("fx:")) {
      await cbAnswer(ctx, "Filter belum dikonfigurasi");
    }
    // ===== PNL =====
    else if (cb === "menu:pnl") {
      await cbAnswer(ctx);
      const st = positions.stats();
      const closed = positions.recentClosed(20);
      let msg = "📈 *PnL Report*\n\n";
      msg += `Open: ${st.open} | Closed: ${st.closed}\n`;
      msg += `Daily PnL: *${st.dailyPnlUsd >= 0 ? "+" : ""}$${st.dailyPnlUsd.toFixed(2)}* (${st.dayWin}W/${st.dayLoss}L)\n`;
      msg += `All-time PnL: *${st.totalPnlUsd >= 0 ? "+" : ""}$${st.totalPnlUsd.toFixed(2)}* (${st.win}W/${st.loss}L, win rate ${st.closed ? Math.round((st.win / st.closed) * 100) : 0}%)\n\n`;

      if (closed.length) {
        msg += "*Riwayat Close (max 20)*\n";
        for (const p of closed) {
          const when = p.closedAt ? new Date(p.closedAt).toLocaleString("id-ID", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "-";
          msg += `${escMd(p.symbol)} · ${escMd(p.closeReason)} · ${(p.pnlPct ?? 0) >= 0 ? "+" : ""}${(p.pnlPct ?? 0).toFixed(1)}% (${(p.pnlUsd ?? 0) >= 0 ? "+" : ""}$${(p.pnlUsd ?? 0).toFixed(2)}) · ${when}\n`;
        }
      } else {
        msg += "Belum ada posisi close. Auto-engine bakal isi saat ada sinyal.\n";
      }
      await editInPlace(ctx, msg, () => mainKeyboard());
    }
    // ===== POSITIONS =====
    else if (cb === "menu:positions") {
      await cbAnswer(ctx);
      const opens = positions.listOpen();
      if (!opens.length) {
        await editInPlace(ctx, "📭 *Position* kosong — belum ada posisi terbuka.\n\nAuto-engine bakal buka saat ada sinyal.", () => mainKeyboard());
        return;
      }
      let msg = "📑 *Posisi Terbuka*\n\n";
      const rows: any[] = [];
      for (const p of opens) {
        let cur = p.entryPrice;
        let mc = 0;
        try {
          const info = await gmgn.tokenInfo(p.tokenAddress);
          const px = Number((info?.price as any)?.price ?? info?.price ?? 0);
          if (px > 0) cur = px;
          const supply = Number(info?.circulating_supply || info?.total_supply || 0);
          if (supply > 0) mc = px * supply;
        } catch { /* keep entry */ }
        const pct = cur > 0 ? ((cur - p.entryPrice) / p.entryPrice) * 100 : 0;
        const eth = (pct / 100) * p.sizeUsd;
        msg += `*${escMd(p.symbol)}* — ${escMd(p.name)}\n` +
          `Entry: $${fmtPrice(p.entryPrice)} → Now: $${fmtPrice(cur)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)\n` +
          `MC: $${mc.toLocaleString(undefined, { maximumFractionDigits: 0 })} | Size: ${fmtEthAmt(p.sizeUsd)} ETH | uPnL: ${eth >= 0 ? "+" : ""}${fmtEthAmt(eth)} ETH\n`;
        if (p.tpPlan?.length) {
          const rem = Math.round((p.remainingFrac ?? 1) * 100);
          msg += `🎯 TP: ${p.tpPlan.map((l) => `+${l.pct}%→${l.frac}%${l.triggered ? "✓" : ""}`).join(" · ")} | Sisa ${rem}%${p.moonbag ? " 🧘" : ""}\n`;
        }
        msg += `\n`;
        // satu baris: tombol GMGN (buka chart) + Sell + TP
        rows.push([
          Markup.button.url(`📈 GMGN ${p.symbol}`, `https://gmgn.ai/robinhood/token/${p.tokenAddress}`),
          Markup.button.callback(`💸 Sell ${p.symbol}`, `pos:sell:${p.tokenAddress}`),
          Markup.button.callback(`🎯 TP`, `tdp:view:${p.tokenAddress}`),
        ]);
      }
      rows.push(bigRow("🔄 Refresh", "menu:positions"));
      rows.push(bigRow("⬅️ Kembali", "back:main"));
      await editInPlace(ctx, msg, () => Markup.inlineKeyboard(rows));
    }
    // ===== TP LADDER (partial take profit) =====
        else if (cb.startsWith("tdp:view:")) {
          const addr = cb.slice("tdp:view:".length).toLowerCase();
          const p = positions.listOpen().find((x) => x.tokenAddress.toLowerCase() === addr);
          if (!p) {
            await cbAnswer(ctx, "⚠️ Posisi sudah tidak ada");
            return;
          }
          await cbAnswer(ctx);
          await editInPlace(ctx, tpSummaryText(p), () => tpKeyboard(p));
        }
        else if (cb.startsWith("tdp:add:")) {
          const addr = cb.slice("tdp:add:".length).toLowerCase();
          const p = positions.listOpen().find((x) => x.tokenAddress.toLowerCase() === addr);
          if (!p) {
            await cbAnswer(ctx, "⚠️ Posisi sudah tidak ada");
            return;
          }
          st.pendingTp = { addr, stage: "pct" };
          await cbAnswer(ctx, "Ketik profit % TP");
          const q = await ctx.reply(
            `🎯 *TP Ladder — ${escMd(p.symbol)}* (level baru)\n\n` +
            "Ketik *profit %* target level ini (dari entry).\n" +
            "Contoh: `30` = jual di +30% dari harga entry.\n\n" +
            (p.tpPlan?.length ? "Level yang udah ada: " + p.tpPlan.map((l) => `+${l.pct}%`).join(", ") + "\n" : "") +
            "Harus lebih tinggi dari level sebelumnya. /cancel untuk batal.",
            { parse_mode: "Markdown" }
          );
          st.pendingInputMsgId = (q as any)?.message_id ?? null;
        }
        else if (cb.startsWith("tdp:hold:")) {
          const addr = cb.slice("tdp:hold:".length).toLowerCase();
          const p = positions.listOpen().find((x) => x.tokenAddress.toLowerCase() === addr);
          if (!p) {
            await cbAnswer(ctx, "⚠️ Posisi sudah tidak ada");
            return;
          }
          const res = positions.setTpPlan(addr, p.tpPlan || [], true);
          await cbAnswer(ctx, res.ok ? "🧘 Sisa jadi moonbag" : "⚠️ " + (res.error || "gagal"));
          const np = positions.listOpen().find((x) => x.tokenAddress.toLowerCase() === addr) || p;
          await editInPlace(ctx, tpSummaryText(np), () => tpKeyboard(np));
        }
        else if (cb.startsWith("tdp:clear:")) {
          const addr = cb.slice("tdp:clear:".length).toLowerCase();
          st.pendingTp = null;
          const res = positions.clearTpPlan(addr);
          await cbAnswer(ctx, res.ok ? "🗑️ Plan TP dihapus" : "⚠️ " + (res.error || "gagal"));
          const p = positions.listOpen().find((x) => x.tokenAddress.toLowerCase() === addr);
          if (p) await editInPlace(ctx, tpSummaryText(p), () => tpKeyboard(p));
        }
        else if (cb.startsWith("tdp:done:")) {
          const addr = cb.slice("tdp:done:".length).toLowerCase();
          st.pendingTp = null;
          await cbAnswer(ctx, "Selesai");
          const p = positions.listOpen().find((x) => x.tokenAddress.toLowerCase() === addr);
          const msg = p
            ? tpSummaryText(p) + "\n\n— Auto-engine bakal jual parsial tiap level kena, sisanya tetap open —"
            : "📭 Posisi sudah ditutup.";
          await editInPlace(ctx, msg, () => Markup.inlineKeyboard([bigRow("📑 Position", "menu:positions"), bigRow("🗂️ Menu", "back:main")]));
        }
        else if (cb.startsWith("pos:sell:")) {
      const addr = cb.slice("pos:sell:".length).toLowerCase();
      const p = positions.listOpen().find((x) => x.tokenAddress.toLowerCase() === addr);
      if (!p) {
        await cbAnswer(ctx, "⚠️ Posisi sudah tidak ada");
        return;
      }
      await cbAnswer(ctx);
      await editInPlace(ctx,
        `💸 *Sell ${escMd(p.symbol)}* (${walletMgr.shortLabel(p.tokenAddress)})\n\n` +
        `Entry: $${fmtPrice(p.entryPrice)} · Size: ${fmtEthAmt(p.sizeUsd)} ETH\n\n` +
        `Yakin mau jual sekarang?`,
        () => Markup.inlineKeyboard([
          [Markup.button.callback("✅ Konfirmasi Jual", `pos:confirm:${p.tokenAddress}`)],
          [Markup.button.callback("❌ Batal", "pos:cancel")],
        ])
      );
    }
    else if (cb === "pos:cancel") {
      await cbAnswer(ctx, "Dibatalkan");
      await editInPlace(ctx, "📑 Posisi dibatalkan.", () => mainKeyboard());
    }
    else if (cb.startsWith("pos:confirm:")) {
      const addr = cb.slice("pos:confirm:".length).toLowerCase();
      const p = positions.listOpen().find((x) => x.tokenAddress.toLowerCase() === addr);
      if (!p) {
        await cbAnswer(ctx, "⚠️ Posisi sudah tidak ada");
        await editInPlace(ctx, "⚠️ Posisi sudah tidak ada.", () => mainKeyboard());
        return;
      }
      await cbAnswer(ctx, "💸 Menjual…");
      try {
        const info = await gmgn.tokenInfo(p.tokenAddress).catch(() => null);
        const px = Number((info?.price as any)?.price ?? info?.price ?? 0);
        if (!px) throw new Error("Harga tidak ditemukan (GMGN down?) — coba lagi nanti");
        // Eksekusi lewat executor — LIVE beneran jual on-chain, dry-run simulasi.
        const ex = createExecutor(walletMgr.getActiveWallet()?.address || "");
        const res = await ex.sell(
          { address: p.tokenAddress, symbol: p.symbol, name: p.name, price: px },
          "MANUAL_SELL",
          px
        );
        if (!res.ok) {
          await editInPlace(ctx, "⚠️ Gagal sell: " + (res.error || "unknown"), () => mainKeyboard());
          return;
        }
        const pct = res.pct ?? 0;
        const usd = res.usd ?? 0;
        await editInPlace(
          ctx,
          "✋ *MANUAL SELL*" + (res.simulated ? " (dry-run)" : " (LIVE)") + "\n\n" +
          `Token: ${p.symbol}\n` +
          `Exit: $${fmtPrice(px)}\n` +
          `PnL: ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% (${usd >= 0 ? "+" : ""}${fmtEthAmt(usd)} ETH)`,
          () => mainKeyboard()
        );
      } catch (e: any) {
        await editInPlace(ctx, "⚠️ Gagal sell: " + (e.message || String(e)), () => mainKeyboard());
      }
    }
    else {
      await cbAnswer(ctx, "⚠️ Perintah tidak dikenal");
    }
  } catch (e: any) {
    console.error("[callback] error:", e);
    await ctx.reply("⚠️ Error: " + (e.message || String(e))).catch(() => {});
  }
});

// ---------- text commands (confirmation flows) ----------
bot.on("text", async (ctx) => {
  const chatId = ctx.chat.id;
  const st = getState(chatId);
  const text = (ctx.message.text || "").trim();

  if (text === "/cancel") {
    st.pendingDelete = null;
    st.pendingSend = null;
    st.pendingInput = null;
    st.pendingPresetName = null;
    st.pendingTp = null;
    delete (globalThis as any).__sendPending;
    // hapus pesan flow send yang lagi di-edit biar ga nyangkut
    if (st.sendMsgId != null) {
      try {
        await bot.telegram.deleteMessage(chatId, st.sendMsgId);
      } catch { /* noop */ }
      st.sendMsgId = null;
    }
    await cleanInputMessages(chatId, st, ctx.message.message_id);
    const cancelMsg = await ctx.reply("✅ Dibatalkan.");
    // balasan konfirmasi langsung hapus — biar ga nyangkut di chat
    if (cancelMsg && (cancelMsg as any).message_id) {
      bot.telegram.deleteMessage(chatId, (cancelMsg as any).message_id).catch(() => {});
    }
    return;
  }

  // preset save flow: user ketik nama preset
  if (st.pendingPresetName) {
    const res = settings.savePreset(text);
    st.pendingPresetName = null;
    // hapus pertanyaan + jawaban LANGSUNG — biar ga ada delay
    await cleanInputMessages(chatId, st, ctx.message.message_id);
    if (!res.ok) {
      await ctx.reply("⚠️ " + (res.error || "Gagal simpan preset"));
      return;
    }
    const okEdit = await editMenuMessage(chatId, st.filterMsgId, presetSummaryText(), () => presetKeyboard());
    if (!okEdit) {
      await ctx.reply(`✅ *Preset "${escMd(text)}" disimpan*\n\n` + presetSummaryText(), {
        parse_mode: "Markdown",
        ...presetKeyboard(),
      });
    }
    return;
  }

  // TP ladder wizard: user ketik angka
    if (st.pendingTp) {
      const pt = st.pendingTp;
      const isGlobal = pt.addr === "GLOBAL";
      const p = isGlobal ? null : positions.listOpen().find((x) => x.tokenAddress.toLowerCase() === pt.addr.toLowerCase());
      if (!isGlobal && !p) {
        st.pendingTp = null;
        await ctx.reply("⚠️ Posisi sudah ditutup.");
        return;
      }
      const amt = parseFloat(text.replace(/[.,]/g, (m) => (m === "," ? "." : m)).replace(/[^0-9.\-]/g, ""));
      if (Number.isNaN(amt)) {
        await ctx.reply("⚠️ Input harus angka. Coba lagi atau /cancel.");
        return;
      }
      // hapus pesan pertanyaan + jawaban langsung
      await cleanInputMessages(chatId, st, ctx.message.message_id);

      if (pt.stage === "pct") {
        // validasi: pct harus naik dari level terakhir
        const cur = isGlobal
          ? (settings.getSettings().tpLadder || []).map((l) => l.pct)
          : (p!.tpPlan || []).map((l) => l.pct);
        const last = cur.length ? Math.max(...cur) : 0;
        if (amt <= last) {
          st.pendingTp = null;
          if (isGlobal) {
            await cbAnswer(ctx, "⚠️ Harus lebih tinggi");
            await editInPlace(ctx, `⚠️ Profit % harus lebih tinggi dari level terakhir (+${last}%).\n\n${tpGSummaryText()}`, () => tpGKeyboard());
          } else {
            await cbAnswer(ctx, "⚠️ Harus lebih tinggi");
            await editInPlace(ctx, `⚠️ Profit % harus lebih tinggi dari level terakhir (+${last}%).\n\n${tpSummaryText(p!)}`, () => tpKeyboard(p!));
          }
          return;
        }
        pt.tmpPct = amt;
        pt.stage = "frac";
        const q = await ctx.reply(
          `🎯 *TP Ladder${isGlobal ? " (global)" : " — " + (p!.symbol || "")}* — level baru: *+${amt}%*\n\n` +
          "Sekarang ketik *berapa % dari posisi awal (100%)* yang dijual di level ini (1-100).\n" +
          "Contoh: `50` = jual 50% dari seluruh posisi di level ini; sisanya lanjut ke level berikutnya / moonbag.\n\n" +
          "/cancel untuk batal.",
          { parse_mode: "Markdown" }
        );
        st.pendingInputMsgId = (q as any)?.message_id ?? null;
        return;
      }

      // stage = "frac" → tambah level
      if (amt <= 0 || amt > 100) {
        st.pendingTp = null;
        if (isGlobal) {
          await cbAnswer(ctx, "⚠️ 1-100");
          await editInPlace(ctx, `⚠️ Persen jual harus 1-100.\n\n${tpGSummaryText()}`, () => tpGKeyboard());
        } else {
          await editInPlace(ctx, `⚠️ Persen jual harus 1-100.\n\n${tpSummaryText(p!)}`, () => tpKeyboard(p!));
        }
        return;
      }
      const tmpPct = pt.tmpPct ?? 0;
      if (isGlobal) {
        const cur = settings.getSettings().tpLadder || [];
        settings.setTpLadder([...cur, { pct: tmpPct, frac: amt }]);
        st.pendingTp = null;
        await editInPlace(ctx, tpGSummaryText(), () => tpGKeyboard());
        return;
      }
      const level: positions.TpPlanLevel = { pct: tmpPct, frac: amt, triggered: false };
      const plan = [...(p!.tpPlan || []), level];
      const res = positions.setTpPlan(pt.addr, plan);
      st.pendingTp = null;
      if (!res.ok) {
        await editInPlace(ctx, `⚠️ ${res.error}\n\n${tpSummaryText(p!)}`, () => tpKeyboard(p!));
        return;
      }
      const np = positions.listOpen().find((x) => x.tokenAddress.toLowerCase() === pt.addr.toLowerCase()) || p!;
      await editInPlace(ctx, tpSummaryText(np), () => tpKeyboard(np));
      return;
    }

  // manual numeric input for settings/filters
  if (st.pendingInput) {
    const pi = st.pendingInput;
    const amt = parseFloat(text.replace(/[.,]/g, (m) => (m === "," ? "." : m)).replace(/[^0-9.\-]/g, ""));
    if (Number.isNaN(amt)) {
      await ctx.reply("⚠️ Input harus angka. Coba lagi atau /cancel.");
      return;
    }
    // hapus pertanyaan + jawaban LANGSUNG (bukan nunggu edit menu selesai) — biar ga ada delay
    st.pendingInput = null; // bersihkan dulu biar ga re-entry kalau edit menu gagal
    await cleanInputMessages(chatId, st, ctx.message.message_id);
    if (pi.kind === "setting") {
      settings.setNumeric(pi.key as keyof settings.BotSettings, amt);
      const ok = await editMenuMessage(chatId, st.settingsMsgId, settingsSummaryText(), () => settingsKeyboard());
      await finishInputReply(chatId, st, pi.label, amt, ok, settingsSummaryText(), () => settingsKeyboard());
    } else {
      settings.setFilter(pi.key as keyof settings.FilterSettings, amt);
      const ok = await editMenuMessage(chatId, st.filterMsgId, filterSummaryText(), () => filtersKeyboard());
      await finishInputReply(chatId, st, pi.label, amt, ok, filterSummaryText(), () => filtersKeyboard());
    }
    return;
  }

  // --- kill switch / status ---
  if (text === "/pause") {
    risk.setKillSwitch(true);
    await ctx.reply("🔴 *PAUSED* — entry baru dihentikan.\n\nPosisi terbuka tetap dimonitor & emergency exit aktif.", {
      parse_mode: "Markdown",
      ...mainKeyboard(),
    });
    return;
  }
  // ---- wallet watch ----
  if (text.startsWith("/watch ")) {
    const addr = text.slice(7).trim().split(/\s+/)[0];
    const label = text.slice(7).trim().split(/\s+/).slice(1).join(" ") || undefined;
    const res = settings.addWatchWallet(addr, label);
    if (!res.ok) {
      await ctx.reply("⚠️ " + (res.error || "Gagal tambah wallet"));
    } else {
      await ctx.reply("✅ *Wallet ditambahkan ke watchlist*\n\n" + watchlistText(), { parse_mode: "Markdown" });
    }
    return;
  }
  if (text === "/watch") {
    await ctx.reply("📝 Format: `/watch 0x... label(opsional)`\nContoh: `/watch 0xabc123 ... 0xabc123` wallet", {
      parse_mode: "Markdown",
    });
    return;
  }
  if (text.startsWith("/unwatch ")) {
    const addr = text.slice(9).trim().split(/\s+/)[0];
    const ok = settings.removeWatchWallet(addr);
    await ctx.reply(ok ? "✅ Wallet dihapus dari watchlist." : "⚠️ Wallet tidak ada di watchlist.", {
      parse_mode: "Markdown",
    });
    return;
  }
  if (text === "/watchlist") {
    const w = settings.listWatchedWallets();
    if (!w.length) {
      await ctx.reply("📭 Watchlist kosong. Tambah dengan `/watch <address>`", { parse_mode: "Markdown" });
    } else {
      await ctx.reply(watchlistText(), { parse_mode: "Markdown" });
    }
    return;
  }
  if (text === "/resume") {
    risk.setKillSwitch(false);
    await ctx.reply("🟢 *RESUMED* — bot bisa entry lagi.", {
      parse_mode: "Markdown",
      ...mainKeyboard(),
    });
    return;
  }
  if (text === "/status") {
    const stt = positions.stats();
    const riskLine = risk.riskSummary();
    await ctx.reply(
      "📊 *Status*\n\n" +
      `Mode: ${settings.getSettings().mode === "live" ? "🟢 LIVE" : "🟡 DRY-RUN"}\n` +
      riskLine + "\n" +
      `Win/Loss closed: ${stt.win}/${stt.loss} | Total PnL: $${stt.totalPnlUsd.toFixed(2)}`,
      { parse_mode: "Markdown", ...mainKeyboard() }
    );
    return;
  }
  if (text === "/close_all") {
    const opens = positions.listOpen();
    if (!opens.length) {
      await ctx.reply("Gak ada posisi terbuka.");
      return;
    }
    await ctx.reply(`⚠️ Konfirmasi tutup semua ${opens.length} posisi? Ketik \`/confirm_close_all\`.\nAtau /cancel.`, {
      parse_mode: "Markdown",
    });
    (globalThis as any).__closeAllPending = true;
    return;
  }
  if (text === "/confirm_close_all" && (globalThis as any).__closeAllPending) {
    delete (globalThis as any).__closeAllPending;
    const opens = positions.listOpen();
    let count = 0;
    for (const p of opens) {
      try {
        const info = await gmgn.tokenInfo(p.tokenAddress);
        const price = info?.price ?? info?.price_usd ?? 0;
        const closed = positions.closePosition(p.tokenAddress, "MANUAL_CLOSE_ALL", price);
        count += closed ? 1 : 0;
      } catch { /* skip */ }
    }
    await ctx.reply(`✅ ${count} posisi ditutup.`, { parse_mode: "Markdown", ...mainKeyboard() });
    return;
  }

  // delete confirm
  if (text === "/confirm_delete" && st.pendingDelete) {
    const addr = st.pendingDelete;
    const res = walletMgr.deleteWallet(addr);
    st.pendingDelete = null;
    if (res.ok) {
      log("wallet", "deleted " + addr);
      await ctx.reply("✅ Wallet dihapus:\n\n" + walletSummaryText() + "\n\n" + walletMenuHint(), {
        parse_mode: "Markdown",
      });
    } else {
      await ctx.reply("⚠️ " + (res.error || "Gagal hapus"));
    }
    return;
  }
  if (text === "/confirm_delete" && !st.pendingDelete) {
    await ctx.reply("⚠️ Tidak ada wallet pending delete.");
    return;
  }

  // send flow: step 1 awaiting token number
  if (st.pendingSend && !st.pendingSend.token && /^\d+$/.test(text)) {
    const idx = parseInt(text, 10) - 1;
    const tk = st.pendingSend.tokens?.[idx];
    if (!tk) {
      await ctx.reply("⚠️ Nomor tidak valid. Pilih 1–" + (st.pendingSend.tokens?.length || 1) + ", atau /cancel.");
      return;
    }
    st.pendingSend.token = tk;
    // hapus pertanyaan + jawaban langsung
    await cleanInputMessages(chatId, st, ctx.message.message_id);
    const ok = await editMenuMessage(
      chatId, st.sendMsgId,
      "📤 Token: *" + tk.symbol + "*" + (tk.name ? ` — ${tk.name}` : "") + "\n" +
      "Saldo: *" + fmtNumAmount(tk.amount) + "*" + (tk.usd ? ` ($${tk.usd.toFixed(2)})` : "") + "\n\n" +
      "Sekarang ketik *alamat tujuan* (0x...):",
      () => Markup.inlineKeyboard([bigRow("⬅️ Kembali", "back:wallet")])
    );
    if (!ok) {
      await ctx.reply("📤 Token: *" + tk.symbol + "* · saldo: *" + fmtNumAmount(tk.amount) + "*\n\nKetik alamat tujuan (0x...):", { parse_mode: "Markdown" });
    }
    return;
  }
  // send flow: step 2 awaiting destination (wajib format EVM valid)
  if (st.pendingSend && st.pendingSend.token && !st.pendingSend.to) {
    const m = text.trim().match(/^0x[0-9a-fA-F]{40}$/);
    if (!m) {
      await ctx.reply(
        "⚠️ Alamat tidak valid. Format EVM address: `0x` + 40 karakter hex (a-f, 0-9).\n" +
        "Contoh: `0x1234...abcd` — cek lagi, jangan kurang/lebih 1 karakter."
      );
      return;
    }
    st.pendingSend.to = m[0].toLowerCase();
    // hapus pertanyaan + jawaban langsung
    await cleanInputMessages(chatId, st, ctx.message.message_id);
    const tk = st.pendingSend.token;
    const ok = await editMenuMessage(
      chatId, st.sendMsgId,
      "📤 Token: *" + tk.symbol + "* · saldo: *" + fmtNumAmount(tk.amount) + "*\n" +
      "Tujuan: `" + m[0] + "`\n\nSekarang ketik *jumlah* yang mau dikirim, atau /cancel.",
      () => Markup.inlineKeyboard([bigRow("⬅️ Kembali", "back:wallet")])
    );
    if (!ok) {
      await ctx.reply("📤 Token: *" + tk.symbol + "* · saldo: *" + fmtNumAmount(tk.amount) + "*\n\nSekarang ketik jumlah (token asli / USD) atau /cancel.", { parse_mode: "Markdown" });
    }
    return;
  }
  // send flow: step 3 awaiting amount
  if (st.pendingSend && st.pendingSend.token && st.pendingSend.to && st.pendingSend.amount === null) {
    const amt = parseFloat(text.replace(/[$,]/g, ""));
    if (Number.isNaN(amt) || amt <= 0) {
      await ctx.reply("⚠️ Jumlah tidak valid. Ketik angka (misal 50).");
      return;
    }
    const tk = st.pendingSend.token;
    if (amt > tk.amount) {
      await ctx.reply(
        "⚠️ Jumlah *melebihi saldo*. Saldo " + tk.symbol + ": *" + fmtNumAmount(tk.amount) + "* — ketik ulang atau /cancel."
      );
      return;
    }
    st.pendingSend.amount = amt;
    const { token, to, amount } = st.pendingSend;
    const active = walletMgr.getActiveWallet();
    // hapus pertanyaan + jawaban langsung
    await cleanInputMessages(chatId, st, ctx.message.message_id);
    const confText =
      "🚀 *SEND CONFIRMATION*\n\n" +
      "Token: *" + token.symbol + "* · saldo: *" + fmtNumAmount(token.amount) + "*\n" +
      "Dari: `" + (active?.address || "?") + "`\n" +
      "Ke: `" + to + "`\n" +
      "Jumlah: " + fmtNumAmount(amount) + " " + token.symbol + "\n\n" +
      "Mode: *" + settings.getSettings().mode.toUpperCase() + "*\n\n" +
      (settings.getSettings().mode === "live"
        ? "Tap konfirmasi untuk kirim tx asli."
        : "Dry-run — kirim disimulasikan, tidak ada tx asli.");
    st.pendingSend = null; // bersihkan dulu biar ga re-entry
    const ok = await editMenuMessage(
      chatId, st.sendMsgId, confText,
      () => Markup.inlineKeyboard([
        [Markup.button.callback("✅ Konfirmasi Kirim", "send:confirm")],
        [Markup.button.callback("❌ Batal", "send:cancel")],
      ])
    );
    if (!ok) {
      await ctx.reply(confText, { parse_mode: "Markdown" });
    }
    if (settings.getSettings().mode === "dry-run") {
      log("send", `DRY-RUN send ${amount} ${token.symbol} -> ${to}`);
    } else {
      (globalThis as any).__sendPending = { chatId, to, amount, token: token.symbol, address: token.address, decimals: token.decimals };
    }
    return;
  }
  if (text === "/confirm" && (globalThis as any).__sendPending) {
    const p = (globalThis as any).__sendPending;
    if (p.chatId !== chatId) {
      await ctx.reply("⚠️ Tidak ada transaksi pending di chat ini.");
      return;
    }
    // TODO: wire real viem tx once live executor lands
    await ctx.reply("✅ *(Dry-run placeholder)* Send " + p.amount + " -> " + p.to + "\n\nLive executor belum diimplementasi.", {
      parse_mode: "Markdown",
    });
    delete (globalThis as any).__sendPending;
    return;
  }

  // unknown
  await ctx.reply("⚠️ Command tidak dikenal. Ketik /start buat menu.");
});

export async function startBot() {
  // NOTE: telegraf's bot.launch() awaits the polling loop and never resolves
  // while the bot is running. Launch fire-and-forget and keep errors surfaced.
  bot.launch().catch((e: any) => {
    log("telegram", "bot launch error: " + (e?.message || String(e)));
  });
  // give launch a moment to complete getMe + first poll
  await new Promise((r) => setTimeout(r, 1500));
  log("telegram", "bot started");
}

export async function stopBot() {
  await bot.stop();
}

/** Send an automated message to the configured admin chat (used by auto-engine). */
export async function sendAdmin(text: string, extra: Record<string, unknown> = {}): Promise<void> {
  const chatId = config.telegram.chatId;
  if (!chatId) {
    log("telegram", "no chatId configured, skipping notify");
    return;
  }
  try {
    await bot.telegram.sendMessage(chatId, text, { parse_mode: "Markdown", ...extra });
  } catch (e: any) {
    log("telegram", "notify markdown failed, retry plain: " + (e?.message || String(e)));
    try {
      await bot.telegram.sendMessage(chatId, text, { ...extra });
    } catch (e2: any) {
      log("telegram", "notify plain also failed: " + (e2?.message || String(e2)));
    }
  }
}

export { bot };
export type { Context };