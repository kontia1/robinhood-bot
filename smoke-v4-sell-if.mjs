// SELL eth_call valid — pakai IF (balance ~10327, bukan 0).
import { createPublicClient, http } from "viem";
import { buildSellCalldata, UNIVERSAL_ROUTER } from "./dist/chain/uniswap-v4.js";
import { getAddress } from "ethers";
import dotenv from "dotenv";
dotenv.config();

const c = createPublicClient({ transport: http("https://robinhood-mainnet.g.alchemy.com/v2/" + process.env.ALCHEMY_API_KEY) });
const WALLET = getAddress("0x0d20d494285939b748D631D82470E3e6523739bd");
const IF = "0x30a0f716f97de3bd0c93ffc8fe05e72f488b0f0f";
const dl = BigInt(Math.floor(Date.now() / 1000) + 300);
const data = buildSellCalldata(IF, BigInt("1000000000000000000"), 1n, WALLET, dl);
try {
  const r = await c.call({ account: WALLET, to: UNIVERSAL_ROUTER, data, value: 0n });
  console.log("SELL IF eth_call: OK", String(r).slice(0, 24));
} catch (e) {
  console.log("SELL IF eth_call: REVERT", String(e.message).slice(0, 240).replace(/\n/g," "));
}
process.exit(0);