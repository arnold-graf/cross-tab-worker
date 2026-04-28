export interface BufferedMessage {
  message: unknown;
  transfer: Transferable[];
}

export class OutboundBuffer {
  #pending: BufferedMessage[] = [];

  push(message: unknown, transfer: Transferable[] = []): void {
    this.#pending.push({ message, transfer });
  }

  drain(): BufferedMessage[] {
    const pending = this.#pending;
    this.#pending = [];
    return pending;
  }

  get size(): number {
    return this.#pending.length;
  }
}
