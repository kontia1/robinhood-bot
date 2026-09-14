/**
 * Dupe blocklist — anti-copycat token.
 *
 * Masalah: banyak token robinhood muncul dengan ticker+nama yang SAMA persis
 * (copycat / re-launch palsu). Bot cuma mau beli yang ASLI = yang PERTAMA
 * KALI muncul (address pertama yang daftar dengan kombinasi ticker|nama itu).
 * Sisanya (duplikat) di-skip selamanya.
 *
 * State disimpan ke file JSON (blocklist-dupe.json) biar ingat lintas restart.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DUPE_FILE = path.resolve(__dirname, "../../blocklist-dupe.json");

/**
 * map: "ticker|name-lowercase" -> { firstAddr, firstSeenAt }
 * firstAddr = address asli yang pertama kali daftar untuk kombinasi itu.
 */
interface DupeEntry {
  firstAddr: string;
  firstSeenAt: number;
}
type DupeMap = Record<string, DupeEntry>;

let cache: DupeMap | null = null;

function load(): DupeMap {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(DUPE_FILE, "utf8")) || {};
  } catch {
    cache = {};
  }
  return cache!;
}

function persist() {
  if (!cache) return;
  fs.writeFileSync(DUPE_FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

/** Normalize kombinasi ticker+nama jadi key stabil (case-insensitive, trim). */
export function dupeKey(symbol: string, name: string): string {
  const sym = String(symbol || "").trim().toLowerCase();
  const nm = String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
  return `${sym}|${nm}`;
}

/**
 * Cek + daftarkan token.
 * Return:
 *  - "original"  → pertama kali lihat kombinasi ini, atau address yang sama dengan firstAddr
 *  - "duplicate" → kombinasi ticker+nama sudah ada dengan address LAIN (copycat) — SKIP
 */
export function checkAndRegister(address: string, symbol: string, name: string): "original" | "duplicate" {
  const m = load();
  const key = dupeKey(symbol, name);
  if (!key || key === "|") return "original"; // data kosong — jangan blokir aneh-aneh
  const addr = address.toLowerCase();
  const entry = m[key];
  if (!entry) {
    m[key] = { firstAddr: addr, firstSeenAt: Date.now() };
    persist();
    return "original";
  }
  if (entry.firstAddr.toLowerCase() === addr) return "original";
  return "duplicate";
}

/** Hitung jumlah kombinasi yang terdaftar (buat status/UI). */
export function countDupeKeys(): number {
  return Object.keys(load()).length;
}

/** Bersihkan semua state (buat reset kalau salah daftar). */
export function resetDupe(): void {
  cache = {};
  persist();
}
