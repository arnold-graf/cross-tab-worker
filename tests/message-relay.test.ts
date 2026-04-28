import { describe, it, expect } from 'vitest';
import { OutboundBuffer } from '../src/buffer.js';

describe('OutboundBuffer', () => {
  it('starts empty', () => {
    expect(new OutboundBuffer().size).toBe(0);
  });

  it('push increases size', () => {
    const buf = new OutboundBuffer();
    buf.push('hello');
    buf.push('world');
    expect(buf.size).toBe(2);
  });

  it('drain returns items in FIFO order and clears the buffer', () => {
    const buf = new OutboundBuffer();
    buf.push('first');
    buf.push('second');
    buf.push('third');
    expect(buf.drain().map(i => i.message)).toEqual(['first', 'second', 'third']);
    expect(buf.size).toBe(0);
  });

  it('drain returns empty array when buffer is empty', () => {
    expect(new OutboundBuffer().drain()).toEqual([]);
  });

  it('stores transfer array alongside message', () => {
    const buf = new OutboundBuffer();
    const ab = new ArrayBuffer(8);
    buf.push({ data: ab }, [ab]);
    const [item] = buf.drain();
    expect(item.transfer).toHaveLength(1);
    expect(item.transfer[0]).toBe(ab);
  });

  it('defaults transfer to empty array when not provided', () => {
    const buf = new OutboundBuffer();
    buf.push('no-transfer');
    const [item] = buf.drain();
    expect(item.transfer).toEqual([]);
  });

  it('multiple drains are independent', () => {
    const buf = new OutboundBuffer();
    buf.push('a');
    buf.drain();
    buf.push('b');
    expect(buf.drain().map(i => i.message)).toEqual(['b']);
  });
});

describe('port relay protocol', () => {
  it('port relay message carries message + transfer array', () => {
    const ab = new ArrayBuffer(16);
    const msg = { message: { buf: ab }, transfer: [ab] };
    expect(msg.transfer[0]).toBe(ab);
  });

  it('leader-ready carries tabId', () => {
    const msg = { type: 'leader-ready' as const, tabId: 'abc' };
    expect(msg.tabId).toBe('abc');
  });

  it('leader-info from broker carries leaderTabId', () => {
    const msg = { type: 'leader-info' as const, leaderTabId: 'tab-xyz' };
    expect(msg.leaderTabId).toBe('tab-xyz');
  });
});

describe('port relay zero-copy semantics', () => {
  it('buffer drains preserve the transfer array for port delivery', () => {
    const buf = new OutboundBuffer();
    const ab = new ArrayBuffer(64);
    buf.push({ page: ab }, [ab]);

    const sent: Array<{ message: unknown; transfer: Transferable[] }> = [];
    const fakePort = {
      postMessage(msg: unknown, transfer: Transferable[]) { sent.push({ message: msg, transfer }); },
    };

    for (const { message, transfer } of buf.drain()) {
      fakePort.postMessage({ message, transfer }, transfer);
    }

    expect(sent).toHaveLength(1);
    expect((sent[0].message as { transfer: Transferable[] }).transfer[0]).toBe(ab);
    expect(sent[0].transfer[0]).toBe(ab);
  });

  it('leader forwards port relay to worker preserving the transfer array', () => {
    const ab = new ArrayBuffer(32);
    const received: Array<{ message: unknown; transfer: Transferable[] }> = [];
    const fakeWorker = {
      postMessage(msg: unknown, transfer: Transferable[]) { received.push({ message: msg, transfer }); },
    };

    const portRelay = { message: { buf: ab }, transfer: [ab] };
    fakeWorker.postMessage(portRelay.message, portRelay.transfer);

    expect(received[0].transfer[0]).toBe(ab);
  });

  it('postMessage without transfer sends empty transfer array', () => {
    const received: Transferable[][] = [];
    const fakePort = {
      postMessage(_msg: unknown, transfer: Transferable[]) { received.push(transfer); },
    };
    const buf = new OutboundBuffer();
    buf.push('plain-message');
    for (const { message, transfer } of buf.drain()) {
      fakePort.postMessage({ message, transfer }, transfer);
    }
    expect(received[0]).toEqual([]);
  });
});
