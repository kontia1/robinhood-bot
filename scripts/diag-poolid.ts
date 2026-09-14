/**
 * Reverse-engineer pool key robinhood V4 dari PoolId GMGN.
 * PoolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks)).
 */
import { AbiCoder, getAddress, keccak256 } from "ethers";

const ac = new AbiCoder();

const TARGET_POOL_ID = "0xc20dd7d5ff5df28c65186fa0487f598cf773c9ce5ddcc0cbb0d36bb580df6229";
const NVDA = getAddress("0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec");
const PLUMBER = getAddress("0x0758858405eb0fa18d80915134996f15f0ce6002");

const FEES = [0, 60, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000];
const TICKS = [1, 10, 20, 60, 120, 200, 500];
const HOOKS = [
  "0x0000000000000000000000000000000000000000",
  "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044",
];

function computeId(c0: string, c1: string, fee: number, tick: number, hook: string): string {
  const enc = ac.encode(
    ["address", "address", "uint24", "int24", "address"],
    [c0, c1, fee, tick, getAddress(hook)]
  );
  return keccak256(enc);
}

function main() {
  const target = TARGET_POOL_ID.toLowerCase();
  const [A, B] = NVDA.toLowerCase() < PLUMBER.toLowerCase() ? [NVDA, PLUMBER] : [PLUMBER, NVDA];
  console.log("target:", target);
  console.log(`pair: ${A} / ${B}`);
  let found = 0;
  for (const fee of FEES) {
    for (const tick of TICKS) {
      for (const hook of HOOKS) {
        const id = computeId(A, B, fee, tick, hook);
        if (id.toLowerCase() === target) {
          console.log(`>>> FOUND: fee=${fee} tickSpacing=${tick} hook=${hook}`);
          found++;
        }
      }
    }
  }
  if (!found) console.log("tidak ada yang match di kombinasi ini");
}

main();