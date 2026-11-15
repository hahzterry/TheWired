import { ChannelHeader } from "./ChannelHeader";
import { OnboardingBanner } from "./OnboardingBanner";
import { useSpace } from "./useSpace";
import { lazyView } from "@/components/ui/lazyView";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";

const HEADING_CLASS = "text-xl font-bold text-gradient-accent tracking-wide";

// The animated heading is the only thing on the landing view that needs the
// animation library, so it loads on its own. The heading animates in from
// transparent, so an invisible copy holds its place until then.
const TextAnimate = lazyView(
  () => import("@/components/ui/TextAnimate").then((m) => ({ default: m.TextAnimate })),
  <h2 aria-hidden="true" className={`${HEADING_CLASS} opacity-0`}>
    Select a Space
  </h2>,
);

interface SpaceViewProps {
  children?: React.ReactNode;
}

export function SpaceView({ children }: SpaceViewProps) {
  const { activeSpace } = useSpace();

  if (!activeSpace) {
    return (
      <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-grid">
        <div className="pointer-events-none absolute inset-0 bg-ambient opacity-60" />
        <div className="relative z-10 text-center">
          {/* Decoration only: if its chunk cannot be loaded, show the plain heading. */}
          <ErrorBoundary
            variant="inline"
            scope="panel"
            label="space-heading"
            fallback={<h2 className={HEADING_CLASS}>Select a Space</h2>}
          >
            <TextAnimate animation="blurInUp" by="word" once as="h2" className={HEADING_CLASS}>
              {"Select a Space"}
            </TextAnimate>
          </ErrorBoundary>
          <p className="mt-1 text-sm text-soft">
            Choose a space from the sidebar to get started
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <ChannelHeader />
      <OnboardingBanner
        spaceId={activeSpace.id}
        spaceName={activeSpace.name}
        spacePicture={activeSpace.picture}
      />
      <div className="flex flex-1 overflow-hidden">
        {children}
      </div>
    </div>
  );
}
