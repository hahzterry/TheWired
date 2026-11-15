import { lazyView } from "@/components/ui/lazyView";

/** Stand-in for an article body: a few text-height bars where the prose will be. */
function ArticleBodySkeleton() {
  return (
    <div data-lazy-fallback="article" aria-hidden="true" className="space-y-3 animate-pulse">
      <div className="h-4 w-11/12 rounded bg-field" />
      <div className="h-4 w-full rounded bg-field" />
      <div className="h-4 w-4/5 rounded bg-field" />
      <div className="h-4 w-2/3 rounded bg-field" />
    </div>
  );
}

/**
 * `ArticleMarkdown`, loaded on demand. The renderer brings react-markdown,
 * the remark/rehype pipeline and every highlight.js grammar, which is far more
 * than the article list or the editor form around it needs up front.
 */
export const LazyArticleMarkdown = lazyView(
  () => import("./ArticleMarkdown").then((m) => ({ default: m.ArticleMarkdown })),
  <ArticleBodySkeleton />,
);
