/**
 * Every shared primitive from src/components/ui on one page, for the
 * real-browser keyboard and axe checks in e2e/a11y.spec.ts. Served by the Vite
 * dev server at /e2e/harness/primitives.html; never bundled.
 */
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import { AnchoredPopover } from "../../src/components/ui/AnchoredPopover";
import { Avatar } from "../../src/components/ui/Avatar";
import { BlockedMessage } from "../../src/components/ui/BlockedMessage";
import { Button } from "../../src/components/ui/Button";
import { ColorPicker } from "../../src/components/ui/ColorPicker";
import { ConfirmDialog } from "../../src/components/ui/ConfirmDialog";
import { ImageUpload } from "../../src/components/ui/ImageUpload";
import { MediaLightbox } from "../../src/components/ui/MediaLightbox";
import { Modal } from "../../src/components/ui/Modal";
import { PopoverMenu, PopoverMenuItem, PopoverMenuSeparator } from "../../src/components/ui/PopoverMenu";
import { ShimmerButton } from "../../src/components/ui/ShimmerButton";
import { Spinner } from "../../src/components/ui/Spinner";
import { Toggle } from "../../src/components/ui/Toggle";

const swatch = (color: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="${color}"/></svg>`,
  )}`;
const IMAGES = [swatch("#3b5bdb"), swatch("#2f9e44"), swatch("#e8590c")];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="rounded-xl border border-border p-4">
      <h2 className="mb-3 text-sm font-semibold text-heading">{title}</h2>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </section>
  );
}

function ModalDemo() {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [deleted, setDeleted] = useState(0);
  return (
    <Section title="Modal">
      <Button onClick={() => setOpen(true)}>Open modal</Button>
      <span data-testid="deleted-count" className="text-sm text-heading">
        deleted: {deleted}
      </span>
      <Modal open={open} onClose={() => setOpen(false)}>
        <div data-testid="modal-panel" className="w-full max-w-sm rounded-2xl card-glass p-6 shadow-2xl">
          <h2 className="mb-2 text-base font-bold text-heading">Rename space</h2>
          <label htmlFor="harness-name" className="block text-sm text-heading">
            Name
          </label>
          <input
            id="harness-name"
            className="mb-4 w-full rounded-xl border border-border bg-field px-3 py-1.5 text-sm text-heading"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirm(true)}>
              Delete…
            </Button>
            <Button onClick={() => setOpen(false)}>Save</Button>
          </div>
        </div>
      </Modal>
      <ConfirmDialog
        open={confirm}
        danger
        title="Delete space?"
        body="This cannot be undone."
        confirmLabel="Delete"
        onConfirm={() => setDeleted((n) => n + 1)}
        onClose={() => setConfirm(false)}
      />
    </Section>
  );
}

function MenuDemo() {
  const [inline, setInline] = useState(false);
  const [portal, setPortal] = useState(false);
  const [rowClicks, setRowClicks] = useState(0);
  const [picked, setPicked] = useState("none");
  const anchor = useRef<HTMLButtonElement>(null);
  const items = (close: () => void) => (
    <>
      <PopoverMenuItem
        label="Copy text"
        onClick={() => {
          setPicked("copy");
          close();
        }}
      />
      <PopoverMenuItem
        label="Reply"
        onClick={() => {
          setPicked("reply");
          close();
        }}
      />
      <PopoverMenuSeparator />
      <PopoverMenuItem
        label="Delete"
        variant="danger"
        onClick={() => {
          setPicked("delete");
          close();
        }}
      />
    </>
  );
  return (
    <Section title="PopoverMenu">
      {/* A clickable row, like a note card: clicks inside the menu must not count. */}
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div data-testid="row" className="flex items-center gap-3" onClick={() => setRowClicks((n) => n + 1)}>
        <div className="relative">
          <Button aria-haspopup="menu" aria-expanded={inline} onClick={() => setInline((o) => !o)}>
            Inline menu
          </Button>
          <PopoverMenu open={inline} onClose={() => setInline(false)} position="below" label="Inline actions">
            {items(() => setInline(false))}
          </PopoverMenu>
        </div>
        <Button ref={anchor} aria-haspopup="menu" aria-expanded={portal} onClick={() => setPortal((o) => !o)}>
          Portal menu
        </Button>
        <PopoverMenu
          open={portal}
          onClose={() => setPortal(false)}
          anchorRef={anchor}
          position="below"
          label="Portal actions"
        >
          {items(() => setPortal(false))}
        </PopoverMenu>
      </div>
      <span data-testid="row-clicks" className="text-sm text-heading">
        row clicks: {rowClicks}
      </span>
      <span data-testid="picked" className="text-sm text-heading">
        picked: {picked}
      </span>
    </Section>
  );
}

function PopoverDemo() {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <Section title="AnchoredPopover">
      <Button ref={setAnchor} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Emoji
      </Button>
      <Button variant="secondary">After popover</Button>
      <AnchoredPopover anchorEl={anchor} open={open} onClose={() => setOpen(false)} role="dialog" label="Emoji picker">
        <div className="w-56 rounded-xl border border-border bg-panel p-3">
          <label htmlFor="harness-emoji" className="block text-sm text-heading">
            Search emoji
          </label>
          <input
            id="harness-emoji"
            className="mb-2 w-full rounded-xl border border-border bg-field px-2 py-1 text-sm text-heading"
          />
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Smile
          </Button>
        </div>
      </AnchoredPopover>
    </Section>
  );
}

function LightboxDemo() {
  const [open, setOpen] = useState(false);
  return (
    <Section title="MediaLightbox">
      <button type="button" onClick={() => setOpen(true)} className="rounded-lg">
        <img src={IMAGES[0]} alt="Open gallery" className="h-16 w-24 rounded-lg object-cover" />
      </button>
      {open && <MediaLightbox srcs={IMAGES} alt="Sample gallery" onClose={() => setOpen(false)} />}
    </Section>
  );
}

function FormDemo() {
  const [on, setOn] = useState(false);
  const [color, setColor] = useState("220 14% 8%");
  const [image, setImage] = useState("");
  return (
    <>
      <Section title="Toggle and ColorPicker">
        <div className="w-80">
          <Toggle label="Read receipts" description="Let others see when you read" checked={on} onChange={setOn} />
        </div>
        <div className="w-64">
          <ColorPicker label="Accent" value={color} onChange={setColor} />
        </div>
        <span data-testid="color" className="text-sm text-heading">
          {color}
        </span>
      </Section>
      <Section title="ImageUpload">
        <div className="w-80">
          <ImageUpload value={image} onChange={setImage} context="public" label="Space icon" />
        </div>
        <div className="w-80">
          <ImageUpload value={IMAGES[1]} onChange={() => {}} context="public" label="Banner" shape="banner" />
        </div>
      </Section>
    </>
  );
}

function App() {
  return (
    <main className="mx-auto max-w-4xl space-y-4 p-6">
      <h1 className="text-xl font-bold text-heading">UI primitives</h1>
      <ModalDemo />
      <MenuDemo />
      <PopoverDemo />
      <LightboxDemo />
      <FormDemo />
      <Section title="Display">
        <Avatar alt="Luna Vega" />
        <Avatar src={IMAGES[2]} alt="Marcus Cole" />
        <Spinner />
        <ShimmerButton>Get started</ShimmerButton>
        <div className="w-80">
          <BlockedMessage variant="note" onUnblock={() => {}}>
            <p className="text-sm text-heading">Hidden message text</p>
          </BlockedMessage>
        </div>
      </Section>
      <Button variant="secondary">Last control</Button>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
