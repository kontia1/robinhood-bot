/**
 * Brute-force pool key hop ETH(0x0)→NVDA di robinhood V4.
 * eth_call per kombinasi — yang BUKAN PoolNotInitialized = key yang pool-nya ada.
 */
import dotenv from "dotenv";
dotenv.config();
import { AbiCoder, Interface, getAddress } from "ethers";
import * as fs from "node:fs";
import * as path from "node:path";

const RPC = process.env.RPC_URL || `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
const UR = "0x8876789976dEcBfCbBbe364623C63652db8C0904";
const ACCOUNT = "0x0d20d494285939b748D631D82470E3e6523739bd";
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";

const ac = new AbiCoder();
const execIf = new Interface(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]);

const FEES = [0, 60, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000];
const TICKS = [1, 10, 20, 60, 120, 200, 500];
const HOOKS = ["0x0000000000000000000000000000000000000000", "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044"];

function buyTemplateHex(): string {
  const f = fs.readFileSync(path.resolve("/root/robinhood-bot/ur_buys.txt"), "utf8").trim().split("\n");
  return f[1];
}

/** Build single-hop swap ETH→token dengan pool key arbitrer (fee,tick,hook). */
function buildHop(token: string, fee: number, tick: number, hook: string): string {
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
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
  const [act] = ac.decode(["bytes"], params[0] as any);
  // actions bytes ada di t.inputs[0]?? — decode ulang: execIf decode [commands, inputs[], deadline]
  // inputs[0] = (bytes actions, bytes[] params) -> kita decode actions dari params[0] irisan awal
  return "";
}

async function callRaw(url: string, method: string, params: any[]): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

async function probe(token: string, fee: number, tick: number, hook: string): Promise<string> {
  const data = buildHop(token, fee, tick, hook);
  const r = await callRaw(RPC, "eth_call", [{ from: ACCOUNT, to: UR, data, value: "0x38d7ea4c68000" }, "latest"]);
  if (!r.error) return "OK";
  const d = r.error.data || "";
  return d === "0x486aa307" ? "POOL_NOT_INIT" : d.slice(0, 12) || "REVERT";
}

(async () => {
  console.log(`brute-force ETH→NVDA (${FEES.length}×${TICKS.length}×${HOOKS.length} calls)`);
  const found: string[] = [];
  for (const fee of FEES) {
    for (const tick of TICKS) {
      for (const hook of HOOKS) {
        try {
          const st = await probeLLLLLLLLL(NVDA, fee, tick, hook);
          if (st !== "POOL_NOT_INIT") {
            console.log(`  fee=${fee} tick=${tick} hook=${hook.slice(0, 8)} => ${st}`);
            if (st === "OK") found.push(`fee=${fee} tick=${tick} hook=${hook}`);
          }
        } catch (e: any) {
          console.log(`  err fee=${fee} tick=${tick}: ${(e?.message||'').slice(0,100)}`);
        }
      }
    }
  }
  console.log("\n== key OK (pool native→NVDA exist) ==");
  console.log(found.join("\n") || "TIDAK ADA — native/NVDA bukan pool V4 robinhood (kemungkinan via WETH, bukan native)");
})();