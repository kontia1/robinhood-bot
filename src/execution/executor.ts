/**
 * Trade executor — unified interface for dry-run (simulated) and live (real swap).
 * Strategy calls executor.buy / executor.sell; it never knows which mode runs.
 */
import * as gmgn from "../chain/gmgn.js";
import * as v3 from "../chain/uniswap-v3.js";
import * as v4 from "../chain/uniswap-v4.js";
import * as uniApi from "../chain/uniswap-api.js";
import * as positions from "../positions/index.js";
import { getSettings } from "../settings/index.js";
import * as risk from "../risk/risk-manager.js";
import { config } from "../config/index.js";

export interface BuyResult {
  ok: boolean;
  simulated: boolean;
  positionId?: string;
  txHash?: string;
  address?: string;
  symbol?: string;
  error?: string;
}

export interface SellResult {
  ok: boolean;
  simulated: boolean;
  reason: string;
  pct?: number;
  usd?: number;
  txHash?: string;
  closed?: boolean;
  error?: string;
}

export interface TokenRef {
  address: string;
  symbol: string;
  name: string;
  price: number;
}

export interface TradeExecutor {
  buy(token: TokenRef, sizeUsd: number): Promise<BuyResult>;
  sell(token: TokenRef, reason: string, exitPrice: number): Promise<SellResult>;
  /**
   * Jual SEBAGIAN posisi (fraksi 0..1 dari sisa balance). TIDAK menutup posisi
   * secara bookkeeping — caller (auto engine) yang panggil positions.onTpTriggered
   * buat mencatat level TP. Dipakai partial take-profit ladder.
   */
  sellFraction(token: TokenRef, reason: string, exitPrice: number, fraction: number): Promise<SellResult>;
}

export class DryRunExecutor implements TradeExecutor {
  async buy(token: TokenRef, sizeUsd: number): Promise<BuyResult> {
    const pos = positions.openPosition({
      tokenAddress: token.address,
      symbol: token.symbol,
      name: token.name,
      entryPrice: token.price,
      sizeUsd,
    });
    return { ok: true, simulated: true, positionId: pos.id, address: token.address, symbol: token.symbol };
  }

  async sell(token: TokenRef, reason: string, exitPrice: number): Promise<SellResult> {
    const closed = positions.closePosition(token.address, reason, exitPrice);
    if (!closed) return { ok: false, simulated: true, reason, error: "position not found" };
    risk.recordClosed(closed.pnlUsd || 0);
    return {
      ok: true, simulated: true, reason, closed: true,
      pct: closed.pnlPct, usd: closed.pnlUsd,
    };
  }

  /** Dry-run partial sell — bookkeeping dilakukan oleh caller via onTpTriggered. */
  async sellFraction(token: TokenRef, reason: string, exitPrice: number, fraction: number): Promise<SellResult> {
    const rem = positions.remainingFraction(token.address);
    if (rem <= 0.0001) return { ok: false, simulated: true, reason, error: "no remaining position" };
    return { ok: true, simulated: true, reason, closed: false };
  }
}

export class LiveExecutor implements TradeExecutor {
  constructor(private walletAddress: string) {}

  async buy(token: TokenRef, sizeEth: number): Promise<BuyResult> {
    const slippage = getSettings().slippagePct ?? 20;
    // Path utama: swap on-chain via Uniswap V3 (tanpa GMGN CLI / rate limit).
    try {
      const amountInWei = BigInt(Math.round(sizeEth * 1e18));
      if (amountInWei <= 0n) {
        return { ok: false, simulated: false, address: token.address, symbol: token.symbol, error: `Position size ETH invalid (${sizeEth})` };
      }
      const ethBal = await v3.getBalance(this.walletAddress as `0x${string}`);
      if (amountInWei > ethBal) {
        return { ok: false, simulated: false, address: token.address, symbol: token.symbol, error: `Saldo ETH kurang (butuh ${(Number(amountInWei) / 1e18).toFixed(4)}, punya ${(Number(ethBal) / 1e18).toFixed(4)})` };
      }
      // 0) Token bonding-only (GMGN exchange "bags"/"PonS" — BELUM pindah ke Uniswap):
      //    skip semua jalur Uniswap (API/V3/V4) → langsung GMGN. Jangan buang 3 call
      //    yang pasti gagal + notif error panjang.
      const pool = await gmgn.tokenPool(token.address).catch(() => null);
      const exch = String(pool?.exchange ?? pool?.pool?.exchange ?? "").toLowerCase();
      if (exch && !/uniswap/.test(exch)) {
        const fb = await this.gmgnBuy(token, sizeEth);
        if (fb.ok) {
          positions.openPosition({ tokenAddress: token.address, symbol: token.symbol, name: token.name, entryPrice: token.price, sizeUsd: sizeEth });
          return fb;
        }
        return { ok: false, simulated: false, address: token.address, symbol: token.symbol, error: `Token exchange "${exch}" non-Uniswap — GMGN: ${fb.error}` };
      }
      // 1) Uniswap Trading API (proxy approval, robinhood 4663 supported)
            const u = await uniApi.buyWithNative(token.address as `0x${string}`, amountInWei, Math.round(slippage * 100));
            if (u.ok) {
              positions.openPosition({ tokenAddress: token.address, symbol: token.symbol, name: token.name, entryPrice: token.price, sizeUsd: sizeEth });
              return { ok: true, simulated: false, txHash: u.hash, address: token.address, symbol: token.symbol };
            }
            // 1b) Uniswap API 2-leg: ETH -> quote -> token (token quote NON-ETH, mis. IBM/USDG/GME)
            if (/NoRoute|404|UpstreamTimeout/i.test(String(u.error))) {
              const u2 = await uniApi.buyViaQuote(token.address as `0x${string}`, amountInWei, Math.round(slippage * 100));
              if (u2.ok) {
                positions.openPosition({ tokenAddress: token.address, symbol: token.symbol, name: token.name, entryPrice: token.price, sizeUsd: sizeEth });
                return { ok: true, simulated: false, txHash: u2.hash, address: token.address, symbol: token.symbol };
              }
              u.error = `${u.error} | buyViaQuote: ${u2.error}`;
            }
            // 2) Fallback: Uniswap V3 on-chain langsung
            const r = await v3.buyWithNative(token.address as `0x${string}`, amountInWei, Math.round(slippage * 100));
            if (r.ok) {
              positions.openPosition({ tokenAddress: token.address, symbol: token.symbol, name: token.name, entryPrice: token.price, sizeUsd: sizeEth });
              return { ok: true, simulated: false, txHash: r.hash, address: token.address, symbol: token.symbol };
            }
            // 2b) Fallback: Uniswap V4 on-chain (token hasil bonding / fee-0 hook pool — Uniswap API & V3 ga bisa route)
            const v4b = await v4.buyWithNative(token.address as `0x${string}`, amountInWei, Math.round(slippage * 100));
            if (v4b.ok) {
              positions.openPosition({ tokenAddress: token.address, symbol: token.symbol, name: token.name, entryPrice: token.price, sizeUsd: sizeEth });
              return { ok: true, simulated: false, txHash: v4b.hash, address: token.address, symbol: token.symbol };
            }
            // 3) Fallback GMGN (like before).
            const fallback = await this.gmgnBuy(token, sizeEth);
            if (fallback.ok) {
              positions.openPosition({ tokenAddress: token.address, symbol: token.symbol, name: token.name, entryPrice: token.price, sizeUsd: sizeEth });
              return fallback;
            }
            return { ok: false, simulated: false, address: token.address, symbol: token.symbol, error: `UniswapAPI: ${u.error} | V3: ${r.error} | V4: ${v4b.error} | GMGN: ${fallback.error}` };
    } catch (e: any) {
      return { ok: false, simulated: false, address: token.address, symbol: token.symbol, error: e?.shortMessage || e?.message || String(e) };
    }
  }

  private async gmgnBuy(token: TokenRef, sizeEth: number): Promise<BuyResult> {
      // GMGN free tier sering 429 (rate limit ~30s). Coba sekali; kalau 429, tunggu reset lalu retry 1x.
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const quote = await gmgn.quoteTokenOf(token.address);
          const swap = await gmgn.executeSwap({
            chain: config.chain,
            from: this.walletAddress,
            inputToken: quote.address,
            outputToken: token.address,
            percent: 10, // conservative default; risk layer enforces USD caps
            slippage: getSettings().slippagePct ?? 20,
          });
          return {
            ok: true, simulated: false,
            txHash: swap?.tx_hash || swap?.hash || swap?.txHash,
            address: token.address, symbol: token.symbol,
          };
        } catch (e: any) {
          const msg = (e?.shortMessage || e?.message || String(e)).slice(0, 600);
          if (attempt === 1 && /429|RATE_LIMIT|rate limit/i.test(msg)) {
            console.log(`[auto] gmgn buy ${token.symbol} kena 429 — tunggu 30s, retry…`);
            await new Promise((r) => setTimeout(r, 30_000));
            continue;
          }
          if (attempt === 2) return { ok: false, simulated: false, address: token.address, symbol: token.symbol, error: msg };
        }
      }
      return { ok: false, simulated: false, address: token.address, symbol: token.symbol, error: "gmgn buy gagal" };
    }

    /** Jual token via GMGN (untuk token exchange non-Uniswap). */
    private async gmgnSell(token: TokenRef, bal: bigint, exitPrice: number): Promise<{ ok: boolean; hash?: string; error?: string }> {
      try {
        const quote = await gmgn.quoteTokenOf(token.address);
        const amountStr = bal.toString();
        const swap = await gmgn.executeSwap({
          chain: config.chain,
          from: this.walletAddress,
          inputToken: token.address,
          outputToken: quote.address,
          amount: amountStr,
          slippage: getSettings().slippagePct ?? 20,
        });
        return { ok: true, hash: swap?.tx_hash || swap?.hash || swap?.txHash };
      } catch (e: any) {
        const msg = (e?.shortMessage || e?.message || String(e)).slice(0, 600);
        // 429 → tunggu 30s + retry sekali
        if (/429|RATE_LIMIT|rate limit/i.test(msg)) {
          await new Promise((r) => setTimeout(r, 30_000));
          try {
            const quote = await gmgn.quoteTokenOf(token.address);
            const swap = await gmgn.executeSwap({
              chain: config.chain,
              from: this.walletAddress,
              inputToken: token.address,
              outputToken: quote.address,
              amount: bal.toString(),
              slippage: getSettings().slippagePct ?? 20,
            });
            return { ok: true, hash: swap?.tx_hash || swap?.hash || swap?.txHash };
          } catch (e2: any) {
            return { ok: false, error: (e2?.shortMessage || e2?.message || String(e2)).slice(0, 400) };
          }
        }
        return { ok: false, error: msg };
      }
    }

  async sell(token: TokenRef, reason: string, exitPrice: number): Promise<SellResult> {
        try {
          const bal = await v3.getBalance(this.walletAddress as `0x${string}`, token.address as `0x${string}`);
          if (bal === 0n) {
            return { ok: false, simulated: false, reason, error: "balance token 0 (mungkin sudah terjual)" };
          }
          const res = await this.swapOut(token, bal, exitPrice, reason);
          if (res.ok) {
            const closed = positions.closePosition(token.address, reason, exitPrice);
            if (closed) risk.recordClosed(closed.pnlUsd || 0);
            return {
              ok: true, simulated: false, reason,
              txHash: res.hash, closed: !!closed, pct: closed?.pnlPct, usd: closed?.pnlUsd,
            };
          }
          return { ok: false, simulated: false, reason, error: res.error || "sell gagal" };
        } catch (e: any) {
          return { ok: false, simulated: false, reason, error: e?.shortMessage || e?.message || String(e) };
        }
      }

    /**
     * Jual SEBAGIAN balance token (fraction 0..1 dari sisa). Swap on-chain beneran,
     * tapi posisi TIDAK ditutup — caller catat via positions.onTpTriggered.
     */
    async sellFraction(token: TokenRef, reason: string, exitPrice: number, fraction: number): Promise<SellResult> {
        try {
          const fr = Math.min(1, Math.max(0.0001, fraction));
          const bal = await v3.getBalance(this.walletAddress as `0x${string}`, token.address as `0x${string}`);
          if (bal === 0n) {
            return { ok: false, simulated: false, reason, error: "balance token 0" };
          }
          const amountIn = (bal * BigInt(Math.round(fr * 1000))) / 1000n;
          if (amountIn === 0n) return { ok: false, simulated: false, reason, error: "fraksi terlalu kecil" };
          const res = await this.swapOut(token, amountIn, exitPrice, reason);
          if (!res.ok) return { ok: false, simulated: false, reason, error: res.error || "partial sell gagal" };
          return { ok: true, simulated: false, reason, closed: false, txHash: res.hash };
        } catch (e: any) {
          return { ok: false, simulated: false, reason, error: e?.shortMessage || e?.message || String(e) };
        }
      }

    /** Jalankan swap token -> quote/native via semua path (Uniswap API → V3 → V4 → GMGN). */
    private async swapOut(
      token: TokenRef,
      amountIn: bigint,
      exitPrice: number,
      reason: string
    ): Promise<{ ok: boolean; hash?: string; error?: string }> {
      const slippage = getSettings().slippagePct ?? 20;
      try {
        // 0) Token bonding-only (exchange non-uniswap) → jual via GMGN langsung,
        //    jangan buang 3 call Uniswap yang pasti gagal.
        const poolS = await gmgn.tokenPool(token.address).catch(() => null);
        const exchS = String(poolS?.exchange ?? poolS?.pool?.exchange ?? "").toLowerCase();
        if (exchS && !/uniswap/.test(exchS)) {
          const g = await this.gmgnSell(token, amountIn, exitPrice);
          return g.ok ? { ok: true, hash: g.hash } : { ok: false, error: g.error || `exchange "${exchS}" non-uniswap — GMGN sell gagal` };
        }
        // 1) Uniswap Trading API (proxy approval) — path utama
        const u = await uniApi.sellToken(token.address as `0x${string}`, amountIn, Math.round(slippage * 100));
        if (u.ok) return { ok: true, hash: u.hash };
        // 1b) Uniswap API 2-leg: token -> quote -> ETH (token quote NON-ETH)
        if (/NoRoute|404|UpstreamTimeout/i.test(String(u.error))) {
          const uq2 = await uniApi.sellViaQuote(token.address as `0x${string}`, amountIn, Math.round(slippage * 100));
          if (uq2.ok) return { ok: true, hash: uq2.hash };
          u.error = `${u.error} | sellViaQuote: ${uq2.error}`;
        }
        // 2) Fallback: Uniswap V3 on-chain langsung
        const r = await v3.sellToken(token.address as `0x${string}`, amountIn, Math.round(slippage * 100));
        if (r.ok) return { ok: true, hash: r.hash };
        // 2b) Fallback: Uniswap V4 on-chain — token hasil bonding (fee-0 hook pool)
        const v4b = await v4.sellToken(token.address as `0x${string}`, amountIn, Math.round(slippage * 100));
        if (v4b.ok) return { ok: true, hash: v4b.hash };
        return { ok: false, error: `UniswapAPI: ${u.error} | V3: ${r.error} | V4: ${v4b.error}` };
      } catch (e: any) {
        return { ok: false, error: e?.shortMessage || e?.message || String(e) };
      }
    }
}

export function createExecutor(walletAddress: string): TradeExecutor {
  const mode = getSettings().mode;
  return mode === "live" ? new LiveExecutor(walletAddress) : new DryRunExecutor();
}