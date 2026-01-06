import { VERSION, PACKAGE_NAME } from "./version";

interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  packageManager: "npm" | "bun" | "pnpm" | "yarn" | "unknown";
}

/**
 * Detect which package manager was used to install the package
 */
export function detectPackageManager(): UpdateInfo["packageManager"] {
  const execPath = process.env.npm_execpath || "";
  const userAgent = process.env.npm_config_user_agent || "";

  if (userAgent.includes("bun") || execPath.includes("bun")) {
    return "bun";
  }
  if (userAgent.includes("pnpm") || execPath.includes("pnpm")) {
    return "pnpm";
  }
  if (userAgent.includes("yarn") || execPath.includes("yarn")) {
    return "yarn";
  }
  if (userAgent.includes("npm") || execPath.includes("npm")) {
    return "npm";
  }

  return "unknown";
}

/**
 * Get the upgrade command for the detected package manager
 */
export function getUpgradeCommand(pm: UpdateInfo["packageManager"]): string {
  switch (pm) {
    case "bun":
      return `bun add -g ${PACKAGE_NAME}@latest`;
    case "pnpm":
      return `pnpm add -g ${PACKAGE_NAME}@latest`;
    case "yarn":
      return `yarn global add ${PACKAGE_NAME}@latest`;
    case "npm":
    default:
      return `npm install -g ${PACKAGE_NAME}@latest`;
  }
}

/**
 * Fetch the latest version from npm registry
 */
export async function fetchLatestVersion(): Promise<string | null> {
  try {
    const response = await fetch(
      `https://registry.npmjs.org/${PACKAGE_NAME}/latest`,
      {
        headers: {
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(5000), // 5 second timeout
      }
    );

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as { version: string };
    return data.version;
  } catch {
    // Network error or timeout - silently fail
    return null;
  }
}

/**
 * Compare two semver version strings
 * Returns: -1 if a < b, 0 if a === b, 1 if a > b
 */
export function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const partA = partsA[i] || 0;
    const partB = partsB[i] || 0;

    if (partA < partB) return -1;
    if (partA > partB) return 1;
  }

  return 0;
}

/**
 * Check if an update is available
 */
export async function checkForUpdate(): Promise<UpdateInfo> {
  const latestVersion = await fetchLatestVersion();
  const packageManager = detectPackageManager();

  return {
    currentVersion: VERSION,
    latestVersion: latestVersion || VERSION,
    updateAvailable: latestVersion
      ? compareVersions(VERSION, latestVersion) < 0
      : false,
    packageManager,
  };
}

/**
 * Perform the upgrade using exec
 */
export async function performUpgrade(): Promise<{
  success: boolean;
  message: string;
}> {
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const execAsync = promisify(exec);

  const pm = detectPackageManager();
  const command = getUpgradeCommand(pm);

  console.log(`Upgrading ${PACKAGE_NAME} using ${pm}...`);
  console.log(`Running: ${command}\n`);

  try {
    const { stdout, stderr } = await execAsync(command);
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);

    return {
      success: true,
      message: `Successfully upgraded ${PACKAGE_NAME}!`,
    };
  } catch (err) {
    const error = err as Error & { code?: number };
    return {
      success: false,
      message: `Upgrade failed: ${error.message}\nTry running manually:\n  ${command}`,
    };
  }
}
