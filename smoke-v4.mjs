// Smoke test: build V4 calldata dari module ter-compile, eth_call verify TANPA broadcast.
import { createPublicClient, http } from "viem";
import { buildBuyCalldata, buildSellCalldata, UNIVERSAL_ROUTER } from "./dist/chain/uniswap-v4.js";
import { AbiCoder, Interface, getAddress } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const ac = new AbiCoder();
const execIf = new Interface(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]);
const RPC = "https://robinhood-mainnet.g.alchemy.com/v2/" + process.env.ALCHEMY_API_KEY;
const client = createPublicClient({ transport: http(RPC) });
const WALLET = getAddress("0x0d20d494285939b748d631d82470e3e6523739bd");
const MECHA = "0xbb6b4c9690ae95bd72c1d9d698ad7a1570291df5";

const dl = BigInt(Math.floor(Date.now() / 1000) + 300);

// BUY MECHA 0.0005 ETH — harusnya eth_call OK (dah dibuktikan dengan template patch)
const buyData = buildBuyCalldata(MECHA, BigInt("500000000000000"), 1n, WALLET, dl);
const d1 = execIf.decodeFunctionData("execute", buyData);
console.log("BUY commands:", Buffer.from(d1[0].slice(2), "hex").toString("hex"));
const [a1, p1] = ac.decode(["bytes", "bytes[]"], d1[1][0]);
console.log("BUY actions:", Buffer.from(a1.slice(2), "hex").toString("hex"), "params:", p1.length);

try {
  await client.call({ account: WALLET, to: UNIVERSAL_ROUTER, data: buyData, value: BigInt("500000000000000") });
  console.log("BUY eth_call: OK");
} catch (e) {
  console.log("BUY eth_call: REVERT", String(e.message).slice(0, 200).replace(/\n/g, " "));
}

// SELL MECHA 1 token — expect REVERT karna wallet ga punya MECHA (validasi struktur doang)
const sellData = buildSellCalldata(MECHA, BigInt("1000000000000000000"), 1n, WALLET, dl);
const d2 = execIf.decodeFunctionData("execute", sellData);
console.log("SELL commands:", Buffer.from(d2[0].slice(2), "hex").toString("hex"));
const [a2, p2] = ac.decode(["bytes", "bytes[]"], d2[1][0]);
console.log("SELL actions:", Buffer.from(a2.slice(2), "hex").toString("hex"), "params:", p2.length);

try {
  await client.call({ account: WALLET, to: UNIVERSAL_ROUTER, data: sellData, value: 0n });
  console.log("SELL eth_call: OK (wallet ternyata punya token/bisa settle)");
} catch (e) {
  console.log("SELL eth_call: REVERT (wajar kalo wallet ga punya token)", String(e.message).slice(0, 160).replace(/\n/g, " "));
}
process.exit(0);