import { cn } from "@/lib/utils"

type Status = "success" | "danger" | "warning" | "info" | "idle"
const colorMap: Record<Status, string> = {
  success: "bg-success",
  danger: "bg-destructive",
  warning: "bg-warning",
  info: "bg-info",
  idle: "bg-ink-mute",
}

export function StatusDot({
  status = "idle",
  pulse = false,
  className,
}: {
  status?: Status
  pulse?: boolean
  className?: string
}) {
  return (
    <span
      data-slot="status-dot"
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        colorMap[status],
        pulse && "animate-pulse",
        className
      )}
    />
  )
}
