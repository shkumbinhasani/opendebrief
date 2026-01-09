#!/usr/bin/env bun

/**
 * Syncs the version from package.json to src/version.ts
 * Run after changeset version to keep them in sync
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

// Read version from package.json
const packageJson = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf-8")
);
const version = packageJson.version;

// Write to src/version.ts
const versionTs = `// Version information - auto-generated, do not edit manually
export const VERSION = "${version}";
export const PACKAGE_NAME = "opendebrief";
`;

writeFileSync(join(ROOT, "src/version.ts"), versionTs);

console.log(`Synced version to ${version}`);
