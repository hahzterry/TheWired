import { createContext } from "react";

/**
 * Navigation epoch. Every error boundary below a provider resets when the
 * value changes, so moving somewhere else in the app always gets a clean
 * attempt without each call site having to thread a key through. `null` (no
 * provider) disables navigation resets.
 */
export const BoundaryResetContext = createContext<string | null>(null);
