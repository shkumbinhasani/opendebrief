import { VERSION, PACKAGE_NAME } from "./version";

const REPO = "shkumbinhasani/opendebrief";

interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
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
 * Fetch the latest version from GitHub releases
 */
export async function fetchLatestVersion(): Promise<string | null> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      {
        headers: {
          Accept: "application/vnd.github.v3+json",
          "User-Agent": PACKAGE_NAME,
        },
        signal: AbortSignal.timeout(5000),
      }
    );

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as { tag_name: string };
    // Remove 'v' prefix if present
    return data.tag_name.replace(/^v/, "");
  } catch {
    return null;
  }
}

/**
 * Check if an update is available
 */
export async function checkForUpdate(): Promise<UpdateInfo> {
  const latestVersion = await fetchLatestVersion();

  return {
    currentVersion: VERSION,
    latestVersion: latestVersion || VERSION,
    updateAvailable: latestVersion
      ? compareVersions(VERSION, latestVersion) < 0
      : false,
  };
}

/**
 * Get the upgrade command
 */
export function getUpgradeCommand(): string {
  return `curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install | bash`;
}

/**
 * Perform the upgrade by running the install script
 */
export async function performUpgrade(): Promise<{
  success: boolean;
  message: string;
}> {
  const { exec } = await import("child_process");
  const { promisify } = await import("util");
  const execAsync = promisify(exec);

  const command = getUpgradeCommand();

  console.log(`Upgrading ${PACKAGE_NAME}...`);
  console.log(`Running: ${command}\n`);

  try {
    const { stdout, stderr } = await execAsync(command, {
      shell: "/bin/bash",
    });
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);

    return {
      success: true,
      message: `Successfully upgraded ${PACKAGE_NAME}!`,
    };
  } catch (err) {
    const error = err as Error;
    return {
      success: false,
      message: `Upgrade failed: ${error.message}\nTry running manually:\n  ${command}`,
    };
  }
}
