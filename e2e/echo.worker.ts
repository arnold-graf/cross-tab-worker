type DedicatedWorkerLikeScope = typeof globalThis & {
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
  onmessage: ((event: MessageEvent<any>) => void) | null;
};

const workerScope = self as unknown as DedicatedWorkerLikeScope;

async function writeBlob(path: string, bytes: Uint8Array): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const file = await root.getFileHandle(path, { create: true });
  const writable = await file.createWritable();
  const safeBuffer = new Uint8Array(bytes).buffer;
  await writable.write(safeBuffer);
  await writable.close();
}

async function readBlob(path: string): Promise<Uint8Array> {
  const root = await navigator.storage.getDirectory();
  const file = await root.getFileHandle(path, { create: false });
  const data = await (await file.getFile()).arrayBuffer();
  return new Uint8Array(data);
}

workerScope.onmessage = (event: MessageEvent<any>) => {
  const data = event.data;

  if (data?.kind === 'opfs-write') {
    void (async () => {
      try {
        const bytes = data.bytes instanceof Uint8Array ? data.bytes : new Uint8Array(data.bytes ?? []);
        await writeBlob(data.path, bytes);
        workerScope.postMessage({
          kind: 'opfs-write-ack',
          reqId: data.reqId ?? null,
          path: data.path ?? null,
          byteLength: bytes.byteLength,
        });
      } catch (error) {
        workerScope.postMessage({
          kind: 'opfs-error',
          reqId: data.reqId ?? null,
          path: data.path ?? null,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return;
  }

  if (data?.kind === 'opfs-read') {
    void (async () => {
      try {
        const bytes = await readBlob(data.path);
        workerScope.postMessage({
          kind: 'opfs-read-ack',
          reqId: data.reqId ?? null,
          path: data.path ?? null,
          bytes,
          byteLength: bytes.byteLength,
        });
      } catch (error) {
        workerScope.postMessage({
          kind: 'opfs-error',
          reqId: data.reqId ?? null,
          path: data.path ?? null,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return;
  }

  if (data?.kind === 'buffer') {
    const buf: ArrayBuffer | undefined = data.buf;
    const firstByte = buf && buf.byteLength > 0 ? new Uint8Array(buf)[0] : null;
    workerScope.postMessage({
      kind: 'buffer-ack',
      label: data.label ?? null,
      byteLength: buf?.byteLength ?? null,
      firstByte,
    });
    return;
  }

  if (data?.kind === 'buffer-echo') {
    // Directed zero-copy reply: if a relay port is present (message came from a follower),
    // transfer the buffer back via e.ports[0] instead of broadcasting via self.postMessage.
    const buf: ArrayBuffer | undefined = data.buf;
    const replyPort: MessagePort | undefined = event.ports[0];
    const byteLength = buf?.byteLength ?? 0;

    if (replyPort && buf) {
      // Send the buffer back zero-copy to the specific follower that requested it.
      replyPort.postMessage(
        { payload: { kind: 'buffer-echo-ack', label: data.label ?? null, byteLength }, transfer: [buf] },
        [buf],
      );
      // After the transfer above, buf is detached in this worker (byteLength === 0).
      // Broadcast this so the e2e test can verify the transfer actually happened.
      workerScope.postMessage({
        kind: 'worker-buffer-state',
        label: data.label ?? null,
        byteLengthAfterSend: buf.byteLength,
      });
    } else {
      // Leader-local call — no relay port, fall back to broadcast.
      workerScope.postMessage({ kind: 'buffer-echo-ack', label: data.label ?? null, byteLength });
    }
    return;
  }

  workerScope.postMessage({
    kind: 'ack',
    seq: data?.seq ?? null,
    payload: data?.payload ?? data ?? null,
  });
};
