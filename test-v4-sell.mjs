import { createPublicClient, http } from "viem";
import { AbiCoder, Interface } from "ethers";
import fs from "node:fs";

const ac = new AbiCoder();
const execIf = new Interface(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]);
const RPC = "https://robinhood-mainnet.g.alchemy.com/v2/" + (process.env.ALCHEMY_API_KEY || "");
const client = createPublicClient({ transport: http(RPC) });

const UR = "0x8876789976decbfcbbbe364623c63652db8c0904";
const FROM = "0x0d20d494285939b748D631D82470E3e6523739bd";
const MECHA = "0xbb6b4c9690ae95bd72c1d9d698ad7a1570291df5";

function patchSell(rawHex, token, amountIn, minOutEth, deadline) {
  const d = execIf.decodeFunctionData("execute", rawHex);
  const [actions, params] = ac.decode(["bytes", "bytes[]"], d[1][0]);
  const p0 = ac.decode(["((address,address,uint24,int24,address),bool,int128,int128,uint160,bytes)"], params[0])[0];
  // poolKey: currency0 native, currency1 token (pola sama utk semua bonding)
  const pk = [p0[0][0], token, p0[0][2], p0[0][3], p0[0][4]];
  const newP0 = ac.encode(["((address,address,uint24,int24,address),bool,int128,int128,uint160,bytes)"],
    [[pk, false, amountIn, minOutEth, 0n, "0x"]]);
  // param1 SETTLE: token which gets taken from wallet
  let newP1;
  try {
    const p1 = ac.decode(["address", "uint256"], params[1]);
    newP1 = ac.encode(["address", "uint256"], [token, p1[1]]);
  } catch { newP1 = params[1]; }
  // param2 TAKE: token out (native), recipient wallet
  let newP2;
  try {
    const p2 = ac.decode(["address", "address", "uint256"], params[2]);
    newP2 = ac.encode(["address", "address", "uint256"], [p2[0], FROM, p2[2]]);
  } catch { newP2 = params[2]; }
  const newInput = ac.encode(["bytes", "bytes[]"], [actions, [newP0, newP1, newP2]]);
  return execIf.encodeFunctionData("execute", [d[0], [newInput], deadline]);
}

const t = fs.readFileSync("/root/robinhood-bot/ur_txs.txt", "utf8").trim().split("\n\n");
const sellTpl = t[1].split("\n")[1]; // SELL#1

const amountIn = BigInt("1000000000000000000"); // 1 token (ignore decimals utk test)
const minOut = 1n;
const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
const cd = patchSell(sellTpl, MECHA, amountIn, minOut, deadline);
try {
  const r = await client.call({ account: FROM, to: UR, data: cd, value: 0n });
  console.log("eth_call SELL patched MECHA: OK", String(r).slice(0, 24));
} catch (e) {
  console.log("eth_call SELL patched MECHA: REVERT", String(e.message).slice(0, 240).replace(/\n/g, " "));
}
process.exit(0);