import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/__tests__/helpers/renderWithProviders";
import { createTestStore } from "@/__tests__/helpers/createTestStore";
import type { ActiveCall } from "@/types/calling";

const service = vi.hoisted(() => ({
  hangupCall: vi.fn().mockResolvedValue(undefined),
  setCallMuted: vi.fn().mockResolvedValue(undefined),
  rejectCall: vi.fn().mockResolvedValue(undefined),
  answerCall: vi.fn().mockResolvedValue(undefined),
  initiateCall: vi.fn().mockResolvedValue(undefined),
}));
const ringtone = vi.hoisted(() => ({ startRinging: vi.fn(), stopRinging: vi.fn() }));

vi.mock("../callService", () => service);
vi.mock("../callRingtone", () => ringtone);

import { ActiveCallFallback, IncomingCallFallback } from "../CallOverlayFallback";

const PARTNER = "b".repeat(64);

function activeCall(overrides: Partial<ActiveCall> = {}): ActiveCall {
  return {
    partnerPubkey: PARTNER,
    callType: "audio",
    direction: "outgoing",
    roomId: "room-1",
    roomSecretKey: "",
    e2ee: true,
    state: "active",
    startedAt: 1,
    isMuted: false,
    isVideoEnabled: false,
    isScreenSharing: false,
    ...overrides,
  } as ActiveCall;
}

function storeWith(call: Record<string, unknown>) {
  const base = createTestStore().getState();
  return createTestStore({ call: { ...base.call, ...call } });
}

describe("ActiveCallFallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ends the call through the call service", () => {
    renderWithProviders(<ActiveCallFallback onRetry={() => {}} />, {
      store: storeWith({ activeCall: activeCall() }),
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Call in progress");
    expect(screen.getByRole("alert")).toHaveTextContent("You are still connected.");

    fireEvent.click(screen.getByRole("button", { name: "End call" }));
    expect(service.hangupCall).toHaveBeenCalledTimes(1);
  });

  it("mutes the transmitted audio, not just the flag", async () => {
    const store = storeWith({ activeCall: activeCall() });
    renderWithProviders(<ActiveCallFallback onRetry={() => {}} />, { store });

    fireEvent.click(screen.getByRole("button", { name: "Mute" }));
    expect(service.setCallMuted).toHaveBeenCalledWith(true);
    expect(store.getState().call.activeCall?.isMuted).toBe(true);
    expect(await screen.findByRole("button", { name: "Unmute" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("You are still connected and muted.");

    fireEvent.click(screen.getByRole("button", { name: "Unmute" }));
    expect(service.setCallMuted).toHaveBeenLastCalledWith(false);
  });

  it("reverts the mute flag when applying it fails", async () => {
    service.setCallMuted.mockRejectedValueOnce(new Error("no track"));
    const store = storeWith({ activeCall: activeCall() });
    renderWithProviders(<ActiveCallFallback onRetry={() => {}} />, { store });

    fireEvent.click(screen.getByRole("button", { name: "Mute" }));
    await waitFor(() => expect(store.getState().call.activeCall?.isMuted).toBe(false));
  });

  it("offers to show the call view again", () => {
    const onRetry = vi.fn();
    renderWithProviders(<ActiveCallFallback onRetry={onRetry} />, {
      store: storeWith({ activeCall: activeCall() }),
    });
    fireEvent.click(screen.getByRole("button", { name: /show call/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders nothing once the call is over", () => {
    const { container } = renderWithProviders(<ActiveCallFallback onRetry={() => {}} />, {
      store: storeWith({ activeCall: null }),
    });
    expect(container).toBeEmptyDOMElement();
  });
});

describe("IncomingCallFallback", () => {
  const incomingCall = { callerPubkey: PARTNER, callType: "audio", roomId: "room-1" };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("declines through the call service and keeps ringing until then", () => {
    const { unmount } = renderWithProviders(<IncomingCallFallback onRetry={() => {}} />, {
      store: storeWith({ incomingCall }),
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Incoming call");
    expect(ringtone.startRinging).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(service.rejectCall).toHaveBeenCalledTimes(1);

    unmount();
    expect(ringtone.stopRinging).toHaveBeenCalled();
  });

  it("accepts through the call service", async () => {
    renderWithProviders(<IncomingCallFallback onRetry={() => {}} />, {
      store: storeWith({ incomingCall }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(service.answerCall).toHaveBeenCalledTimes(1));
  });

  it("renders nothing and does not ring without an incoming call", () => {
    const { container } = renderWithProviders(<IncomingCallFallback onRetry={() => {}} />, {
      store: storeWith({ incomingCall: null }),
    });
    expect(container).toBeEmptyDOMElement();
    expect(ringtone.startRinging).not.toHaveBeenCalled();
  });
});
