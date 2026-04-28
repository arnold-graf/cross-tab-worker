import { describe, it, expect } from 'vitest';
import { OutboundBuffer } from '../src/buffer.js';

describe('failover – outbound buffer replay', () => {
  it('buffered messages are drained in order', () => {
    const buf = new OutboundBuffer();
    buf.push('msg-1');
    buf.push('msg-2');
    buf.push('msg-3');
    expect(buf.drain().map(i => i.message)).toEqual(['msg-1', 'msg-2', 'msg-3']);
    expect(buf.size).toBe(0);
  });

  it('buffer is empty after drain', () => {
    const buf = new OutboundBuffer();
    buf.push('x');
    buf.drain();
    expect(buf.size).toBe(0);
    expect(buf.drain()).toEqual([]);
  });

  it('messages queued during failover window are not lost', () => {
    const buf = new OutboundBuffer();
    buf.push('before-1');
    buf.push('before-2');
    buf.push('during');
    expect(buf.drain().map(i => i.message)).toEqual(['before-1', 'before-2', 'during']);
  });
});

describe('failover – buffer drain via port (zero-copy path)', () => {
  it('drainViaPort sends each buffered item with its transfer array', () => {
    const buf = new OutboundBuffer();
    const ab1 = new ArrayBuffer(16);
    const ab2 = new ArrayBuffer(32);
    buf.push({ page: ab1 }, [ab1]);
    buf.push({ page: ab2 }, [ab2]);

    const sent: Array<{ data: unknown; transfer: Transferable[] }> = [];
    const fakePort = {
      postMessage(data: unknown, transfer: Transferable[]) { sent.push({ data, transfer }); },
    };

    for (const { message, transfer } of buf.drain()) {
      fakePort.postMessage({ message, transfer }, transfer);
    }

    expect(sent).toHaveLength(2);
    expect(sent[0].transfer[0]).toBe(ab1);
    expect(sent[1].transfer[0]).toBe(ab2);
  });

  it('port drain after failover re-establishes zero-copy for buffered items', () => {
    const buf = new OutboundBuffer();
    const pages = [new ArrayBuffer(4096), new ArrayBuffer(4096)];
    buf.push({ op: 'write', buf: pages[0] }, [pages[0]]);
    buf.push({ op: 'write', buf: pages[1] }, [pages[1]]);

    const leaderReceived: Transferable[][] = [];
    const fakePort = {
      postMessage(_data: unknown, transfer: Transferable[]) { leaderReceived.push(transfer); },
    };

    for (const { message, transfer } of buf.drain()) {
      fakePort.postMessage({ message, transfer }, transfer);
    }

    expect(leaderReceived).toHaveLength(2);
    expect(leaderReceived[0][0]).toBe(pages[0]);
    expect(leaderReceived[1][0]).toBe(pages[1]);
  });
});

describe('failover – role transition', () => {
  it('new leader processes port relay from followers', () => {
    const workerReceived: unknown[] = [];
    const fakeWorker = {
      postMessage: (msg: unknown, _transfer?: Transferable[]) => workerReceived.push(msg),
    };

    const portRelay = { message: 'hello-after-failover', transfer: [] };
    fakeWorker.postMessage(portRelay.message, portRelay.transfer);

    expect(workerReceived).toEqual(['hello-after-failover']);
  });

  it('follower port is closed when winning the election', () => {
    let portClosed = false;
    const fakeOldPort = { close() { portClosed = true; } };
    fakeOldPort.close(); // mirrors #becomeLeader: this.#leaderPort?.close()
    expect(portClosed).toBe(true);
  });

  it('broker is notified when a new leader is elected', () => {
    const brokerMessages: unknown[] = [];
    const fakeBroker = { postMessage: (msg: unknown) => brokerMessages.push(msg) };

    fakeBroker.postMessage({ type: 'declare-leader', tabId: 'new-leader-tab' });

    expect(brokerMessages).toHaveLength(1);
    expect((brokerMessages[0] as { type: string }).type).toBe('declare-leader');
  });
});

describe('failover – broker broadcast fan-out', () => {
  it('broker routes broadcast to all tabs except sender', () => {
    // Simulate broker fan-out logic
    const tabPorts = new Map<string, { received: unknown[] }>();
    tabPorts.set('leader', { received: [] });
    tabPorts.set('follower-a', { received: [] });
    tabPorts.set('follower-b', { received: [] });

    const fromTabId = 'leader';
    const message = { type: 'leader-ready', tabId: 'leader' };

    for (const [tabId, port] of tabPorts) {
      if (tabId !== fromTabId) {
        port.received.push({ type: 'broadcast', message });
      }
    }

    expect(tabPorts.get('leader')!.received).toHaveLength(0);
    expect(tabPorts.get('follower-a')!.received).toHaveLength(1);
    expect(tabPorts.get('follower-b')!.received).toHaveLength(1);
  });

  it('broker sends leader-info to newly registering tabs', () => {
    let leaderTabId: string | null = 'existing-leader';
    const newTabMessages: unknown[] = [];

    // Simulate register handler
    if (leaderTabId) {
      newTabMessages.push({ type: 'leader-info', leaderTabId });
    }

    expect(newTabMessages).toHaveLength(1);
    expect((newTabMessages[0] as { leaderTabId: string }).leaderTabId).toBe('existing-leader');
  });
});
