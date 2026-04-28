/**
 * Minimal BroadcastChannel stub that routes messages synchronously within a test.
 */
export class FakeBroadcastChannel {
  static channels = new Map<string, Set<FakeBroadcastChannel>>();

  private _closed = false;
  onmessage: ((e: MessageEvent) => void) | null = null;

  constructor(public readonly name: string) {
    if (!FakeBroadcastChannel.channels.has(name)) {
      FakeBroadcastChannel.channels.set(name, new Set());
    }
    FakeBroadcastChannel.channels.get(name)!.add(this);
  }

  postMessage(data: unknown): void {
    if (this._closed) return;
    for (const ch of FakeBroadcastChannel.channels.get(this.name) ?? []) {
      if (ch !== this && !ch._closed && ch.onmessage) {
        ch.onmessage(new MessageEvent('message', { data }));
      }
    }
  }

  close(): void {
    this._closed = true;
    FakeBroadcastChannel.channels.get(this.name)?.delete(this);
  }

  static reset(): void {
    FakeBroadcastChannel.channels.clear();
  }
}

/** Minimal Worker stub */
export class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;
  received: unknown[] = [];
  terminated = false;

  postMessage(message: unknown): void {
    this.received.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Simulate a message coming from the worker back to the app */
  emit(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }
}

/** Fake lock state shared across all FakeLockManager instances */
let _lockHolder = false;
let _lockQueue: Array<(lock: Lock | null) => Promise<void>> = [];

export function resetLocks(): void {
  _lockHolder = false;
  _lockQueue = [];
}

export class FakeLockManager implements LockManager {
  query(): Promise<LockManagerSnapshot> {
    return Promise.resolve({ held: [], pending: [] });
  }

  request<T>(
    name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback<T>,
    maybeCallback?: LockGrantedCallback<T>,
  ): Promise<T> {
    const options: LockOptions = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const callback: LockGrantedCallback<T> =
      typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!;

    if (options.ifAvailable) {
      if (_lockHolder) {
        // Lock is held — pass null immediately
        return Promise.resolve(callback(null));
      }
      // Acquire immediately
      return new Promise<T>((resolve, reject) => {
        _lockHolder = true;
        const fakeLock = { name, mode: 'exclusive' } as Lock;
        Promise.resolve(callback(fakeLock)).then((value) => {
          _lockHolder = false;
          resolve(value);
          // Grant to next in queue if any
          const next = _lockQueue.shift();
          if (next) {
            _lockHolder = true;
            next(fakeLock).then(() => { _lockHolder = false; });
          }
        }).catch(reject);
      });
    }

    // Blocking request — queue if held
    if (_lockHolder) {
      return new Promise<T>((resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new DOMException('Lock request was aborted', 'AbortError'));
          return;
        }
        const onAbort = () => {
          const index = _lockQueue.indexOf(entry);
          if (index !== -1) _lockQueue.splice(index, 1);
          reject(new DOMException('Lock request was aborted', 'AbortError'));
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });
        const entry = async (lock: Lock | null) => {
          options.signal?.removeEventListener('abort', onAbort);
          try {
            const value = await callback(lock);
            resolve(value);
          } catch (error) {
            reject(error);
          }
        };
        _lockQueue.push(entry);
      });
    }

    // Acquire immediately
    return new Promise<T>((resolve, reject) => {
      _lockHolder = true;
      const fakeLock = { name, mode: 'exclusive' } as Lock;
      Promise.resolve(callback(fakeLock)).then((value) => {
        _lockHolder = false;
        resolve(value);
        const next = _lockQueue.shift();
        if (next) {
          _lockHolder = true;
          next(fakeLock).then(() => { _lockHolder = false; });
        }
      }).catch(reject);
    });
  }
}
