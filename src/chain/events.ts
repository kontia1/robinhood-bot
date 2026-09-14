/**
 * Event ingestor — WebSocket subscription ke Robinhood Chain (Alchemy).
 * Subscribe newHeads → trigger scan engine real-time (event-driven discovery),
 * bukan polling buta tiap interval. Kalau WS drop → fallback polling tetap jalan.
 */
import { createPublicClient, webSocket, http, type PublicClient } from "viem";

export interface BlockEvent {
  number: bigint;
  hash: `0x${string}`;
  timestamp: bigint;
}

export interface EventIngestorOptions {
  rpcHttpUrl: string;
  rpcWsUrl?: string;
  onBlock?: (block: BlockEvent) => void;
  onError?: (err: Error) => void;
}

export class EventIngestor {
  private client: PublicClient | null = null;
  private unsub: (() => void) | null = null;
  private wsUrl = "";
  private stopped = false;
  private lastBlock: BlockEvent | null = null;
  private opts: EventIngestorOptions;

  constructor(opts: EventIngestorOptions) {
    this.opts = opts;
    // Derive WS URL: prefer explicit RPC_WS_URL, else https→wss on same Alchemy key
    if (opts.rpcWsUrl) {
      this.wsUrl = opts.rpcWsUrl;
    } else if (opts.rpcHttpUrl) {
      this.wsUrl = opts.rpcHttpUrl.replace(/^https/, "wss");
    }
  }

  get connected(): boolean {
    return this.client !== null;
  }

  get lastBlockNumber(): bigint | null {
    return this.lastBlock?.number ?? null;
  }

  async start(): Promise<boolean> {
    if (!this.wsUrl) {
      console.log("[events] no RPC URL — WebSocket ingestor disabled");
      return false;
    }
    try {
      this.client = createPublicClient({
        transport: webSocket(this.wsUrl, {
          reconnect: true,
          retryCount: 30,
          retryDelay: 2000,
        }),
      });
      this.unsub = await this.client.watchBlocks({
        onBlock: (block) => {
          if (!block || block.number == null) return; // guard: kadang block undefined di awal sub
          const ev: BlockEvent = {
            number: block.number,
            hash: block.hash,
            timestamp: BigInt(block.timestamp),
          };
          this.lastBlock = ev;
          try {
            this.opts.onBlock?.(ev);
          } catch (e: any) {
            console.log("[events] onBlock handler error:", e?.message || e);
          }
        },
      });
      console.log(`[events] WebSocket connected: ${this.wsUrl.replace(/\/v2\/.*/, "/v2/…")}`);
      return true;
    } catch (e: any) {
      console.log("[events] WebSocket start failed:", e?.message || String(e));
      this.opts.onError?.(e as Error);
      this.client = null;
      return false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.unsub) {
      try {
        this.unsub();
      } catch { /* noop */ }
      this.unsub = null;
    }
    if (this.client) {
      try {
        (this.client as any)?.destroy?.();
      } catch { /* noop */ }
      this.client = null;
    }
  }

  /** getLatestBlockNumber — fallback read via HTTP (no subscription needed). */
  async getLatestBlockNumber(): Promise<bigint | null> {
    if (!this.opts.rpcHttpUrl) return null;
    try {
      const client = createPublicClient({ transport: http(this.opts.rpcHttpUrl) });
      return await client.getBlockNumber();
    } catch (e: any) {
      console.log("[events] getBlockNumber failed:", e?.message || String(e));
      return null;
    }
  }
}