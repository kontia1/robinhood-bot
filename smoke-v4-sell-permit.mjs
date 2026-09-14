// Full SELL test dengan permit2 signature — eth_call (tanpa broadcast)
import { createPublicClient, http, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildSellCalldata, encodePermitInput, UNIVERSAL_ROUTER, PERMIT2 } from "./dist/chain/uniswap-v4.js";
import { AbiCoder, Interface } from "ethers";
import dotenv from "dotenv";
import fs from "node:fs";
dotenv.config();

const RPC = "https://robinhood-mainnet.g.alchemy.com/v2/" + process.env.ALCHEMY_API_KEY;
const c = createPublicClient({ transport: http(RPC) });
const ws = JSON.parse(fs.readFileSync("./wallet.json", "utf8"));
const w = Array.isArray(ws) ? ws.find((x) => x.isActive) || ws[0] : ws;
const acct = privateKeyToAccount((w.privateKey.startsWith("0x") ? w.privateKey : "0x" + w.privateKey));
console.log("wallet:", acct.address);

const IF = "0x30a0f716f97de3bd0c93ffc8fe05e72f488b0f0f";

// 1) sign permit2
const domain = { name: "Permit2", chainId: 4663, verifyingContract: PERMIT2 };
const types = {
  PermitSingle: [
    { name: "details", type: "PermitDetails" },
    { name: "spender", type: "address" },
    { name: "sigDeadline", type: "uint256" },
  ],
  PermitDetails: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint160" },
    { name: "expiration", type: "uint48" },
    { name: "nonce", type: "uint48" },
  ],
};
const expiration = BigInt(Math.floor(Date.now() / 1000) + 3600);
const sigDeadline = expiration;
const amountMax = BigInt("0xffffffffffffffffffffffffffffffffffffffff");
const message = {
  details: { token: IF, amount: amountMax, expiration, nonce: 0n },
  spender: UNIVERSAL_ROUTER,
  sigDeadline,
};
const sig = await acct.signTypedData({ domain: domain, types, primaryType: "PermitSingle", message });
console.log("sig:", sig.slice(0, 20) + "...");

// 2) build permit input
const permit = encodePermitInput(IF, amountMax, expiration, 0n, UNIVERSAL_ROUTER, sigDeadline, sig);

// 3) build sell (1 token)
const dl = BigInt(Math.floor(Date.now() / 1000) + 300);
const data = buildSellCalldata(IF, BigInt("1000000000000000000"), 1n, acct.address, dl, permit);
const d = new Interface(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]).decodeFunctionData("execute", data);
console.log("commands:", d[0]);
console.log("inputs:", d[1].length, "| input0 len:", d[1][0].length, "| input1 len:", d[1][1].length);

// 4) eth_call (no broadcast) — ambil error data selector
try {
  const r = await c.call({ account: acct.address, to: UNIVERSAL_ROUTER, data, value: 0n });
  console.log("SELL IF eth_call: OK", r.slice(0, 24));
} catch (e) {
  // raw eth_call utk error data
  const raw = await fetch(RPC, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "eth_call", params: [{ from: acct.address, to: UNIVERSAL_ROUTER, data, value: "0x0" }, "latest"] }),
  }).then((r) => r.json());
  console.log("REVERT raw:", JSON.stringify(raw.error || raw).slice(0, 300));
}
process.exit(0);