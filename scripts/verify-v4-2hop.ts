/** Verifikasi fix: resolveQuotePoolKey(NVDA) + build 2-hop ETH→NVDA→Plumber + eth_call. */
import dotenv from "dotenv";
dotenv.config();
import * as v4 from "../src/chain/uniswap-v4.js";
import { getActiveWallet } from "../src/wallet/index.js";

const RPC = process.env.RPC_URL || `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
const PLUMBER = "0x0758858405eb0fa18d80915134996f15f0ce6002";
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";

async function main() {
  const w = getActiveWallet();
  const owner = (w.address.startsWith("0x") ? w.address : "0x" + w.address) as `0x${string}`;
  console.log("owner:", owner);

  console.log("\n== resolveQuotePoolKey(NVDA) ==");
  const key = await v4.resolveQuotePoolKey(NVDA as any);
  console.log("key:", key ? `fee=${key.fee} tick=${key.tick} hook=${key.hook.slice(0, 8)}` : "GA ADA yang exist");

  console.log("\n== build 2-hop ETH→NVDA→Plumber full ==");
  const amountWei = 1000000000000000n;
  const data = v4.buildBuyCalldataViaQuoteHooked(PLUMBER, NVDA, amountWei, 1n, owner, BigInt(Math.floor(Date.now()/1000)+1800), key);
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ from: owner, to: v4.UNIVERSAL_ROUTER, data, value: "0x38d7ea4c68000" }, "latest"] }),
  });
  const j = await res.json();
  if (j.error) {
    console.log("REVERT:", JSON.stringify(j.error).slice(0, 300));
    console.log("revert data:", (j.error.data || "").slice(0, 120));
  } else {
    console.log("OK — swap 2-hop bisa eth_call, return:", String(j.result).slice(0, 80));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });