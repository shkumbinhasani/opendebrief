// Configuration management for opendebrief
// Similar to opencode's approach using XDG base directories

import { z } from "zod";
import { homedir } from "os";
import { join } from "path";
import { mkdir } from "fs/promises";

// XDG Base Directory paths
function getXdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

const APP_NAME = "opendebrief";

export const Path = {
  get config() {
    return join(getXdgConfigHome(), APP_NAME);
  },
  get configFile() {
    return join(this.config, "config.json");
  },
};

// Audio config schema
const AudioConfigSchema = z.object({
  // Selected microphone device ID
  selectedMicId: z.string().optional(),
  // Selected microphone name (for display/fallback matching)
  selectedMicName: z.string().optional(),
  // Recording mode: mic, system, or both
  recordingMode: z.enum(["mic", "system", "both"]).default("mic"),
});

// Output config schema
const OutputConfigSchema = z.object({
  // Directory to save recordings
  directory: z.string().optional(),
  // File name format (supports date placeholders)
  fileNameFormat: z.string().default("recording_{timestamp}"),
});

// UI config schema
const UIConfigSchema = z.object({
  // Color theme (for future use)
  theme: z.enum(["dark", "light"]).default("dark"),
});

// Full config schema
export const ConfigSchema = z.object({
  audio: AudioConfigSchema.default({
    recordingMode: "mic",
  }),
  output: OutputConfigSchema.default({
    fileNameFormat: "recording_{timestamp}",
  }),
  ui: UIConfigSchema.default({
    theme: "dark",
  }),
});

export type Config = z.infer<typeof ConfigSchema>;
export type AudioConfig = z.infer<typeof AudioConfigSchema>;
export type OutputConfig = z.infer<typeof OutputConfigSchema>;
export type UIConfig = z.infer<typeof UIConfigSchema>;

// Default configuration
export function getDefaultConfig(): Config {
  return ConfigSchema.parse({});
}

// Ensure config directory exists
async function ensureConfigDir(): Promise<void> {
  await mkdir(Path.config, { recursive: true });
}

// Load configuration from disk
export async function loadConfig(): Promise<Config> {
  try {
    const file = Bun.file(Path.configFile);
    const exists = await file.exists();

    if (!exists) {
      return getDefaultConfig();
    }

    const text = await file.text();
    const data = JSON.parse(text);

    // Validate and apply defaults
    const result = ConfigSchema.safeParse(data);
    if (result.success) {
      return result.data;
    }

    // If validation fails, log warning and return defaults
    console.warn("Invalid config file, using defaults:", result.error.issues);
    return getDefaultConfig();
  } catch (error) {
    // File doesn't exist or parse error - return defaults
    return getDefaultConfig();
  }
}

// Save configuration to disk
export async function saveConfig(config: Config): Promise<void> {
  await ensureConfigDir();

  // Validate before saving
  const validated = ConfigSchema.parse(config);

  await Bun.write(Path.configFile, JSON.stringify(validated, null, 2));
}

// Update specific config values (merge with existing)
export async function updateConfig(
  updates: Partial<Config>
): Promise<Config> {
  const current = await loadConfig();

  // Deep merge
  const merged: Config = {
    audio: { ...current.audio, ...updates.audio },
    output: { ...current.output, ...updates.output },
    ui: { ...current.ui, ...updates.ui },
  };

  await saveConfig(merged);
  return merged;
}

// Config state manager (singleton pattern for the app)
class ConfigManager {
  private config: Config | null = null;
  private loaded = false;

  async get(): Promise<Config> {
    if (!this.loaded) {
      this.config = await loadConfig();
      this.loaded = true;
    }
    return this.config!;
  }

  async update(updates: Partial<Config>): Promise<Config> {
    this.config = await updateConfig(updates);
    return this.config;
  }

  async reload(): Promise<Config> {
    this.loaded = false;
    return this.get();
  }

  // Convenience methods
  async setSelectedMic(id: string, name: string): Promise<void> {
    const current = await this.get();
    await this.update({
      audio: {
        ...current.audio,
        selectedMicId: id,
        selectedMicName: name,
      },
    });
  }

  async setRecordingMode(mode: "mic" | "system" | "both"): Promise<void> {
    const current = await this.get();
    await this.update({
      audio: {
        ...current.audio,
        recordingMode: mode,
      },
    });
  }

  async setOutputDirectory(directory: string): Promise<void> {
    const current = await this.get();
    await this.update({
      output: {
        ...current.output,
        directory,
      },
    });
  }
}

// Export singleton instance
export const configManager = new ConfigManager();

// Re-export for convenience
export { Path as ConfigPath };
