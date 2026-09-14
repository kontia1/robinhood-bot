// Test SELL tanpa permit — approve ersim if needed (simulate dengan state override allowance UR)
import { createPublicClient, http, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildSellCalldata, UNIVERSAL_ROUTER } from "./dist/chain/uniswap-v4.js";
import { AbiCoder, Interface } from "ethers";
import dotenv from "dotenv";
import fs from "node:fs";
dotenv.config();

const ac = new AbiCoder();
const execIf = new Interface(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]);
const RPC = "https://robinhood-mainnet.g.alchemy.com/v2/" + process.env.ALCHEMY_API_KEY;
const c = createPublicClient({ transport: http(RPC) });
const ws = JSON.parse(fs.readFileSync("./wallet.json", "utf8"));
const w = Array.isArray(ws) ? ws.find((x) => x.isActive) || ws[0] : ws;
const acct = privateKeyToAccount((w.privateKey.startsWith("0x") ? w.privateKey : "0x" + w.privateKey));
const IF = "0x30a0f716f97de3bd0c93ffc8fe05e72f488b0f0f";

const dl = BigInt(Math.floor(Date.now() / 1000) + 300);
const data = buildSellCalldata(IF, BigInt("1000000000000000000"), 1n, acct.address, dl);
const d = new Interface(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]).decodeFunctionData("execute", data);
console.log("commands:", d[0], "inputs:", d[1].length);
const [actions, params] = ac.decode(["bytes", "bytes[]"], d[1][0]);
console.log("actions:", actions, "params:", params.length);
console.log("input0 preview:", d[1][0].slice(0, 100));

// check allowance dulu
const erc = [{ type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] }];
const allowance = await c.readContract({ address: IF, abi: erc, functionName: "allowance", args: [acct.address, UNIVERSAL_ROUTER] });
console.log("allowance IF->UR:", allowance.toString());

try {
  const r = await c.call({ account: acct.address, to: UNIVERSAL_ROUTER, data, value: 0n });
  console.log("SELL IF eth_call: OK", r.slice(0, 24));
} catch (e) {
  const raw = await fetch(RPC, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "eth_call", params: [{ from: acct.address, to: UNIVERSAL_ROUTER, data, value: "0x0" }, "latest"] }),
  }).then((r) => r.json());
  console.log("REVERT raw:", JSON.stringify(raw.error || raw).slice(0, 200));
}
process.exit(0);