import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { compileWorldSpec, parseWorldSpec } from "../src/world_compiler.js";

const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
const skill = readFileSync(new URL("../../skills/kadmos/SKILL.md", import.meta.url), "utf8");
const worldSource = readme.match(/```yaml\n([\s\S]*?)\n```/)?.[1];
const examples = [
  ["README", readme.match(/### 3\. Fabric Under Governance[\s\S]*?```typescript\n([\s\S]*?)\n```/)?.[1]],
  ["copied skill", skill.match(/### Phase 4: Fabric Implementation Under Gatekeeper[\s\S]*?```typescript\n([\s\S]*?)\n```/)?.[1]],
] as const;

test("README World compiles and authorizes its documented payment", () => {
  assert.ok(worldSource, "README World YAML fence");
  const world = parseWorldSpec(worldSource);
  const confirm = world.transitions.find((entry) => entry.id === "CONFIRM_PAYMENT");
  assert.ok(confirm);
  assert.equal(confirm.directive, null);
  assert.equal(world.context.order_amount?.default, 5000);
});

for (const [label, exampleSource] of examples) {
  test(`${label} Fabric example preserves prior acceptance and recovers its queue after failure`, async () => {
    assert.ok(worldSource);
    assert.ok(exampleSource, `${label} TypeScript Fabric fence`);
    const projection = compileWorldSpec(parseWorldSpec(worldSource));
    const directory = mkdtempSync(join(tmpdir(), "kadmos-public-example-"));
    try {
      mkdirSync(join(directory, "world"));
      writeFileSync(join(directory, "package.json"), '{"type":"module"}');
      writeFileSync(join(directory, "world", "ports.d.ts"), projection.portsDts);
      writeFileSync(join(directory, "world", "world_checker.ts"), projection.worldCheckerTs);
      writeFileSync(join(directory, "example.ts"), exampleSource);
      const compile = spawnSync(process.execPath, [join(process.cwd(), "node_modules/typescript/bin/tsc"),
        "--ignoreConfig", "--strict", "--skipLibCheck", "--target", "ES2022", "--module", "NodeNext",
        "--moduleResolution", "NodeNext", "--typeRoots", join(process.cwd(), "node_modules/@types"),
        "--types", "node", join(directory, "world/ports.d.ts"), join(directory, "world/world_checker.ts"), join(directory, "example.ts"),
      ], { encoding: "utf8" });
      assert.equal(compile.status, 0, `${compile.stdout}\n${compile.stderr}`);
      const moduleUrl = pathToFileURL(join(directory, "example.js")).href;
      const accepted = await import(`${moduleUrl}?case=accepted`);
      let writes = 0;
      await accepted.processPayment("one", 5000, async () => { writes++; });
      await assert.rejects(accepted.processPayment("two", 5000, async () => { writes++; }), /Gatekeeper/);
      assert.equal(writes, 1);
      assert.equal(accepted.checker.getState(), "PAID");

      const recovered = await import(`${moduleUrl}?case=recovered`);
      const calls: string[] = [];
      let rejectPersist: ((error: Error) => void) | undefined;
      const held = new Promise<void>((_resolve, reject) => { rejectPersist = reject; });
      const first = recovered.processPayment("first", 5000, async () => { calls.push("first"); await held; });
      const firstOutcome = first.then(() => "resolved", (error: Error) => error.message);
      const second = recovered.processPayment("second", 5000, async () => { calls.push("second"); });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(calls, ["first"]);
      rejectPersist!(new Error("persist failed"));
      assert.equal(await firstOutcome, "persist failed");
      await second;
      assert.deepEqual(calls, ["first", "second"]);
      assert.equal(recovered.checker.getState(), "PAID");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
