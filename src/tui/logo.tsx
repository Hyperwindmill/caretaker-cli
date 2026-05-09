import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Box, Text } from "ink";
import BigText from "ink-big-text";

const ANS_PATH = fileURLToPath(new URL("../../assets/logo.ans", import.meta.url));
const LOGO_ANS = readFileSync(ANS_PATH, "utf8");

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
      <BigText text="caretaker" font="block" colors={["#1FA3E5"]} letterSpacing={0} space={false} />
    </Box>
  );
}
