import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import {
  createMcpServer,
  deleteMcpServer,
  listMcpServers,
  patchMcpServer,
  type CreateMcpServerInput,
  type PatchMcpServerInput,
} from "../mcp/server_manager.js";
import { isEncrypted } from "../lib/encryption.js";
import type { McpServerConfig, McpTransport } from "../types.js";

type Mode = "list" | "detail" | "create" | "edit" | "delete";

export default function McpServers({ onBack }: { onBack: () => void }) {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState<Mode>("list");
  const [selected, setSelected] = useState<McpServerConfig | null>(null);

  const reload = async (): Promise<McpServerConfig[]> => {
    const s = await listMcpServers();
    setServers(s);
    return s;
  };

  useEffect(() => {
    void reload().then(() => setLoaded(true));
  }, []);

  if (!loaded) return <Text dimColor>loading…</Text>;

  if (mode === "create") {
    return (
      <ServerForm
        onCancel={() => setMode("list")}
        onSave={async (input) => {
          const created = await createMcpServer(input as CreateMcpServerInput);
          await reload();
          setSelected(created);
          setMode("detail");
        }}
      />
    );
  }

  if (mode === "edit" && selected) {
    return (
      <ServerForm
        initial={selected}
        onCancel={() => setMode("detail")}
        onSave={async (input) => {
          const patched = await patchMcpServer(selected.id, input as PatchMcpServerInput);
          if (patched) {
            await reload();
            setSelected(patched);
          }
          setMode("detail");
        }}
      />
    );
  }

  if (mode === "delete" && selected) {
    return (
      <Box flexDirection="column">
        <Text>Delete MCP server "{selected.name}"?</Text>
        <Box marginTop={1}>
          <SelectInput
            items={[
              { label: "No, cancel", value: "no" },
              { label: "Yes, delete", value: "yes" },
            ]}
            onSelect={async (item) => {
              if (item.value === "no") return setMode("detail");
              await deleteMcpServer(selected.id);
              await reload();
              setSelected(null);
              setMode("list");
            }}
          />
        </Box>
      </Box>
    );
  }

  if (mode === "detail" && selected) {
    const headerCount = selected.headers ? Object.keys(selected.headers).length : 0;
    const envCount = selected.env ? Object.keys(selected.env).length : 0;
    return (
      <Box flexDirection="column">
        <Text bold>{selected.name}</Text>
        <Text>transport:       {selected.transport}</Text>
        <Text>enabled:         {selected.enabled ? "yes" : "no"}</Text>
        {selected.transport === "stdio" && (
          <>
            <Text>command:         {selected.command ?? "(none)"}</Text>
            <Text>args:            {selected.args && selected.args.length > 0 ? selected.args.join(" ") : "(none)"}</Text>
            <Text>env:             {envCount > 0 ? `${envCount} entr${envCount === 1 ? "y" : "ies"}` : "(none)"}</Text>
          </>
        )}
        {selected.transport === "http" && (
          <>
            <Text>url:             {selected.url ?? "(none)"}</Text>
            <Text>headers:         {headerCount > 0 ? `${headerCount} (encrypted)` : "(none)"}</Text>
          </>
        )}
        <Text>lastConnected:   {selected.lastConnectedAt ?? "(never)"}</Text>
        {selected.lastConnectError && (
          <Text color="red">lastError:       {selected.lastConnectError.slice(0, 200)}</Text>
        )}

        <Box marginTop={1}>
          <SelectInput
            items={[
              { label: "Edit", value: "edit" },
              { label: "Delete", value: "delete" },
              { label: "← Back", value: "back" },
            ]}
            onSelect={(item) => {
              if (item.value === "edit") return setMode("edit");
              if (item.value === "delete") return setMode("delete");
              setMode("list");
            }}
          />
        </Box>
      </Box>
    );
  }

  const items = [
    ...servers.map((s) => {
      const where = s.transport === "stdio" ? s.command ?? "(no command)" : s.url ?? "(no url)";
      const flag = s.enabled ? "" : " [disabled]";
      return { label: `${s.transport.padEnd(5)} ${s.name} — ${where}${flag}`, value: `s:${s.id}` };
    }),
    { label: "+ Create new", value: "__new__" },
    { label: "← Back", value: "__back__" },
  ];

  return (
    <Box flexDirection="column">
      <Text bold>MCP servers ({servers.length})</Text>
      <Box marginTop={1}>
        <SelectInput
          items={items}
          onSelect={(item) => {
            if (item.value === "__back__") return onBack();
            if (item.value === "__new__") return setMode("create");
            const id = item.value.replace(/^s:/, "");
            const s = servers.find((x) => x.id === id);
            if (s) {
              setSelected(s);
              setMode("detail");
            }
          }}
        />
      </Box>
    </Box>
  );
}

// ─── Form ───────────────────────────────────────────────────────────────

type FormStep =
  | "transport"
  | "name"
  | "command"
  | "args"
  | "env"
  | "url"
  | "headers"
  | "enabled";

interface FormResult {
  name: string;
  transport: McpTransport;
  enabled: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  /** Headers as Record<string,string>; undefined = leave unchanged in edit mode. */
  headers?: Record<string, string>;
}

function parseKeyValueLines(raw: string, sep: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(",")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(sep);
    if (idx <= 0) continue;
    const k = trimmed.slice(0, idx).trim();
    const v = trimmed.slice(idx + sep.length).trim();
    if (k) out[k] = v;
  }
  return out;
}

function formatEnv(env: Record<string, string> | undefined): string {
  if (!env) return "";
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

function formatHeadersDisplay(headers: Record<string, string> | undefined): string {
  // We never echo encrypted blobs back into the input. Show "(encrypted)"
  // for each preserved value, plain for user-typed plaintext lines.
  if (!headers) return "";
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${isEncrypted(v) ? "(encrypted)" : v}`)
    .join(", ");
}

function ServerForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: McpServerConfig;
  onSave: (input: FormResult) => void | Promise<void>;
  onCancel: () => void;
}) {
  const isEdit = !!initial;
  const [step, setStep] = useState<FormStep>(isEdit ? "name" : "transport");
  const [transport, setTransport] = useState<McpTransport>(initial?.transport ?? "stdio");
  const [name, setName] = useState(initial?.name ?? "");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [args, setArgs] = useState((initial?.args ?? []).join(" "));
  const [env, setEnv] = useState(formatEnv(initial?.env));
  const [url, setUrl] = useState(initial?.url ?? "");
  // Headers: in edit mode we DON'T preload values (the on-disk values are
  // ciphertext), only the keys. The user re-types tokens to update them.
  const [headers, setHeaders] = useState(
    initial?.headers
      ? Object.keys(initial.headers)
          .map((k) => `${k}: `)
          .join(", ")
      : "",
  );
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);

  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  const buildResult = (enabledValue: boolean): FormResult => {
    const result: FormResult = {
      name: name.trim(),
      transport,
      enabled: enabledValue,
    };
    if (transport === "stdio") {
      result.command = command.trim();
      result.args = args.trim() ? args.trim().split(/\s+/) : [];
      result.env = env.trim() ? parseKeyValueLines(env, "=") : {};
    } else {
      result.url = url.trim();
      // Merge: keep existing headers whose key is mentioned with empty value
      // (= unchanged), apply new key:value pairs that have a value.
      const typed = parseKeyValueLines(headers, ":");
      const merged: Record<string, string> = {};
      if (initial?.headers) {
        for (const [k, v] of Object.entries(initial.headers)) {
          // Preserve the (already-encrypted) value when the user did not
          // re-type a value for this key.
          if (k in typed && typed[k] === "") merged[k] = v;
        }
      }
      for (const [k, v] of Object.entries(typed)) {
        if (v !== "") merged[k] = v;
      }
      result.headers = merged;
    }
    return result;
  };

  const advance = () => {
    setError(null);
    if (step === "transport") return setStep("name");
    if (step === "name") {
      if (!name.trim()) return setError("name is required");
      return setStep(transport === "stdio" ? "command" : "url");
    }
    if (step === "command") {
      if (!command.trim()) return setError("command is required");
      return setStep("args");
    }
    if (step === "args") return setStep("env");
    if (step === "env") return setStep("enabled");
    if (step === "url") {
      if (!url.trim()) return setError("url is required");
      try {
        new URL(url);
      } catch {
        return setError("url must be a valid URL");
      }
      return setStep("headers");
    }
    if (step === "headers") return setStep("enabled");
  };

  return (
    <Box flexDirection="column">
      <Text bold>{isEdit ? `Edit MCP server "${initial!.name}"` : "New MCP server"}</Text>

      <Box marginTop={1}>
        <Text>transport:  </Text>
        {step === "transport" ? (
          <SelectInput
            items={[
              { label: "stdio (spawn a subprocess)", value: "stdio" },
              { label: "http (Streamable HTTP)", value: "http" },
            ]}
            onSelect={(item) => {
              setTransport(item.value as McpTransport);
              setStep("name");
            }}
          />
        ) : (
          <Text>{transport}</Text>
        )}
      </Box>

      <Box>
        <Text>name:       </Text>
        {step === "name" ? (
          <TextInput value={name} onChange={setName} onSubmit={advance} placeholder="github" />
        ) : step === "transport" ? (
          <Text dimColor>(pending)</Text>
        ) : (
          <Text>{name}</Text>
        )}
      </Box>

      {transport === "stdio" && (
        <>
          <Box>
            <Text>command:    </Text>
            {step === "command" ? (
              <TextInput value={command} onChange={setCommand} onSubmit={advance} placeholder="npx" />
            ) : ["transport", "name"].includes(step) ? (
              <Text dimColor>(pending)</Text>
            ) : (
              <Text>{command}</Text>
            )}
          </Box>
          <Box>
            <Text>args:       </Text>
            {step === "args" ? (
              <TextInput
                value={args}
                onChange={setArgs}
                onSubmit={advance}
                placeholder="-y @modelcontextprotocol/server-github"
              />
            ) : ["transport", "name", "command"].includes(step) ? (
              <Text dimColor>(pending)</Text>
            ) : (
              <Text>{args || "(none)"}</Text>
            )}
          </Box>
          <Box>
            <Text>env:        </Text>
            {step === "env" ? (
              <TextInput
                value={env}
                onChange={setEnv}
                onSubmit={advance}
                placeholder="KEY=value, OTHER=x"
              />
            ) : ["transport", "name", "command", "args"].includes(step) ? (
              <Text dimColor>(pending)</Text>
            ) : (
              <Text>{env || "(none)"}</Text>
            )}
          </Box>
        </>
      )}

      {transport === "http" && (
        <>
          <Box>
            <Text>url:        </Text>
            {step === "url" ? (
              <TextInput
                value={url}
                onChange={setUrl}
                onSubmit={advance}
                placeholder="https://mcp.example.com/v1"
              />
            ) : ["transport", "name"].includes(step) ? (
              <Text dimColor>(pending)</Text>
            ) : (
              <Text>{url}</Text>
            )}
          </Box>
          <Box>
            <Text>headers:    </Text>
            {step === "headers" ? (
              <TextInput
                value={headers}
                onChange={setHeaders}
                onSubmit={advance}
                placeholder="Authorization: Bearer xyz, X-Other: val"
              />
            ) : ["transport", "name", "url"].includes(step) ? (
              <Text dimColor>(pending)</Text>
            ) : (
              <Text>
                {initial?.headers && Object.keys(initial.headers).length > 0
                  ? `${Object.keys(initial.headers).length} (existing values masked)`
                  : headers || "(none)"}
              </Text>
            )}
          </Box>
          {step === "headers" && (
            <Box marginTop={1}>
              <Text dimColor>
                {isEdit
                  ? "Hint: leave a key's value empty to keep its existing (encrypted) value."
                  : "Each value is encrypted on save with the on-disk key."}
              </Text>
            </Box>
          )}
        </>
      )}

      <Box>
        <Text>enabled:    </Text>
        {step === "enabled" ? (
          <SelectInput
            items={[
              { label: "yes", value: "yes" },
              { label: "no — keep config but skip at connect time", value: "no" },
            ]}
            initialIndex={enabled ? 0 : 1}
            onSelect={(item) => {
              const v = item.value === "yes";
              setEnabled(v);
              setTimeout(() => void onSave(buildResult(v)), 0);
            }}
          />
        ) : (
          <Text dimColor>(pending)</Text>
        )}
      </Box>

      {error && (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>(esc to cancel)</Text>
      </Box>
    </Box>
  );
}
