#!/usr/bin/env bun

/**
 * Build script for opendebrief
 * - Bundles TypeScript to dist/
 * - Compiles native Swift recorder
 * - Copies necessary files
 */

import { $ } from "bun";
import { mkdir, copyFile, readFile, writeFile, chmod } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

const projectRoot = process.cwd();
const distDir = join(projectRoot, "dist");
const nativeDir = join(projectRoot, "native");

async function build() {
  console.log("Building opendebrief...\n");

  // 1. Create dist directory
  console.log("1. Creating dist directory...");
  await mkdir(distDir, { recursive: true });

  // 2. Read version from package.json and update version.ts
  console.log("2. Syncing version...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const versionTs = `// Version information - auto-generated at build time
export const VERSION = "${pkg.version}";
export const PACKAGE_NAME = "${pkg.name}";
`;
  await writeFile("src/version.ts", versionTs);

  // 3. Bundle TypeScript with Bun
  console.log("3. Bundling TypeScript...");
  const result = await Bun.build({
    entrypoints: ["src/cli.ts"],
    outdir: distDir,
    target: "bun", // Target bun runtime since we use Bun builtins
    format: "esm",
    minify: false, // Keep readable for debugging
    sourcemap: "external",
    external: [
      // Keep native modules external
      "clipboardy",
    ],
  });

  if (!result.success) {
    console.error("Build failed:");
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }

  // 4. Add shebang to CLI output
  console.log("4. Adding shebang to CLI...");
  const cliPath = join(distDir, "cli.js");
  const cliContent = await readFile(cliPath, "utf-8");
  if (!cliContent.startsWith("#!/")) {
    await writeFile(cliPath, `#!/usr/bin/env bun\n${cliContent}`);
  }
  await chmod(cliPath, 0o755);

  // 5. Copy Swift source for postinstall
  console.log("5. Copying Swift source...");
  const swiftSource = join(nativeDir, "recorder.swift");
  if (existsSync(swiftSource)) {
    await copyFile(swiftSource, join(distDir, "recorder.swift"));
  }

  // 6. Compile native recorder
  console.log("6. Compiling native recorder...");
  if (process.platform === "darwin") {
    try {
      await $`swiftc -O -o ${join(distDir, "recorder")} ${swiftSource}`;
      console.log("   Native recorder compiled successfully");
    } catch (error) {
      console.error("   Warning: Failed to compile native recorder");
      console.error("   Make sure Xcode Command Line Tools are installed");
    }
  } else {
    console.log("   Skipping (macOS only)");
  }

  // 7. Copy postinstall script
  console.log("7. Copying scripts...");
  await copyFile(
    join(projectRoot, "scripts", "postinstall.js"),
    join(distDir, "postinstall.js")
  );

  console.log("\nBuild complete! Output in dist/");
  console.log("\nTo test locally:");
  console.log("  node dist/cli.js");
  console.log("\nTo publish:");
  console.log("  npm publish");
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
