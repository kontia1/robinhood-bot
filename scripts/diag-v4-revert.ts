/**
 * Cek V4 revert reason operasional — pakai buildBuyCalldataViaQuote asli dari
 * uniswap-v4.ts (generator yang dipakai bot), replay eth_call, decode revert.
 */
import { createPublicClient, http } from "viem";
import { AbiCoder, Interface } from "ethers";
import dotenv from "dotenv";
dotenv.config();
import * as v4 from "../src/chain/uniswap-v4.js";
import { getActiveWallet } from "../src/wallet/index.js";

const RPC = process.env.RPC_URL || `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
const PLUMBER = "0x0758858405eb0fa18d80915134996f15f0ce6002";
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";

async function main() {
  const w = getActiveWallet();
  const owner: string = w.address.startsWith("0x") ? w.address : "0x" + w.address;
  const amountWei = 1000000000000000n; // 0.001 ETH buat test
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);

  // 1) single-hop build (quote null)
  const single = v4.buildBuyCalldata(PLUMBER, amountWei, 1n, owner, deadline);
  // 2) 2-hop via NVDA
  const viaNvda = v4.buildBuyCalldataViaQuote(PLUMBER, NVDA, amountWei, 1n, owner, deadline);

  const c = createPublicClient({ transport: http(RPC) });
  const ac = new AbiCoder();
  const ur = new Interface(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]);

  for (const [label, data] of [
    ["single-hati (pool template)", single],
    ["2-hop via NVDA", viaNvda],
  ] as const) {
    console.log(`\n===== ${label} =====`);
    try {
      const d = ur.decodeFunctionData("execute", data);
      console.log("commands:", d[0], "deadline:", d[2].toString());
      const [actions, params] = ac.decode(["bytes", "bytes[]"], d[1][0]);
      console.log("actions:", actions);
      const p0 = ac.decode(["(address,(address,uint24,int24,address,bytes)[],uint128,uint128)"], params[0])[0];
      console.log("p0.currency0:", p0[0]);
      for (const h of p0[1]) console.log("  hop:", h[0].slice(0, 14), "fee", h[1], "tick", h[2], "hook", (h[3] as string).slice(0, 12));
      console.log("amountIn:", p0[3].toString(), "minOut:", p0[2].toString());
    } catch (e: any) {
      console.log("decode err:", e?.message?.slice(0, 200));
    }
    try {
      const r = await c.call({ from: owner as any, to: v4.UNIVERSAL_ROUTER as any, data, value: amountWei });
      console.log("eth_call OK:", r);
    } catch (e: any) {
      console.log("REVERT:", (e?.shortMessage || e?.message || String(e)).slice(0, 400));
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });