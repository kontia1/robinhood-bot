import { createPublicClient, http } from "viem";
import { AbiCoder, Interface } from "ethers";
import fs from "node:fs";

const ac = new AbiCoder();
const execIf = new Interface(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]);
const RPC = "https://robinhood-mainnet.g.alchemy.com/v2/" + (process.env.ALCHEMY_API_KEY || "");
const client = createPublicClient({ transport: http(RPC) });

const UR = "0x8876789976decbfcbbbe364623c63652db8c0904";
const TOKEN = "0xbb6b4c9690ae95bd72c1d9d698ad7a1570291df5"; // MECHA

async function hoodTrades(token, limit = 80) {
  const r = await fetch(`https://hoodscan.co/swaps-api/trades?limit=${limit}&token=${token}`).catch(() => null);
  if (!r) return null;
  try { const j = await r.json(); return j?.items || null; } catch { return null; }
}

async function findRouterTx(token, side) {
  const items = await hoodTrades(token) || [];
  for (const it of items) {
    if ((it.side || "") !== side) continue;
    try {
      const t = await client.getTransaction({ hash: it.tx });
      if (t && (t.to || "").toLowerCase() === UR.toLowerCase()) {
        return { hash: it.tx, input: t.input, value: t.value };
      }
    } catch {}
  }
  return null;
}

// patch buy template: ganti token address di path[0], ganti deadline, value = amountIn baru
function patchBuyTemplate(rawHex, newToken, amountInWei, minOutTokens, deadline) {
  const d = execIf.decodeFunctionData("execute", rawHex);
  const [actions, params] = ac.decode(["bytes", "bytes[]"], d[1][0]);
  // param0 = (address recipient, path[], a, b)
  const p0 = ac.decode(["(address,(address,uint24,int24,address,bytes)[],uint128,uint128)"], params[0]);
  p0[0] = "0x0000000000000000000000000000000000000000";
  p0[1][0][0] = token;      // ganti token address di path
  p0[2] = amountIn;          // ETH wei masuk
  p0[3] = deadlineAmount;    // min token out (bantu; dgn urutan a/b kita tes)
  const newP0 = ac.encode(["(address,(address,uint24,int24,address,bytes)[],uint128,uint128)"], p0);
  // param2 = TAKE (token, recipient, amount) — ganti token + recipient 0xF6 (wallet lama) biar tetap
  const p2 = ac.decode(["address", "address", "uint256"], params[2]);
  p2[0] = token;
  const newP2 = ac.encode(["address", "address", "uint256"], p2);
  const newParams = [newP0, params[1], newP2];
  const newInput = ac.encode(["bytes", "bytes[]"], [actions, newParams]);
  return execIf.encodeFunctionData("execute", [d[0], [newInput], deadline]);
}

const data = fs.readFileSync("/root/robinhood-bot/ur_buys.txt", "utf8").trim().split("\n");
const buyTemplate = data[1];
const t = await findRouterTx(TOKEN, "buy");
console.log("MECHA buy router tx:", t ? t.hash : "NONE");
if (t) {
  // dump struktur asli tx MECHA biar bisa compare
  const d = execIf.decodeFunctionData("execute", t.input);
  console.log("commands:", Buffer.from(d[0].slice(2), "hex").toString("hex"));
  const [actions, params] = ac.decode(["bytes", "bytes[]"], d[1][0]);
  console.log("actions:", Buffer.from(actions.slice(2), "hex").toString("hex"), "params:", params.length);
  try {
    const v = ac.decode(["(address,(address,uint24,int24,address,bytes)[],uint128,uint128)"], params[0]);
    console.log("recipient:", v[0], "| path len:", v[1].length);
    v[1].forEach((pt, i) => console.log("  path", i, pt[0], "fee=" + Number(pt[1]), "tick=" + Number(pt[2]), "hooks=" + pt[3]));
    console.log("a:", v[2].toString(), "b:", v[3].toString());
  } catch (e) { console.log("param0 decode fail:", String(e.message).slice(0, 80)); }
  try {
    const v = ac.decode(["address", "address", "uint256"], params[2]);
    console.log("TAKE token:", v[0], "to:", v[1], "amt:", v[2].toString());
  } catch (e) { console.log("param2 decode fail:", String(e.message).slice(0, 60)); }
}

// eth_call test pakai template FEES yang di-patch → MECHA (nilai kecil)
const amountIn = BigInt("500000000000000"); // 0.0005 ETH ~ $1
const testData = patchBuyTemplate(buyTemplate, TOKEN, amountIn, 1n, BigInt(Math.floor(Date.now() / 1000) + 300));
const from = "0x0d20d494285939b748D631D82470E3e6523739bd";
try {
  const r = await client.call({ account: from, to: UR, data: testData, value: amountIn });
  console.log("\neth_call BUY patched MECHA: OK", r.slice(0, 20));
} catch (e) {
  console.log("\neth_call BUY patched MECHA: REVERT", String(e.message).slice(0, 300));
}
process.exit(0);