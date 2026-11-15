import { describe, it, expect, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { resetRetainedStateForTests, useRetainedState } from "../useRetainedState";

beforeEach(() => resetRetainedStateForTests());

describe("useRetainedState", () => {
  it("behaves like useState while mounted", () => {
    const { result } = renderHook(() => useRetainedState("k", 0));
    expect(result.current[0]).toBe(0);
    act(() => result.current[1](5));
    expect(result.current[0]).toBe(5);
    act(() => result.current[1]((n) => n + 1));
    expect(result.current[0]).toBe(6);
  });

  it("gives a remounted component the value it had (a row scrolled away and back)", () => {
    const first = renderHook(() => useRetainedState("note:1:reply-draft", ""));
    act(() => first.result.current[1]("half a reply"));
    first.unmount();

    const second = renderHook(() => useRetainedState("note:1:reply-draft", ""));
    expect(second.result.current[0]).toBe("half a reply");
  });

  it("keeps values apart by key", () => {
    const a = renderHook(() => useRetainedState("note:1:thread", false));
    act(() => a.result.current[1](true));
    a.unmount();
    expect(renderHook(() => useRetainedState("note:2:thread", false)).result.current[0]).toBe(false);
    expect(renderHook(() => useRetainedState("note:1:thread", false)).result.current[0]).toBe(true);
  });

  it("forgets a value set back to the initial one (a sent or cleared draft)", () => {
    const first = renderHook(() => useRetainedState("k", ""));
    act(() => first.result.current[1]("draft"));
    act(() => first.result.current[1](""));
    first.unmount();
    // A different initial value shows nothing was stored for the key.
    expect(renderHook(() => useRetainedState("k", "fresh")).result.current[0]).toBe("fresh");
  });

  it("retains a value that differs from the initial even when it is falsy", () => {
    const first = renderHook(() => useRetainedState("media", true));
    act(() => first.result.current[1](false));
    first.unmount();
    expect(renderHook(() => useRetainedState("media", true)).result.current[0]).toBe(false);
  });

  it("is plain state with a null key", () => {
    const first = renderHook(() => useRetainedState<string>(null, ""));
    act(() => first.result.current[1]("typed"));
    first.unmount();
    expect(renderHook(() => useRetainedState<string>(null, "")).result.current[0]).toBe("");
  });
});
