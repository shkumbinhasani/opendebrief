#!/usr/bin/env bun

import { VERSION, PACKAGE_NAME } from "./version";
import {
  checkForUpdate,
  performUpgrade,
  getUpgradeCommand,
} from "./upgrade";
import { writeFileSync, appendFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

const HELP_TEXT = `
${PACKAGE_NAME} v${VERSION}
A TUI application for recording and transcribing meetings on macOS

Usage:
  opendebrief              Start the meeting transcriber TUI
  opendebrief upgrade      Upgrade to the latest version
  opendebrief version      Show version information
  opendebrief help         Show this help message

Options:
  --no-update-check        Skip checking for updates on startup
  --debug                  Enable debug logging to ~/opendebrief-debug.log
  --help, -h               Show this help message
  --version, -v            Show version information

Environment Variables:
  OPENAI_API_KEY           OpenAI API key for Whisper transcription
  ELEVENLABS_API_KEY       ElevenLabs API key for Scribe transcription

Requirements:
  - macOS 12.3+ (for system audio capture)
  - Screen Recording permission (for system audio)
  - FFmpeg (for "both" recording mode)
`;

// Debug logging
const DEBUG_LOG_PATH = join(homedir(), "opendebrief-debug.log");
let debugEnabled = false;

export function enableDebug() {
  debugEnabled = true;
  writeFileSync(DEBUG_LOG_PATH, `=== OpenDebrief Debug Log ===\nStarted: ${new Date().toISOString()}\n\n`);
  debugLog("Debug mode enabled");
  debugLog(`Version: ${VERSION}`);
  debugLog(`process.argv: ${JSON.stringify(process.argv)}`);
  debugLog(`process.argv[1]: ${process.argv[1]}`);
  debugLog(`import.meta.path: ${import.meta.path}`);
  debugLog(`import.meta.dir: ${import.meta.dir}`);
  debugLog(`process.cwd(): ${process.cwd()}`);
  debugLog(`__dirname equivalent: ${dirname(import.meta.path)}`);
}

export function debugLog(message: string) {
  if (debugEnabled) {
    const timestamp = new Date().toISOString();
    appendFileSync(DEBUG_LOG_PATH, `[${timestamp}] ${message}\n`);
  }
}

// Make debugLog available globally
(globalThis as any).__opendebrief_debug = debugLog;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  // Enable debug mode if requested
  if (args.includes("--debug")) {
    enableDebug();
    console.log(`Debug logging enabled. Log file: ${DEBUG_LOG_PATH}`);
  }

  // Handle flags
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  if (args.includes("--version") || args.includes("-v")) {
    console.log(`${PACKAGE_NAME} v${VERSION}`);
    process.exit(0);
  }

  // Handle commands
  switch (command) {
    case "help":
      console.log(HELP_TEXT);
      process.exit(0);
      break;

    case "version":
      console.log(`${PACKAGE_NAME} v${VERSION}`);

      // Also check for updates
      const updateInfo = await checkForUpdate();
      if (updateInfo.updateAvailable) {
        console.log(
          `\nUpdate available: ${updateInfo.currentVersion} -> ${updateInfo.latestVersion}`
        );
        console.log(`Run: ${getUpgradeCommand()}`);
      }
      process.exit(0);
      break;

    case "upgrade":
      console.log(`Checking for updates...`);
      const info = await checkForUpdate();

      if (!info.updateAvailable) {
        console.log(
          `You're already on the latest version (${info.currentVersion})`
        );
        process.exit(0);
      }

      console.log(
        `Update available: ${info.currentVersion} -> ${info.latestVersion}\n`
      );

      const result = await performUpgrade();
      console.log(result.message);
      process.exit(result.success ? 0 : 1);
      break;

    case undefined:
    default:
      // Start the TUI app
      await startApp(!args.includes("--no-update-check"));
      break;
  }
}

async function startApp(checkUpdates: boolean) {
  // Check for updates in background (non-blocking)
  if (checkUpdates) {
    checkForUpdate().then((info) => {
      if (info.updateAvailable) {
        // Store update info for the app to display
        process.env.OPENDEBRIEF_UPDATE_AVAILABLE = "1";
        process.env.OPENDEBRIEF_LATEST_VERSION = info.latestVersion;
        process.env.OPENDEBRIEF_UPGRADE_COMMAND = getUpgradeCommand();
      }
    });
  }

  // Import and run the app
  const { MeetingTranscriberApp } = await import("./app");
  const app = new MeetingTranscriberApp();
  await app.init();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
