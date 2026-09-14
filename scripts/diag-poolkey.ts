/** Probe pool key robinhood V4: cari kombinasi (fee,tick,hook) yang pool-nya exist (bukan PoolNotInitialized). */
import dotenv from "dotenv";
dotenv.config();
import * as v4 from "../src/chain/uniswap-v4.js";
import { getActiveWallet } from "../src/wallet/index.js";
import { Interface } from "ethers";

const RPC = process.env.RPC_URL || `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
const PLUMBER = "0x0758858405eb0fa18d80915134996f15f0ce6002";
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const HOOKS = [v4.HOOK_BONDING, "0x0000000000000000000000000000000000000000"];
const TICKS = [200, 10, 1, 60];
const FEES = [0, 100, 500, 3000, 10000];

async function callRaw(url: string, method: string, params: any[]): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

// Monkey-patch: build calldata dengan pool key ARBITRER (bukan template langsung).
// Reuse buildBuyCalldataViaQuote tapi override fee/tick/hook lewat modul sementara? 
// Lebih gampang: bikin ulang builder here dari template.
import * as fs from "node:fs";
import * as path from "node:path";
import { AbiCoder, Interface, getAddress } from "ethers";

const ROOT = path.resolve(import.meta.dirname, "..");
const ac = new AbiCoder();
const execIf = new Interface(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]);

function buyTemplateHex(): string {
  const f = fs.readFileSync(path.join(ROOT, "ur_buys.txt"), "utf8").trim().split("\n");
  return f[1];
}

function build(token: string, quote: string | null, amountWei: bigint, fee: number, tick: number, hook: string): string {
  const t = execIf.decodeFunctionData("execute", buyTemplateHex());
  const [actions, params] = ac.decode(["bytes", "bytes[]"], t.inputs[0] as any);
  const p0 = ac.decode(["(address,(address,uint24,int24,address,bytes)[],uint128,uint128)"], params[0] as any)[0];
  const hop = (cur: string) => [cur.toLowerCase(), BigInt(fee), BigInt(tick), getAddress(hook), "0x"];
  const newPath = quote ? [hop(quote), hop(token)] : [hop(token)];
  const newP0 = ac.encode(
    ["(address,(address,uint24,int24,address,bytes)[],uint128,uint128)"],
    [[p0[0], newPath, 1n, amountWei]]
  );
  const p2 = ac.decode(["address", "address", "uint256"], params[2] as any);
  const newP2 = ac.encode(["address", "address", "uint256"], [token, p2[1], p2[2]]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const newInput = ac.encode(["bytes", "bytes[]"], [actions, [newP0, params[1], newP2]]);
  return execIf.encodeFunctionData("execute", [t.commands, [newInput], deadline]);
}

async function main() {
  const w = getActiveWallet();
  const owner = (w.address.startsWith("0x") ? w.address : "0x" + w.address) as `0x${string}`;
  const amountWei = "0x38d7ea4c68000";
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);

  async function exists(data: string): Promise<string> {
    const r = await callRaw(RPC, "eth_call", [{ from: owner, to: v4.UNIVERSAL_ROUTER, data, value: amountWei }, "latest"]);
    if (!r.error) return "OK";
    const dd = r.error.data || "";
    return dd === "0x486aa307" ? "POOL_NOT_INIT" : dd.slice(0, 10) || "REVERT";
  }

  console.log("== Plumber native (single-hop) — variasi hook/fee/tick ==");
  for (const hook of HOOKS) {
    for (const fee of [0n, 3000n]) {
      for (const tick of [200, 10]) {
        const data = build(PLUMBER, null, 1000000000000000n, fee, BigInt(tick), hook);
        const status = await exists(data);
        console.log(`  hook=${hook.slice(0, 8)} fee=${fee} tick=${tick} => ${status}`);
      }
    }
  }

  console.log("\n== Plumber via NVDA (2-hop) — hook plumber beneran live? ==");
  for (const hook of HOOKS) {
    for (const tick of [200, 10]) {
      const data = build(PLUMBER, NVDA, 1000000000000000n, 0n, BigInt(tick), hook);
      console.log(`  hook=${hook.slice(0, 8)} tick=${tick} => ${await exists(data)}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });