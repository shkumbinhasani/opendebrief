// Native recorder wrapper for the Swift CLI tool

import { EventEmitter } from "events";
import { join, dirname } from "path";
import { existsSync } from "fs";

// Debug logger - will be set by CLI if --debug is passed
function debugLog(message: string) {
  const logger = (globalThis as any).__opendebrief_debug;
  if (logger) {
    logger(`[native-recorder] ${message}`);
  }
}

export type RecordingState = "idle" | "recording" | "stopping";

export interface NativeDevice {
  index: string;
  name: string;
  id: string;
  type: "microphone" | "system";
}

export interface RecorderConfig {
  outputPath: string;
  recordMic?: boolean;
  recordSystem?: boolean;
}

export interface RecorderEvents {
  stateChange: [RecordingState];
  error: [Error];
  started: [{ outputPath: string }];
  stopped: [{ outputPath: string }];
}

interface RecorderMessage {
  success: boolean;
  message?: string;
  error?: string;
  data?: { output: string };
}

/**
 * Get the path to the native recorder binary
 */
function getRecorderPath(): string {
  // Look in multiple places
  const scriptDir = dirname(import.meta.path);
  const possiblePaths: string[] = [];
  
  debugLog(`Looking for recorder binary...`);
  debugLog(`scriptDir (from import.meta.path): ${scriptDir}`);
  debugLog(`import.meta.path: ${import.meta.path}`);
  
  // When running from npm global install, the CLI is at:
  // ~/.bun/install/global/node_modules/opendebrief/dist/cli.js
  // and recorder is at:
  // ~/.bun/install/global/node_modules/opendebrief/dist/recorder
  
  const arg1 = process.argv[1];
  debugLog(`process.argv[1]: ${arg1}`);
  
  if (arg1) {
    const arg1Dir = dirname(arg1);
    debugLog(`arg1Dir: ${arg1Dir}`);
    
    // Most likely path for npm global install - same directory as CLI
    possiblePaths.push(join(arg1Dir, "recorder"));
    // If CLI is symlinked, resolve it
    possiblePaths.push(join(arg1Dir, "..", "dist", "recorder"));
    possiblePaths.push(join(arg1Dir, "..", "native", "recorder"));
  }
  
  // Development paths
  possiblePaths.push(
    join(scriptDir, "recorder"), // Same directory as the script
    join(scriptDir, "..", "..", "native", "recorder"),
    join(scriptDir, "..", "..", "dist", "recorder"),
    join(process.cwd(), "native", "recorder"),
    join(process.cwd(), "dist", "recorder"),
  );

  debugLog(`Checking paths: ${JSON.stringify(possiblePaths, null, 2)}`);

  for (const p of possiblePaths) {
    const exists = existsSync(p);
    debugLog(`  ${p} -> ${exists ? 'EXISTS' : 'not found'}`);
    if (exists) {
      debugLog(`Found recorder at: ${p}`);
      return p;
    }
  }

  // Log for debugging
  debugLog(`ERROR: Could not find recorder binary in any location!`);
  console.error("Could not find recorder binary. Searched:", possiblePaths);
  return possiblePaths[0] ?? "native/recorder";
}

/**
 * Check if the native recorder is available
 */
export async function isNativeRecorderAvailable(): Promise<boolean> {
  try {
    const recorderPath = getRecorderPath();
    const proc = Bun.spawn([recorderPath, "version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

export interface PermissionStatus {
  screenRecording: boolean;
  errorMessage?: string;
}

/**
 * Check if screen recording permission is granted
 * This will also trigger the permission prompt if not yet asked
 */
export async function checkScreenRecordingPermission(): Promise<PermissionStatus> {
  try {
    const recorderPath = getRecorderPath();
    debugLog(`Checking screen recording permission using: ${recorderPath}`);
    
    const proc = Bun.spawn([recorderPath, "check-permissions"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    debugLog(`Permission check stdout: ${stdout}`);

    try {
      const result = JSON.parse(stdout.trim()) as { success: boolean; message?: string; error?: string };
      return {
        screenRecording: result.success,
        errorMessage: result.error,
      };
    } catch {
      return {
        screenRecording: false,
        errorMessage: "Failed to parse permission check result",
      };
    }
  } catch (error) {
    debugLog(`Permission check failed: ${error}`);
    return {
      screenRecording: false,
      errorMessage: (error as Error).message,
    };
  }
}

/**
 * List available audio devices using the native recorder
 */
export async function listNativeDevices(): Promise<NativeDevice[]> {
  const recorderPath = getRecorderPath();

  const proc = Bun.spawn([recorderPath, "list-devices"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  if (proc.exitCode !== 0) {
    throw new Error("Failed to list devices");
  }

  try {
    return JSON.parse(stdout) as NativeDevice[];
  } catch {
    throw new Error("Failed to parse device list");
  }
}

/**
 * Find microphone devices
 */
export function findMicrophones(devices: NativeDevice[]): NativeDevice[] {
  return devices.filter((d) => d.type === "microphone");
}

/**
 * Find system audio device
 */
export function findSystemAudio(devices: NativeDevice[]): NativeDevice | null {
  return devices.find((d) => d.type === "system") ?? null;
}

/**
 * Native audio recorder using Swift CLI
 */
export class NativeAudioRecorder extends EventEmitter<RecorderEvents> {
  private state: RecordingState = "idle";
  private process: ReturnType<typeof Bun.spawn> | null = null;
  private config: RecorderConfig;
  private startTime: number = 0;

  constructor(config: RecorderConfig) {
    super();
    this.config = {
      recordMic: true,
      recordSystem: false,
      ...config,
    };
  }

  getState(): RecordingState {
    return this.state;
  }

  getElapsedTime(): number {
    if (this.state === "idle") return 0;
    return Date.now() - this.startTime;
  }

  /**
   * Start recording
   */
  async start(): Promise<void> {
    if (this.state !== "idle") {
      throw new Error(`Cannot start recording in state: ${this.state}`);
    }

    const recorderPath = getRecorderPath();
    const args = [recorderPath, "record", this.config.outputPath];

    if (this.config.recordMic && this.config.recordSystem) {
      args.push("--both");
    } else if (this.config.recordSystem) {
      args.push("--system");
    } else {
      args.push("--mic");
    }

    debugLog(`Starting recording...`);
    debugLog(`Recorder path: ${recorderPath}`);
    debugLog(`Full command: ${args.join(' ')}`);
    debugLog(`Output path: ${this.config.outputPath}`);
    debugLog(`Config: ${JSON.stringify(this.config)}`);

    try {
      this.process = Bun.spawn(args, {
        stdout: "pipe",
        stderr: "pipe",
      });

      this.state = "recording";
      this.startTime = Date.now();
      this.emit("stateChange", this.state);

      // Read stdout for JSON messages
      this.handleOutput();
      
      // Also capture stderr for debugging
      this.handleStderr();

      // Handle process exit
      this.process.exited.then((code) => {
        debugLog(`Recorder process exited with code: ${code}`);
        if (this.state === "recording") {
          // Unexpected exit
          this.state = "idle";
          this.emit("stateChange", this.state);
        }
      });
    } catch (error) {
      debugLog(`Failed to start recorder: ${error}`);
      this.state = "idle";
      this.emit("error", error as Error);
      throw error;
    }
  }
  
  private async handleStderr(): Promise<void> {
    if (!this.process?.stderr) return;

    const stderr = this.process.stderr;
    if (typeof stderr === "number") return;

    const reader = stderr.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text.trim()) {
          debugLog(`Recorder stderr: ${text}`);
        }
      }
    } catch {
      // Stream closed
    }
  }

  private async handleOutput(): Promise<void> {
    if (!this.process?.stdout) return;

    const stdout = this.process.stdout;
    if (typeof stdout === "number") return;

    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete JSON lines
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.trim()) {
            debugLog(`Recorder stdout: ${line}`);
            try {
              const msg = JSON.parse(line) as RecorderMessage;
              if (msg.success && msg.message === "Recording started") {
                debugLog(`Recording started event received`);
                this.emit("started", { outputPath: this.config.outputPath });
              } else if (msg.success && msg.message === "Recording stopped") {
                debugLog(`Recording stopped event received`);
                this.emit("stopped", { outputPath: this.config.outputPath });
              } else if (!msg.success && msg.error) {
                debugLog(`Recording error: ${msg.error}`);
                this.emit("error", new Error(msg.error));
              }
            } catch (e) {
              debugLog(`Failed to parse recorder output: ${e}`);
            }
          }
        }
      }
    } catch {
      // Stream closed
    }
  }

  /**
   * Stop recording
   */
  async stop(): Promise<void> {
    debugLog(`Stopping recording... current state: ${this.state}`);
    
    if (this.state !== "recording") {
      throw new Error(`Cannot stop recording in state: ${this.state}`);
    }

    this.state = "stopping";
    this.emit("stateChange", this.state);
    debugLog(`Sending SIGINT to recorder process...`);

    if (this.process) {
      // Send SIGINT to gracefully stop
      this.process.kill("SIGINT");

      // Wait for process to exit with timeout
      const timeout = new Promise<void>((resolve) => {
        setTimeout(() => {
          if (this.process) {
            this.process.kill("SIGKILL");
          }
          resolve();
        }, 5000);
      });

      await Promise.race([this.process.exited, timeout]);
    }

    this.state = "idle";
    this.emit("stateChange", this.state);
    this.process = null;
  }

  /**
   * Force kill
   */
  kill(): void {
    if (this.process) {
      this.process.kill("SIGKILL");
      this.process = null;
    }
    this.state = "idle";
    this.emit("stateChange", this.state);
  }

  /**
   * Update configuration (only when idle)
   */
  setConfig(config: Partial<RecorderConfig>): void {
    if (this.state !== "idle") {
      throw new Error("Cannot update config while recording");
    }
    this.config = { ...this.config, ...config };
  }

  getConfig(): RecorderConfig {
    return { ...this.config };
  }
}

/**
 * Format duration in ms to HH:MM:SS
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}
