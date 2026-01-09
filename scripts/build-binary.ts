#!/usr/bin/env bun

/**
 * Build script for opendebrief native binaries
 * Creates standalone executables for distribution via GitHub Releases
 */

import { $ } from "bun";
import { mkdir, readFile, writeFile, copyFile, rm } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

const projectRoot = process.cwd();
const distDir = join(projectRoot, "dist");
const nativeDir = join(projectRoot, "native");

type Target = "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64";

const BUN_TARGETS: Record<Target, string> = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64",
  "linux-arm64": "bun-linux-arm64",
  "linux-x64": "bun-linux-x64",
};

async function syncVersion() {
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const versionTs = `// Version information - auto-generated at build time
export const VERSION = "${pkg.version}";
export const PACKAGE_NAME = "${pkg.name}";
`;
  await writeFile("src/version.ts", versionTs);
  return pkg.version;
}

async function buildBinary(target: Target): Promise<string> {
  const bunTarget = BUN_TARGETS[target];
  const outputName = target.startsWith("darwin") ? "opendebrief" : "opendebrief";
  const outputPath = join(distDir, target, outputName);

  console.log(`  Building for ${target}...`);

  await mkdir(join(distDir, target), { recursive: true });

  // Compile to standalone binary
  await $`bun build src/cli.ts --compile --target=${bunTarget} --outfile=${outputPath}`.quiet();

  return outputPath;
}

async function compileSwiftRecorder(targetDir: string): Promise<void> {
  const swiftSource = join(nativeDir, "recorder.swift");
  const outputPath = join(targetDir, "recorder");

  if (!existsSync(swiftSource)) {
    console.log("    Warning: recorder.swift not found");
    return;
  }

  try {
    await $`swiftc -O -o ${outputPath} ${swiftSource}`.quiet();
    console.log("    Swift recorder compiled");
  } catch (error) {
    console.log("    Warning: Failed to compile Swift recorder");
  }
}

async function createArchive(target: Target, version: string): Promise<string> {
  const targetDir = join(distDir, target);
  const archiveName = `opendebrief-v${version}-${target}${target.startsWith("linux") ? ".tar.gz" : ".zip"}`;
  const archivePath = join(distDir, archiveName);

  console.log(`  Creating ${archiveName}...`);

  if (target.startsWith("linux")) {
    await $`tar -czvf ${archivePath} -C ${targetDir} .`.quiet();
  } else {
    await $`cd ${targetDir} && zip -r ${archivePath} .`.quiet();
  }

  return archivePath;
}

async function prepareNpmPackages(version: string, targets: Target[]) {
  const npmDir = join(projectRoot, "npm");
  
  console.log("\n4. Preparing npm packages...");
  
  // Update version in all npm packages
  for (const pkg of ["opendebrief", "opendebrief-darwin-arm64", "opendebrief-darwin-x64"]) {
    const pkgJsonPath = join(npmDir, pkg, "package.json");
    if (existsSync(pkgJsonPath)) {
      const pkgJson = JSON.parse(await readFile(pkgJsonPath, "utf-8"));
      pkgJson.version = version;
      if (pkgJson.optionalDependencies) {
        for (const dep of Object.keys(pkgJson.optionalDependencies)) {
          pkgJson.optionalDependencies[dep] = version;
        }
      }
      await writeFile(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");
    }
  }
  
  // Copy binaries to npm packages
  for (const target of targets) {
    if (!target.startsWith("darwin")) continue;
    
    const npmPkgDir = join(npmDir, `opendebrief-${target}`, "bin");
    await mkdir(npmPkgDir, { recursive: true });
    
    // Copy main binary
    await copyFile(
      join(distDir, target, "opendebrief"),
      join(npmPkgDir, "opendebrief")
    );
    
    // Copy recorder if exists
    const recorderPath = join(distDir, target, "recorder");
    if (existsSync(recorderPath)) {
      await copyFile(recorderPath, join(npmPkgDir, "recorder"));
    }
    
    console.log(`   Prepared opendebrief-${target}`);
  }
  
  console.log("\nTo publish npm packages:");
  console.log("  cd npm/opendebrief-darwin-arm64 && npm publish");
  console.log("  cd npm/opendebrief-darwin-x64 && npm publish");
  console.log("  cd npm/opendebrief && npm publish");
}

async function buildAll() {
  console.log("Building opendebrief binaries...\n");

  // Clean dist
  if (existsSync(distDir)) {
    await rm(distDir, { recursive: true });
  }
  await mkdir(distDir, { recursive: true });

  // Sync version
  console.log("1. Syncing version...");
  const version = await syncVersion();
  console.log(`   Version: ${version}\n`);

  // Determine which targets to build
  const currentPlatform = process.platform;
  const currentArch = process.arch;

  let targets: Target[];

  if (process.argv.includes("--all")) {
    // Build all targets (for CI)
    targets = Object.keys(BUN_TARGETS) as Target[];
  } else if (process.argv.includes("--current")) {
    // Build only current platform
    const current = `${currentPlatform === "darwin" ? "darwin" : "linux"}-${currentArch === "arm64" ? "arm64" : "x64"}` as Target;
    targets = [current];
  } else {
    // Default: build macOS targets (since Swift recorder is macOS only for now)
    targets = ["darwin-arm64", "darwin-x64"];
  }

  console.log(`2. Building binaries for: ${targets.join(", ")}\n`);

  const archives: string[] = [];

  for (const target of targets) {
    console.log(`\n[${target}]`);

    // Build the binary
    await buildBinary(target);

    // Compile Swift recorder for macOS targets
    if (target.startsWith("darwin") && currentPlatform === "darwin") {
      await compileSwiftRecorder(join(distDir, target));
    }

    // Create archive
    const archive = await createArchive(target, version);
    archives.push(archive);
  }

  console.log("\n3. Build complete!\n");
  console.log("Archives created:");
  for (const archive of archives) {
    console.log(`  - ${archive}`);
  }

  // Prepare npm packages
  await prepareNpmPackages(version, targets);

  console.log("\nTo create a GitHub release:");
  console.log(`  gh release create v${version} ${archives.join(" ")} --title "v${version}" --generate-notes`);
}

async function buildCurrent() {
  console.log("Building opendebrief for current platform...\n");

  // Sync version
  const version = await syncVersion();

  const target = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}` as Target;

  await mkdir(join(distDir, target), { recursive: true });

  console.log(`Building for ${target}...`);
  await buildBinary(target);

  if (process.platform === "darwin") {
    console.log("Compiling Swift recorder...");
    await compileSwiftRecorder(join(distDir, target));
  }

  console.log(`\nDone! Binary at: dist/${target}/opendebrief`);
  console.log(`\nTo test: ./dist/${target}/opendebrief`);
}

// Main
if (process.argv.includes("--current")) {
  buildCurrent().catch(console.error);
} else {
  buildAll().catch(console.error);
}
