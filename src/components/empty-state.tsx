import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

// The popup's empty state: the page was read successfully and held no media.
//
// Deliberately not the loading state, which is skeleton rows, and not a notice,
// which means the page could not be read at all. The caller picks the icon, title
// and hint, because the wording differs between a YouTube page and any other and
// this component has no business knowing which one it is sitting in.

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  className?: string;
}

function EmptyState({ icon: Icon, title, description, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center gap-4 px-6 py-12 text-center", className)}>
      <div className="flex size-12 items-center justify-center rounded-full border border-border bg-card">
        <Icon aria-hidden className="size-5 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="mx-auto max-w-64 text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

export { EmptyState };