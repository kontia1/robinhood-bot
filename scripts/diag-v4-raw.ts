/** Raw eth_call + decode full revert data via Alchemy RPC (bukan viem yang nge-mask). */
import dotenv from "dotenv";
dotenv.config();
import * as v4 from "../src/chain/uniswap-v4.js";
import { getActiveWallet } from "../src/wallet/index.js";
import { AbiCoder, Interface } from "ethers";

const RPC = process.env.RPC_URL || `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
const PLUMBER = "0x0758858405eb0fa18d80915134996f15f0ce6002";
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";

async function callRaw(url: string, method: string, params: any[]): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

async function main() {
  const w = getActiveWallet();
  const owner = w.address.startsWith("0x") ? w.address : "0x" + w.address;
  const amountWei = "0x38d7ea4c68000"; // 0.001 ETH
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);

  const cases: Record<string, string> = {
    single: v4.buildBuyCalldata(PLUMBER, 1000000000000000n, 1n, owner, deadline),
    viaNvda: v4.buildBuyCalldataViaQuote(PLUMBER, NVDA, 1000000000000000n, 1n, owner, deadline),
  };

  for (const [label, data] of Object.entries(cases)) {
    console.log(`\n===== ${label} =====`);
    const r = await callRaw(RPC, "eth_call", [{ from: owner, to: v4.UNIVERSAL_ROUTER, data, value: amountWei }, "latest"]);
    if (r.error) {
      console.log("error:", JSON.stringify(r.error));
      const d0 = r.error.data;
      if (d0) {
        console.log("revert data:", d0.slice(0, 200));
        try {
          const iface = new Interface([
            "function Error(string)",
            "function Panic(uint256)",
            "error V4TooLittleReceived()",
            "error V4TooMuchRequested()",
            "error V4SwapFailed()",
          ]);
          console.log("decoded:", iface.parseError(d0));
        } catch (e2: any) {
          console.log("decode fail:", e2?.message?.slice(0, 150));
        }
      }
      // try traceCall
      try {
        const tr = await callRaw(RPC, "alchemy_traceCall", [{ from: owner, to: v4.UNIVERSAL_ROUTER, value: amountWei, data }, ["trace"], "latest"]);
        const out = JSON.stringify(tr).slice(0, 600);
        console.log("trace:", out);
      } catch {}
    } else {
      console.log("eth_call OK:", JSON.stringify(r.result).slice(0, 200));
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });