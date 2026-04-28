import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CrossTabWorker } from '../src/CrossTabWorker.js';
import { FakeBroadcastChannel, FakeLockManager, resetLocks } from './helpers.js';

// Local FakeWorker that also captures MessagePort objects from each postMessage call.
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;
  received: unknown[] = [];
  receivedPorts: MessagePort[][] = [];
  terminated = false;

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.received.push(message);
    // Extract any MessagePort objects the library injected into the transfer array.
    const ports = (transfer ?? []).filter(
      (t): t is MessagePort => typeof (t as FakeMessagePort).setPeer === 'function',
    );
    this.receivedPorts.push(ports);
  }

  terminate(): void { this.terminated = true; }
}

class FakeMessagePort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  private _peer: FakeMessagePort | null = null;
  private _closed = false;

  setPeer(peer: FakeMessagePort): void {
    this._peer = peer;
  }

  start(): void {}

  close(): void {
    this._closed = true;
  }

  postMessage(data: unknown, transfer: Transferable[] = []): void {
    if (this._closed || !this._peer) return;
    const ports = transfer.filter((t): t is MessagePort => t instanceof FakeMessagePort);
    this._peer.onmessage?.({ data, ports } as unknown as MessageEvent);
  }
}

class FakeMessageChannel {
  readonly port1: MessagePort;
  readonly port2: MessagePort;

  constructor() {
    const p1 = new FakeMessagePort();
    const p2 = new FakeMessagePort();
    p1.setPeer(p2);
    p2.setPeer(p1);
    this.port1 = p1 as unknown as MessagePort;
    this.port2 = p2 as unknown as MessagePort;
  }
}

class FakeBroker {
  private readonly _tabPorts = new Map<string, MessagePort>();
  private _leaderTabId: string | null = null;

  connect(clientPort: MessagePort): void {
    const brokerPort = new FakeMessagePort() as unknown as MessagePort;
    (clientPort as unknown as FakeMessagePort).setPeer(brokerPort as unknown as FakeMessagePort);
    (brokerPort as unknown as FakeMessagePort).setPeer(clientPort as unknown as FakeMessagePort);

    brokerPort.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as {
        type: 'register' | 'unregister' | 'declare-leader' | 'forward-port' | 'broadcast';
        tabId?: string;
        toTabId?: string;
        fromTabId?: string;
        message?: unknown;
      };

      if (msg.type === 'register') {
        this._tabPorts.set(msg.tabId!, brokerPort);
        if (this._leaderTabId) {
          // Inform this new tab of the existing leader immediately.
          brokerPort.postMessage({ type: 'leader-info', leaderTabId: this._leaderTabId });
        }
        return;
      }

      if (msg.type === 'unregister') {
        this._tabPorts.delete(msg.tabId!);
        if (this._leaderTabId === msg.tabId) this._leaderTabId = null;
        return;
      }

      if (msg.type === 'declare-leader') {
        this._leaderTabId = msg.tabId!;
        return;
      }

      if (msg.type === 'forward-port') {
        const target = this._tabPorts.get(msg.toTabId!);
        const relayPort = ev.ports[0];
        if (!target || !relayPort) return;
        target.postMessage({ type: 'incoming-port', fromTabId: msg.fromTabId }, [relayPort]);
        return;
      }

      if (msg.type === 'broadcast') {
        // Fan out to every tab except the sender.
        for (const [, p] of this._tabPorts) {
          if (p !== brokerPort) {
            p.postMessage({ type: 'broadcast', message: msg.message });
          }
        }
      }
    };
  }
}

let broker = new FakeBroker();

class FakeSharedWorker {
  readonly port: MessagePort;

  constructor(_url: URL, _options: { type: 'module'; name: string }) {
    this.port = new FakeMessagePort() as unknown as MessagePort;
    broker.connect(this.port);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('SharedWorker relay zero-copy path', () => {
  beforeEach(() => {
    broker = new FakeBroker();
    resetLocks();
    FakeBroadcastChannel.reset();
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    vi.stubGlobal('SharedWorker', FakeSharedWorker);
    vi.stubGlobal('MessageChannel', FakeMessageChannel);
    vi.stubGlobal('navigator', { locks: new FakeLockManager() });
    vi.stubGlobal('addEventListener', () => {});
    vi.stubGlobal('removeEventListener', () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('follower transfers ArrayBuffer to leader worker through direct port', async () => {
    const workers: FakeWorker[] = [];
    const factory = () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    };

    const leader = new CrossTabWorker('zero-copy-shared-worker', factory);
    const follower = new CrossTabWorker('zero-copy-shared-worker', factory);

    await waitFor(() => workers.length === 1);
    await waitFor(() => follower.hasLeaderPort);

    const payload = new ArrayBuffer(128);
    follower.postMessage({ op: 'write', payload }, [payload]);

    await waitFor(() => workers[0].received.length === 1);
    const received = workers[0].received[0] as { op: string; payload: ArrayBuffer };
    expect(received.op).toBe('write');
    expect(received.payload).toBe(payload);

    leader.destroy();
  });

  it('worker directed reply reaches follower zero-copy via direct port', async () => {
    const workers: FakeWorker[] = [];
    const factory = () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    };

    const leader = new CrossTabWorker('directed-reply', factory);
    const follower = new CrossTabWorker('directed-reply', factory);

    await waitFor(() => workers.length === 1);
    await waitFor(() => follower.hasLeaderPort);

    const followerMessages: unknown[] = [];
    follower.onmessage = (e) => followerMessages.push(e.data);

    // Follower sends a request. The library attaches a reply port to the
    // transfer array, so workers[0].receivedPorts[0][0] is the reply port.
    const requestBuf = new ArrayBuffer(64);
    follower.postMessage({ op: 'read', buf: requestBuf }, [requestBuf]);

    await waitFor(() => workers[0].received.length === 1);

    const replyPort = workers[0].receivedPorts[0][0] as unknown as FakeMessagePort;
    expect(replyPort).toBeTruthy();

    // Worker sends a directed reply: { payload, transfer } envelope — zero-copy path.
    const responseBuf = new ArrayBuffer(256);
    replyPort.postMessage(
      { payload: { result: responseBuf }, transfer: [responseBuf] },
      [responseBuf],
    );

    await waitFor(() => followerMessages.length === 1);

    const msg = followerMessages[0] as { result: ArrayBuffer };
    // Follower received the exact same buffer object — zero-copy (in a real browser
    // it would be transferred; in the fake it's the same reference).
    expect(msg.result).toBe(responseBuf);

    // Leader tab itself also dispatches via its own worker.onmessage only if the
    // worker called self.postMessage — it didn't, so no double-delivery.
    const leaderMessages: unknown[] = [];
    leader.onmessage = (e) => leaderMessages.push(e.data);
    expect(leaderMessages.length).toBe(0);

    leader.destroy();
  });
});
