import { store } from "../../../store";
import {
  addRelay,
  removeRelay,
  setRelayStatus,
  updateLatency,
} from "../../../store/slices/relaysSlice";
import { relayManager } from "../relayManager";
import { handlePotentialKick } from "../kickHandler";
import { wireSelfWrapOutboxAcks } from "../../../features/dm/dmPersistence";
import { publishOutbox } from "../publishOutbox";

// Relay manager → store: relay status rows, publish OKs, reconnect replays.

/** Wire relay status changes from relayManager → Redux store */
export function wireRelayStatusBridge(): void {
  relayManager.setGlobalCallbacks({
    onOK: (eventId, success, message, relayUrl) => {
      // First success clears the publish-outbox row (audit #34).
      publishOutbox.handleOK(eventId, success, relayUrl);
      if (!success) {
        console.warn(`[relay] ${relayUrl} rejected ${eventId.slice(0, 8)}: ${message}`);
        // Reactive kick detection: if the relay rejected this event because
        // we're no longer a member, sync membership and clean up locally.
        // No-op for any other rejection.
        void handlePotentialKick(eventId, success, message);
      }
    },
    onStatusChange: (url, status, error) => {
      const state = store.getState().relays.connections[url];
      if (!state) {
        // First time seeing this relay -- add it
        const conn = relayManager.getAllConnections().get(url);
        store.dispatch(
          addRelay({
            url,
            status,
            mode: conn?.mode ?? "read+write",
            latencyMs: conn?.getLatency() ?? 0,
            eventCount: conn?.getEventCount() ?? 0,
            error,
          }),
        );
      } else {
        store.dispatch(setRelayStatus({ url, status }));
      }

      if (status === "connected") {
        const conn = relayManager.getAllConnections().get(url);
        if (conn) {
          store.dispatch(updateLatency({ url, latencyMs: conn.getLatency() }));
        }
      }
    },
    // Keep the Redux connections record in lockstep with relayManager:
    // disconnect() (disable toggle, removed relay, mode-change recreate,
    // bootstrap pruning) drops the row instead of leaving a ghost entry.
    onRelayRemoved: (url) => {
      store.dispatch(removeRelay(url));
    },
  });

  // On any relay reconnect, re-publish un-acked outbox events (a relay that
  // dropped mid-publish never sent its OK). Idempotent + in-flight-guarded (#34).
  relayManager.onReconnect(() => void publishOutbox.replay());
  // A replayed DM self-wrap's OK also clears its message's sync warning.
  wireSelfWrapOutboxAcks();
}
