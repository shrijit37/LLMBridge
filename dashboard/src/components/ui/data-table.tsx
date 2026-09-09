import { cn } from "@/lib/utils";

/**
 * Styled table container: border, rounded corners, horizontal scroll.
 * Wrap an existing <table> element. No opinion on internal layout.
 */
export function DataTable({
  children,
  className,
  maxHeight,
  ...props
}: React.ComponentProps<"div"> & { maxHeight?: string }) {
  return (
    <div
      className={cn("overflow-x-auto rounded-lg border border-edge", className)}
      style={maxHeight ? { maxHeight } : undefined}
      {...props}
    >
      {children}
    </div>
  );
}

/** Styled table header cell with sticky positioning. */
export function TableHead({
  className,
  align = "left",
  ...props
}: React.ComponentProps<"th"> & { align?: "left" | "right" | "center" }) {
  return (
    <th
      className={cn(
        "sticky top-0 z-[1] bg-card px-3 py-2.5 text-xs font-medium text-ink-mute",
        align === "right" && "text-right",
        align === "center" && "text-center",
        className,
      )}
      {...props}
    />
  );
}

/** Styled table cell. */
export function TableCell({
  className,
  align = "left",
  ...props
}: React.ComponentProps<"td"> & { align?: "left" | "right" | "center" }) {
  return (
    <td
      className={cn(
        "px-3 py-2.5 text-sm",
        align === "right" && "text-right",
        align === "center" && "text-center",
        className,
      )}
      {...props}
    />
  );
}
