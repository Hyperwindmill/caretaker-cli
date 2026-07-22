// CLI entry: dispatch based on argv.
//   `caretaker`                   → render the Ink TUI (default)
//   `caretaker run [prompt...]`   → headless one-shot via the harness
//   `caretaker --help|-h`         → commander's help
//   `caretaker --version|-v`      → prints the CLI version (from package.json)
//
// More subcommands (web, exec, session, agent, plugin, …) plug in
// alongside `run` via `program.command(…)`.

import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { createElement } from 'react';
import { render } from 'ink';
import App from '../tui/app.js';
import { runCommand, type OutputFormat } from './run.js';

export async function runCli(argv: string[]): Promise<void> {
  // No subcommand and no flags → TUI. Anything else flows through commander
  // so `--help`, `--version|-v` and unknown-command diagnostics behave normally.
  if (argv.length <= 2) {
    // Wait for Ink to unmount (ESC / Quit call useApp().exit()), then force the
    // process down. Without this the event loop stays alive on background boot
    // handles (MCP pool, model-limits fetch, refresh-on-start) and the TUI
    // appears frozen after exit until the user hits Ctrl+C.
    const { waitUntilExit } = render(createElement(App));
    await waitUntilExit();
    process.exit(0);
  }

  // Read the version from package.json at runtime (relative to this module, not
  // the CWD) so it tracks the single Changesets-managed version without a static
  // JSON import that would break tsc's rootDir constraint.
  const { version } = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { version: string };

  const program = new Command();
  program
    .name('caretaker-cli')
    .description('Caretaker — TUI agent harness with subcommands for scripting.')
    .version(version, '-v, --version', 'output the CLI version and exit');

  program
    .command('run [prompt...]')
    .description('Run an agent headlessly with a one-shot prompt.')
    .option('-a, --agent <name>', 'agent to run (auto-picks when exactly one exists)')
    .option('-t, --tools <list>', "comma-separated tool names, overriding the agent's allowedTools")
    .option(
      '-o, --output <format>',
      'output format: plain (streaming text) or json (final blob)',
      'plain',
    )
    .action(
      async (
        promptParts: string[] | undefined,
        opts: { agent?: string; tools?: string; output?: OutputFormat },
      ) => {
        const prompt = (promptParts ?? []).join(' ').trim();
        const code = await runCommand(prompt, opts);
        process.exit(code);
      },
    );

  program
    .command('web')
    .description('Launch the Caretaker web server local-first GUI.')
    .option('-p, --port <number>', 'Port to listen on', '3000')
    .option('-h, --host <string>', 'Host to bind to', '127.0.0.1')
    .action(async (opts: { port: string; host: string }) => {
      const { startServer } = await import('./web/server.js');
      await startServer(parseInt(opts.port, 10), opts.host);
    });

  program
    .command('mcp')
    .description('Serve the caretaker task/project tools over stdio for an external MCP client.')
    .action(async () => {
      const { startMcpStdioServer } = await import('./mcp.js');
      await startMcpStdioServer();
    });

  const config = program.command('config').description('Configure caretaker integrations.');
  config
    .command('claude')
    .description("Register caretaker's MCP server in your Claude Code config (user scope).")
    .action(async () => {
      const { configureClaude } = await import('./config_claude.js');
      process.exit(await configureClaude());
    });

  await program.parseAsync(argv);
}
