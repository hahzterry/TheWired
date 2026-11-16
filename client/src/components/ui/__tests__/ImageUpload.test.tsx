import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockUpload = vi.fn();
vi.mock("@/lib/media/uploadPlan", () => ({
  uploadWithContext: (...args: unknown[]) => mockUpload(...args),
}));

import { ImageUpload } from "../ImageUpload";

function Harness({ initial = "", label = "Space icon" }: { initial?: string; label?: string | undefined }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <ImageUpload value={value} onChange={setValue} context={"public" as never} label={label} />
      <div data-testid="value">{value}</div>
    </>
  );
}

beforeEach(() => {
  mockUpload.mockReset();
});

describe("ImageUpload semantics", () => {
  it("is a group named by its label", () => {
    render(<Harness />);
    expect(screen.getByRole("group", { name: "Space icon" })).toBeTruthy();
  });

  it("renders no orphan <label>: nothing claims a control it is not tied to", () => {
    const { container } = render(<Harness />);
    expect(container.querySelector("label")).toBeNull();
  });

  it("is an unnamed-group-free container without a label", () => {
    const { container } = render(
      <ImageUpload value="" onChange={() => {}} context={"public" as never} />,
    );
    expect(container.firstElementChild).not.toHaveAttribute("aria-labelledby");
  });

  it("names the remove button", () => {
    render(<Harness initial="https://example.test/icon.png" />);
    expect(screen.getByRole("button", { name: "Remove image" })).toBeTruthy();
  });

  it("names the URL field after the label", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Paste URL" }));
    expect(screen.getByRole("textbox", { name: "Space icon URL" })).toBeTruthy();
  });

  it("keeps the hidden file input out of the tab order and the a11y tree", () => {
    const { container } = render(<Harness />);
    const input = container.querySelector('input[type="file"]')!;
    expect(input).toHaveAttribute("tabindex", "-1");
    expect(input).toHaveAttribute("aria-hidden", "true");
  });
});

describe("ImageUpload keyboard", () => {
  it("the drop zone is a button: Tab reaches it, Enter and Space open the file picker", async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const picker = vi.spyOn(input, "click").mockImplementation(() => {});

    await user.tab(); // "Paste URL" toggle
    await user.tab();
    const zone = screen.getByRole("button", { name: "Upload image or paste URL" });
    expect(zone).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(picker).toHaveBeenCalledTimes(1);
    await user.keyboard(" ");
    expect(picker).toHaveBeenCalledTimes(2);
  });

  it("removes the image with the keyboard", async () => {
    const user = userEvent.setup();
    render(<Harness initial="https://example.test/icon.png" />);
    screen.getByRole("button", { name: "Remove image" }).focus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("value")).toHaveTextContent("");
    expect(screen.queryByRole("button", { name: "Remove image" })).toBeNull();
  });
});

describe("ImageUpload upload state", () => {
  it("keeps the drop zone's name stable, marks it busy and announces the upload", async () => {
    let finish!: (r: { url: string }) => void;
    mockUpload.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File([new Uint8Array([1])], "icon.png", { type: "image/png" }));

    const zone = screen.getByRole("button", { name: "Upload image or paste URL" });
    expect(zone).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Uploading image");

    await act(async () => finish({ url: "https://example.test/up.png" }));
    await waitFor(() => expect(screen.getByTestId("value")).toHaveTextContent("https://example.test/up.png"));
    expect(screen.getByRole("button", { name: "Upload image or paste URL" })).toHaveAttribute("aria-busy", "false");
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("announces a failed upload as an alert", async () => {
    mockUpload.mockImplementation(async () => {
      throw new Error("Server said no");
    });
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File([new Uint8Array([1])], "icon.png", { type: "image/png" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Server said no");
  });
});
