import "dotenv/config";
import { getActiveWallet } from "../src/wallet/index.js";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const w = getActiveWallet()!;
const acct = privateKeyToAccount(w.privateKey as `0x${string}`);
const RPC = `https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
const pub = createPublicClient({ transport: http(RPC) });

async function main() {
  try {
    const nonce = await pub.getTransactionCount({ address: acct.address });
    console.log("nonce:", nonce.toString());
    const signed = await acct.signTransaction({
      chainId: 4663n,
      to: acct.address,
      value: 0n,
      nonce: BigInt(nonce) - 1n,
      gas: 21000n,
      maxFeePerGas: 100000000n,
      maxPriorityFeePerGas: 1000000n,
    });
    console.log("signed len:", signed.length);
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_sendRawTransaction", params: [signed], id: 1 }),
    });
    const j = await res.json();
    console.log("eth_sendRawTransaction →", JSON.stringify(j).slice(0, 300));
    console.log("error 'nonce too low' = SUPPORTED; 'does not exist' = TIDAK support");
  } catch (e: any) {
    console.error("ERR:", e?.message || e);
    if (e?.stack) console.error(e.stack.split("\n").slice(0, 4).join("\n"));
  }
}
main();
