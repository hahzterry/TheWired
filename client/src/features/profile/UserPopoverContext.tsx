import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { UserPopoverCard } from "./UserPopoverCard";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";

interface UserPopoverState {
  pubkey: string;
  anchorEl: HTMLElement;
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
  const navigate = useNavigate();

  const openUserPopover = useCallback(
    (pubkey: string, anchorEl: HTMLElement) => {
      setState({ pubkey, anchorEl });
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
        <ErrorBoundary
          variant="inline"
          scope="overlay"
          label="user-popover"
          resetKeys={[state.pubkey, state.anchorEl]}
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
