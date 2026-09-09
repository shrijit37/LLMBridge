import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface KeyValueEditorProps {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  keyPlaceholder?: string;
  valPlaceholder?: string;
}

export function KeyValueEditor({
  value,
  onChange,
  keyPlaceholder = "key",
  valPlaceholder = "value",
}: KeyValueEditorProps) {
  const entries = Object.entries(value);

  const update = (oldKey: string, newKey: string, newVal: string) => {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === oldKey) {
        if (newKey.trim()) next[newKey.trim()] = newVal;
      } else {
        next[k] = v;
      }
    }
    onChange(next);
  };

  const remove = (key: string) => {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k !== key) next[k] = v;
    }
    onChange(next);
  };

  const add = () => {
    let hint = "key";
    let i = 1;
    while (hint in value) {
      hint = `key_${i++}`;
    }
    onChange({ ...value, [hint]: "" });
  };

  return (
    <div className="flex flex-col gap-2">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-center gap-2">
          <Input
            className="flex-1"
            value={k}
            placeholder={keyPlaceholder}
            onChange={(e) => update(k, e.target.value, v)}
          />
          <Input
            className="flex-1"
            value={v}
            placeholder={valPlaceholder}
            onChange={(e) => update(k, k, e.target.value)}
          />
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => remove(k)}
            aria-label={`Remove ${k}`}
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      ))}
      <div>
        <Button variant="ghost" size="xs" onClick={add}>
          <Plus className="size-3" /> Add
        </Button>
      </div>
    </div>
  );
}
