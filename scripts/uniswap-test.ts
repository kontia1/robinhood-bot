/**
 * Test Uniswap Trading API di Robinhood Chain (4663) — swap kecil $0.1.
 * Flow: quote → approve proxy (kalau perlu) → swap → broadcast → receipt.
 * Pakai proxy approval flow (x-permit2-disabled: true) — ga perlu EIP-712.
 */
import "dotenv/config";
import { getActiveWallet } from "../src/wallet/index.js";
import { createPublicClient, createWalletClient, http, maxUint256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const API = "https://trade-api.gateway.uniswap.org/v1";
const KEY = process.env.UNISWAP_API_KEY || "";
const PROXY = "0x02E5be68D46DAc0B524905bfF209cf47EE6dB2a9" as `0x${string}`;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as `0x${string}`;
const NATIVE = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const CHAIN_ID = 4663;
const RPC = process.env.RPC_URL || (process.env.ALCHEMY_API_KEY
  ? `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
  : "");

if (!KEY) { console.error("UNISWAP_API_KEY kosong"); process.exit(1); }
if (!RPC) { console.error("ALCHEMY_API_KEY kosong"); process.exit(1); }

const wallet = getActiveWallet();
if (!wallet) { console.error("Wallet tidak ada"); process.exit(1); }

const account = privateKeyToAccount(wallet.privateKey as `0x${string}`);
const publicClient = createPublicClient({ transport: http(RPC) });
const walletClient = createWalletClient({
  account,
  chain: { id: CHAIN_ID, name: "robinhood", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } },
  transport: http(RPC),
});
const SWAPPER = account.address;

const erc20Approve = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;
const erc20View = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

async function api(path: string, body: any) {
  const res = await fetch(API + path, {
    method: "POST",
    headers: { "x-api-key": KEY, "x-permit2-disabled": "true", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 500)}`);
  return json;
}

function quoteBody(tokenIn: `0x${string}`, tokenOut: `0x${string}`, amount: string, slippageBps = 100) {
  return {
    tokenInChainId: CHAIN_ID, tokenOutChainId: CHAIN_ID, amount,
    tokenIn, tokenOut, swapper: SWAPPER, type: "EXACT_INPUT",
    slippageTolerance: slippageBps, protocols: ["V3"],
  };
}

async function ensureApproval(token: `0x${string}`, need: bigint) {
  const allowance = await publicClient.readContract({ address: token, abi: erc20View, functionName: "allowance", args: [SWAPPER, PROXY] });
  if (BigInt(allowance as bigint) >= need) return;
  console.log("  approve proxy:", token.slice(0, 10) + "…");
  const tx = await walletClient.writeContract({
    address: token,
    abi: erc20Approve,
    functionName: "approve",
    args: [PROXY, maxUint256],
  });
  const rc = await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 180_000, confirmations: 1 });
  if (rc.status !== "success") throw new Error("approve failed");
  console.log("  approved:", tx);
}

async function sendSwap(swap: { to: string; data: string; value: string }) {
  const value = BigInt(swap.value || "0x0");
  console.log("  swap →", swap.to.slice(0, 14) + "… value:", value.toString(), "wei");
  const tx = await walletClient.sendTransaction({
    to: swap.to as `0x${string}`,
    data: swap.data as `0x${string}`,
    value,
  });
  console.log("  tx:", tx);
  const rc = await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 180_000, confirmations: 1 });
  console.log("  status:", rc.status, "| gasUsed:", rc.gasUsed?.toString());
  if (rc.status !== "success") throw new Error("swap tx failed");
}

async function main() {
  const bal = await publicClient.getBalance({ address: SWAPPER });
  console.log("Wallet:", SWAPPER);
  console.log("ETH:", (Number(bal) / 1e18).toFixed(6));

  // probe harga: 0.00001 ETH → USDG
  const probe = await api("/quote", quoteBody(NATIVE, USDG, "10000000000000"));
  const usdgOut = Number(probe.quote.output.amount) / 1e6;
  const ethUsd = usdgOut / 1e-5;
  const amountIn = BigInt(Math.min(Math.floor((0.1 / ethUsd) * 1e18), Number(bal))); // $0.1 (gas terpisah, balance cukup)
  console.log("1 ETH ≈ $", ethUsd.toFixed(0), "→ $0.1 =", (Number(amountIn) / 1e18).toFixed(8), "ETH");

  // 1) BUY path: ETH → USDG
  console.log("\n== [1] BUY: ETH → USDG ==");
  const q1 = await api("/quote", quoteBody(NATIVE, USDG, amountIn.toString()));
  console.log("  out:", (Number(q1.quote.output.amount) / 1e6).toFixed(6), "USDG");
  const s1 = await api("/swap", { quote: q1.quote, tokenInChainId: CHAIN_ID, tokenOutChainId: CHAIN_ID, swapper: SWAPPER, deadline: 300 });
  await sendSwap(s1.swap);
  console.log("  BUY OK ✅");

  const usdgBal = BigInt(await publicClient.readContract({ address: USDG, abi: erc20View, functionName: "balanceOf", args: [SWAPPER] }) as bigint);
  console.log("  USDG balance:", (Number(usdgBal) / 1e6).toFixed(6));

  // 2) SELL: USDG → ETH
  console.log("\n== [2] SELL: USDG → ETH ==");
  if (usdgBal > 0n) {
    await ensureApproval(USDG, usdgBal);
    const q2 = await api("/quote", quoteBody(USDG, NATIVE, usdgBal.toString()));
    console.log("  out:", (Number(q2.quote.output.amount) / 1e18).toFixed(8), "ETH");
    const s2 = await api("/swap", { quote: q2.quote, tokenInChainId: CHAIN_ID, tokenOutChainId: CHAIN_ID, swapper: SWAPPER, deadline: 300 });
    await sendSwap(s2.swap);
    console.log("  SELL OK ✅");
  } else {
    console.log("  skip — USDG balance 0");
  }

  const bal2 = await publicClient.getBalance({ address: SWAPPER });
  console.log("\nFinal ETH:", (Number(bal2) / 1e18).toFixed(8), "(biaya gas:", ((Number(bal) - Number(bal2)) / 1e18).toFixed(8), "ETH)");
}

main().catch((e) => { console.error("FAIL:", e?.message || e); process.exit(1); });