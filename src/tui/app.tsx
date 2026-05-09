import { useState } from "react";
import { Box, useApp } from "ink";
import SelectInput from "ink-select-input";
import Providers from "./providers.js";
import Agents from "./agents.js";
import Plugins from "./plugins.js";
import Logo from "./logo.js";

type View = "menu" | "providers" | "agents" | "plugins";

export default function App() {
  const [view, setView] = useState<View>("menu");
  const { exit } = useApp();

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Logo />
      </Box>
      {view === "menu" && (
        <SelectInput
          items={[
            { label: "Agents", value: "agents" },
            { label: "Providers", value: "providers" },
            { label: "Plugins", value: "plugins" },
            { label: "Quit", value: "quit" },
          ]}
          onSelect={(item) => {
            if (item.value === "quit") exit();
            else setView(item.value as View);
          }}
        />
      )}
      {view === "providers" && <Providers onBack={() => setView("menu")} />}
      {view === "agents" && <Agents onBack={() => setView("menu")} />}
      {view === "plugins" && <Plugins onBack={() => setView("menu")} />}
    </Box>
  );
}
