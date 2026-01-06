#!/usr/bin/env bun

/**
 * Creates a git tag and GitHub release for the current version.
 * The changesets workflow will then build and upload the binary.
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
  // Fetch remote tags to ensure we have the latest
  execSync(`git fetch --tags`, { stdio: "pipe", cwd: ROOT });

  // Check if tag already exists (locally or remote)
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

  // Create GitHub release (or update if it exists)
  try {
    execSync(`gh release create ${tag} --title "${tag}" --generate-notes`, {
      stdio: "inherit",
      cwd: ROOT,
    });
  } catch {
    // Release might already exist, that's ok
    console.log(`Release ${tag} may already exist, continuing...`);
  }

  console.log(`Successfully created release ${tag}`);
} catch (error) {
  console.error("Failed to create release:", error);
  process.exit(1);
}
