// Process-wide ToolRegistry singleton. Built-ins are registered at module
// load. Future MCP-adapted tools will be registered here too (likely via
// an async init driven by caretaker.json's mcpServers list).
//
// Importing this from anywhere in the app yields the same registry — the
// agent form uses it to render the tool picker, and the chat screen uses
// it to filter per agent. ToolRegistry tests don't depend on this
// singleton; they instantiate their own.
//
// Note: this module registers builtins as a one-time side effect at load.
// If a future test cache-busts this module and re-imports it (e.g. via a
// `?cb=…` query string), the registry will throw "tool already registered".
// Tests should import individual tool files (e.g. ./builtin/bash.js)
// directly or instantiate their own ToolRegistry rather than depend on
// this singleton.

import { ToolRegistry } from "./registry.js";
import { registerBuiltins } from "./builtin/index.js";

export const tools = new ToolRegistry();
registerBuiltins(tools);
