import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface Wallet {
  address: string;
  privateKey: string;
  label: string;
  createdAt: string;
  isActive?: boolean;
}

const WALLET_FILE = process.env.WALLET_FILE
  ? path.resolve(process.env.WALLET_FILE)
  : path.resolve(__dirname, "../../wallet.json");

let cache: Wallet[] | null = null;

function loadWallets(): Wallet[] {
  if (cache) return cache;
  if (!fs.existsSync(WALLET_FILE)) {
    cache = [];
    return cache;
  }
  const raw = fs.readFileSync(WALLET_FILE, "utf8");
  const parsed = JSON.parse(raw);
  const arr: Wallet[] = (Array.isArray(parsed) ? parsed : [parsed]).map((w) => ({
    // normalisasi field lama (snake_case) ke bentuk baru biar aman
    address: w.address,
    privateKey: (w.privateKey ?? w.private_key ?? "").startsWith("0x") ? w.privateKey ?? w.private_key ?? "" : "0x" + (w.privateKey ?? w.private_key ?? ""),
    label: w.label ?? `0x${(w.address || "").slice(2, 6)}…`,
    createdAt: w.createdAt ?? w.created_at ?? "",
    isActive: w.isActive ?? false,
  }));
  const hasActive = arr.some((w) => w.isActive);
  if (arr.length && !hasActive) arr[0].isActive = true;
  cache = arr;
  return cache;
}

function persist(ws: Wallet[]): void {
  if (!fs.existsSync(path.dirname(WALLET_FILE))) {
    fs.mkdirSync(path.dirname(WALLET_FILE), { recursive: true });
  }
  fs.writeFileSync(WALLET_FILE, JSON.stringify(ws, null, 2), { mode: 0o600 });
  cache = ws;
}

export function getActiveWallet(): Wallet | null {
  const ws = loadWallets();
  return ws.find((w) => w.isActive) || ws[0] || null;
}

export function listWallets(): Wallet[] {
  return loadWallets();
}

export function walletCount(): number {
  return loadWallets().length;
}

export function shortLabel(address: string): string {
  return address.slice(0, 6) + "…" + address.slice(-4);
}

export function createWallet(label?: string): Wallet {
  const ws = loadWallets();
  const acct = generateEVMAccount();
  const wallet: Wallet = {
    address: acct.address,
    privateKey: acct.privateKey,
    label: label?.trim() || shortLabel(acct.address),
    createdAt: new Date().toISOString(),
    isActive: ws.length === 0,
  };
  ws.push(wallet);
  persist(ws);
  return wallet;
}

export function switchWallet(address: string): boolean {
  const ws = loadWallets();
  const found = ws.find((w) => w.address.toLowerCase() === address.toLowerCase());
  if (!found) return false;
  for (const w of ws) w.isActive = false;
  found.isActive = true;
  persist(ws);
  return true;
}

export function deleteWallet(address: string): { ok: boolean; error?: string } {
  const ws = loadWallets();
  if (ws.length <= 1) {
    return { ok: false, error: "Cannot delete the only wallet — at least 1 wallet required" };
  }
  const idx = ws.findIndex((w) => w.address.toLowerCase() === address.toLowerCase());
  if (idx === -1) return { ok: false, error: "Wallet not found" };
  const wasActive = ws[idx].isActive;
  ws.splice(idx, 1);
  if (wasActive && ws.length) ws[0].isActive = true; // promote next wallet
  persist(ws);
  return { ok: true };
}

export function generateEVMAccount(): { address: string; privateKey: string } {
  const privateKey = "0x" + crypto.randomBytes(32).toString("hex");
  const acct = privateKeyToAccount(privateKey as `0x${string}`);
  return { address: acct.address, privateKey };
}

export function getWalletFilePath(): string {
  return WALLET_FILE;
}