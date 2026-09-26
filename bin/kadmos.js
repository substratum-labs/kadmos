#!/usr/bin/env node
import { runCli } from "../dist/src/cli.js";

try {
  const output = await runCli(process.argv.slice(2));
  process.stdout.write(output);
  if (process.argv[2] === "run" && !process.argv.includes("--dry-run") && JSON.parse(output).success === false) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`kadmos: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
