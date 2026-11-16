/**
 * `e2eeSupported()` answers without the SDK, so the call and voice services
 * can ask before the SDK chunk has been fetched. This keeps it honest: it must
 * agree with livekit-client's own `isE2EESupported()` in every environment. If
 * an SDK upgrade changes the rule, this fails and `support.ts` gets updated.
 */
import { describe, it, expect, afterEach } from "vitest";
import { isE2EESupported } from "livekit-client";
import { e2eeSupported, E2EEUnsupportedError } from "../support";

type Win = Record<string, unknown>;
const win = window as unknown as Win;

function setEnvironment({ insertableStreams, scriptTransform }: { insertableStreams: boolean; scriptTransform: boolean }) {
  delete win.RTCRtpSender;
  delete win.RTCRtpScriptTransform;
  if (insertableStreams) {
    class RTCRtpSender {
      createEncodedStreams() {}
    }
    win.RTCRtpSender = RTCRtpSender;
  }
  if (scriptTransform) win.RTCRtpScriptTransform = class RTCRtpScriptTransform {};
}

afterEach(() => {
  delete win.RTCRtpSender;
  delete win.RTCRtpScriptTransform;
});

describe("e2eeSupported", () => {
  const cases = [
    { name: "neither API (an old WebView)", insertableStreams: false, scriptTransform: false, expected: false },
    { name: "insertable streams only (Chromium)", insertableStreams: true, scriptTransform: false, expected: true },
    { name: "script transform only (WebKit, Firefox)", insertableStreams: false, scriptTransform: true, expected: true },
    { name: "both", insertableStreams: true, scriptTransform: true, expected: true },
  ];

  it.each(cases)("$name → $expected, same as the SDK", ({ insertableStreams, scriptTransform, expected }) => {
    setEnvironment({ insertableStreams, scriptTransform });
    expect(e2eeSupported()).toBe(expected);
    expect(e2eeSupported()).toBe(isE2EESupported());
  });

  it("an RTCRtpSender without createEncodedStreams does not count", () => {
    win.RTCRtpSender = class RTCRtpSender {};
    expect(e2eeSupported()).toBe(false);
    expect(e2eeSupported()).toBe(isE2EESupported());
  });
});

describe("E2EEUnsupportedError", () => {
  it("is the class the session module re-exports, so instanceof holds across both imports", async () => {
    const session = await import("../session");
    expect(session.E2EEUnsupportedError).toBe(E2EEUnsupportedError);
    expect(new session.E2EEUnsupportedError()).toBeInstanceOf(E2EEUnsupportedError);
    expect(new E2EEUnsupportedError().name).toBe("E2EEUnsupportedError");
    // Importing the session module pulls in the whole SDK, which is slow cold.
  }, 30_000);
});
