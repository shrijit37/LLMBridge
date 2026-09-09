import { useMemo } from "react";
import { KeyRound, ShieldAlert, Sparkles, KeyRoundIcon } from "lucide-react";
import { PageHeader } from "@/components/common/PageHeader";
import { EmptyState } from "@/components/common/EmptyState";
import { Card, CardContent } from "@/components/ui/card";
import { DataTable, TableHead } from "@/components/ui/data-table";
import { TabularText } from "@/components/ui/TabularText";
import { useStats } from "@/hooks/useStats";

const POLICY_ROWS = [
  {
    icon: KeyRound,
    text: "Gateway forwards Authorization / x-api-key to upstream providers unchanged.",
  },
  {
    icon: Sparkles,
    text: "Provider keys are never stored here — they resolve from $ENV variables in config.",
  },
  {
    icon: ShieldAlert,
    text: "No key rotation managed by this gateway; quota_output is captured from a provider quota_command.",
  },
];

export function GatewayKeys() {
  const { data: stats } = useStats();

  const quotaRows = useMemo(
    () => (stats ?? []).filter((s) => s.quota_output != null),
    [stats],
  );

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <PageHeader
        eyebrow="Access"
        title="Gateway Keys"
        description="Quota output snapshots captured from providers that run a quota command."
      />

      <Card>
        <CardContent className="px-5 py-4">
          <h2 className="mb-3 text-sm font-medium">Quota snapshots</h2>
          {quotaRows.length === 0 ? (
            <EmptyState
              icon={KeyRoundIcon}
              heading="No quota snapshots yet"
              description="Configure a provider with quota_command to populate this table."
            />
          ) : (
            <DataTable>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-edge text-left">
                    <TableHead>Provider</TableHead>
                    <TableHead>Quota output</TableHead>
                  </tr>
                </thead>
                <tbody>
                  {quotaRows.map((s) => (
                    <tr
                      key={s.provider_id}
                      className="border-b border-edge-subtle last:border-0 transition-colors hover:bg-surface-hover"
                    >
                      <td className="px-3 py-2.5">
                        <TabularText className="text-xs">{s.provider_name}</TabularText>
                      </td>
                      <td className="px-3 py-2.5">
                        <pre className="whitespace-pre-wrap rounded bg-surface-raised p-3 font-mono text-xs">
                          {s.quota_output}
                        </pre>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </DataTable>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3 px-5 py-4">
          <h2 className="text-sm font-medium">Key policy summary</h2>
          <ul className="flex flex-col gap-2">
            {POLICY_ROWS.map((row) => (
              <li key={row.text} className="flex items-start gap-2">
                <row.icon className="mt-0.5 size-3.5 shrink-0 text-ink-mute" />
                <TabularText className="text-xs text-ink-mute">{row.text}</TabularText>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
