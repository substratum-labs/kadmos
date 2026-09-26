import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

export function atomicWrite(path: string, content: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* no temporary file was created */ }
    throw error;
  }
}
