#!/usr/bin/env bun

/**
 * Creates a git tag for the current version and pushes it.
 * This triggers the release workflow which builds and publishes the binary.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const ROOT = join(import.meta.dir, "..");

// Read version from package.json
const packageJson = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf-8")
);
const version = packageJson.version;
const tag = `v${version}`;

console.log(`Creating release for ${tag}...`);

try {
  // Check if tag already exists
  try {
    execSync(`git rev-parse ${tag}`, { stdio: "pipe" });
    console.log(`Tag ${tag} already exists, skipping release.`);
    process.exit(0);
  } catch {
    // Tag doesn't exist, continue
  }

  // Create and push the tag
  execSync(`git tag ${tag}`, { stdio: "inherit", cwd: ROOT });
  execSync(`git push origin ${tag}`, { stdio: "inherit", cwd: ROOT });

  console.log(`Successfully created and pushed tag ${tag}`);
  console.log(`Release workflow will now build and publish the binary.`);
} catch (error) {
  console.error("Failed to create release:", error);
  process.exit(1);
}
