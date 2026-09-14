/**
 * Uniswap V4 swap on Robinhood Chain (4663) — GMGN-free executor.
 *
 * Robinhood (verified 2026-09-09 dari tx nyata ur_buys.txt / ur_txs.txt + eth_call):
 *   - UniversalRouter : 0x8876789976DecBfCBBBE364623C63652dB8C0904
 *   - Permit2         : 0x000000000022D473030F116dDEE9F6B43aC78BA3
 *   - Commands        : BUY 0x10 (V4_SWAP) / SELL 0x0a10 (PERMIT2-PERMIT + V4_SWAP)
 *   - BUY   actions   : 0x07 SWAP_EXACT_IN (recipient, path[], minOut, amount) + SETTLE + TAKE
 *   - SELL  swap      : 0x07 SWAP_EXACT_IN dengan path (token, fee0, tick200, hook) → (USDG, fee460, tick9)
 *   - PoolKey bonding : (0x0 native, token, fee=0, tickSpacing=200, hooks=0xE5e7..Be044)
 *
 * Strategi: TEMPLATE SKELETON (ur_*.txt) + PATCH nilai berubah (token, amount,
 * recipient, deadline); SELL wajib EIP-712 Permit2 signature karena UR robinhood
 * selalu settle via Permit2 (error 0xd81b2f2e InvalidSignature kalau tanpa permit).
 */
import { createPublicClient, createWalletClient, http, getAddress as viemGetAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AbiCoder, Interface, getAddress } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { getActiveWallet } from "../wallet/index.js";

export const UNIVERSAL_ROUTER = getAddress("0x8876789976decbfcbbbe364623c63652db8c0904");
export const PERMIT2 = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");
export const NATIVE = "0x0000000000000000000000000000000000000000";
/** WETH robinhood (dipakai resolver quote — pool ber-quote WETH = single-hop ETH tidak perlu) */
export const WETH = getAddress("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
export const HOOK_BONDING = getAddress("0xe5e702641ea86f4ae6cc3cdaed2b886f976be044");
export const FEE = 0;
export const TICK_SPACING = 200;

const ac = new AbiCoder();
const execIf = new Interface(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]);
const ROOT = path.resolve(import.meta.dirname, "../..");

function buyTemplateHex(): string {
  const f = fs.readFileSync(path.join(ROOT, "ur_buys.txt"), "utf8").trim().split("\n");
  return f[1];
}
// SELL#0 (0x0a10: permit + swap)
function sellTemplateHex(): string {
  const f = fs.readFileSync(path.join(ROOT, "ur_txs.txt"), "utf8").trim().split("\n\n");
  return f[0].split("\n")[1];
}

function rpcUrl(): string {
  return (process.env.RPC_URL || `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`).replace(/\/$/, "");
}
function client() {
  return createPublicClient({ transport: http(rpcUrl()) });
}
function walletCfg() {
  const w = getActiveWallet();
  if (!w) throw new Error("Wallet kosong — buat wallet dulu");
  const acc = privateKeyToAccount((w.privateKey.startsWith("0x") ? w.privateKey : "0x" + w.privateKey) as `0x${string}`);
  return { account: acc, wc: createWalletClient({ account: acc, transport: http(rpcUrl()) }) };
}

interface ExecShape { commands: string; inputs: string[]; deadline: bigint; }
function decodeExec(hex: string): ExecShape {
  const d = execIf.decodeFunctionData("execute", hex);
  return { commands: d[0] as string, inputs: d[1] as string[], deadline: d[2] as bigint };
}

/** Build BUY (ETH -> token): path token single hop, value=amountWei */
export function buildBuyCalldata(token: string, amountWei: bigint, minOutTokens: bigint, recipient: string, deadline: bigint): string {
  return buildBuyCalldataViaQuote(token, null, amountWei, minOutTokens, recipient, deadline);
}

/**
 * Build BUY (ETH -> token) dengan 1-2 hop.
 * - quote=null → single hop ETH→token (pool key template).
 * - quote!=null → 2 hop ETH→quote→token (token punya pool quote NON-ETH, mis. IBM/USDG/GME).
 * Pool key robinhood konsisten untuk semua lane: fee=0, tickSpacing=200, hook=0xe5e7.. — dipakai dari template.
 */
export function buildBuyCalldataViaQuote(
  token: string,
  quote: string | null,
  amountWei: bigint,
  minOutTokens: bigint,
  recipient: string,
  deadline: bigint
): string {
  return buildBuyCalldataViaQuoteHooked(token, quote, amountWei, minOutTokens, recipient, deadline, null);
}

/**
 * Versi dengan pool key hop-quote override.
 * TEMUAN (2026-09-10): pool ETH→quote di robinhood V4 BUKAN fee=0/hook-bonding —
 * tapi pool standar dengan hook KOSONG (fee 0.01%/0.05%/0.1%/1%). Template
 * (fee=0,tick=200,hook=0xe5e7..) selalu ke-reject PoolNotInitialized buat hop pertama.
 * Hop pertama (ETH->quote) harus pakai key dari `quoteKey`; hop kedua (quote→token)
 * TETAP template bonding.
 */
export function buildBuyCalldataViaQuoteHooked(
  token: string,
  quote: string | null,
  amountWei: bigint,
  minOutTokens: bigint,
  recipient: string,
  deadline: bigint,
  quoteKey?: { fee: number; tick: number; hook: string } | null
): string {
  const t = decodeExec(buyTemplateHex());
  const [actions, params] = ac.decode(["bytes", "bytes[]"], t.inputs[0] as any);
  const p0 = ac.decode(["(address,(address,uint24,int24,address,bytes)[],uint128,uint128)"], params[0] as any)[0];
  // hop dari template: [token-or-self, fee, tick, hook, hookData]
  const baseHop = (Array.from(p0[1]) as any[])[0];
  const hopTpl = (cur: string) => [getAddress(cur), baseHop[1], baseHop[2], baseHop[3], baseHop[4]];
  const hopCustom = (cur: string) => [
    getAddress(cur),
    BigInt(quoteKey?.fee ?? Number(baseHop[1])),
    BigInt(quoteKey?.tick ?? Number(baseHop[2])),
    quoteKey?.hook ? getAddress(quoteKey.hook) : baseHop[3],
    baseHop[4],
  ];
  const newPath =
    quote && quote !== NATIVE
      ? [hopCustom(quote), hopTpl(token)]
      : quoteKey
        ? [hopCustom(token)] // single-hop dengan pool key custom (buat probe quote hop)
        : [hopTpl(token)];
  const newP0 = ac.encode(["(address,(address,uint24,int24,address,bytes)[],uint128,uint128)"], [[p0[0], newPath, minOutTokens, amountWei]]);
  const p2gucci = ac.decode(["address", "address", "uint256"], params[2] as any);
  const newP2 = ac.encode(["address", "address", "uint256"], [getToken(token), recipient, p2gucci[2]]);
  const newInput = ac.encode(["bytes", "bytes[]"], [actions, [newP0, params[1], newP2]]);
  return execIf.encodeFunctionData("execute", [t.commands, [newInput], deadline]);
}

/** Build SELL (token -> native ETH): SELL#1 template (060c0f poolKey single hop), commands 0x10 — robinhood sell TIDAK pakai permit2 (verified tx nyata IF & FEES). */
export function buildSellCalldata(
  token: string,
  amountIn: bigint,
  minOutEth: bigint,
  recipient: string,
  deadline: bigint,
  _permit: string | null = null
): string {
  const f = fs.readFileSync(path.join(ROOT, "ur_txs.txt"), "utf8").trim().split("\n\n");
  const s1hex = f[1].split("\n")[1];
  const s1 = decodeExec(s1hex);
  const [actions, params] = ac.decode(["bytes", "bytes[]"], s1.inputs[0] as any);
  const p0 = ac.decode(
    ["((address,address,uint24,int24,address),bool,int128,int128,uint160,bytes)"],
    params[0] as any
  )[0];
  const pk = [p0[0][0], getToken(token), p0[0][2], p0[0][3], p0[0][4]];
  const newP0 = ac.encode(
    ["((address,address,uint24,int24,address),bool,int128,int128,uint160,bytes)"],
    [[pk, false, amountIn, minOutEth, 0n, "0x"]]
  );
  // param1 = SETTLE (token, amount)
  let newP1: string;
  try {
    const p1 = ac.decode(["address", "uint256"], params[1] as any);
    newP1 = ac.encode(["address", "uint256"], [getToken(token), amountIn]);
  } catch {
    newP1 = params[1];
  }
  // param2 = TAKE (native, amount)
  let newP2: string;
  try {
    const p2 = ac.decode(["address", "uint256"], params[2] as any);
    newP2 = ac.encode(["address", "uint256"], [NATIVE, minOutEth]);
  } catch {
    try {
      const p2 = ac.decode(["address", "address", "uint256"], params[2] as any);
      newP2 = ac.encode(["address", "address", "uint256"], [p2[0], recipient, p2[2]]);
    } catch {
      newP2 = params[2];
    }
  }
  const newInput = ac.encode(["bytes", "bytes[]"], [actions, [newP0, newP1, newP2]]);
  return execIf.encodeFunctionData("execute", [s1.commands, [newInput], deadline]);
}

/** Encode input permit2 (details + spender + deadline + sig). */
export function encodePermitInput(
  token: string,
  amountMax: bigint,
  expiration: bigint,
  nonce: bigint,
  spender: string,
  sigDeadline: bigint,
  sig: string
): string {
  return ac.encode(
    ["(address,uint160,uint48,uint48,address,uint256,bytes)"],
    [[getToken(token), amountMax, expiration, nonce, getToken(spender), sigDeadline, sig]]
  );
}

/** Sign EIP-712 Permit2 PermitSingle — robinhood domain (chainId 4663). */
async function signPermit(client: { account: any }, details: { token: string; amount: bigint; expiration: bigint; nonce: bigint }, spender: string, sigDeadline: bigint): Promise<string> {
  const account = client.account;
  const domain = {
    name: "Permit2",
    chainId: 4663,
    verifyingContract: PERMIT2 as `0x${string}`,
  };
  const types = {
    PermitSingle: [
      { name: "details", type: "PermitDetails" },
      { name: "spender", type: "address" },
      { name: "sigDeadline", type: "uint256" },
    ],
    PermitDetails: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
  };
  // viem signTypedData via account client
  const sig = await account.signTypedData({
    domain: domain as any,
    types,
    primaryType: "PermitSingle",
    message: {
      details: {
        token: details.token as `0x${string}`,
        amount: details.amount,
        expiration: details.expiration,
        nonce: details.nonce,
      },
      spender: spender as `0x${string}`,
      sigDeadline,
    },
  });
  return sig as unknown as string;
}

export interface SwapResult { ok: boolean; hash?: string; error?: string; }

/** SELL: token -> native ETH. Wajib 2-step approval + permit2 allowance (sekali per token). */
export async function sellToken(token: `0x${string}`, amountInWei: bigint, _slipBps = 3000): Promise<SwapResult> {
  try {
    const { account } = walletCfg();
    const owner = account.address;
    const bal = await getBalance(owner, token);
    if (bal === 0n) return { ok: false, error: "balance token 0 (mungkin sudah terjual)" };
    const amt = amountInWei > bal ? bal : amountInWei;
    const c = client();

    await ensurePermit2Approve(owner, token);

    const data = buildSellCalldata(token, amt, 1n, owner, nowDeadline());
    await c.call({ account: owner, to: UNIVERSAL_ROUTER as any, data: data as any, value: 0n });
    const tx = await walletCfg().wc.sendTransaction({ chain: null as any, to: UNIVERSAL_ROUTER as any, data: data as any, value: 0n });
    await c.waitForTransactionReceipt({ hash: tx });
    return { ok: true, hash: tx };
  } catch (e: any) {
    return { ok: false, error: e?.shortMessage || e?.message || String(e) };
  }
}

const MAX_UINT = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
const MAX_UINT160 = (1n << 160n) - 1n;

// ---------- Quote token resolver (DexScreener, GMGN-free) ----------
interface DexPair {
  quoteToken?: { address?: string; symbol?: string };
  liquidity?: { usd?: number };
  labels?: string[];
}
const quoteCache = new Map<string, { at: number; quote: string | null }>();
const QUOTE_CACHE_MS = 5 * 60_000;

/** Pool key standar robinhood V4 buat hop ETH→quote (stock token: NVDA/GME/IBM/USDG...).
 *  Probed 2026-09-10: pool ETH→NVDA exist di fee 0.05%/0.01%/0.1%/1%, hook KOSONG.
 *  (Template fee=0/tick200/hook-bonding ga pernah match → PoolNotInitialized.) */
interface QuotePoolKey { fee: number; tick: number; hook: string }
const QUOTE_POOL_CANDIDATES: QuotePoolKey[] = [
  { fee: 500, tick: 10, hook: "0x0000000000000000000000000000000000000000" },
  { fee: 100, tick: 1, hook: "0x0000000000000000000000000000000000000000" },
  { fee: 1000, tick: 10, hook: "0x0000000000000000000000000000000000000000" },
  { fee: 10000, tick: 200, hook: "0x0000000000000000000000000000000000000000" },
];
const poolKeyCache = new Map<string, { at: number; key: QuotePoolKey | null }>();

function isEthLikeQuote(addr: string): boolean {
  const a = (addr || "").toLowerCase();
  return (
    a === "" ||
    /^0x0{40}$/.test(a) ||
    a === "0x0000000000000000000000000000000000000000" ||
    a === WETH.toLowerCase() ||
    a === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  );
}

/**
 * Cari quote token untuk swap token di robinhood.
 * PRIORITAS:
 *   1. Kalau ada pool ber-quote ETH/native/WETH (walau kecil) → return null
 *      (single-hop ETH→token / token→ETH, tanpa biaya hop ke stock/appendix).
 *   2. Kalau nggak ada pool ETH → pilih quote token dengan liquidity terbesar
 *      (mis. USDG/IBM/NVDA/GME/SPY) buat jalur 2-hop.
 * Sumber DexScreener (free) — bukan GMGN.
 */
export async function resolveQuoteToken(token: `0x${string}`): Promise<string | null> {
  const key = token.toLowerCase();
  const hit = quoteCache.get(key);
  if (hit && Date.now() - hit.at < QUOTE_CACHE_MS) return hit.quote;
  let quote: string | null = null;
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`);
    const d: any = await res.json();
    const pairs: DexPair[] = Array.isArray(d?.pairs) ? d.pairs : [];
    if (!pairs.length) {
      quote = null;
    } else {
      // 1) prefer ETH pair (native / WETH) — ga perlu buang-buang fee ke stock
      const hasEthPair = pairs.some((p) => isEthLikeQuote(p.quoteToken?.address as string));
      if (hasEthPair) {
        quote = null;
      } else {
        // 2) fallback: quote token dari pool dengan liquidity terbesar
        const best = [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
        const qt = best?.quoteToken?.address || "";
        quote = qt || null;
      }
    }
  } catch {
    quote = null;
  }
  quoteCache.set(key, { at: Date.now(), quote });
  return quote;
}

/**
 * Cari pool key yang BENERAN exist buat hop ETH→quote di robinhood V4.
 * Quote token robinhood (NVDA/GME/IBM/USDG...) bukan bonding pool fee=0 — yang
 * exist justru pool standar hook kosong. Probe kandidat sampai eth_call nggak
 * nge-return PoolNotInitialized (0x486aa307). Cached 5 menit.
 */
export async function resolveQuotePoolKey(quote: `0x${string}`): Promise<QuotePoolKey | null> {
  const key = quote.toLowerCase();
  const hit = poolKeyCache.get(key);
  if (hit && Date.now() - hit.at < QUOTE_CACHE_MS) return hit.key;
  let best: QuotePoolKey | null = null;
  const owner = (walletCfg().account.address as string) as `0x${string}`;
  const sampleWei = 1000000000000000n; // 0.001 ETH probe
  const deadline = nowDeadline();
  for (const cand of QUOTE_POOL_CANDIDATES) {
    try {
      const data = buildBuyCalldataViaQuoteHooked(quote, null, sampleWei, 1n, owner, deadline, cand);
      await client().call({ account: owner, to: UNIVERSAL_ROUTER as any, data: data as any, value: sampleWei });
      best = cand;
      break;
    } catch {
      // PoolNotInitialized / revert lain — coba kandidat berikutnya
    }
  }
  poolKeyCache.set(key, { at: Date.now(), key: best });
  return best;
}

/**
 * BUY: native ETH -> token, value=amountWei. Kalau token cuma punya pool quote NON-ETH
 * (penyelesaian via IBM/USDG/GME dst), otomatis 2-hop ETH→quote→token.
 * Hop quote (ETH→quote) harus pakai pool key DARI POOL NYATA — robinhood V4 quote stock
 * (NVDA/GME/IBM/USDG dsb) pakai fee-fee standar + hook kosong, BUKAN fee=0/hook bonding.
 */
export async function buyWithNative(token: `0x${string}`, amountWei: bigint, _slipBps = 3000, quote?: string | null): Promise<SwapResult> {
  try {
    const { account } = walletCfg();
    const owner = account.address;
    const eth = await client().getBalance({ address: owner });
    if (eth < amountWei) return { ok: false, error: `Saldo ETH kurang (butuh ${fmtEth(amountWei)}, punya ${fmtEth(eth)})` };
    // quote: parameter eksplisit > resolve otomatis (kalau belum dicek)
    if (quote === undefined) quote = await resolveQuoteToken(token);
    const qKey = quote ? await resolveQuotePoolKey(quote as `0x${string}`) : null;
    const data = buildBuyCalldataViaQuoteHooked(token, quote ?? null, amountWei, 1n, owner, nowDeadline(), qKey);
    const c = client();
    await c.call({ account: owner, to: UNIVERSAL_ROUTER as any, data: data as any, value: amountWei });
    const tx = await walletCfg().wc.sendTransaction({ chain: null as any, to: UNIVERSAL_ROUTER as any, data: data as any, value: amountWei });
    await c.waitForTransactionReceipt({ hash: tx });
    return { ok: true, hash: tx };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * 2-step approval ala robinhood sell (verified dari tx nyata seller IF):
 * 1) ERC20 approve(token -> PERMIT2, MAX_UINT)
 * 2) permit2.approve(token, UR, MAX_UINT160, expiry)
 */
async function ensurePermit2Approve(owner: `0x${string}`, token: `0x${string}`): Promise<void> {
  const c = client();
  const erc = [
    { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
    { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  ] as const;
  const p2 = [
    { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
    { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "address" }, { type: "uint160" }, { type: "uint48" }], outputs: [] },
  ] as const;
  const { wc } = walletCfg();

  // 1) ERC20 approve -> Permit2
  const ercAllow = BigInt((await c.readContract({ address: token, abi: erc as any, functionName: "allowance", args: [owner, PERMIT2 as any] })) as bigint);
  if (ercAllow < MAX_UINT160) {
    const t = await wc.writeContract({ chain: null as any, address: token, abi: erc as any, functionName: "approve", args: [PERMIT2 as any, MAX_UINT] });
    await c.waitForTransactionReceipt({ hash: t });
  }
  // 2) permit2.approve(token, UR, max160, 30d)
  let p2Allow = 0n;
  try {
    p2Allow = BigInt((await c.readContract({ address: PERMIT2 as any, abi: p2 as any, functionName: "allowance", args: [owner, token, UNIVERSAL_ROUTER as any] })) as bigint);
  } catch { /* ok */ }
  if (p2Allow < MAX_UINT160) {
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600 * 24 * 30);
    const t2 = await wc.writeContract({ chain: null as any, address: PERMIT2 as any, abi: p2 as any, functionName: "approve", args: [token, UNIVERSAL_ROUTER as any, MAX_UINT160, expiry] });
    await c.waitForTransactionReceipt({ hash: t2 });
  }
}

export async function getBalance(owner: `0x${string}`, token?: string): Promise<bigint> {
  if (!token || token === NATIVE) return client().getBalance({ address: owner });
  return BigInt(
    await client().readContract({
      address: token as `0x${string}`,
      abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
      functionName: "balanceOf",
      args: [owner],
    })
  );
}

const MAC = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

function getToken(a: string): string {
  // Normalize checksum — kembali string asli
  return a;
}
function nowDeadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + 300);
}
function fmtEth(w: bigint): string {
  return (Number(w) / 1e18).toFixed(5);
}