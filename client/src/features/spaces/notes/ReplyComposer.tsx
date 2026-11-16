import { useRef, useEffect } from "react";
import { Send, X } from "lucide-react";
import { useProfile } from "../../profile/useProfile";
import { useAutoResize } from "../../../hooks/useAutoResize";
import { useRetainedState } from "../../../hooks/useRetainedState";

interface ReplyComposerProps {
  targetPubkey: string;
  onSend: (content: string) => void;
  onCancel: () => void;
  /** Header verb before the author name. Default "Replying to"; e.g. "Quoting". */
  label?: string;
  placeholder?: string;
  /**
   * Keeps the draft while the composer is not mounted. Cards in a virtualized
   * feed unmount when scrolled away; with a key the text is still there when
   * the card comes back.
   */
  draftKey?: string;
}

export function ReplyComposer({
  targetPubkey,
  onSend,
  onCancel,
  label = "Replying to",
  placeholder = "Write a reply...",
  draftKey,
}: ReplyComposerProps) {
  const [text, setText] = useRetainedState(draftKey ?? null, "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useAutoResize(textareaRef, text, 120);
  const { profile } = useProfile(targetPubkey);
  const name = profile?.display_name || profile?.name || targetPubkey.slice(0, 8) + "...";

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (text.trim()) {
        onSend(text);
        setText("");
      }
    }
    if (e.key === "Escape") {
      onCancel();
    }
  };

  return (
    <div className="mt-2 rounded-xl card-glass border border-border">
      <div className="flex items-center gap-1 border-l-2 border-primary px-3 pt-2 text-xs text-muted">
        <span>{label}</span>
        <span className="text-primary">{name}</span>
      </div>
      <div className="flex items-end gap-2 p-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder={placeholder}
          className="flex-1 resize-none overflow-hidden rounded-md bg-transparent px-2 py-1 text-sm text-body placeholder:text-muted focus:outline-none"
        />
        <div className="flex gap-1 pb-1">
          <button
            onClick={() => { if (text.trim()) { onSend(text); setText(""); } }}
            disabled={!text.trim()}
            className="rounded-md p-1.5 text-primary transition-colors hover:bg-primary/10 disabled:opacity-40"
          >
            <Send size={14} />
          </button>
          <button
            onClick={onCancel}
            className="rounded-md p-1.5 text-muted transition-colors hover:bg-card-hover hover:text-heading"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
