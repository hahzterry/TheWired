import { createContext, useContext, useRef, useState, useCallback, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { UserPopoverCard } from "./UserPopoverCard";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";

interface UserPopoverState {
  pubkey: string;
  anchorEl: HTMLElement;
  /** Increments on every open, so each open is a fresh attempt for the boundary. */
  openId: number;
}

interface UserPopoverContextValue {
  openUserPopover: (pubkey: string, anchorEl: HTMLElement) => void;
  closeUserPopover: () => void;
}

const UserPopoverCtx = createContext<UserPopoverContextValue>({
  openUserPopover: () => {},
  closeUserPopover: () => {},
});

export function useUserPopover() {
  return useContext(UserPopoverCtx);
}

export function UserPopoverProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<UserPopoverState | null>(null);
  const opens = useRef(0);
  const navigate = useNavigate();

  const openUserPopover = useCallback(
    (pubkey: string, anchorEl: HTMLElement) => {
      opens.current += 1;
      setState({ pubkey, anchorEl, openId: opens.current });
    },
    [],
  );

  const closeUserPopover = useCallback(() => {
    setState(null);
  }, []);

  const handleMessage = useCallback(
    (pubkey: string) => {
      navigate(`/dm/${pubkey}`);
    },
    [navigate],
  );

  return (
    <UserPopoverCtx.Provider value={{ openUserPopover, closeUserPopover }}>
      {children}
      {state && (
        // The popover renders an arbitrary profile, and this provider wraps the
        // whole shell: without a boundary a bad profile would take it all down.
        // The fallback is empty, so there is no Retry to press: keying on the
        // open count makes clicking the avatar again the retry.
        <ErrorBoundary
          variant="inline"
          scope="overlay"
          label="user-popover"
          resetKeys={[state.openId]}
          fallback={null}
        >
          <UserPopoverCard
            pubkey={state.pubkey}
            anchorEl={state.anchorEl}
            onClose={closeUserPopover}
            onMessage={handleMessage}
          />
        </ErrorBoundary>
      )}
    </UserPopoverCtx.Provider>
  );
}
