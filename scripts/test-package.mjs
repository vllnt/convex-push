// Package test. Run after `pnpm build`.
// 1. The tarball file list: docs consumers and coding agents read from
//    node_modules ship, contributor-only files do not, and llms.txt links
//    resolve inside the tarball.
// 2. The packed tarball installs in a throwaway consumer (low end of the convex
//    peer range) under the repo's release-age gate, every entry point imports
//    or type-checks under strict settings, and the `./test` helper mounts the
//    component in convex-test beside a host table of its own.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

const root = process.cwd();
const metadata = JSON.parse(readFileSync("package.json", "utf8"));
const { name, version, packageManager } = metadata;
if (typeof name !== "string" || typeof version !== "string")
  throw new Error("invalid package metadata");
if (
  !existsSync("dist/client/index.js") ||
  !existsSync("dist/component/convex.config.js")
) {
  throw new Error("dist/ is missing: run `pnpm build` first");
}
const releaseAge = readFileSync("pnpm-workspace.yaml", "utf8");
if (
  !/^minimumReleaseAge: \d+$/mu.test(releaseAge) ||
  !releaseAge.includes("minimumReleaseAgeExclude:")
) {
  throw new Error("pnpm-workspace.yaml lacks the release-age gate");
}

// --- 1. Tarball file list -------------------------------------------------
const REQUIRED = [
  "package.json",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "llms.txt",
  "docs/API.md",
  "src/client/index.ts",
  "src/test.ts",
  "dist/client/index.js",
  "dist/client/index.d.ts",
  "dist/component/convex.config.js",
  "dist/component/convex.config.d.ts",
  "dist/component/_generated/component.d.ts",
];
const FORBIDDEN = [
  /^AGENTS\.md$/,
  /^CLAUDE\.md$/,
  /^pnpm-workspace\.yaml$/,
  /^docs\/(?!API\.md$)/,
  /^specs\//,
  /^scripts\//,
  /^example\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)testing\//,
];
const REPO_BLOB =
  /^https:\/\/github\.com\/vllnt\/convex-push\/blob\/[^/]+\/(.+)$/;

const output = execFileSync("pnpm", ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
});
const packed = new Set(JSON.parse(output).files.map((file) => file.path));

const errors = [];
for (const path of REQUIRED) {
  if (!packed.has(path)) errors.push(`missing from tarball: ${path}`);
}
for (const path of packed) {
  if (FORBIDDEN.some((pattern) => pattern.test(path)))
    errors.push(`must not ship: ${path}`);
}
for (const [, target] of readFileSync("llms.txt", "utf8").matchAll(
  /\]\(([^)\s]+)\)/g,
)) {
  const blob = REPO_BLOB.exec(target);
  if (blob && packed.has(blob[1])) {
    errors.push(`llms.txt: ${target} ships in the tarball; link ./${blob[1]}`);
  }
  if (/^[a-z]+:/i.test(target) || target.startsWith("#")) continue;
  const path = target.split("#")[0].replace(/^\.\//, "");
  if (!packed.has(path))
    errors.push(`llms.txt: ${target} is not in the tarball`);
}
if (errors.length > 0) {
  for (const error of errors) console.error(`FAIL ${error}`);
  process.exit(1);
}
console.log(
  `OK    package: ${packed.size} files, required files present, llms.txt links resolve`,
);

// --- 2. Install and use the packed tarball --------------------------------
const tarball = `${name.replace("@", "").replace("/", "-")}-${version}.tgz`;
const temporary = mkdtempSync(join(tmpdir(), "push-consumer-"));
/** @param {string} command @param {string[]} args */
const run = (command, args, cwd = temporary) =>
  execFileSync(command, args, { cwd, stdio: "inherit" });
/** @param {Record<string, string>} files */
const write = (files) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(temporary, path)), { recursive: true });
    writeFileSync(join(temporary, path), text);
  }
};
/** @param {"ESNext" | "NodeNext"} module @param {string[]} files */
const typecheck = (module, files) =>
  run("pnpm", [
    "exec",
    "tsc",
    "--noEmit",
    "--strict",
    "--module",
    module,
    "--moduleResolution",
    module === "NodeNext" ? "NodeNext" : "Bundler",
    "--target",
    "ES2022",
    "--lib",
    "ES2023,DOM",
    "--types",
    "vite/client,node",
    ...files,
  ]);

try {
  run("pnpm", ["pack", "--pack-destination", temporary], root);
  write({
    "package.json": JSON.stringify({
      packageManager,
      pnpm: { ignoredBuiltDependencies: ["esbuild"] },
      private: true,
      type: "module",
    }),
    // No lockfile here, so pnpm picks versions itself: the repo's release-age gate
    // (pnpm 10 reads it from this file, not from package.json) applies as is.
    "pnpm-workspace.yaml": releaseAge,
  });
  // Low end of the convex peer range; the test toolchain a consumer would use.
  run("pnpm", [
    "add",
    join(temporary, tarball),
    "convex@1.47.0",
    "convex-test@0.0.73",
    "typescript@5.9.3",
    "vite@8.3.8",
    "vitest@5.1.1",
    "@edge-runtime/vm@5.0.0",
    "@types/node@22.20.2",
  ]);

  // Agents read the bundled docs from node_modules, so they must install.
  const installed = join(temporary, "node_modules", name);
  const docs = [
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
    "llms.txt",
    "docs/API.md",
  ];
  const missing = docs.filter((file) => !existsSync(join(installed, file)));
  if (missing.length > 0)
    throw new Error(`installed package is missing ${missing.join(", ")}`);

  // Runtime entry points in plain Node. `./test` needs Vite and runs under vitest
  // below. `./convex.config` calls `use()`, which throws outside the Convex runtime
  // (also under vitest), so the consumer type-checks it with `app.use(config)`.
  run("node", [
    "--input-type=module",
    "-e",
    `
const client = await import("${name}");
const meta = (await import("${name}/package.json", { with: { type: "json" } })).default;
if (typeof client.Push !== "function" || typeof client.deviceAddress !== "object" || meta.name !== "${name}")
  throw new Error("missing export");
`,
  ]);

  write({
    "vitest.config.mts": `
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { environment: "edge-runtime", server: { deps: { inline: ["convex-test", "${name}"] } } },
});
`,
    "convex/schema.ts": `
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
export default defineSchema({ notes: defineTable({ body: v.string() }) });
`,
    // The part of `convex codegen` output the test needs: one mount of the component.
    "convex/_generated/api.ts": `
import type { ComponentApi } from "${name}/_generated/component";
import { componentsGeneric } from "convex/server";
export const components = componentsGeneric() as unknown as { push: ComponentApi };
`,
    // register(t) at runtime beside a host table, then a real call through the client.
    "convex/host.test.ts": `
/// <reference types="vite/client" />
import { Push } from "${name}";
import { register } from "${name}/test";
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { components } from "./_generated/api";
import schema from "./schema";

test("the installed package mounts beside a host table and registers a device", async () => {
  const t = convexTest(schema, import.meta.glob("./**/*.ts"));
  register(t);
  const push = new Push(components.push, { apps: { android: { platform: "fcm" } } });
  await t.run(async (ctx) => {
    await ctx.db.insert("notes", { body: "host row" });
  });
  const result = await t.run(async (ctx) =>
    push.register(ctx, { subjectRef: "user_1", appRef: "android", address: { platform: "fcm", token: "t1" } }),
  );
  expect(result.created).toBe(true);
  const devices = await t.run(async (ctx) => push.listDevices(ctx, { subjectRef: "user_1" }));
  expect(devices.map((device) => device.deviceId)).toEqual([result.deviceId]);
  const notes = await t.run(async (ctx) => ctx.db.query("notes").collect());
  expect(notes.map((note) => note.body)).toEqual(["host row"]);
});
`,
    // Strict consumer: the client surface, both component type paths, the config.
    "consumer.ts": `
import { Push, deliveryEvent, type DeliveryEvent, type DeviceAddress, type PushOptions } from "${name}";
import type { ComponentApi } from "${name}/_generated/component";
import type { ComponentApi as ComponentApiJs } from "${name}/_generated/component.js";
import config from "${name}/convex.config";
import configJs from "${name}/convex.config.js";
import { defineApp } from "convex/server";
declare const component: ComponentApi;
const sameApi: ComponentApiJs = component;
const options: PushOptions = { apps: { ios: { platform: "apns", topic: "com.example.app", environment: "production" } } };
const push = new Push(sameApi, options);
const address: DeviceAddress = { platform: "apns", token: "t" };
const app = defineApp();
app.use(config);
app.use(configJs, { name: "pushPartner" });
export const describe = (event: DeliveryEvent): string => event.status;
void push; void address; void deliveryEvent;
`,
    // register accepts a host schema with its own tables and a custom mount name.
    "registration.ts": `
import { register } from "${name}/test";
import { convexTest } from "convex-test";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
const host = defineSchema({ notes: defineTable({ body: v.string() }) });
register(convexTest(host, {}), "custom");
`,
  });
  typecheck("ESNext", [
    "consumer.ts",
    "registration.ts",
    "convex/host.test.ts",
  ]);
  // `./test` ships TypeScript source, so it must also compile for NodeNext consumers.
  typecheck("NodeNext", ["consumer.ts", "registration.ts"]);
  run("pnpm", ["exec", "vitest", "run"]);
  console.log(
    `OK    package test: ${name}@${version} installs, imports, type-checks and mounts`,
  );
} finally {
  rmSync(temporary, { force: true, recursive: true });
}
