/**
 * On-chain Uniswap V3 swap for Robinhood Chain (4663) — GMGN-free execution path.
 *
 * Route: detect pool via V3 factory → conservative quote from pool reserves →
 * approve router → exactInputSingle swap.
 *
 * Addresses verified on-chain 2026-09-08:
 *  - Factory : 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA
 *  - Router  : 0xE592427A0AEce92De3Edee1F18E0157C05861564
 *  - WETH    : 0x0Bd7D308f8e1639FAb988df18A8011f41EAcAD73
 *  - USDG    : 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
 */
import { createPublicClient, createWalletClient, http, type Address, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config/index.js";
import { getActiveWallet } from "../wallet/index.js";

export const CHAIN_ID = 4663;
export const V3_FACTORY = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" as Address;
export const V3_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564" as Address;
export const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address;
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
export const NATIVE = "0x0000000000000000000000000000000000000000" as Address;
export const FEE_TIERS = [100, 500, 3000, 10000] as const;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

const MAX_UINT256 =
  "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as `0x${string}`;

const erc20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

const weth9 = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
] as const;

const factoryAbi = [
  { type: "function", name: "getPool", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }], outputs: [{ type: "address" }] },
] as const;

const poolAbi = [
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "fee", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
  { type: "function", name: "liquidity", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }] },
] as const;

const routerAbi = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
        name: "params",
      },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

const rhChain: Chain = {
  id: CHAIN_ID,
  name: "robinhood",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl || `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`] } },
};

let _client: ReturnType<typeof createPublicClient> | null = null;
function client(): ReturnType<typeof createPublicClient> {
  if (!_client) {
    _client = createPublicClient({
      transport: http(config.rpcUrl || `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`),
    });
  }
  return _client;
}

function activePrivateKey(): `0x${string}` {
  const w = getActiveWallet();
  if (!w) throw new Error("Wallet kosong — buat wallet dulu");
  return w.privateKey as `0x${string}`;
}

function wallet() {
  const acct = privateKeyToAccount(activePrivateKey());
  return {
    account: acct,
    client: createWalletClient({ account: acct, chain: robinhoodChain(), transport: http(rpcUrl()) }),
  };
}
function robinhoodChain(): Chain {
  return {
    id: CHAIN_ID,
    name: "robinhood",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl()] } },
  };
}
function rpcUrl(): string {
  return config.rpcUrl || `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
}

export async function getBalance(owner: Address, token?: Address): Promise<bigint> {
  if (!token || token === ZERO_ADDRESS) return client().getBalance({ address: owner });
  return BigInt(
    await client().readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [owner] })
  );
}

export async function getTokenMeta(address: Address): Promise<{ symbol: string; decimals: number }> {
  try {
    const [symbol, decimals] = await Promise.all([
      client().readContract({ address, abi: erc20, functionName: "symbol" }),
      client().readContract({ address, abi: erc20, functionName: "decimals" }),
    ]);
    return { symbol: String(symbol), decimals: Number(decimals) };
  } catch {
    return { symbol: address.slice(0, 8), decimals: 18 };
  }
}

export interface WalletToken {
  address: string;
  symbol: string;
  decimals: number;
  balance: bigint;
}

/**
 * List semua token ERC-20 di wallet via Alchemy (alchemy_getTokenBalances)
 * — tidak butuh GMGN (yang sering rate-limit banned).
 * Kalau RPC bukan Alchemy (endpoint lain), fallback kosong — caller bisa
 * pake getBalance() per token yang dia kenal.
 */
export async function getWalletTokens(owner: string): Promise<WalletToken[]> {
  const c = client();
  let res: any;
  try {
    // request() pada public client bisa dipakai buat method non-standar
    res = await (c as any).request({
      method: "alchemy_getTokenBalances",
      params: [owner as `0x${string}`, "erc20"],
    });
  } catch {
    return [];
  }
  const items: any[] = res?.tokenBalances || [];
  const out: WalletToken[] = [];
  for (const it of items) {
    const bal = BigInt(it.tokenBalance || "0x0");
    if (bal <= 0n) continue;
    let symbol = it.contractAddress.slice(0, 8);
    let decimals = 18;
    try {
      const meta = await (c as any).request({
        method: "alchemy_getTokenMetadata",
        params: [it.contractAddress],
      });
      if (meta?.symbol) symbol = String(meta.symbol);
      if (meta?.decimals != null) decimals = Number(meta.decimals);
    } catch { /* fallback ke address pendek */ }
    out.push({ address: it.contractAddress, symbol, decimals, balance: bal });
  }
  return out;
}

/** Find V3 pool across supported fee tiers. Returns pool address + fee. */
export async function findPool(a: Address, b: Address, fee?: number): Promise<{ pool: Address; fee: number } | null> {
  const tiers = fee ? [fee] : FEE_TIERS;
  // factory.getPool bersifat ORDER-SENSITIVE — harus sorted (address lebih kecil dulu)
  const [x, y] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  for (const f of tiers) {
    try {
      const pool = await client().readContract({
        address: V3_FACTORY,
        abi: factoryAbi,
        functionName: "getPool",
        args: [x, y, f],
      });
      if (pool && pool !== ZERO_ADDRESS) return { pool, fee: f };
    } catch {
      /* next tier */
    }
  }
  return null;
}

export interface QuoteResult {
  amountOut: bigint;
  fee: number;
  pool: Address;
}

/** Conservative quote: constant-product from on-chain pool token balances. */
export async function quoteV3(pool: Address, tokenIn: Address, amountIn: bigint): Promise<QuoteResult | null> {
  const [t0, t1, fee] = await Promise.all([
    client().readContract({ address: pool, abi: poolAbi, functionName: "token0" }),
    client().readContract({ address: pool, abi: poolAbi, functionName: "token1" }),
    client().readContract({ address: pool, abi: poolAbi, functionName: "fee" }),
  ]);
  const [r0, r1] = await Promise.all([
    client().readContract({ address: t0 as Address, abi: erc20, functionName: "balanceOf", args: [pool] }),
    client().readContract({ address: t1 as Address, abi: erc20, functionName: "balanceOf", args: [pool] }),
  ]);
  const b0 = BigInt(r0 as bigint);
  const b1 = BigInt(r1 as bigint);
  if (b0 === 0n || b1 === 0n) return null;
  const zeroForOne = tokenIn.toLowerCase() === (t0 as Address).toLowerCase();
  const [resIn, resOut] = zeroForOne ? [b0, b1] : [b1, b0];
  const amountOut = (amountIn * resOut) / (resIn + amountIn);
  return { amountOut, fee: Number(fee), pool };
}

async function ensureAllowance(owner: Address, token: Address, spender: Address, needed: bigint): Promise<void> {
  const current = BigInt(
    await client().readContract({ address: token, abi: erc20, functionName: "allowance", args: [owner, spender] })
  );
  if (current >= needed) return;
  const { client: wc } = wallet();
  const tx = await wc.writeContract({
    address: token,
    abi: erc20,
    functionName: "approve",
    args: [spender, MAX_UINT_BIGINT],
  });
  await client().waitForTransactionReceipt({ hash: tx });
}
const MAX_UINT_BIGINT = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");

export interface SwapResult {
  ok: boolean;
  hash?: `0x${string}`;
  amountOut?: bigint;
  error?: string;
}

function toSwapResult(tx: `0x${string}`, amountOut: bigint): SwapResult {
  return { ok: true, hash: tx, amountOut };
}

/** Buy token with native ETH: wrap → approve → exact single-hop WETH→token. */
export async function buyWithNative(token: Address, amountInWei: bigint, slippageBps = 2000): Promise<SwapResult> {
  try {
    const { account, client: wc } = wallet();
    const owner = account.address;

    const pool = await findPool(WETH, token);
    if (!pool) return { ok: false, error: "Tidak ada pool WETH-token" };

    // 1) wrap ETH → WETH
    const wrapTx = await wc.writeContract({
      address: WETH,
      abi: weth9,
      functionName: "deposit",
      value: amountInWei,
    });
    await client().waitForTransactionReceipt({ hash: wrapTx });

    // 2) approve router for WETH
    await ensureAllowance(owner, WETH, V3_ROUTER, amountInWei);

    // 3) quote + swap
    const q = await quoteV3(pool.pool, WETH, amountInWei);
    if (!q) return { ok: false, error: "Quote V3 gagal" };
    const minOut = (q.amountOut * BigInt(10000 - slippageBps)) / 10000n;

    const tx = await wc.writeContract({
      address: V3_ROUTER,
      abi: routerAbi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: WETH,
          tokenOut: token,
          fee: pool.fee,
          recipient: owner,
          deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
          amountIn: amountInWei,
          amountOutMinimum: minOut,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    await client().waitForTransactionReceipt({ hash: tx });
    return toSwapResult(tx, q.amountOut);
  } catch (e: any) {
    return { ok: false, error: e?.shortMessage || e?.message || String(e) };
  }
}

/** Sell token → quote token (auto: try WETH pool, fallback USDG pool). */
export async function sellToken(token: Address, amountIn: bigint, slippageBps = 2000): Promise<SwapResult> {
  try {
    const { account, client: wc } = wallet();
    const owner = account.address;

    let pool = await findPool(token, WETH);
    let quoteToken = WETH;
    if (!pool) {
      pool = await findPool(token, USDG);
      quoteToken = USDG;
    }
    if (!pool) return { ok: false, error: "Tidak ada pool sell (WETH/USDG)" };

    await ensureAllowance(owner, token, V3_ROUTER, amountIn);
    const q = await quoteV3(pool.pool, token, amountIn);
    if (!q) return { ok: false, error: "Quote sell gagal" };
    const minOut = (q.amountOut * BigInt(10000 - slippageBps)) / 10000n;

    const tx = await wc.writeContract({
      address: V3_ROUTER,
      abi: routerAbi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: token,
          tokenOut: quoteToken,
          fee: pool.fee,
          recipient: owner,
          deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
          amountIn,
          amountOutMinimum: minOut,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    await client().waitForTransactionReceipt({ hash: tx });
    return toSwapResult(tx, q.amountOut);
  } catch (e: any) {
    return { ok: false, error: e?.shortMessage || e?.message || String(e) };
  }
}

export function isNative(addr: string): boolean {
  const a = addr.toLowerCase();
  return a === ZERO_ADDRESS.toLowerCase() || a === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
}

/**
 * Convert a USD notional into native ETH wei using the on-chain WETH/USDG pool
 * (USDG ≈ $1 stable). Returns 0 if the pool/quote is unavailable so callers can
 * fall back to a percentage-based size.
 */
export async function usdToNativeWei(usd: number): Promise<bigint> {
  try {
    const pool = await findPool(WETH, USDG);
    if (!pool) return 0n;
    const oneWeth = 10n ** 18n;
    const q = await quoteV3(pool.pool, WETH, oneWeth);
    if (!q || q.amountOut === 0n) return 0n;
    // q.amountOut = USDG per 1 WETH (USDG has 6 decimals)
    const usdgPerWeth = Number(q.amountOut) / 1e6;
    if (!(usdgPerWeth > 0)) return 0n;
    // wei = usd / usdPerWeth * 1e18
    return BigInt(Math.round((usd / usdgPerWeth) * 1e18));
  } catch {
    return 0n;
  }
}