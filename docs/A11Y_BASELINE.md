# Accessibility baseline

The client has three accessibility gates. The shared primitives in
`client/src/components/ui/` are held to zero findings. The rest of the client
is held to a committed baseline: what exists today passes, anything new fails.
This file lists what the baseline currently allows, so the follow-up work is
ready to pick up.

## The gates

| Gate | Command | What it checks | Baseline file |
| --- | --- | --- | --- |
| Lint | `pnpm lint` (or `pnpm --filter @thewired/client lint`) | JSX accessibility rules over `client/src` | `client/a11y-lint-baseline.json` |
| Unit | `pnpm test:client` | axe-core on every primitive in jsdom, plus keyboard and focus behaviour | none (zero tolerance) |
| Browser | `pnpm --filter @thewired/client test:e2e:a11y` | axe and real key presses in Chromium: every primitive on a harness page, then the app shell and core screens | `client/e2e/a11y-baseline.json` (app screens only) |

All three run in CI in the `Client Tests` and `Client Accessibility` jobs.

### Lint

The linter is [oxlint](https://oxc.rs) with its `jsx-a11y` rules, configured
in `client/.oxlintrc.json`, plus two local rules in
`client/tools/oxlint-plugin-wired-a11y.mjs`:

- `wired-a11y/icon-button-has-name`: a `<button>` whose only content is a
  lucide icon needs `aria-label`, `aria-labelledby` or `title`. The stock rule
  cannot see this case, because it gives any child component the benefit of
  the doubt.
- `wired-a11y/modal-has-name`: a `<Modal>` needs a `<ModalTitle>` in the same
  file, or a `label` / `labelledBy` prop. Every dialog passes today.

`client/tools/a11y-lint.mjs` runs the linter and applies the ratchet:

- any finding under a **strict path** (`src/components/ui/`) fails;
- elsewhere, a file fails only when it has **more** findings of a rule than
  the baseline records for that file and rule. Counts, not line numbers, so
  moving code around does not trip it.

When you fix findings, tighten the baseline so they cannot come back:

```bash
pnpm --filter @thewired/client lint:a11y --update
```

`--update` never records findings for strict paths. To see every baselined
finding with its location, run `pnpm --filter @thewired/client lint:a11y --all`.

### Browser

`client/e2e/a11y.spec.ts` has two parts.

1. **Primitives, zero tolerance.** `client/e2e/harness/primitives.html` (served
   by the Vite dev server, never bundled) renders every primitive with the
   app's stylesheet. The spec drives each one with the keyboard and expects no
   axe findings. Two rules are excluded there because they are not about the
   primitives' markup: `color-contrast` (theme tokens, see below) and `region`
   (menus and popovers are portaled to `<body>`).
2. **App screens, baseline.** Login, the shell, the account menu, the Add
   Account dialog, Discover, Settings and Messages are scanned and compared
   with `client/e2e/a11y-baseline.json`: per screen, the number of failing
   elements per axe rule. A new rule or a higher count fails. `color-contrast`
   and `region` are recorded as `"any"`, because their count follows how much
   content is on screen.

The page is cut off from relays and the API during these tests, so they need
only the dev server and see the same empty-state screens everywhere. Routes,
panels and heavy dialogs are lazy chunks, so every scan first waits until no
Suspense fallback (`data-lazy-fallback`) is left and the screen's own content
is visible; a scan of a loading placeholder would pass without checking
anything. After
fixing something, regenerate the screen baseline:

```bash
UPDATE_A11Y_BASELINE=1 pnpm --filter @thewired/client test:e2e:a11y
```

Locally, `WIRED_PORT=<port>` moves the dev server off 1420, and
`PW_CHANNEL=chrome` or `PW_EXECUTABLE_PATH=<binary>` uses an installed
Chromium-based browser instead of Playwright's Chromium.

## What the lint baseline allows today

242 findings in 97 files (measured on the commit that introduced the gate).

| Severity | Rule | Count | What it means for a user |
| --- | --- | ---: | --- |
| High | `wired-a11y/icon-button-has-name` | 133 | A screen reader announces "button" with no name. |
| High | `jsx-a11y/control-has-associated-label` | 7 | Same, for controls the stock rule can see. |
| High | `jsx-a11y/click-events-have-key-events` | 19 | A clickable element that the keyboard cannot operate. |
| High | `jsx-a11y/no-static-element-interactions` | 20 | A `div`/`span` acting as a control: no role, not focusable. |
| High | `jsx-a11y/no-noninteractive-element-interactions` | 4 | A handler on an image, list item or similar. |
| Medium | `jsx-a11y/label-has-associated-control` | 59 | A visible label that is not tied to its field, so the field is announced without a name. |

The click-handler rules usually fire in pairs on one element (19 + 20 findings
are about 20 elements).

### By area

Counts are findings, highest first. "Unnamed" = the two naming rules;
"mouse-only" = the three handler rules; "labels" = `label-has-associated-control`.

| Area | Total | Unnamed | Mouse-only | Labels | Start with |
| --- | ---: | ---: | ---: | ---: | --- |
| `features/music` | 88 | 54 | 11 | 23 | `playbackBar/NowPlayingOverlay.tsx` (12), `PlaybackBar.tsx` (8), `playbackBar/ExpandedBar.tsx` (8), `CreateAlbumModal.tsx` (7) |
| `features/spaces` | 58 | 27 | 2 | 29 | `CreateSpaceModal.tsx` (10), `settings/OnboardingTab.tsx` (8), `InviteGenerateModal.tsx` (7), `settings/GeneralTab.tsx` (4) |
| `features/profile` | 12 | 11 | 1 | 0 | `NoteThreadPage.tsx`, `ProfileMusicTab.tsx`, `ProfileShowcaseTab.tsx`, `UserPopoverCard.tsx` (2 each) |
| `features/listenTogether` | 11 | 9 | 2 | 0 | `NowPlayingPanel.tsx` (4), `CallNowPlaying.tsx` (3) |
| `features/media` | 11 | 5 | 6 | 0 | `EnhancedVideoPlayer.tsx` (10) |
| `components/content` | 7 | 1 | 6 | 0 | `EmbeddedNote.tsx` (4), `MusicPostMedia.tsx` (2) |
| `features/settings` | 7 | 3 | 0 | 4 | `AISettingsTab.tsx` (4) |
| `components/media` | 6 | 0 | 6 | 0 | `SmartImage.tsx` (6): click-to-open images |
| `features/dm` | 6 | 6 | 0 | 0 | `DMConversation.tsx` (3), `NewDMModal.tsx` (2) |
| `components/chat` | 5 | 5 | 0 | 0 | `GifPicker.tsx` (3) |
| `components/sharing` | 5 | 5 | 0 | 0 | `SpacePickerModal.tsx` (3), `RecipientPickerModal.tsx` (2) |
| `features/longform` | 4 | 0 | 2 | 2 | `CoverImageField.tsx` (2) |
| `features/notifications` | 4 | 2 | 2 | 0 | `NotificationToast.tsx` (3) |
| `features/chat` | 3 | 3 | 0 | 0 | `ChatEditBanner.tsx`, `ChatReply.tsx`, `ChatView.tsx` |
| `features/search` | 3 | 3 | 0 | 0 | `SearchPanel.tsx` (2) |
| `features/wallet` | 3 | 2 | 0 | 1 | `ZapModal.tsx` (2) |
| `components/layout` | 2 | 0 | 2 | 0 | `RightPanel.tsx`, `Sidebar.tsx` (resize handles) |
| `features/calling` | 2 | 0 | 2 | 0 | `CallController.tsx` |
| `features/onboarding` | 2 | 2 | 0 | 0 | `ProfileWizard.tsx` (close buttons) |
| `features/emoji`, `features/identity`, `features/polls` | 1 each | 2 | 1 | 0 | `EmojiSetManager.tsx`, `AddAccountModal.tsx`, `PollCard.tsx` |

Most of the "unnamed" findings are one-line fixes: add `aria-label` to the
icon button. The music playback bar and the video player are where a sweep
pays off most.

## What the browser baseline allows today

Found by axe in Chromium on the running app. These are structural and mostly
live in the layout.

| Severity | Finding | Where | Notes |
| --- | --- | --- | --- |
| High | Unnamed button (`button-name`) | Top bar: the sidebar toggle, on every screen | Lint misses it (the name would come through a component); axe does not. |
| High | Unnamed button | Discover header (one more), Add Account dialog (close button) | |
| High | Six fields without a label (`label`) | Settings → Profile: Username, Display Name, About, NIP-05, Lightning Address, Website | The visible labels are not tied to the inputs. |
| Medium | No `main` landmark (`landmark-one-main`), content outside landmarks (`region`) | Whole shell | Sidebar → `nav`, centre panel → `main`, top bar → `header` would clear both. |
| Medium | No level-one heading (`page-has-heading-one`) | Shell, Settings, Messages | Discover already has one. |
| Medium | Text contrast below 4.5:1 (`color-contrast`) | Muted text (`text-muted`), small caps labels, inactive segment buttons; white text on the primary button | A theme-token decision, not a per-component fix. Left alone here because it changes the visual design. |

## Using the primitives accessibly

The primitives now do the following on their own; callers get it for free.

- **Modal**: `role="dialog"`, `aria-modal`, focus moves in, Tab stays in, focus
  returns to the opener, Escape closes only the top overlay. It is named by
  the `<ModalTitle>` rendered inside it (a heading that registers itself with
  the dialog), or by the `label` prop when there is no visible title. It never
  looks through its content for a heading, so a note or article shown in a
  dialog cannot become its name.
- **ConfirmDialog**: one `alertdialog`, named by its title, described by its body.
- **PopoverMenu**: when its children are only `PopoverMenuItem` /
  `PopoverMenuSeparator` it is a `role="menu"` of `menuitem`s. While closed it
  is `inert` (it used to leave its invisible buttons in the tab order).
- **AnchoredPopover**: opened from the keyboard on a button, it takes focus;
  Tab past either end closes it; focus returns to the trigger. Anchored to a
  text field (autocomplete) it never takes focus.
- **MediaLightbox**: a named modal dialog with named controls.
- **ImageUpload**: the drop zone is a real button; the group is named by `label`.

What callers still need to do (none of this is enforced by lint yet):

| Do this | Why |
| --- | --- |
| Render a dialog's title with `<ModalTitle>` (`as="h3"` etc. to change the element); give a title-less `Modal` a `label` | Otherwise the dialog has no name. Lint enforces this. |
| Pass `label` to `PopoverMenu` and `label` + `role` to `AnchoredPopover` | "Message actions", "Emoji picker": the popup is announced with a name. |
| Put `aria-haspopup` and `aria-expanded` on the button that opens a menu or popover | The trigger is the caller's element; the primitive cannot set it. |
| Pass `alt=""` to `Avatar` when the person's name is right next to it | Otherwise the name is read twice. The placeholder avatar now has the same text alternative as the image. |
| Pass `label=""` to `Spinner` when visible text already says "Loading…" | Otherwise "Loading" is announced twice. The label is visually hidden text inside the status element, which is what a live region reads out. |
| Menus with mixed content (a text field, a slider, a custom list) stay plain containers | `role="menu"` forbids those children; consider `AnchoredPopover` with `role="dialog"` for them. |
