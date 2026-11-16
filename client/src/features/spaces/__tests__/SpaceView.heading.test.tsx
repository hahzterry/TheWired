/**
 * The landing view's animated heading is the only startup user of the
 * animation library, so it is a lazy chunk. It must never cost the landing
 * view anything: an invisible copy holds its place while it loads, and a plain
 * heading replaces it if the chunk cannot be loaded.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/__tests__/helpers/renderWithProviders";
import { resetCrashLogForTests } from "@/lib/crash/crashLog";
import { retryFailedLazyImports, setLazyImportsFailingForTests } from "@/lib/lazyWithRetry";

vi.mock("@/components/ui/TextAnimate", () => ({
  TextAnimate: ({ children, className }: { children: string; className?: string }) => (
    <h2 data-testid="animated-heading" className={className}>
      {children}
    </h2>
  ),
}));
vi.mock("../ChannelHeader", () => ({ ChannelHeader: () => null }));
vi.mock("../OnboardingBanner", () => ({ OnboardingBanner: () => null }));

import { SpaceView } from "../SpaceView";

beforeEach(() => {
  localStorage.clear();
  resetCrashLogForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  setLazyImportsFailingForTests(false);
  vi.restoreAllMocks();
});

describe("SpaceView landing heading", () => {
  // Failure first: the lazy component is a module singleton.
  it("falls back to a plain, visible heading when the animation chunk cannot be loaded", async () => {
    setLazyImportsFailingForTests(true);
    renderWithProviders(<SpaceView />);

    const heading = await screen.findByRole("heading", { name: "Select a Space" });
    expect(heading).not.toHaveClass("opacity-0");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("animated-heading")).toBeNull();
    // The rest of the landing view is there regardless.
    expect(screen.getByText("Choose a space from the sidebar to get started")).toBeInTheDocument();
  });

  it("holds the heading's place invisibly while the chunk loads, then shows the animated heading", async () => {
    retryFailedLazyImports();
    const { container } = renderWithProviders(<SpaceView />);

    const placeholder = container.querySelector("h2[aria-hidden='true']");
    expect(placeholder).toHaveClass("opacity-0");
    expect(placeholder).toHaveTextContent("Select a Space");

    const animated = await screen.findByTestId("animated-heading");
    expect(animated).toHaveTextContent("Select a Space");
    // Same typography as the placeholder, so nothing moves when it swaps in.
    expect(animated.className).toBe(placeholder!.className.replace(" opacity-0", ""));
    expect(container.querySelector("h2[aria-hidden='true']")).toBeNull();
  });
});
