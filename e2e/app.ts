import { CrossTabWorker } from '../src/CrossTabWorker';

type HarnessState = {
  worker: CrossTabWorker;
  messages: unknown[];
};

const states = new Map<string, HarnessState>();
let nextId = 1;

function getState(id: string): HarnessState {
  const state = states.get(id);
  if (!state) throw new Error(`Unknown worker id: ${id}`);
  return state;
}

function makeWorker(): Worker {
  return new Worker(new URL('./echo.worker.ts', import.meta.url), { type: 'module' });
}

const harness = {
  create(name: string): string {
    const id = `w-${nextId++}`;
    const worker = new CrossTabWorker(name, makeWorker);
    const messages: unknown[] = [];
    worker.onmessage = (event: MessageEvent) => messages.push(event.data);
    states.set(id, { worker, messages });
    return id;
  },

  isLeader(id: string): boolean {
    return getState(id).worker.isLeader;
  },

  hasLeaderPort(id: string): boolean {
    return getState(id).worker.hasLeaderPort;
  },

  post(id: string, payload: unknown): void {
    getState(id).worker.postMessage(payload);
  },

  postBufferDirected(id: string, size: number, label: string): { before: number; after: number } {
    const buf = new ArrayBuffer(size);
    if (size > 0) new Uint8Array(buf)[0] = 7;
    const before = buf.byteLength;
    getState(id).worker.postMessage({ kind: 'buffer-echo', label, buf }, [buf]);
    return { before, after: buf.byteLength };
  },

  postBuffer(id: string, size: number, label: string): { before: number; after: number } {
    const buf = new ArrayBuffer(size);
    if (size > 0) new Uint8Array(buf)[0] = 7;
    const before = buf.byteLength;
    getState(id).worker.postMessage({ kind: 'buffer', label, buf }, [buf]);
    return { before, after: buf.byteLength };
  },

  getMessages(id: string): unknown[] {
    return [...getState(id).messages];
  },

  clearMessages(id: string): void {
    getState(id).messages.length = 0;
  },

  destroy(id: string): void {
    const state = states.get(id);
    if (!state) return;
    state.worker.destroy();
    states.delete(id);
  },
};

Object.assign(window, { __ctwHarness: harness });

declare global {
  interface Window {
    __ctwHarness: typeof harness;
  }
}
