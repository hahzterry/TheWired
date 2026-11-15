import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { LoadMoreButton } from "../LoadMoreButton";

describe("LoadMoreButton", () => {
  it("offers Load more when idle", () => {
    const onLoadMore = vi.fn();
    render(<LoadMoreButton isLoading={false} hasMore onLoadMore={onLoadMore} />);
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("is disabled while loading", () => {
    render(<LoadMoreButton isLoading hasMore onLoadMore={() => {}} />);
    expect(screen.getByRole("button", { name: /Loading/ })).toBeDisabled();
  });

  it("says so, and offers Retry, when the request could not be sent", () => {
    const onLoadMore = vi.fn();
    render(<LoadMoreButton isLoading={false} hasMore onLoadMore={onLoadMore} error="unreachable" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't reach a relay to load more.");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("distinguishes relays that did not answer in time", () => {
    render(<LoadMoreButton isLoading={false} hasMore onLoadMore={() => {}} error="timeout" />);
    expect(screen.getByRole("alert")).toHaveTextContent("The relays took too long to answer.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });

  it("shows the spinner, not the error, once the retry is under way", () => {
    render(<LoadMoreButton isLoading hasMore onLoadMore={() => {}} error="unreachable" />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: /Loading/ })).toBeDisabled();
  });

  it("an exhausted feed shows the end marker even if an old error lingers", () => {
    render(<LoadMoreButton isLoading={false} hasMore={false} onLoadMore={() => {}} error="timeout" />);
    expect(screen.getByText("No more to load")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
