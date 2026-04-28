// ── Coordination messages (travel via broker broadcast) ───────────────────────

export type LeaderReadyMessage = { type: 'leader-ready'; tabId: string };
export type WorkerMessage      = { type: 'worker-msg';       message: unknown };
export type WorkerMessageError = { type: 'worker-msg-error'; message: unknown };

export type CoordinationMessage =
  | LeaderReadyMessage
  | WorkerMessage
  | WorkerMessageError;

export function isLeaderReady(m: CoordinationMessage): m is LeaderReadyMessage {
  return m.type === 'leader-ready';
}
export function isWorkerMessage(m: CoordinationMessage): m is WorkerMessage {
  return m.type === 'worker-msg';
}
export function isWorkerMessageError(m: CoordinationMessage): m is WorkerMessageError {
  return m.type === 'worker-msg-error';
}

// ── Broker → tab messages ─────────────────────────────────────────────────────

export type BrokerIncomingPortMessage = { type: 'incoming-port'; fromTabId: string };
export type BrokerLeaderInfoMessage   = { type: 'leader-info';   leaderTabId: string };
export type BrokerBroadcastMessage    = { type: 'broadcast';     message: CoordinationMessage };

export type BrokerMessage =
  | BrokerIncomingPortMessage
  | BrokerLeaderInfoMessage
  | BrokerBroadcastMessage;

// ── Port relay (follower → leader, via direct MessagePort) ────────────────────

/** Payload sent over the direct follower→leader MessagePort. */
export type RelayMessage = { message: unknown; transfer: Transferable[] };

// ── Directed reply (worker → leader → specific follower, zero-copy) ───────────

/**
 * When a worker wants to reply zero-copy to the specific follower that sent a
 * request, it posts this envelope to the reply port it received in e.ports[0]:
 *
 *   self.onmessage = (e) => {
 *     const replyPort = e.ports[0];      // present on relayed messages
 *     const result = new ArrayBuffer(…);
 *     if (replyPort) {
 *       replyPort.postMessage({ payload: result, transfer: [result] }, [result]);
 *     } else {
 *       self.postMessage(result);         // broadcast fallback
 *     }
 *   };
 *
 * The library unwraps `payload` and re-transfers `transfer` to the follower,
 * so the follower's onmessage receives `payload` directly — not the envelope.
 */
export type DirectedReplyMessage = { payload: unknown; transfer: Transferable[] };
