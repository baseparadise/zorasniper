import { EventEmitter } from "events";

export interface BotState {
  running: boolean;
  startedAt: Date | null;
  totalTrades: number;
  snipedToday: number;
  walletAddress: string | null;
  walletBalanceEth: string | null;
  lastEventAt: string | null;
  network: string;
}

class BotStateManager extends EventEmitter {
  private _state: BotState = {
    running: false,
    startedAt: null,
    totalTrades: 0,
    snipedToday: 0,
    walletAddress: null,
    walletBalanceEth: null,
    lastEventAt: null,
    network: "base",
  };

  get(): BotState {
    return { ...this._state };
  }

  update(patch: Partial<BotState>): void {
    this._state = { ...this._state, ...patch };
    this.emit("update", this._state);
  }

  getUptimeSeconds(): number {
    if (!this._state.startedAt) return 0;
    return Math.floor((Date.now() - this._state.startedAt.getTime()) / 1000);
  }
}

export const botState = new BotStateManager();
