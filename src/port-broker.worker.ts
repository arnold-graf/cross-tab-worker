/**
 * Port-broker SharedWorker.
 *
 * Responsibilities:
 *  1. Maintain a registry of tab ports (tabId → MessagePort).
 *  2. Forward a MessagePort from one tab to another (used for follower→leader direct channels).
 *  3. Broadcast coordination messages (leader-ready, worker-msg) from the leader
 *     to all other registered tabs.
 *  4. Track the current leader tabId and inform newly-registering tabs immediately.
 *
 * It is never involved in actual worker calls or OPFS data.
 *
 * Tab → Broker messages:
 *   { type: 'register',       tabId }
 *   { type: 'unregister',     tabId }
 *   { type: 'declare-leader', tabId }
 *   { type: 'forward-port',   toTabId, fromTabId }   + port in transfer
 *   { type: 'broadcast',      fromTabId, message }
 *
 * Broker → Tab messages:
 *   { type: 'incoming-port',  fromTabId }             + port in transfer
 *   { type: 'leader-info',    leaderTabId }           (sent on register if leader is known)
 *   { type: 'broadcast',      message }               (coordination fan-out)
 */

interface RegisterMessage      { type: 'register';       tabId: string; channelId: string }
interface UnregisterMessage    { type: 'unregister';     tabId: string; channelId: string }
interface DeclareLeaderMessage { type: 'declare-leader'; tabId: string; channelId: string }
interface ForwardPortMessage   { type: 'forward-port';   toTabId: string; fromTabId: string; channelId: string }
interface BroadcastMessage     { type: 'broadcast';      fromTabId: string; channelId: string; message: unknown }
type IncomingMessage =
  | RegisterMessage
  | UnregisterMessage
  | DeclareLeaderMessage
  | ForwardPortMessage
  | BroadcastMessage;

type SharedWorkerScope = typeof globalThis & {
  onconnect: ((event: MessageEvent) => void) | null;
};

type ChannelState = {
  currentLeaderTabId: string | null;
  registeredTabPorts: Map<string, MessagePort>;
};

const channels = new Map<string, ChannelState>();

function getChannelState(channelId: string): ChannelState {
  let state = channels.get(channelId);
  if (!state) {
    state = { currentLeaderTabId: null, registeredTabPorts: new Map() };
    channels.set(channelId, state);
  }
  return state;
}

(self as unknown as SharedWorkerScope).onconnect = (connectEvent: MessageEvent) => {
  const tabPort = connectEvent.ports[0];
  tabPort.start();

  tabPort.onmessage = (event: MessageEvent<IncomingMessage>) => {
    const message = event.data;

    if (message.type === 'register') {
      const channel = getChannelState(message.channelId);
      channel.registeredTabPorts.set(message.tabId, tabPort);
      // Tell this new tab who the current leader is, if known.
      if (channel.currentLeaderTabId) {
        tabPort.postMessage({ type: 'leader-info', leaderTabId: channel.currentLeaderTabId });
      }
      return;
    }

    if (message.type === 'unregister') {
      const channel = getChannelState(message.channelId);
      channel.registeredTabPorts.delete(message.tabId);
      // Clear the leader record so the next tab to register doesn't get a stale leader-info.
      if (channel.currentLeaderTabId === message.tabId) {
        channel.currentLeaderTabId = null;
      }
      if (channel.currentLeaderTabId === null && channel.registeredTabPorts.size === 0) {
        channels.delete(message.channelId);
      }
      return;
    }

    if (message.type === 'declare-leader') {
      const channel = getChannelState(message.channelId);
      channel.currentLeaderTabId = message.tabId;
      return;
    }

    if (message.type === 'forward-port') {
      const channel = getChannelState(message.channelId);
      const portToForward = event.ports[0];
      if (!portToForward) return;
      const destinationPort = channel.registeredTabPorts.get(message.toTabId);
      if (!destinationPort) return;
      destinationPort.postMessage(
        { type: 'incoming-port', fromTabId: message.fromTabId },
        [portToForward],
      );
      return;
    }

    if (message.type === 'broadcast') {
      const channel = getChannelState(message.channelId);
      // Fan out to every tab except the sender.
      // Posting to a closed tab's port silently fails — no cleanup needed.
      for (const [tabId, port] of channel.registeredTabPorts) {
        if (tabId !== message.fromTabId) {
          port.postMessage({ type: 'broadcast', message: message.message });
        }
      }
      return;
    }
  };
};
