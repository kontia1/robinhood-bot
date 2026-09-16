/**
 * Auto engine — schedules scans, runs strategy → risk → executor pipeline,
 * monitors TP/SL/trailing, and emits Telegram notifications for every event.
 */
import { config } from "../config/index.js";
import * as gmgn from "../chain/gmgn.js";
import * as v3 from "../chain/uniswap-v3.js";
import { scanNow, ScanResult } from "../scanner/scanner.js";
import * as positions from "../positions/index.js";
import type { Position } from "../positions/index.js";
import { getSettings } from "../settings/index.js";
import { listWatchedWallets } from "../settings/index.js";
import * as walletMgr from "../wallet/index.js";
import { evaluateEntry } from "../strategy/strategy-engine.js";
import * as risk from "../risk/risk-manager.js";
import { createExecutor, TradeExecutor } from "../execution/executor.js";

function fmtNum(n: number | undefined | null): string {
  if (n == null || Number.isNaN(n)) return "?";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

/** Potong pesan error biar gak bikin notif Telegram "message is too long" (4096 limit). */
function truncErr(s: unknown, max = 300): string {
  let str = String(s ?? "unknown").replace(/\s+/g, " ").trim();
  if (str.length <= max) return str;
  // potong ada stack/repeated yang panjang
  return str.slice(0, max - 3) + "…";
}

/** Escape karakter Markdown khusus di teks dinamis (symbol, reason, error) biar gak rusak parse. */
function escMd(s: unknown): string {
  return String(s ?? "").replace(/([_*[\]`])/g, "\\$1");
}

/** Angka polos (tanpa $) untuk holders, count, dll. */
function fmtNumPlain(n: number | undefined | null): string {
  if (n == null || Number.isNaN(n)) return "?";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(Math.round(n));
}

/** Format jumlah ETH hasil trade (0.000244, 0.05 dst) — biar nggak nampil $0.00 / e-notation utk minus. */
function fmtEthAmt(n: number | undefined | null): string {
  if (n == null || Number.isNaN(n)) return "?";
  const abs = Math.abs(n);
  if (abs >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  if (abs >= 0.000001) return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "") || "0";
  return n.toExponential(4);
}

/** Detail tambahan di notif token lolos: contract + smart-wallet-ish. */
function detailLine(r: ScanResult): string {
  return (
    "📜 Contract: `" + r.address + "`\n" +
    "👥 Holders: " + fmtNumPlain(r.holders) + " | Top10: " + top10HolderPctLabel(r.top10HolderPct) + " | 👍 KOL: " + r.kol + " | 🧠 Degen: " + r.smartDegen + "\n" +
    "🔥 Tax B/S: " + r.buyTax + "/" + r.sellTax + "% | " +
    (r.renounced ? "🔓 Renounced" : "🔒 No renounce") + " | " +
    (r.openSource ? "📖 Open source" : "📕 Closed source")
  );
}

function top10HolderPctLabel(p: number | null): string {
  return p == null ? "?" : p.toFixed(1) + "%";
}

/** Inline keyboard singkat buat notif otomatis: GMGN link + tombol Menu. */
function tokenKeyboard(r: ScanResult, includeSell = false) {
  const urlRow: any[] = [{ text: "📈 GMGN " + r.symbol, url: `https://gmgn.ai/robinhood/token/${r.address}` }];
  if (includeSell) urlRow.push({ text: "💸 Sell " + r.symbol, callback_data: `pos:sell:${r.address}` });
  return {
    reply_markup: {
      inline_keyboard: [urlRow, [{ text: "🗂️ Menu", callback_data: "back:main" }]],
    },
  };
}

export class AutoEngine {
  private notify: (text: string, extra?: Record<string, unknown>) => Promise<void>;
  private scanTimer: NodeJS.Timeout | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private seen = new Set<string>(); // address -> already alerted/bought (skip total)
  private notified = new Set<string>(); // address -> SKIP/RISK notification already sent (anti-spam, TETAP re-evaluate)
    private watchSeen = new Set<string>(); // watch tx hash -> already alerted
    private running = false;
    private executor: TradeExecutor;
    private execMode: string = "";
    private execWallet: string = "";
    private walletAddress: string;
    private lastScanAt = 0; // ms epoch — throttle for event-driven triggerScan
    private lastPriceCheckAt: Record<string, number> = {}; // token addr → last gmgn price check
    private lastBalCheckAt: Record<string, number> = {}; // token addr -> last RPC balance check

  constructor(notify: (text: string, extra?: Record<string, unknown>) => Promise<void>, walletAddress = "") {
    this.notify = notify;
    this.walletAddress = walletAddress;
    this.execMode = getSettings().mode;
    this.execWallet = walletAddress;
    this.executor = createExecutor(walletAddress);
  }

  /** Pastikan executor sesuai mode + wallet AKTIF sekarang — toggle mode / switch wallet langsung efektif. */
  private ensureExecutor(): TradeExecutor {
    const mode = getSettings().mode;
    const active = walletMgr.getActiveWallet()?.address || this.walletAddress;
    if (this.execMode !== mode || this.execWallet !== active) {
      console.log(`[auto] rebuild executor (mode ${this.execMode}→${mode}, wallet ${this.execWallet.slice(0, 8)}→${active.slice(0, 8)})`);
      this.execMode = mode;
      this.execWallet = active;
      this.executor = createExecutor(active);
    }
    return this.executor;
  }

  /** Live config — reads settings.json every tick so bot edits apply instantly. */
  private cfg() {
    const s = getSettings();
    return {
      intervalMs: s.scanIntervalMs,
      autoTrade: s.autoTrade,
      positionSizeEth: s.positionSizeEth,
      stopLossPct: s.stopLossPct,
      trailingStopPct: s.trailingStopPct,
      maxPositions: s.maxPositions,
      riskCap: s.riskCap,
    };
  }

  async start() {
    if (this.running) return;
    this.running = true;
    // rebuild executor so mode switches take effect without restart
    this.executor = createExecutor(this.walletAddress);
    console.log(`[auto] engine start (mode=${getSettings().mode}, wallet=${this.walletAddress.slice(0, 10) || "none"})`);
    await this.scanTick(true);
    const iv = this.cfg().intervalMs;
    console.log(`[auto] warm-up done, interval=${iv}ms`);
    this.scanTimer = setInterval(() => this.scanTick(false).catch(console.error), iv);
    // TP/SL/trailing — poll cepat (5 detik) biar posisi ke-manage responsif
    this.monitorTimer = setInterval(() => this.monitor().catch(console.error), 5_000);
    // wallet watch loop — every 2 intervals, lightweight
    this.watchTimer = setInterval(() => this.watchWallets().catch(console.error), Math.max(30_000, iv * 2));
  }

  stop() {
    this.running = false;
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.scanTimer = null;
    this.monitorTimer = null;
    this.watchTimer = null;
  }

  /** Event-driven scan trigger (WebSocket new block). Throttled by scan interval. */
  triggerScan(): void {
    if (!this.running) return;
    const iv = this.cfg().intervalMs;
    if (Date.now() - this.lastScanAt < iv) return; // masih dalam cooldown interval
    this.scanTick(false).catch(console.error);
  }

  private async scanTick(initial = false) {
    const cfg = this.cfg();
    this.lastScanAt = Date.now();
    const results = await scanNow(20, initial);
    let buys = 0;
    let candidates = 0;
    const cands: string[] = [];
    for (const r of results) {
      const addr = r.address.toLowerCase();
      if (this.seen.has(addr)) continue;
      // warm-up: refresh cache aja, jangan masuk seen-set biar tick pertama
      // yang beneran bisa alert (kalau ga, semua token ke-skip, hasil selalu 0).
      if (initial) continue;

      // 1) strategy engine — full entry rules, not just score
      const decision = evaluateEntry(r);
      if (decision.decision !== "BUY") continue;
      candidates++;
      cands.push(`${r.symbol}(${r.address.slice(0, 6)})`);
      // NOTE: seen di-add SETELAH buy sukses (di bawah). Token yang gagal filter
      // ATAU risk-reject TETAP di-re-evaluate tiap scan — jadi pas kondisinya
      // membaik (progress naik, slot kosong) dia bisa masuk. Anti-spam notif
      // pakai `notified` terpisah.

      // auto trade OFF → jangan eksekusi, cuma hitung kandidat (biar user lihat ada sinyal)
      if (!cfg.autoTrade) continue;

      // 2) risk manager — gates every trade
      const riskCheck = risk.checkEntry(r.address, cfg.positionSizeEth);
      if (!riskCheck.ok) {
        console.log(`[auto] risk-reject ${r.symbol} ${r.address.slice(0, 8)} — ${riskCheck.reason}`);
        // notif buat token yg lolos filter tapi di-gate risk — biar tau kenapa ga di-buy
        if (getSettings().mode === "live" && !this.notified.has(addr)) {
          this.notified.add(addr);
          await this.notify(
            "⚠️ *SKIP (RISK)* — " + escMd(r.symbol) + " — " + escMd(r.name) + "\n\n" +
            "Price: $" + r.price + "\n" +
            "Alasan: " + escMd(riskCheck.reason || "risk reject") + "\n",
            tokenKeyboard(r)
          ).catch((e) => console.log("[auto] risk notif fail:", e?.message || e));
        }
        continue;
      }

      // 2b) min volume 5m — token mati guard (volume_5m cuma ada di tokenInfo, cek per-kandidat)
      const f5m = getSettings().filters.minVolume5m;
      if (f5m > 0) {
        try {
          const info = await gmgn.tokenInfo(r.address);
          const v5m = Number((info?.price as any)?.volume_5m ?? 0);
          if (!Number.isFinite(v5m) || v5m < f5m) {
            console.log(`[auto] skip ${r.symbol} — vol5m $${v5m} < $${f5m} (token mati)`);
            if (getSettings().mode === "live") {
              await this.notify(
                "⚪ *SKIP (VOL5M)* — " + escMd(r.symbol) + " — " + escMd(r.name) + "\n\n" +
                "Price: $" + r.price + "\n" +
                `Alasan: volume 5m $${fmtNum(Number(v5m) || 0)} < $${fmtNum(f5m)} (token sepi)\n`,
                tokenKeyboard(r)
              ).catch((e) => console.log("[auto] vol5m notif fail:", e?.message || e));
            }
            continue;
          }
        } catch {
          // tokenInfo gagal → biarkan (jangan blokir trade karena RPC error)
        }
      }

      // 3) execute (dry-run or live via same interface)
      const result = await this.ensureExecutor().buy(
        { address: r.address, symbol: r.symbol, name: r.name, price: r.price },
        cfg.positionSizeEth
      );
      if (!result.ok) {
        // notif gagal buy — biar user tau sinyal lolos tapi eksekusi gagal
        // NOTE: masuk seen biar ga retry-loop tiap 30s buat token yang sama
        this.seen.add(addr);
        const modeS = result.simulated ? "dry-run" : "LIVE";
        if (getSettings().mode === "live") {
          console.log(`[auto] buy gagal ${r.symbol} ${r.address.slice(0, 8)}: ${result.error || "unknown"}`);
          await this.notify(
            "❌ *BUY GAGAL* (LIVE)\n\n" +
            "Token: " + escMd(r.symbol) + " — " + escMd(r.name) + "\n" +
            "Price: $" + r.price + "\n" +
            "MC: " + fmtNum(r.marketCap) + " | Vol: " + fmtNum(r.volume) + " | Liq: " + fmtNum(r.liquidity) + "\n" +
            "Alasan filter: " + escMd(decision.reason) + "\n\n" +
            detailLine(r) + "\n\n" +
            "Error: `" + escMd(truncErr(result.error)) + "`",
            tokenKeyboard(r)
          ).catch((e) => console.log("[auto] buy-gagal notif fail:", e?.message || e));
        } else {
          console.log(`[auto] buy skipped ${r.symbol} — ${result.error || "fail"} (${modeS})`);
        }
        continue;
      }

      console.log(`[auto] auto buy OK ${r.symbol} ${r.address.slice(0, 8)} tx=${result.txHash || "-"} (${result.simulated ? "dry-run" : "LIVE"})`);
      buys++;
      this.seen.add(addr); // token yang SUDAH dibeli — skip dari evaluasi berikutnya
      const ladderTxt = (getSettings().tpLadder || []).length
        ? "🎯 TP: " + getSettings().tpLadder!.map((l) => `+${l.pct}%→${l.frac}%`).join(" · ") + (getSettings().tpMoonbag ? " 🧘" : "")
        : "🎯 TP: — (kalau mau, set di Settings → TP Ladder)";
      await this.notify(
        "🚀 *AUTO BUY*" + (result.simulated ? " (dry-run)" : " (LIVE)") + "\n\n" +
        "Token: " + escMd(r.symbol) + " — " + escMd(r.name) + "\n" +
        "Risk: " + r.risk + "\n" +
        "Price: $" + r.price + "\n" +
        "MC: " + fmtNum(r.marketCap) + " | Vol: " + fmtNum(r.volume) + " | Liq: " + fmtNum(r.liquidity) + "\n" +
        "Alasan: " + escMd(decision.reason) + "\n\n" +
        detailLine(r) + "\n\n" +
        "Size: " + cfg.positionSizeEth + " ETH | SL: " + cfg.stopLossPct + "%\n" +
        ladderTxt + "\n" +
        (result.txHash ? "TX: `" + result.txHash + "`" : ""),
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "📈 GMGN " + r.symbol, url: `https://gmgn.ai/robinhood/token/${r.address}` },
                { text: "💸 Sell " + r.symbol, callback_data: `pos:sell:${r.address}` },
              ],
              [
                { text: "📑 Position", callback_data: "menu:positions" },
              ],
              [
                { text: "🗂️ Menu", callback_data: "back:main" },
              ],
            ],
          },
        }
      ).catch((e) => console.log("[auto] auto-buy notif fail:", e?.message || e));
    }
    // visibility: kalau gak ada yang lolos, jangan diam-diam aja
    console.log(`[auto] scan: ${results.length} token, ${candidates} kandidat, ${buys} BUY${!cfg.autoTrade ? " (auto trade OFF)" : buys ? "" : " (semua ke-reject filter)"}${cands.length ? " — " + cands.join(", ") : ""}`);
  }

  private async monitor() {
    const cfg = this.cfg();
    if (risk.isKillSwitchOn()) return; // pause entries; monitoring still runs below
    const opens = positions.listOpen();

    // GMGN sedang backoff → skip update harga (data lama dipakai) biar ga nambah ban.
    // Balance check tetap jalan via RPC (murah, tanpa GMGN).
    const gmgnDown = gmgn.inBackoff();
    const now = Date.now();

    for (const pos of opens) {
      const key = pos.tokenAddress.toLowerCase();
      try {
        // Catch-up: posisi lama yg belum punya tpPlan → pakai default global ladder (kalau di-set).
        // Skip kalau user sengaja matiin (tpOptOut = clear manual).
        if ((!Array.isArray(pos.tpPlan) || !pos.tpPlan.length) && !pos.tpOptOut) {
          const s = getSettings();
          if (Array.isArray(s.tpLadder) && s.tpLadder.length) {
            const st = positions.setTpPlan(pos.tokenAddress, s.tpLadder.map((l) => ({ pct: l.pct, frac: l.frac, triggered: false })), s.tpMoonbag);
            if (st.ok) console.log(`[auto] apply global TP ladder ke ${pos.symbol} (catch-up)`);
            else console.log(`[auto] catch-up ladder ${pos.symbol}: ${st.error}`);
          }
        }
        // ----- harga (GMGN) — throttle per token: maks 1 call per 20s -----
        let px = 0;
        let hasPrice = false;
        if (!gmgnDown && (this.lastPriceCheckAt[key] ?? 0) + 20_000 <= now) {
          this.lastPriceCheckAt[key] = now;
          const info = await gmgn.tokenInfo(pos.tokenAddress).catch(() => null);
          // GMGN token info → price berupa object {price, price_1m, ...} — ambil angka di dalamnya
          px = Number((info?.price as any)?.price ?? info?.price_usd ?? info?.price ?? 0);
          hasPrice = Number.isFinite(px) && px > 0;
        } else if (this.lastPriceCheckAt[key]) {
          // harga segar blom waktunya — pakai data entry buat hitung kasar, TP/SL tetap jalan
          hasPrice = false;
        }

        // ----- Reconcile (RPC) — throttle per POS: maks 1 cek balance per 30s -----
        // posisi open tapi token udah gak ada di wallet (dijual manual) → tutup otomatis.
        // HANYA di mode LIVE: dry-run posisi cuma simulasi, balance wallet asli selalu 0
        // (token gak pernah dibeli beneran) → kalau dijalanin bikin posisi dry-run ke-close EXTERNAL_SOLD.
        try {
          if (getSettings().mode === "live" && (this.lastBalCheckAt[key] ?? 0) + 30_000 <= now) {
            this.lastBalCheckAt[key] = now;
            const bal = await v3.getBalance(walletMgr.getActiveWallet()?.address as `0x${string}`, pos.tokenAddress as `0x${string}`);
            if (bal === 0n) {
              console.log(`[auto] reconcile: ${pos.symbol} balance 0 (langsung menutup) — close`);
              const closed = positions.closePosition(pos.tokenAddress, "EXTERNAL_SOLD", hasPrice ? px : pos.entryPrice);
              if (closed) {
                risk.recordClosed(closed.pnlUsd || 0);
                await this.notify(
                  "💀 *CLOSE (EXTERNAL)* — token udah gak ada di wallet\n\n" +
                  `Token: ${pos.symbol} — ${pos.name}\n` +
                  `Alasan: dijual manual di luar bot (balance 0)\n` +
                  `Entry: $${pos.entryPrice} → ${hasPrice ? `Now: $${px}` : "harga ga ke-fetch (GMGN mati)"}\n` +
                  `PnL: ${(closed.pnlPct ?? 0) >= 0 ? "+" : ""}${(closed.pnlPct ?? 0).toFixed(1)}% (${(closed.pnlUsd ?? 0) >= 0 ? "+" : ""}${fmtEthAmt(closed.pnlUsd ?? 0)} ETH)`,
                  { reply_markup: { inline_keyboard: [[{ text: "🗂️ Menu", callback_data: "back:main" }]] } }
                );
              }
              continue;
            }
          }
        } catch { /* read balance gagal — lanjut normal */ }

        // ----- TP/SL/trailing — butuh harga segar; kalau GMGN down, skip (data lama) -----
        if (!hasPrice) continue;
        const pct = ((px - pos.entryPrice) / pos.entryPrice) * 100;
        if (pct <= cfg.stopLossPct) {
          // SL jual SEMUA sisa (termasuk sisa partial TP yang belum kejual + moonbag)
          await this.closeWith(pos, "STOP_LOSS", px);
          risk.setCooldown(pos.tokenAddress, 30);
          continue;
        }
        // TP LADDER: cek level berikutnya dulu (SATU-SATUNYA mekanisme TP)
        const pending = positions.pendingTpLevels(pos.tokenAddress);
        if (pending.length && pct >= pending[0]!.pct) {
          await this.triggerTpLevel(pos, pending[0]!, px);
          continue;
        }
        // Semua level udah kena — kalau moonbag off & sisa habis → tutup posisi.
        // Kalau moonbag on atau sisa masih ada → dibiarkan jalan (moonbag / nunggu SL/trailing).
        const hasPlan = Array.isArray(pos.tpPlan) && pos.tpPlan.length > 0;
        const planDone = hasPlan && !positions.pendingTpLevels(pos.tokenAddress).length;
        if (hasPlan && planDone && !pos.moonbag && (pos.remainingFrac ?? 1) <= 0.0001) {
          // semua level kejual & gak ada moonbag → posisi beres, tutup
          const closed = positions.closePosition(pos.tokenAddress, "TAKE_PROFIT", px);
          if (closed) {
            risk.recordClosed(closed.pnlUsd || 0);
            await this.notify(
              "💸 *CLOSE — TP LADDER SELESAI*\n\n" +
              `Token: ${pos.symbol} — ${pos.name}\n` +
              `Entry: $${pos.entryPrice} → Exit akhir: $${px}\n` +
              `PnL total: ${(closed.pnlPct ?? 0) >= 0 ? "+" : ""}${(closed.pnlPct ?? 0).toFixed(1)}% (${(closed.pnlUsd ?? 0) >= 0 ? "+" : ""}${fmtEthAmt(closed.pnlUsd ?? 0)} ETH)`,
              { reply_markup: { inline_keyboard: [[{ text: "🗂️ Menu", callback_data: "back:main" }]] } }
            ).catch((e) => console.log("[auto] tp-final notif fail:", e?.message || e));
          }
        } else if (pct >= cfg.trailingStopPct) {
          // simplified trailing: sell when pullback from trailing peak exceeds trailing%
          const peak = pos.entryPrice * (1 + cfg.trailingStopPct / 100);
          if (px <= peak * (1 - cfg.trailingStopPct / 100)) {
            await this.closeWith(pos, "TRAILING_STOP", px);
          }
        }
      } catch {
        // tokenInfo can fail; skip cycle
      }
    }
  }

  /** Satu level TP ladder kena: jual fraksi posisi (%, dari posisi awal), catat realized PnL, notif. */
  private async triggerTpLevel(pos: Position, level: positions.TpPlanLevel, price: number): Promise<void> {
    // frac = % dari posisi AWAL → konversi ke fraksi dari balance SEKARANG (sisa).
    const remNow = Math.max(positions.remainingFraction(pos.tokenAddress), 1e-9);
    const fr = Math.min(1, Math.max(0.0001, level.frac / 100 / remNow));
    const result = await this.ensureExecutor().sellFraction(
      { address: pos.tokenAddress, symbol: pos.symbol, name: pos.name, price },
      "TAKE_PROFIT",
      price,
      fr
    );
    if (!result.ok) {
      await this.notify(
        "⚠️ *TP LADDER GAGAL SELL* (LIVE)\n\n" +
        `Token: ${escMd(pos.symbol)} — ${escMd(pos.name)}\n` +
        `Level: +${level.pct}% · jual ${level.frac}% posisi\n` +
        `Error: \`${escMd(truncErr(result.error))}\``,
        tokenKeyboard({ address: pos.tokenAddress, symbol: pos.symbol } as any)
      ).catch((e) => console.log("[auto] tp-fail notif:", e?.message || e));
      return;
    }
    const upd = positions.onTpTriggered(pos.tokenAddress, level.pct, price);
    if (!upd.ok || !upd.level) {
      console.log(`[auto] onTpTriggered ${pos.symbol}: ${upd.error}`);
      return;
    }
    const remFrac = upd.remainingFrac ?? positions.remainingFraction(pos.tokenAddress);
    const realized = upd.realizedUsd ?? 0;
    const gain = upd.pctGain ?? 0;
    const remPct = Math.round(remFrac * 100);
    console.log(`[auto] TP +${level.pct}% hit ${pos.symbol} — jual ${level.frac}% posisi, realized ${fmtEthAmt(realized)} ETH, sisa ${remPct}%`);
    await this.notify(
      "🎯 *TP HIT*" + (result.simulated ? " (dry-run)" : " (LIVE)") + "\n\n" +
      `Token: ${escMd(pos.symbol)} — ${escMd(pos.name)}\n` +
      `Level: +${level.pct}% → jual *${level.frac}%* posisi\n` +
      `Exit: $${price} (${gain >= 0 ? "+" : ""}${gain.toFixed(1)}%)\n` +
            `Realized: ${realized >= 0 ? "+" : ""}${fmtEthAmt(realized)} ETH\n` +
            `Sisa posisi: *${remPct}%*${remPct > 0 ? (pos.moonbag ? " (moonbag 🧘)" : " — level berikutnya siap") : ""}\n` +
      (result.txHash ? "TX: `" + result.txHash + "`" : ""),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "📈 GMGN " + pos.symbol, url: `https://gmgn.ai/robinhood/token/${pos.tokenAddress}` }],
            [{ text: "📑 Position", callback_data: "menu:positions" }],
            [{ text: "🗂️ Menu", callback_data: "back:main" }],
          ],
        },
      }
    ).catch((e) => console.log("[auto] tp-hit notif fail:", e?.message || e));
  }

  private async closeWith(pos: Position, reason: string, price: number): Promise<void> {
    const result = await this.ensureExecutor().sell(
      { address: pos.tokenAddress, symbol: pos.symbol, name: pos.name, price },
      reason,
      price
    );
    if (!result.ok || !result.closed) return;
    const pct = result.pct ?? 0;
    const usd = result.usd ?? 0;
    await this.notify(
      "💸 *CLOSE*" + (result.simulated ? " (dry-run)" : " (LIVE)") + "\n\n" +
      `Token: ${pos.symbol} — ${pos.name}\n` +
      `Reason: ${reason}\n` +
      `Entry: $${pos.entryPrice} → Exit: $${price}\n` +
      `PnL: ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% (${usd >= 0 ? "+" : ""}${fmtEthAmt(usd)} ETH)` +
      (result.txHash ? "\nTX: `" + result.txHash + "`" : ""),
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "📈 GMGN " + pos.symbol, url: `https://gmgn.ai/robinhood/token/${pos.tokenAddress}` },
            ],
            [
              { text: "📑 Position", callback_data: "menu:positions" },
            ],
            [
              { text: "🗂️ Menu", callback_data: "back:main" },
            ],
          ],
        },
      }
    );
  }

  /**
   * Wallet watch — alert when a watched wallet buys a new token.
   * Label is deliberately plain (short address), NOT "smart money"/"whale",
   * so the update never creates FOMO. Just "wallet <addr> beli <TOKEN>".
   */
  private async watchWallets(): Promise<void> {
    const wallets = listWatchedWallets();
    if (!wallets.length) return;
    const cutoff = Date.now() - 30 * 60 * 1000; // last 30 min of activity
    for (const w of wallets) {
      try {
        const data = await gmgn.walletActivity(w.address, 10);
        const list = Array.isArray(data) ? data : data?.list || data?.data || [];
        for (const act of list) {
          const side = String(act.type || act.side || act.direction || "").toLowerCase();
          const isBuy = side.includes("buy") || act.is_buy === true;
          if (!isBuy) continue;
          const tx = act.tx_hash || act.transaction_hash || act.hash;
          if (!tx || this.watchSeen.has(tx)) continue;
          const ts = act.timestamp || act.bought_at || 0;
          if (ts && Number(ts) * 1000 < cutoff) continue;
          this.watchSeen.add(tx);
          const sym = act.token_symbol || act.symbol || act.token?.symbol || "?";
          const usd = Number(act.amount_usd || act.usd_value || act.amount || 0);
          const addr = act.token_address || act.address || "?";
          await this.notify(
            "🔍 *Update Wallet*\n" +
            "Wallet: `" + w.label + "`\n" +
            "Beli: " + sym + " (" + addr.slice(0, 8) + "…)\n" +
            "Jumlah: $" + (Number.isFinite(usd) ? usd.toFixed(2) : "?") + "\n" +
            "Jam: " + new Date(ts ? ts * 1000 : Date.now()).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }) + "\n\n" +
            "_Lihat sendiri, mau ikut atau engga._"
          );
        }
      } catch {
        // wallet activity can fail (rate-limit); skip cycle
      }
    }
  }
}