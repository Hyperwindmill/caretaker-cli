// CLI entry: dispatch based on argv.
//   `caretaker`                   → render the Ink TUI (default)
//   `caretaker run [prompt...]`   → headless one-shot via the harness
//   `caretaker --help|-h`         → commander's help
//
// More subcommands (web, exec, session, agent, plugin, …) plug in
// alongside `run` via `program.command(…)`.

import { Command } from 'commander';
import { createElement } from 'react';
import { render } from 'ink';
import App from '../tui/app.js';
import { runCommand, type OutputFormat } from './run.js';

export async function runCli(argv: string[]): Promise<void> {
  // No subcommand and no flags → TUI. Anything else flows through commander
  // so `--help`, `--version` and unknown-command diagnostics behave normally.
  if (argv.length <= 2) {
    render(createElement(App));
    return;
  }

  const program = new Command();
  program
    .name('caretaker-cli')
    .description('Caretaker — TUI agent harness with subcommands for scripting.');

  program
    .command('run [prompt...]')
    .description('Run an agent headlessly with a one-shot prompt.')
    .option('-a, --agent <name>', 'agent to run (auto-picks when exactly one exists)')
    .option(
      '-t, --tools <list>',
      "comma-separated tool names, overriding the agent's allowedTools",
    )
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

  await program.parseAsync(argv);
}
