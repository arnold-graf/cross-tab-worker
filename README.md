# cross-tab-worker

A drop-in coordination wrapper that keeps exactly one Worker alive across all same-origin browser tabs.

Exactly one tab owns the real Worker at a time (the **leader**). All other tabs (**followers**) send messages through a direct `MessagePort` to the leader, which forwards them to the worker. When the leader tab closes, one follower is automatically elected as the new leader. The application sees the same `postMessage` / `onmessage` interface regardless of role.

---

## Why not SharedWorker?

`SharedWorker` doesn't support `FileSystemSyncAccessHandle` — the synchronous OPFS API that high-performance SQLite/WASM VFS implementations require. This library achieves the same multi-tab sharing using a regular dedicated Worker owned by one tab, with coordination through Web Locks and a tiny broker SharedWorker.

---

## Usage

```ts
import { CrossTabWorker } from '@arnoldgraf/cross-tab-worker';

const worker = new CrossTabWorker(
  'my-db-worker',                              // stable name — used as the lock key
  () => new Worker(new URL('./db.worker.ts', import.meta.url), { type: 'module' }),
);

worker.onmessage = (e) => console.log('from worker:', e.data);

// Zero-copy if this tab is the leader; relayed through a direct MessagePort if follower.
const buffer = new ArrayBuffer(4096);
worker.postMessage({ op: 'write', buf: buffer }, [buffer]);
```

---

## API

```ts
new CrossTabWorker(name, factory)
```

| Parameter | Type | Description |
| --- | --- | --- |
| `name` | `string` | Unique identifier for this worker type. Used as the Web Lock key and SharedWorker name. Must be stable across page loads. |
| `factory` | `() => Worker` | Called only in the leader tab to instantiate the real Worker. |

### Instance

| Member | Description |
| --- | --- |
| `postMessage(message, transfer?)` | Send a message to the worker. Zero-copy in the leader; transferred via a direct `MessagePort` in followers. |
| `onmessage` | Callback for messages from the worker. |
| `onmessageerror` | Callback for deserialization errors. |
| `addEventListener(type, handler)` | `'message'` or `'messageerror'`. |
| `removeEventListener(type, handler)` | |
| `destroy()` | Leader: terminates the underlying Worker and releases the lock. Follower: closes ports and cancels the queued lock request. Safe to call in either role. |
| `isLeader` | `boolean` getter — true if this tab currently owns the Worker. |

---

## Architecture

```text
Tab A (leader)                    Tab B (follower)
┌────────────────────────────┐    ┌────────────────────────────┐
│  CrossTabWorker            │    │  CrossTabWorker            │
│  ┌──────────┐              │    │  ┌──────────┐              │
│  │  Worker  │◄─────────────┼────┼──│ port1    │ postMessage  │
│  └──────────┘  port2       │    │  └──────────┘  (zero-copy) │
│       │        (relay)     │    └────────────────────────────┘
│       │                    │
│  worker-msg ───────────────┼──► all followers via broker fan-out
└────────────────────────────┘

         ┌─────────────────────────────┐
         │  port-broker SharedWorker   │
         │  - tab registry             │
         │  - leader tracking          │
         │  - port forwarding          │
         │  - coordination fan-out     │
         └─────────────────────────────┘
```

### No BroadcastChannel, no heartbeat

Leader death detection is handled entirely by the Web Locks API — when a leader tab closes or calls `destroy()`, the browser automatically releases the lock and wakes up the next follower. No periodic heartbeat is needed.

All other coordination — `leader-ready` and `worker-msg` — travels through the broker SharedWorker, which fans messages out to all registered tab ports. No `BroadcastChannel` is used anywhere.

### Data path (zero-copy)

When a follower calls `postMessage(msg, [transfer])`:

1. The message and its transfer list travel through the follower's direct `MessagePort` to the leader.
2. Transferable objects (`ArrayBuffer`, etc.) are **transferred** (ownership moves) — no copy.
3. The leader forwards them to the Worker with `worker.postMessage(msg, transfer)` — no copy again.

Two ownership transfers, zero copies.

### Directed zero-copy responses

For bulk response data (e.g. query results), the worker can reply zero-copy to the specific tab that sent the request using the reply port attached to every relayed message:

```ts
// Inside the worker
self.onmessage = (e) => {
  const replyPort = e.ports[0]; // present when the message came from a follower tab
  const result = new ArrayBuffer(1024 * 1024);
  // ... fill result ...

  if (replyPort) {
    // Zero-copy: result is transferred directly to the requesting tab.
    replyPort.postMessage({ payload: { result }, transfer: [result] }, [result]);
  } else {
    // Broadcast fallback for leader-local callers (no relay port).
    self.postMessage({ result });
  }
};
```

The library unwraps the `{ payload, transfer }` envelope and delivers `payload` directly to the follower's `onmessage` — no structured clone, no broadcast to other tabs.

When a message originates from the **leader tab itself**, `e.ports[0]` is absent (the leader posts directly to the worker without a relay). The `self.postMessage(result)` fallback handles that case and broadcasts to all tabs via the broker fan-out path.

### Port handshake

On startup (or after failover), each follower:

1. Creates a `MessageChannel`, keeps `port1` for sending.
2. Sends `port2` to the broker, which forwards it to the leader tab.
3. The leader holds `port2` and listens for relay messages on it.

All subsequent data flows directly through the `MessageChannel` — the broker is not involved after the handshake.

### Late-joining tabs

A tab that opens after the leader is established receives a `leader-info` message from the broker immediately on registration, so it can connect to the leader right away.

### Failover sequence

1. Leader tab closes → browser releases the Web Lock automatically.
2. Every follower is already blocking on `navigator.locks.request` — exactly one wakes up and wins.
3. Winner calls `factory()`, broadcasts `leader-ready`, drains its outbound buffer.
4. Other followers receive `leader-ready` and re-establish direct ports to the new leader.
5. Messages in-flight when the old leader closed are lost. Applications that require exactly-once delivery must implement their own sequence numbers.

---

## Requirements

| API | Required |
| --- | --- |
| Web Locks (`navigator.locks`) | ✅ |
| SharedWorker | ✅ |
| MessageChannel / MessagePort | ✅ |

Throws a clear error on construction if either Web Locks or SharedWorker is unavailable.

---

## Response delivery modes

| Scenario | Path | Copy? |
| --- | --- | --- |
| Worker → leader tab | Direct `onmessage` | Zero-copy (no transfer needed) |
| Worker → all tabs (broadcast) | Broker fan-out via `worker-msg` | Structured clone |
| Worker → specific follower (directed reply) | `e.ports[0]` reply port | Zero-copy |

Use the directed reply pattern for bulk response payloads. Use `self.postMessage(data)` (broadcast) for notifications or results that every tab needs to receive.

---

## File structure

```text
cross-tab-worker/
  src/
    CrossTabWorker.ts         # main class — leader/follower state machine
    port-broker.worker.ts     # SharedWorker — tab registry, port brokering, fan-out
    protocol.ts               # message type definitions and type guards
    buffer.ts                 # OutboundBuffer — queues messages during leader absence
    ids.ts                    # tabId generation
  tests/
    leader-election.test.ts
    failover.test.ts
    message-relay.test.ts
    shared-worker-zero-copy.test.ts
  index.ts
  package.json
  tsconfig.json
```
