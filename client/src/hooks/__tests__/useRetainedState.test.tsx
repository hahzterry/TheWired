import { describe, it, expect, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { act, fireEvent, renderHook, screen } from "@testing-library/react";
import { Provider } from "react-redux";
import { resetRetainedStateForTests, useRetainedState } from "../useRetainedState";
import { createTestStore } from "@/__tests__/helpers/createTestStore";
import { renderWithProviders } from "@/__tests__/helpers/renderWithProviders";
import { identitySlice } from "@/store/slices/identitySlice";
import { ReplyComposer } from "@/features/spaces/notes/ReplyComposer";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const login = (pubkey: string) => identitySlice.actions.login({ pubkey, signerType: "nip07" });

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

  describe("per account", () => {
    function withStore() {
      const store = createTestStore();
      const wrapper = ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>;
      return { store, wrapper };
    }

    it("does not show one account's value to the next account on the same key", () => {
      const { store, wrapper } = withStore();
      act(() => void store.dispatch(login(ALICE)));
      const { result } = renderHook(() => useRetainedState("note:1:reply-draft", ""), { wrapper });
      act(() => result.current[1]("alice's unsent reply"));

      // The account changes under a component that stays mounted.
      act(() => void store.dispatch(login(BOB)));
      expect(result.current[0]).toBe("");

      // And under one that mounts afterwards.
      const fresh = renderHook(() => useRetainedState("note:1:reply-draft", ""), { wrapper });
      expect(fresh.result.current[0]).toBe("");
    });

    it("keeps each account's own value while the other is active", () => {
      const { store, wrapper } = withStore();
      act(() => void store.dispatch(login(ALICE)));
      const { result } = renderHook(() => useRetainedState("note:1:reply-draft", ""), { wrapper });
      act(() => result.current[1]("from alice"));
      act(() => void store.dispatch(login(BOB)));
      act(() => result.current[1]("from bob"));

      act(() => void store.dispatch(login(ALICE)));
      expect(result.current[0]).toBe("from alice");
      act(() => void store.dispatch(login(BOB)));
      expect(result.current[0]).toBe("from bob");
    });

    it("shows nothing of an account after it logs out", () => {
      const { store, wrapper } = withStore();
      act(() => void store.dispatch(login(ALICE)));
      const { result } = renderHook(() => useRetainedState("note:1:thread", false), { wrapper });
      act(() => result.current[1](true));
      act(() => void store.dispatch(identitySlice.actions.logout()));
      expect(result.current[0]).toBe(false);
    });

    it("a reply draft typed by one account is not in the composer after switching accounts", () => {
      const composer = (
        <ReplyComposer targetPubkey={"c".repeat(64)} onSend={() => {}} onCancel={() => {}} draftKey="note:1:reply-draft" />
      );
      const { store, unmount } = renderWithProviders(composer, {
        preloadedState: { identity: { ...identitySlice.getInitialState(), pubkey: ALICE, signerType: "nip07" } },
      });
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "alice's unsent reply" } });
      expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("alice's unsent reply");

      // Switch while the composer is open.
      act(() => void store.dispatch(login(BOB)));
      expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("");

      // The card scrolls away and comes back under the new account.
      unmount();
      renderWithProviders(composer, { store });
      expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("");
    });
  });
});
