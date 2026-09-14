import "dotenv/config";
import { getActiveWallet } from "../src/wallet/index.js";
import { createPublicClient, http } from "viem";
import { config } from "../src/config/index.js";
import * as uniApi from "../src/chain/uniswap-api.js";
import * as v3 from "../src/chain/uniswap-v3.js";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as `0x${string}`;
const pub = createPublicClient({ transport: http(config.rpcUrl) });
const w = getActiveWallet()!;

const erc20Bal = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

async function main() {
  const bal0 = await pub.getBalance({ address: w.address as `0x${string}` });
  console.log("RPC:", config.rpcUrl.replace(/\/v2\/.*/, "/v2/…"));
  console.log("Wallet:", w.address, "| ETH:", (Number(bal0) / 1e18).toFixed(6));

  // sizing: $0.1 dalam wei via pool WETH/USDG (bukan swap — cuma baca)
  const oneUsdWei = await v3.usdToNativeWei(1.0);
  if (oneUsdWei <= 0n) { console.error("ga bisa sizing $1 (pool WETH/USDG?)"); process.exit(1); }
  const amountIn = oneUsdWei / 10n; // $0.1
  console.log("Ukuran tes: $0.1 ≈", (Number(amountIn) / 1e18).toFixed(8), "ETH");

  // 1) BUY via Uniswap API
  console.log("\n== BUY ETH→USDG (Uniswap API) ==");
  const r1 = await uniApi.buyWithNative(USDG, amountIn, 100);
  if (!r1.ok) { console.error("BUY GAGAL:", r1.error); process.exit(1); }
  console.log("BUY OK tx:", r1.hash);

  let usdgBal = BigInt(await pub.readContract({ address: USDG, abi: erc20Bal, functionName: "balanceOf", args: [w.address as `0x${string}`] }) as bigint);
  // baca balance bisa telat settle beberapa detik — retry sebentar
  for (let i = 0; i < 5 && usdgBal === 0n; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    usdgBal = BigInt(await pub.readContract({ address: USDG, abi: erc20Bal, functionName: "balanceOf", args: [w.address as `0x${string}`] }) as bigint);
  }
  console.log("USDG balance:", (Number(usdgBal) / 1e6).toFixed(6));
  console.log("\n== SELL USDG→ETH (Uniswap API) ==");
  const r2 = usdgBal > 0n ? await uniApi.sellToken(USDG, usdgBal, 100) : { ok: false, error: "balance USDG 0" };
  if (!r2.ok) { console.error("SELL GAGAL:", r2.error); process.exit(1); }
  console.log("SELL OK tx:", r2.hash);

  const bal1 = await pub.getBalance({ address: w.address as `0x${string}` });
  console.log("\nFinal ETH:", (Number(bal1) / 1e18).toFixed(8), "| ongkos gas:", ((Number(bal0) - Number(bal1)) / 1e18).toFixed(8), "ETH");
  console.log("ROUND TRIP OK ✅");
}
main().catch((e) => { console.error("FAIL:", e?.message || e); process.exit(1); });