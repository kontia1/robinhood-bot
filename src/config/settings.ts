import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_FILE = process.env.SETTINGS_FILE
  ? path.resolve(process.env.SETTINGS_FILE)
  : path.resolve(__dirname, "../../settings.json");

export interface Filters {
  minLiquidityUsd: number;
  minVolumeUsd: number;
  minBuyPressurePct: number; // 0-100
  maxTop10HolderPct: number; // 0-100
}

export interface AutoSettings {
  enabled: boolean;
  minScore: number;
  positionSizeUsd: number;
  stopLossPct: number; // negative, e.g. -15
  takeProfitPct: number; // e.g. 30
  trailingStopPct: number; // e.g. 10
  maxPositions: number;
}

export interface Settings {
  mode: "dry-run" | "live";
  scanIntervalSec: number;
  auto: AutoSettings;
  filters: Filters;
}

const DEFAULTS: Settings = {
  mode: "dry-run",
  scanIntervalSec: 60,
  auto: {
    enabled: true,
    minScore: 75,
    positionSizeUsd: 100,
    stopLossPct: -15,
    takeProfitPct: 30,
    trailingStopPct: 10,
    maxPositions: 3,
  },
  filters: {
    minLiquidityUsd: 10_000,
    minVolumeUsd: 5_000,
    minBuyPressurePct: 60,
    maxTop10HolderPct: 50,
  },
};

// Numeric keys get clamped to a sane range
const RANGES: Record<string, [number, number]> = {
  "scanIntervalSec": [5, 3600],
  "auto.minScore": [0, 100],
  "auto.positionSizeUsd": [1, 100_000],
  "auto.stopLossPct": [-100, 0],
  "auto.takeProfitPct": [0, 1000],
  "auto.trailingStopPct": [0, 100],
  "auto.maxPositions": [1, 50],
  "filters.minLiquidityUsd": [0, 100_000_000],
  "filters.minVolumeUsd": [0, 100_000_000],
  "filters.minBuyPressurePct": [0, 100],
  "filters.maxTop10HolderPct": [0, 100],
};

// shallow-merge nested defaults so new fields appear after upgrades
function deepMerge(base: any, patch: any): any {
  if (!patch) return base;
  if (Array.isArray(base) || Array.isArray(patch)) return patch;
  if (typeof base === "object" && base !== null && typeof patch === "object" && patch !== null) {
    const out: any = { ...base };
    for (const k of Object.keys(patch)) out[k] = deepMerge(base[k], patch[k]);
    return out;
  }
  return patch;
}

let cache: Settings | null = null;

/** Force reload from disk (used after external edit). */
export function reloadSettings(): Settings {
  cache = null;
  return loadSettings();
}

export function loadSettings(): Settings {
  if (cache) return cache;
  let json: any = {};
  try {
    if (fs.existsSync(SETTINGS_FILE)) json = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch (e) {
    console.warn("[settings] parse error, using defaults: ", (e as Error).message);
    json = {};
  }
  cache = deepMerge(DEFAULTS, json) as Settings;
  return cache as Settings;
}

export function saveSettings(s: Settings = loadSettings()): void {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
  cache = s;
}

/** Update a dotted-path key (e.g. "auto.minScore") with validation. */
export function updateSetting(
  key: string,
  rawValue: string
): { ok: true; settings: Settings } | { ok: false; error: string } {
  const s = loadSettings();
  const parts = key.split(".");
  let target: any = s;
  for (let i = 0; i < parts.length - 1; i++) {
    if (target[parts[i]] == null) return { ok: false, error: `Path invalid: ${key}` };
    target = target[parts[i]];
  }
  const leaf = parts[parts.length - 1];
  const current = target[leaf];
  let next: unknown;
  if (typeof current === "number") {
    const n = Number(rawValue);
    if (Number.isNaN(n)) return { ok: false, error: "Harus angka" };
    next = n;
    const range = RANGES[key];
    if (range && (n < range[0] || n > range[1])) {
      return { ok: false, error: `Di luar range ${range[0]}–${range[1]}` };
    }
  } else if (typeof current === "boolean") {
    const v = rawValue.trim().toLowerCase();
    if (!["true", "false", "1", "0", "on", "off"].includes(v)) return { ok: false, error: "Harus true/false" };
    next = ["true", "1", "on"].includes(v);
  } else {
    next = rawValue.trim();
  }
  target[leaf] = next;
  saveSettings(s);
  return { ok: true, settings: s };
}

export function settingsFile(): string {
  return SETTINGS_FILE;
}

export function settingsSummary(): string {
  const s = loadSettings();
  return [
    `Mode: ${s.mode}`,
    `Scan: ${s.scanIntervalSec}s`,
    `Auto: ${s.auto.enabled ? "ON" : "OFF"} | minScore ${s.auto.minScore} | size $${s.auto.positionSizeUsd}`,
    `SL ${s.auto.stopLossPct}% | TP +${s.auto.takeProfitPct}% | Trailing ${s.auto.trailingStopPct}% | maxPos ${s.auto.maxPositions}`,
    `Filters: liq $${s.filters.minLiquidityUsd} | vol $${s.filters.minVolumeUsd} | buy ${s.filters.minBuyPressurePct}% | top10 ${s.filters.maxTop10HolderPct}%`,
  ].join("\n");
}