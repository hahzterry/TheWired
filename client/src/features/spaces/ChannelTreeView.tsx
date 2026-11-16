import { Suspense, type ReactNode } from "react";
import type { DraggableAttributes, DraggableSyntheticListeners } from "@dnd-kit/core";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { lazyWithRetry } from "@/lib/lazyWithRetry";
import type { SpaceChannel } from "../../types/space";
import type { CategoryNode, ChannelTree } from "./channelTree";

/** Spread onto the element that should start a drag (a grip, or the whole row). */
export interface DragHandle {
  ref: (el: HTMLElement | null) => void;
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
}

export interface ChannelRenderContext {
  handle?: DragHandle;
  dragging: boolean;
  overlay?: boolean;
}

export interface CategoryRenderContext extends ChannelRenderContext {
  /** A channel is being dragged over this subfolder. */
  dropTarget: boolean;
}

export interface ChannelTreeDndProps {
  tree: ChannelTree;
  /** Drag-and-drop on (people who can manage channels). Off renders a plain list. */
  enabled: boolean;
  /** Keyboard dragging via the handle (needs a dedicated handle element, not the row button). */
  keyboard?: boolean;
  /** Collapsed subfolders hide their channels but still accept drops. */
  collapsed?: ReadonlySet<string>;
  onMoveChannel: (channelId: string, toCategoryId: string | null, index: number) => void;
  onMoveCategory: (categoryId: string, index: number) => void;
  renderChannel: (channel: SpaceChannel, ctx: ChannelRenderContext) => ReactNode;
  renderCategoryHeader: (node: CategoryNode, ctx: CategoryRenderContext) => ReactNode;
  /** Shown inside an expanded subfolder with no channels (only when enabled). */
  emptyCategoryHint?: ReactNode;
  /** Whether to render a category (e.g. hide empty ones from members). */
  showCategory?: (node: CategoryNode) => boolean;
}

/** The tree as a plain list: what everyone who cannot arrange channels sees. */
export function PlainChannelTree({
  tree,
  collapsed,
  renderChannel,
  renderCategoryHeader,
  showCategory,
}: ChannelTreeDndProps) {
  return (
    <div>
      {tree.uncategorized.map((ch) => (
        <div key={ch.id}>{renderChannel(ch, { dragging: false })}</div>
      ))}
      {tree.categories.filter((n) => showCategory?.(n) ?? true).map((node) => (
        <div key={node.category.id}>
          {renderCategoryHeader(node, { dragging: false, dropTarget: false })}
          {!collapsed?.has(node.category.id) &&
            node.channels.map((ch) => <div key={ch.id}>{renderChannel(ch, { dragging: false })}</div>)}
        </div>
      ))}
    </div>
  );
}

// dnd-kit is only needed by people who can arrange channels, so the
// drag-and-drop tree is its own chunk.
const LazyChannelTreeDnd = lazyWithRetry(() =>
  import("./ChannelTreeDnd").then((m) => ({ default: m.ChannelTreeDnd })),
);

/**
 * The channel tree. Members get the plain list. People who can arrange
 * channels get the drag-and-drop tree, with the plain list standing in while
 * its chunk loads, and if it cannot be loaded at all: the same rows either
 * way, so the sidebar never jumps and is never left empty.
 */
export function ChannelTreeView(props: ChannelTreeDndProps) {
  if (!props.enabled) return <PlainChannelTree {...props} />;
  const plain = <PlainChannelTree {...props} />;
  return (
    <ErrorBoundary variant="inline" scope="panel" label="channel-tree-dnd" fallback={plain}>
      <Suspense fallback={plain}>
        <LazyChannelTreeDnd {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}
