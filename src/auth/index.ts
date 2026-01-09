// Authentication module for opendebrief
// Stores API keys securely in ~/.local/share/opendebrief/auth.json

import { z } from "zod";
import { homedir } from "os";
import { join } from "path";
import { mkdir, chmod } from "fs/promises";

// XDG Base Directory for data storage
function getXdgDataHome(): string {
  return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
}

const APP_NAME = "opendebrief";

export const AuthPath = {
  get data() {
    return join(getXdgDataHome(), APP_NAME);
  },
  get authFile() {
    return join(this.data, "auth.json");
  },
};

// Provider definitions
export const Providers = {
  openai: {
    id: "openai",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    description: "OpenAI API for Whisper transcription",
    keyPrefix: "sk-",
  },
  elevenlabs: {
    id: "elevenlabs",
    name: "ElevenLabs",
    env: ["ELEVENLABS_API_KEY", "XI_API_KEY"],
    description: "ElevenLabs API for text-to-speech",
    keyPrefix: "",
  },
} as const;

export type ProviderID = keyof typeof Providers;

// Auth entry schema
export const AuthEntry = z.object({
  type: z.literal("api"),
  key: z.string(),
  createdAt: z.number().optional(),
});

export type AuthEntry = z.infer<typeof AuthEntry>;

// Full auth file schema
export const AuthFile = z.record(z.string(), AuthEntry);
export type AuthFile = z.infer<typeof AuthFile>;

// Ensure data directory exists with correct permissions
async function ensureDataDir(): Promise<void> {
  await mkdir(AuthPath.data, { recursive: true, mode: 0o700 });
}

// Read all auth entries
export async function getAll(): Promise<AuthFile> {
  try {
    const file = Bun.file(AuthPath.authFile);
    const exists = await file.exists();

    if (!exists) {
      return {};
    }

    const text = await file.text();
    const data = JSON.parse(text);

    const result = AuthFile.safeParse(data);
    if (result.success) {
      return result.data;
    }

    console.warn("Invalid auth file, returning empty");
    return {};
  } catch {
    return {};
  }
}

// Get auth for a specific provider
export async function get(providerID: ProviderID): Promise<AuthEntry | undefined> {
  // First check environment variables
  const provider = Providers[providerID];
  for (const envVar of provider.env) {
    const value = process.env[envVar];
    if (value) {
      return { type: "api", key: value };
    }
  }

  // Then check auth file
  const all = await getAll();
  return all[providerID];
}

// Set auth for a provider
export async function set(providerID: ProviderID, key: string): Promise<void> {
  await ensureDataDir();

  const all = await getAll();
  all[providerID] = {
    type: "api",
    key,
    createdAt: Date.now(),
  };

  const file = Bun.file(AuthPath.authFile);
  await Bun.write(file, JSON.stringify(all, null, 2));

  // Set secure file permissions (owner read/write only)
  await chmod(AuthPath.authFile, 0o600);
}

// Remove auth for a provider
export async function remove(providerID: ProviderID): Promise<void> {
  const all = await getAll();
  delete all[providerID];

  if (Object.keys(all).length === 0) {
    // Delete file if empty
    try {
      await Bun.file(AuthPath.authFile).exists() &&
        (await Bun.write(AuthPath.authFile, "{}"));
    } catch {
      // Ignore
    }
  } else {
    await Bun.write(AuthPath.authFile, JSON.stringify(all, null, 2));
  }
}

// Check if a provider is authenticated
export async function isAuthenticated(providerID: ProviderID): Promise<boolean> {
  const auth = await get(providerID);
  return auth !== undefined && auth.key.length > 0;
}

// Get API key for a provider (returns undefined if not authenticated)
export async function getApiKey(providerID: ProviderID): Promise<string | undefined> {
  const auth = await get(providerID);
  return auth?.key;
}

// Validate API key format (basic validation)
export function validateApiKey(providerID: ProviderID, key: string): { valid: boolean; error?: string } {
  const provider = Providers[providerID];

  if (!key || key.trim().length === 0) {
    return { valid: false, error: "API key cannot be empty" };
  }

  if (provider.keyPrefix && !key.startsWith(provider.keyPrefix)) {
    return {
      valid: false,
      error: `${provider.name} API key should start with "${provider.keyPrefix}"`,
    };
  }

  // Basic length check
  if (key.length < 10) {
    return { valid: false, error: "API key seems too short" };
  }

  return { valid: true };
}

// Get authentication status for all providers
export async function getStatus(): Promise<
  Record<ProviderID, { authenticated: boolean; source: "env" | "file" | "none" }>
> {
  const result: Record<string, { authenticated: boolean; source: "env" | "file" | "none" }> = {};

  for (const [id, provider] of Object.entries(Providers)) {
    // Check env first
    let fromEnv = false;
    for (const envVar of provider.env) {
      if (process.env[envVar]) {
        fromEnv = true;
        break;
      }
    }

    if (fromEnv) {
      result[id] = { authenticated: true, source: "env" };
      continue;
    }

    // Check file
    const all = await getAll();
    if (all[id]) {
      result[id] = { authenticated: true, source: "file" };
    } else {
      result[id] = { authenticated: false, source: "none" };
    }
  }

  return result as Record<ProviderID, { authenticated: boolean; source: "env" | "file" | "none" }>;
}

// Auth manager singleton
class AuthManager {
  private cache: AuthFile | null = null;

  async get(providerID: ProviderID): Promise<AuthEntry | undefined> {
    return get(providerID);
  }

  async set(providerID: ProviderID, key: string): Promise<void> {
    await set(providerID, key);
    this.cache = null; // Invalidate cache
  }

  async remove(providerID: ProviderID): Promise<void> {
    await remove(providerID);
    this.cache = null;
  }

  async getApiKey(providerID: ProviderID): Promise<string | undefined> {
    return getApiKey(providerID);
  }

  async isAuthenticated(providerID: ProviderID): Promise<boolean> {
    return isAuthenticated(providerID);
  }

  async getStatus() {
    return getStatus();
  }

  validate(providerID: ProviderID, key: string) {
    return validateApiKey(providerID, key);
  }
}

export const authManager = new AuthManager();
