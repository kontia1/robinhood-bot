import { createPublicClient, http, formatUnits, parseAbi } from "viem";
const RPC = "https://robinhood-mainnet.g.alchemy.com/v2/" + (process.env.ALCHEMY_API_KEY || "");
const WALLET = "0x0d20d494285939b748D631D82470E3e6523739bd";
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"]);
const client = createPublicClient({ transport: http(RPC) });
const addrs = [
  "0xf2cc9d26de85760401e9c6009ca1580b464d0c7b", // PEOPLE
  "0xbb6b4c9690ae95bd72c1d9d698ad7a1570291df5", // MECHA
];
for (const addr of addrs) {
  try {
    const bal = await client.readContract({ address: addr, abi: erc20, functionName: "balanceOf", args: [WALLET] });
    const dec = await client.readContract({ address: addr, abi: erc20, functionName: "decimals", args: [] });
    console.log(addr.slice(0,8), "bal→", formatUnits(bal, Number(dec)), "(dec", dec+")");
  } catch (e) { console.log(addr.slice(0,8), "ERR:", String(e.message).slice(0,110)); }
}
