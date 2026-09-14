/**
 * Uniswap Trading API swap path — Robinhood Chain (4663).
 * Proxy approval flow (x-permit2-disabled) — tanpa EIP-712.
 * Broadcast lewat config.rpcUrl (Alchemy) — sign lokal => eth_sendRawTransaction.
 */
import { config } from "../config/index.js";
import { getActiveWallet } from "../wallet/index.js";
import { createPublicClient, createWalletClient, http, maxUint256, type Address, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const UNISWAP_PROXY = "0x02E5be68D46DAc0B524905bfF209cf47EE6dB2a9" as Address;
export const NATIVE = "0x0000000000000000000000000000000000000000" as Address;
const CHAIN_ID = 4663;

const erc20Approve = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;
const erc20Allowance = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const rhChain: Chain = {
  id: CHAIN_ID,
  name: "robinhood",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
};

let _pub: ReturnType<typeof createPublicClient> | null = null;
function pub() {
  if (!_pub) _pub = createPublicClient({ transport: http(config.rpcUrl) });
  return _pub;
}

/** RPC cadangan buat baca receipt — Alchemy robinhood kadang telat index receipt. */
const RECEIPT_RPCS = [
  "", // placeholder: config.rpcUrl (Alchemy)
  "https://robinhood-rpc.publicnode.com",
  "https://rpc.mainnet.chain.robinhood.com",
];
let _receiptPubs: (ReturnType<typeof createPublicClient> | null)[] = [];

async function receiptClient(i: number) {
  const url = RECEIPT_RPCS[i] || config.rpcUrl;
  if (_receiptPubs[i] === undefined) _receiptPubs[i] = createPublicClient({ transport: http(url) });
  return _receiptPubs[i]!;
}

/** Tunggu tx mined — viem kadang timeout padahal udah mined; fallback polling multi-RPC. */
async function waitMined(hash: `0x${string}`): Promise<any> {
  try {
    const rc = await pub().waitForTransactionReceipt({ hash, timeout: 45_000, confirmations: 1 });
    if (rc.status !== "success") throw new Error(`tx ${hash} status=${rc.status}`);
    return rc;
  } catch (e: any) {
    // "could not be found" = masih pending / index telat — poll manual via beberapa RPC
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      for (let rpc = 0; rpc < RECEIPT_RPCS.length; rpc++) {
        try {
          const client = await receiptClient(rpc);
          const rc: any = await client.getTransactionReceipt({ hash });
          if (rc) {
            if (rc.status !== "success") throw new Error(`tx ${hash} status=${rc.status}`);
            return rc;
          }
        } catch { /* next rpc */ }
      }
    }
    throw e;
  }
}

function wallet() {
  const w = getActiveWallet();
  if (!w) throw new Error("Wallet kosong — buat wallet dulu");
  const acct = privateKeyToAccount(w.privateKey as `0x${string}`);
  return { account: acct, client: createWalletClient({ account: acct, chain: rhChain, transport: http(config.rpcUrl) }) };
}

function apiKey(): string {
  if (!config.uniswap.apiKey) throw new Error("UNISWAP_API_KEY kosong");
  return config.uniswap.apiKey;
}

async function api(path: string, body: unknown) {
  let lastErr: any = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(config.uniswap.baseUrl + path, {
        method: "POST",
        headers: { "x-api-key": apiKey(), "x-permit2-disabled": "true", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e: any) {
      lastErr = e;
      if (attempt === 1) { await new Promise((r) => setTimeout(r, 2500)); continue; }
      break;
    }
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* noop */ }
    if (!res.ok) {
      const msg = `${path} ${res.status}: ${text.slice(0, 400)}`;
      // HTTP 404 could be NoRouteFoundError (final) ATAU UpstreamTimeoutError (transient — retry sekali)
      const errCode = String(json?.errorCode || "");
      if (
        attempt === 1 &&
        res.status >= 500 ||
        res.status === 429 ||
        /UpstreamTimeout|ServiceUnavailable|TIMEOUT|too many request/i.test(errCode + " " + text)
      ) {
        await new Promise((r) => setTimeout(r, 2500));
        continue;
      }
      const e: any = new Error(msg);
      e.status = res.status;
      e.json = json;
      throw e;
    }
    return json;
  }
  const e: any = lastErr instanceof Error ? lastErr : new Error(String(lastErr || "api failed"));
  throw e;
}

function quoteBody(tokenIn: Address, tokenOut: Address, amount: string, slippageBps: number) {
  return {
    tokenInChainId: CHAIN_ID, tokenOutChainId: CHAIN_ID, amount,
    tokenIn, tokenOut, swapper: wallet().account.address, type: "EXACT_INPUT",
    slippageTolerance: slippageBps,
    // TANPA protocols — biar auto-route V2/V3/V4. Paksa ["V3"] bikin token yang cuma punya
    // pool V2/V4 (atau quote token non-WETH) gagal "No route with sufficient liquidity".
  };
}

async function ensureAllowance(token: Address, need: bigint) {
  const owner = wallet().account.address;
  const allowance = await pub().readContract({ address: token, abi: erc20Allowance, functionName: "allowance", args: [owner, UNISWAP_PROXY] });
  if (BigInt(allowance as bigint) >= need) return;
  const { client } = wallet();
  const tx = await client.writeContract({ address: token, abi: erc20Approve, functionName: "approve", args: [UNISWAP_PROXY, maxUint256] });
  await waitMined(tx);
}

async function broadcastSwap(swap: any): Promise<{ tx: `0x${string}` }> {
  if (!swap?.to || !swap?.data) throw new Error("swap response tidak valid: " + JSON.stringify(swap).slice(0, 200));
  const { client } = wallet();
  const value = BigInt(swap.value || "0x0");
  const tx = await client.sendTransaction({ to: swap.to as Address, data: swap.data as `0x${string}`, value });
  await waitMined(tx);
  return { tx };
}

export interface UniSwapResult {
  ok: boolean;
  hash?: string;
  amountOut?: bigint;
  error?: string;
}

/** Buy token dengan native ETH: quote → swap (value = amountIn) → broadcast. */
export async function buyWithNative(token: Address, amountInWei: bigint, slippageBps = 20): Promise<UniSwapResult> {
  try {
    const q = await api("/quote", quoteBody(NATIVE, token, amountInWei.toString(), slippageBps));
    const out = BigInt(q.quote.output.amount);
    const s = await api("/swap", { quote: q.quote, tokenInChainId: CHAIN_ID, tokenOutChainId: CHAIN_ID, swapper: wallet().account.address, deadline: 300 });
    const { tx } = await broadcastSwap(s.swap);
    return { ok: true, hash: tx, amountOut: out };
  } catch (e: any) {
    return { ok: false, error: (e?.message || String(e)).slice(0, 300) };
  }
}

/**
 * Buy 2-leg via quote token: ETH → quote → token.
 * Dipakai kalau token cuma punya pool quote NON-ETH (mis. IBM/USDG/GME) — ETH→token
 * direct 404 NoRouteFoundError. Resolver quote = DexScreener (bukan GMGN).
 */
export async function buyViaQuote(token: Address, amountInWei: bigint, slippageBps = 20): Promise<UniSwapResult> {
  try {
    const { resolveQuoteToken } = await import("./uniswap-v4.js");
    const quoteAddr = await resolveQuoteToken(token);
    if (!quoteAddr || quoteAddr.toLowerCase() === NATIVE.toLowerCase())
      return { ok: false, error: `Tidak ada quote mid untuk ${token}` };
    // PRE-QUOTE kedua leg DULUAN — kalau leg2 (quote->token) ga ada route,
    // batal sebelum broadcast leg1. Mencegah dana nyangkut di quote (stock).
    const q1 = await api("/quote", quoteBody(NATIVE, quoteAddr as Address, amountInWei.toString(), slippageBps));
    const leg1Out = BigInt(q1.quote.output.amount);
    const q2 = await api("/quote", quoteBody(quoteAddr as Address, token, q1.quote.output.amount.toString(), slippageBps));
    const out2 = BigInt(q2.quote.output.amount);
    // Kedua quote OK → baru broadcast
    const s1 = await api("/swap", { quote: q1.quote, tokenInChainId: CHAIN_ID, tokenOutChainId: CHAIN_ID, swapper: wallet().account.address, deadline: 300 });
    const { tx: tx1 } = await broadcastSwap(s1.swap);
    await ensureAllowance(quoteAddr as Address, leg1Out);
    const s2 = await api("/swap", { quote: q2.quote, tokenInChainId: CHAIN_ID, tokenOutChainId: CHAIN_ID, swapper: wallet().account.address, deadline: 300 });
    const { tx: tx2 } = await broadcastSwap(s2.swap);
    return { ok: true, hash: tx2, amountOut: out2, error: `leg1:${tx1} leg2:${tx2}` } as any;
  } catch (e: any) {
    return { ok: false, error: (e?.message || String(e)).slice(0, 300) };
  }
}

/** Sell token → native ETH: approve proxy (kalau perlu) → quote → broadcast. */
export async function sellToken(token: Address, amountIn: bigint, slippageBps = 20): Promise<UniSwapResult> {
  try {
    await ensureAllowance(token, amountIn);
    const q = await api("/quote", quoteBody(token, NATIVE, amountIn.toString(), slippageBps));
    const out = BigInt(q.quote?.output?.amount ?? "0");
    const s = await api("/swap", { quote: q.quote, tokenInChainId: CHAIN_ID, tokenOutChainId: CHAIN_ID, swapper: wallet().account.address, deadline: 300 });
    const { tx } = await broadcastSwap(s.swap);
    return { ok: true, hash: tx, amountOut: out };
  } catch (e: any) {
    return { ok: false, error: (e?.message || String(e)).slice(0, 300) };
  }
}

/**
 * Sell token ke target apa pun (ETH native / USDG / quote lain).
 * Strategi: coba direct token→target; kalo gagal (NoRoute), coba via quote token
 * (token→quote→target). Ini generic sell-all: user pilih mau dapet ETH atau USDG.
 */
export async function sellToTarget(
  token: Address,
  target: Address,
  amountIn: bigint,
  slippageBps = 20
): Promise<UniSwapResult> {
  try {
    // 0) DIRECT 1-tx via Uniswap API auto-route (token -> target). API pinter
    //    ngerute multi-hop sendiri — lebih aman daripada 2 tx manual.
    try {
      await ensureAllowance(token, amountIn);
      const qd = await api("/quote", quoteBody(token, target, amountIn.toString(), slippageBps));
      const outD = BigInt(qd.quote.output.amount);
      const sd = await api("/swap", { quote: qd.quote, tokenInChainId: CHAIN_ID, tokenOutChainId: CHAIN_ID, swapper: wallet().account.address, deadline: 300 });
      const { tx: txD } = await broadcastSwap(sd.swap);
      return { ok: true, hash: txD, amountOut: outD };
    } catch (de: any) {
      // direct NoRoute → lanjut 2-leg manual (pre-quote dulu) — kalau bukan NoRoute, return error.
      const msg = String(de?.message || de);
      if (!/NoRoute|404|no route|insufficient liquidity/i.test(msg)) {
        return { ok: false, error: `direct: ${msg.slice(0, 250)}` };
      }
    }

    // 2-leg manual via quote token — TAPI pre-quote keduanya dulu (batal kalau leg2 ga ada route)
    const { resolveQuoteToken } = await import("./uniswap-v4.js");
    const qaddr = await resolveQuoteToken(token);
    const mid: Address | null =
      qaddr && qaddr.toLowerCase() !== target.toLowerCase()
        ? (qaddr as Address)
        : target.toLowerCase() !== NATIVE.toLowerCase()
        ? NATIVE
        : null;
    if (!mid || mid.toLowerCase() === target.toLowerCase()) {
      return { ok: false, error: `No route: token→${target.slice(0, 8)} (direct gagal, mid kosong)` };
    }
    const q1 = await api("/quote", quoteBody(token, mid, amountIn.toString(), slippageBps));
    const leg1Out = BigInt(q1.quote.output.amount);
    const q2 = await api("/quote", quoteBody(mid, target, leg1Out.toString(), slippageBps));
    const out2 = BigInt(q2.quote.output.amount);
    // kedua quote OK → broadcast
    await ensureAllowance(token, amountIn);
    const s1 = await api("/swap", { quote: q1.quote, tokenInChainId: CHAIN_ID, tokenOutChainId: CHAIN_ID, swapper: wallet().account.address, deadline: 300 });
    const { tx: tx1 } = await broadcastSwap(s1.swap);
    await ensureAllowance(mid, leg1Out);
    const s2 = await api("/swap", { quote: q2.quote, tokenInChainId: CHAIN_ID, tokenOutChainId: CHAIN_ID, swapper: wallet().account.address, deadline: 300 });
    const { tx: tx2 } = await broadcastSwap(s2.swap);
    return { ok: true, hash: tx2, amountOut: out2, error: `leg1:${tx1} leg2:${tx2}` } as any;
  } catch (e: any) {
    return { ok: false, error: (e?.message || String(e)).slice(0, 300) };
  }
}
export async function sellViaQuote(token: Address, amountIn: bigint, slippageBps = 20): Promise<UniSwapResult> {
  try {
    const { resolveQuoteToken } = await import("./uniswap-v4.js");
    const quoteAddr = await resolveQuoteToken(token);
    if (!quoteAddr || quoteAddr.toLowerCase() === NATIVE.toLowerCase())
      return { ok: false, error: `Tidak ada quote mid untuk ${token}` };
    // PRE-QUOTE kedua leg DULUAN — kalau leg2 (quote->ETH) ga ada route,
    // batal sebelum broadcast leg1. Mencegah dana nyangkut di quote (stock).
    const q1 = await api("/quote", quoteBody(token, quoteAddr as Address, amountIn.toString(), slippageBps));
    const leg1Out = BigInt(q1.quote.output.amount);
    const q2 = await api("/quote", quoteBody(quoteAddr as Address, NATIVE, leg1Out.toString(), slippageBps));
    const out2 = BigInt(q2.quote.output.amount);
    // Kedua quote OK → baru broadcast
    await ensureAllowance(token, amountIn);
    const s1 = await api("/swap", { quote: q1.quote, tokenInChainId: CHAIN_ID, tokenOutChainId: CHAIN_ID, swapper: wallet().account.address, deadline: 300 });
    const { tx: tx1 } = await broadcastSwap(s1.swap);
    await ensureAllowance(quoteAddr as Address, leg1Out);
    const s2 = await api("/swap", { quote: q2.quote, tokenInChainId: CHAIN_ID, tokenOutChainId: CHAIN_ID, swapper: wallet().account.address, deadline: 300 });
    const { tx: tx2 } = await broadcastSwap(s2.swap);
    return { ok: true, hash: tx2, amountOut: out2, error: `leg1:${tx1} leg2:${tx2}` } as any;
  } catch (e: any) {
    return { ok: false, error: (e?.message || String(e)).slice(0, 300) };
  }
}