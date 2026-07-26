import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Box, Text } from 'ink';

const ANS_PATH = fileURLToPath(new URL('../../assets/logo.ans', import.meta.url));
const LOGO_ANS = readFileSync(ANS_PATH, 'utf8');

// Static banner (figlet "ANSI Shadow", MIT) embedded at authoring time.
// This used to be ink-big-text at runtime, but that pulls in cfonts, which is
// GPL-3.0 — not shippable inside the FSL-licensed Electron installers. A
// banner never changes; it does not need a rendering library in the prod tree.
const WORDMARK = ` ██████╗ █████╗ ██████╗ ███████╗████████╗ █████╗ ██╗  ██╗███████╗██████╗
██╔════╝██╔══██╗██╔══██╗██╔════╝╚══██╔══╝██╔══██╗██║ ██╔╝██╔════╝██╔══██╗
██║     ███████║██████╔╝█████╗     ██║   ███████║█████╔╝ █████╗  ██████╔╝
██║     ██╔══██║██╔══██╗██╔══╝     ██║   ██╔══██║██╔═██╗ ██╔══╝  ██╔══██╗
╚██████╗██║  ██║██║  ██║███████╗   ██║   ██║  ██║██║  ██╗███████╗██║  ██║
 ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝`;

export default function Logo() {
  return (
    <Box
      flexDirection="row"
      alignItems="center"
      borderStyle="round"
      borderColor="#1FA3E5"
      paddingX={1}
    >
      <Box marginRight={2}>
        <Text>{LOGO_ANS}</Text>
      </Box>
      <Text color="#1FA3E5">{WORDMARK}</Text>
    </Box>
  );
}
