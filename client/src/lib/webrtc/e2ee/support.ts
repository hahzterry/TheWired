// Whether frame-level E2EE can run here, answered without the LiveKit SDK.
//
// The call and voice services ask this synchronously before they start a
// join, at a point where the SDK may not be loaded yet (it is fetched on
// demand). The check is the same one `isE2EESupported()` in livekit-client
// makes: insertable streams or RTCRtpScriptTransform. A test keeps the two in
// step, so an SDK upgrade that changes its rule fails there, not in a call.

/** This WebView has neither insertable streams nor RTCRtpScriptTransform. */
export class E2EEUnsupportedError extends Error {
  constructor() {
    super("End-to-end encrypted calls aren't supported on this device");
    this.name = "E2EEUnsupportedError";
  }
}

/** Whether frame-level E2EE can run in this WebView. */
export function e2eeSupported(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as {
    RTCRtpScriptTransform?: unknown;
    RTCRtpSender?: { prototype: { createEncodedStreams?: unknown } };
  };
  const insertableStreams =
    typeof w.RTCRtpSender !== "undefined" &&
    typeof w.RTCRtpSender.prototype.createEncodedStreams !== "undefined";
  const scriptTransform = typeof w.RTCRtpScriptTransform !== "undefined";
  return insertableStreams || scriptTransform;
}
