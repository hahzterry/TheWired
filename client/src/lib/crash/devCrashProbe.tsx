/**
 * Development-only fault injection for error boundaries.
 *
 * Every boundary renders one probe next to its children in dev builds. Arming
 * a target from the console makes the matching probe throw during render, so
 * each containment level can be exercised on demand without hand-crafting a
 * malformed event:
 *
 *     wiredDebug.crash("panel:sidebar")        // every boundary with that name
 *     wiredDebug.crash("item:note", { id })    // only the item with this id
 *     wiredDebug.crash()                       // disarm (then press Retry)
 *
 * Nothing here exists in a production build: the probe is only rendered
 * behind `import.meta.env.DEV`, and the console command is registered behind
 * the same flag, so the bundler drops the whole module.
 */
import { useSyncExternalStore } from "react";
import { registerDebugCommand } from "@/lib/debug/logger";

interface ArmedCrash {
  target: string;
  id?: string;
  message?: string;
}

let armed: ArmedCrash | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getArmed(): ArmedCrash | null {
  return armed;
}

/** Arm (or, with no target, disarm) the probe. Exported for tests. */
export function armDevCrash(target?: string, options: { id?: string; message?: string } = {}): void {
  armed = target ? { target, id: options.id, message: options.message } : null;
  for (const listener of listeners) listener();
}

interface DevCrashProbeProps {
  /** `<scope>:<label>` of the boundary this probe sits in. */
  target: string;
  /** Identity of the boundary's content, when it has one. */
  id?: string;
}

export function DevCrashProbe({ target, id }: DevCrashProbeProps) {
  const current = useSyncExternalStore(subscribe, getArmed, getArmed);
  if (current && current.target === target && (current.id === undefined || current.id === id)) {
    throw new Error(current.message ?? `Dev crash probe: ${target}`);
  }
  return null;
}

if (import.meta.env.DEV) {
  registerDebugCommand("crash", (target, options) => {
    armDevCrash(
      typeof target === "string" ? target : undefined,
      typeof options === "object" && options !== null
        ? (options as { id?: string; message?: string })
        : {},
    );
    return armed ? `armed: ${armed.target}` : "disarmed";
  });
}
