/**
 * Brute-force pool key hop ETH→NVDA robinhood V4.
 * Reuse builder dari diag-poolkey (sudah terbukti benar: PoolNotInitialized = calldata valid,
 * pool-nya yang ga ada). Iterasi (fee,tick,hook) → yang bukan PoolNotInitialized = key NVDA-ETH.
 */
import dotenv from "dotenv";
dotenv.config();
import * as v4 from "../src/chain/uniswap-v4.js";
import { AbiCoder, Interface, getAddress } from "ethers";
import * as fs from "node:fs";
import * as path from "node:path";

const RPC = process.env.RPC_URL || `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const ACCOUNT = "0x0d20d494285939b748D631D82470E3e6523739bd";

const ac = new AbiCoder();
const execIf = new Interface(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]);
const ROOT = path.resolve(import.meta.dirname, "..");

const FEES = [0, 60, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000];
const TICKS = [1, 10, 20, 60, 120, 200, 500];
const HOOKS = ["0x0000000000000000000000000000000000000000", "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044"];

function buyTemplateHex(): string {
  const f = fs.readFileSync(path.join(ROOT, "ur_buys.txt"), "utf8").trim().split("\n");
  return f[1];
}

/** single-hop ETH→token dengan pool key arbitrer (fee,tick,hook) */
function build(token: string, fee: number, tick: number, hook: string): string {
  const t = execIf.decodeFunctionData("execute", buyTemplateHex());
  const [actions, params] = ac.decode(["bytes", "bytes[]"], t.inputs[0] as any);
  const p0 = ac.decode(["(address,(address,uint24,int24,address,bytes)[],uint128,uint128)"], params[0] as any)[0];
  const hop = [token.toLowerCase(), BigInt(fee), BigInt(tick), getAddress(hook), "0x"];
  const newP0 = ac.encode(
    ["(address,(address,uint24,int24,address,bytes)[],uint128,uint128)"],
    [[p0[0], [hop], 1n, 1000000000000000n]]
  );
  const p2 = ac.decode(["address", "address", "uint256"], params[2] as any);
  const newP2 = ac.encode(["address", "address", "uint256"], [token, p2[1], p2[2]]);
  const newInput = ac.encode(["bytes", "bytes[]"], [actions, [newP0, params[1], newP2]]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  return execIf.encodeFunctionData("execute", [t.commands, [newInput], deadline]);
}

async function callRaw(url: string, method: string, params: any[]): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

async function probe(fee: number, tick: number, hook: string): Promise<string> {
  const data = build(NVDA, fee, tick, hook);
  const r = await callRaw(RPC, "eth_call", [{ from: ACCOUNT, to: v4.UNIVERSAL_ROUTER, data, value: "0x38d7ea4c68000" }, "latest"]);
  if (!r.error) return "OK";
  const d = r.error.data || "";
  return d === "0x486aa307" ? "POOL_NOT_INIT" : d.slice(0, 12) || "REVERT";
}

(async () => {
  console.log(`brute-force ETH→NVDA ${FEES.length}×${TICKS.length}×${HOOKS.length} = ${FEES.length * TICKS.length * HOOKS.length} calls`);
  const found: string[] = [];
  let total = 0;
  for (const fee of FEES) {
    for (const tick of TICKS) {
      for (const hook of HOOKS) {
        total++;
        try {
          const st = await probe(fee, tick, hook);
          if (st !== "POOL_NOT_INIT") {
            console.log(`  (${total}) fee=${fee} tick=${tick} hook=${hook.slice(0, 8)} => ${st}`);
            if (st === "OK") found.push(`fee=${fee} tick=${tick} hook=${hook}`);
          }
        } catch (e: any) {
          console.log(`  (${total}) fee=${fee} tick=${tick} err ${(e?.message || "").slice(0, 80)}`);
        }
      }
    }
  }
  console.log("\n== key ETH→NVDA yang exist (OK) ==");
  console.log(found.join("\n") || "TIDAK ADA — native→NVDA bukan pool V4 (cek WETH aja)");
})();