import { createPublicClient, http } from "viem";
import { AbiCoder, Interface } from "ethers";
import fs from "node:fs";

const ac = new AbiCoder();
const execIf = new Interface(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]);
const RPC = "https://robinhood-mainnet.g.alchemy.com/v2/" + (process.env.ALCHEMY_API_KEY || "");
const client = createPublicClient({ transport: http(RPC) });

const UR = "0x8876789976decbfcbbbe364623c63652db8c0904";
const TOKEN = "0xbb6b4c9690ae95bd72c1d9d698ad7a1570291df5"; // MECHA

function patchBuy(rawHex, newToken, bigA, bigB, deadline) {
  const d = execIf.decodeFunctionData("execute", rawHex);
  const [actions, params] = ac.decode(["bytes", "bytes[]"], d[1][0]);
  const p0 = ac.decode(["(address,(address,uint24,int24,address,bytes)[],uint128,uint128)"], params[0])[0];
  const path = Array.from(p0[1]).map((pt) => [newToken, pt[1], pt[2], pt[3], pt[4]]); // ganti token saja
  const newP0 = ac.encode(["(address,(address,uint24,int24,address,bytes)[],uint128,uint128)"], [[p0[0], path, bigA, bigB]]);
  const p2 = ac.decode(["address", "address", "uint256"], params[2]);
  const newP2 = ac.encode(["address", "address", "uint256"], [newToken, p2[1], p2[2]]);
  const newInput = ac.encode(["bytes", "bytes[]"], [actions, [newP0, params[1], newP2]]);
  return execIf.encodeFunctionData("execute", [d[0], [newInput], deadline]);
}

function dec(a, b) { return ac.decode(a, b); }

const data = fs.readFileSync("/root/robinhood-bot/ur_buys.txt", "utf8").trim().split("\n");
const buyTemplate = data[1];
const amountWei = BigInt("500000000000000"); // 0.0005 ETH
const minOut = 1n;
const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
const from = "0x0d20d494285939b748D631D82470E3e6523739bd";

for (const [label, a2, a3] of [["AB(amount=2nd,min=3rd)", amountWei, minOut], ["BA(amount=3rd,min=2nd)", minOut, amountWei]]) {
  const cd = patchBuy(buyTemplate, TOKEN, a2, a3, deadline);
  try {
    const r = await client.call({ account: from, to: UR, data: cd, value: amountWei });
    console.log(`eth_call [${label}]: OK`, String(r).slice(0, 24));
  } catch (e) {
    console.log(`eth_call [${label}]: REVERT`, String(e.message).slice(0, 160).replace(/\n/g, " "));
  }
}
process.exit(0);