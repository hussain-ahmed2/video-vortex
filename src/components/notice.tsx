import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

// The popup's notice: something the user needs to be told about, where the page
// or a transfer did not do what was asked.
//
// Neutral by default, because "this page blocks access" is information rather
// than a failure. Destructive is reserved for something that went wrong, which is
// the only place the palette's single hue appears outside a control.
//
// The role is chosen from the variant so a screen reader hears an interruption
// only when something actually failed.

interface NoticeProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  variant?: "default" | "destructive";
  className?: string;
}

function Notice({
  icon: Icon,
  title,
  description,
  variant = "default",
  className,
}: NoticeProps) {
  const isDestructive = variant === "destructive";

  return (
    <div
      role={isDestructive ? "alert" : "status"}
      className={cn(
        "flex items-start gap-3 rounded-lg border border-border bg-card px-3 py-2.5",
        isDestructive && "border-destructive/40",
        className
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          "mt-0.5 size-4 shrink-0 text-muted-foreground",
          isDestructive && "text-destructive"
        )}
      />
      <div className="min-w-0 flex-1">
        <p className={cn("text-sm font-medium text-foreground", isDestructive && "text-destructive")}>
          {title}
        </p>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </div>
    </div>
  );
}

export { Notice };