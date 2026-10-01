import * as React from "react"
import { cn } from "@/lib/utils"
import { Progress as ProgressPrimitive } from "radix-ui"

function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  // `bytesReceived` counts a whole received body while `totalBytes` is the declared
  // size, so a redirect or a resumed transfer reports more than it was promised and
  // `value` lands above 100. Unclamped, that produced `translateX(--40%)`, which is
  // not a valid transform: the parser dropped it, the indicator fell back to its own
  // width, and the bar read complete. The clamp is why this is not `value || 0`.
  const indeterminate = value === null || value === undefined
  const percent = indeterminate ? 0 : Math.min(100, Math.max(0, Math.round(value)))

  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      // Forwarded, not just read for the transform. Without it Radix has no value,
      // so it rendered `data-state="indeterminate"` and no aria-valuenow whatever
      // number went into the style, and a determinate bar announced itself as unknown.
      value={indeterminate ? undefined : percent}
      className={cn(
        "relative flex h-1 w-full items-center overflow-x-hidden rounded-full bg-muted",
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        // The shadcn CLI generates bg-primary here. Spec 0003 overrides it to
        // --muted-foreground so a row in flight is never brighter than the action
        // it sits beside, which the palette reserves for --primary. Measured 5.84:1
        // against the --muted track, well over the 3:1 non-text bar. Reapply this
        // after any future `shadcn add` overwrites the file.
        //
        // `transition-transform` rather than `transition-all`, and gated with
        // `motion-reduce:` because Tailwind's variant is the layer that covers a CSS
        // transition on a component. Ungated, this was the one animation in the popup
        // that still moved for someone who had asked for reduced motion.
        className="size-full flex-1 bg-muted-foreground transition-transform motion-reduce:transition-none"
        // Indeterminate parks the indicator off the track, so the row shows an empty
        // bar rather than a number nobody measured. Spec 0003 asks for "never a faked
        // 30%" here, and its motion rules forbid the sweeping bar that is the usual
        // answer, because that would be an infinite animation. The visible "size
        // unknown" wording is still owed by the row rebuild in slice 1.
        style={{ transform: `translateX(-${100 - percent}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }