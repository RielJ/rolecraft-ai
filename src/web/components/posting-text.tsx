import { postingBlocks } from "@/shared/posting-blocks";
import { cn } from "@/web/lib/utils";

/**
 * A posting's text, set for reading: the UI's own sans at 15px with a tall line height and a
 * ~66-character measure, with the posting's section titles and bullets shown as real headings
 * and lists. Same component in the Matches reading pane and the job page, so it reads the same.
 */
export function PostingText({ text, className }: { text: string; className?: string }) {
  const blocks = postingBlocks(text);
  return (
    <div
      className={cn(
        "grid max-w-[66ch] gap-4 break-words font-sans text-[0.9375rem] text-foreground/85 leading-[1.7]",
        className,
      )}
    >
      {blocks.map((block, i) => {
        // Blocks have no ids, and the text never reorders, so the index is a stable key.
        const key = `${block.kind}-${i}`;
        switch (block.kind) {
          case "heading":
            return (
              <h3 key={key} className={cn("text-balance font-medium text-foreground", i > 0 && "mt-3")}>
                {block.text}
              </h3>
            );
          case "list": {
            const List = block.ordered ? "ol" : "ul";
            return (
              <List
                key={key}
                className={cn(
                  "grid gap-1.5 pl-5 marker:text-muted-foreground",
                  block.ordered ? "list-decimal marker:tabular-nums" : "list-disc",
                )}
              >
                {block.items.map((item, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static text that never reorders; items can repeat.
                  <li key={`${key}-${j}`} className="text-pretty pl-1">
                    {item}
                  </li>
                ))}
              </List>
            );
          }
          case "paragraph":
            return (
              <p key={key} className="whitespace-pre-line text-pretty">
                {block.text}
              </p>
            );
          default: {
            const _exhaustive: never = block;
            return _exhaustive;
          }
        }
      })}
    </div>
  );
}
