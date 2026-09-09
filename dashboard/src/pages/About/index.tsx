import { useStatus } from "@/hooks/useStatus";
import { useSnapshot } from "@/hooks/useSnapshot";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { StatusDot } from "@/components/ui/StatusDot";
import { TabularText } from "@/components/ui/TabularText";
import { PageHeader } from "@/components/common/PageHeader";

function fmtUptime(s: number): string {
  if (!s || Number.isNaN(s)) return "—"
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${sec
    .toString()
    .padStart(2, "0")}`
}

export function About() {
  const { data: health } = useStatus()
  const { data: snapshot } = useSnapshot()

  const listen = snapshot?.config?.listen ?? "—"
  const version = health?.version ?? "—"
  const providers = health?.providers_count ?? snapshot?.config?.providers?.length ?? 0
  const active = health?.active_provider ?? "—"
  const uptime = fmtUptime(health?.uptime ?? 0)

  const tech = [
    "Hono HTTP server",
    "TypeScript",
    "SQLite (node:sqlite)",
    "undici proxy agents",
    "SSE events for live updates",
  ]

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <PageHeader
        eyebrow="About"
        title="About ccs"
        description="Gateway version and deployment information."
      />

      <Card>
        <CardContent className="flex flex-col gap-3 px-5 py-4">
          <div className="flex items-center gap-2">
            <StatusDot status="success" pulse />
            <span className="flex items-center gap-2">
              <span className="font-medium">CCS Gateway</span>
              <Badge variant="muted" className="font-mono text-[10px]">
                ccs-ts
              </Badge>
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs text-ink-secondary">
            <span>version</span>
            <TabularText className="text-xs">{version}</TabularText>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-ink-secondary">
            <span>
              uptime{" "}
              <TabularText className="text-xs text-ink-primary">{uptime}</TabularText>
            </span>
            <span>
              providers{" "}
              <TabularText className="text-xs text-ink-primary">{providers}</TabularText>
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3 px-5 py-4">
          <h2 className="text-sm font-medium text-ink-primary">Infrastructure</h2>
          <div className="flex flex-col gap-2 text-xs text-ink-secondary">
            <span className="flex items-center justify-between gap-4">
              <span>Listen address</span>
              <TabularText className="text-xs">{listen}</TabularText>
            </span>
            <span className="flex items-center justify-between gap-4">
              <span>Providers count</span>
              <TabularText className="text-xs">{providers}</TabularText>
            </span>
            <span className="flex items-center justify-between gap-4">
              <span>Active provider</span>
              <TabularText className="text-xs">{active}</TabularText>
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3 px-5 py-4">
          <h2 className="text-sm font-medium text-ink-primary">Built with</h2>
          <div className="flex flex-wrap gap-2">
            {tech.map((item) => (
              <Badge key={item} variant="secondary" className="text-xs">
                {item}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      <p className="text-center text-xs text-ink-mute">
        <TabularText className="text-xs">v{version}</TabularText> · Claude Code
        Switch
      </p>
    </div>
  )
}
