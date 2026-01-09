#!/usr/bin/env node

/**
 * Postinstall script - compiles the native Swift recorder on macOS
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

// Check if we're on macOS
if (process.platform !== "darwin") {
  console.log("opendebrief: Skipping native build (macOS only)");
  process.exit(0);
}

// Determine where the native source is
const nativeDir = join(projectRoot, "native");
const distDir = join(projectRoot, "dist");
const swiftSource = join(nativeDir, "recorder.swift");

// Check if source exists
if (!existsSync(swiftSource)) {
  // Try dist directory (for npm install from package)
  const distSwiftSource = join(distDir, "recorder.swift");
  if (existsSync(distSwiftSource)) {
    console.log("opendebrief: Compiling native recorder from dist...");
    try {
      execSync(`swiftc -O -o "${join(distDir, "recorder")}" "${distSwiftSource}"`, {
        stdio: "inherit",
      });
      console.log("opendebrief: Native recorder compiled successfully");
    } catch (error) {
      console.error("opendebrief: Failed to compile native recorder");
      console.error("Make sure you have Xcode Command Line Tools installed:");
      console.error("  xcode-select --install");
      process.exit(1);
    }
  } else {
    console.log("opendebrief: No Swift source found, skipping native build");
  }
  process.exit(0);
}

// Compile from native directory
console.log("opendebrief: Compiling native recorder...");
try {
  execSync(`swiftc -O -o "${join(nativeDir, "recorder")}" "${swiftSource}"`, {
    stdio: "inherit",
  });
  console.log("opendebrief: Native recorder compiled successfully");
} catch (error) {
  console.error("opendebrief: Failed to compile native recorder");
  console.error("Make sure you have Xcode Command Line Tools installed:");
  console.error("  xcode-select --install");
  process.exit(1);
}
