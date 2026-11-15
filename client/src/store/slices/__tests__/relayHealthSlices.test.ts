import { describe, it, expect } from "vitest";
import { relaysSlice, addRelay, clearRelayConnections, setDisabledRelays } from "../relaysSlice";
import { feedSlice, setLoadingMore, setLoadMoreError, setHasMore } from "../feedSlice";

describe("relaysSlice — clearRelayConnections", () => {
  it("drops every connection row in one action and keeps the disabled list", () => {
    let state = relaysSlice.reducer(undefined, { type: "init" });
    for (const url of ["wss://a", "wss://b", "wss://c"]) {
      state = relaysSlice.reducer(state, addRelay({ url, status: "connected", mode: "read+write", latencyMs: 1, eventCount: 0 }));
    }
    state = relaysSlice.reducer(state, setDisabledRelays(["wss://off"]));
    state = relaysSlice.reducer(state, clearRelayConnections());
    expect(state.connections).toEqual({});
    expect(state.disabledRelays).toEqual(["wss://off"]);
  });
});

describe("feedSlice — load-more error", () => {
  const contextId = "space:notes";

  it("records why a load more failed without touching hasMore", () => {
    let state = feedSlice.reducer(undefined, setHasMore({ contextId, value: true }));
    state = feedSlice.reducer(state, setLoadMoreError({ contextId, value: "unreachable" }));
    expect(state.meta[contextId]).toMatchObject({ hasMore: true, loadMoreError: "unreachable" });
  });

  it("clears the error when the next attempt starts, not when it ends", () => {
    let state = feedSlice.reducer(undefined, setLoadMoreError({ contextId, value: "timeout" }));
    state = feedSlice.reducer(state, setLoadingMore({ contextId, value: false }));
    expect(state.meta[contextId].loadMoreError).toBe("timeout");
    state = feedSlice.reducer(state, setLoadingMore({ contextId, value: true }));
    expect(state.meta[contextId].loadMoreError).toBeNull();
  });
});
