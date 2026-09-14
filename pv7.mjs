import { createPublicClient, http } from "viem";
import fs from "node:fs";
const RPC = "https://robinhood-mainnet.g.alchemy.com/v2/" + (process.env.ALCHEMY_API_KEY || "");
const client = createPublicClient({ transport: http(RPC) });
const UR = "0x8876789976decbfcbbbe364623c63652db8c0904".toLowerCase();
const hashes = [
  "0xd94d9405282665d6", "0x7dce471861297d1d", "0x24251c77c91e946b", "0x7295f167c3ca5583",
  "0xc18ed5fc52740737", "0x13a21236aed8ea03", "0x1b4bb9294f0b56f6", "0x76e9fdc7fed82f24",
  "0xb93809255ba0165d", "0xb291a0d1db1dbc5f", "0x91254fbcfb64b13a",
];
for (const h of hashes) {
  const t = await client.getTransaction({ hash: h }).catch(() => null);
  if (!t) { console.log(h.slice(0,12), "no tx (mungkin perlu hash penuh)"); continue; }
  const to = (t.to || "").toLowerCase();
  console.log(t.hash.slice(0,18), "to:", to.slice(0,12), to === UR ? "<<< UR!" : t.to);
  if (to === UR || /55c20f/.test(to)) {
    fs.appendFileSync("/root/robinhood-bot/ur_txs.txt", t.hash + "\n" + (t.input || "") + "\nTO=" + t.to + "\nVAL=" + t.value + "\n\n");
  }
}