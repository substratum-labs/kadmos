#!/usr/bin/env node
import { runCli } from "../dist/src/cli.js";

try {
  process.stdout.write(runCli(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`kadmos: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
