// Audio recorder module using FFmpeg

import { EventEmitter } from "events";
import {
  type AudioDevice,
  type Platform,
  getPlatform,
  getDeviceInputArgs,
} from "./devices";

export type RecordingState = "idle" | "recording" | "paused" | "stopping";

export interface RecorderConfig {
  micDevice?: AudioDevice | null;
  systemDevice?: AudioDevice | null;
  outputPath: string;
  outputFormat?: "m4a" | "mp3" | "wav" | "mkv";
  mixAudio?: boolean; // If true, mix mic + system into one track
  bitrate?: string;
}

export interface RecorderEvents {
  stateChange: [RecordingState];
  error: [Error];
  progress: [{ duration: number; size: number }];
  finished: [{ outputPath: string; duration: number }];
}

export class AudioRecorder extends EventEmitter<RecorderEvents> {
  private state: RecordingState = "idle";
  private process: ReturnType<typeof Bun.spawn> | null = null;
  private config: RecorderConfig;
  private platform: Platform;
  private startTime: number = 0;
  private pausedDuration: number = 0;
  private pauseStartTime: number = 0;

  constructor(config: RecorderConfig) {
    super();
    this.config = {
      outputFormat: "m4a",
      mixAudio: true,
      bitrate: "192k",
      ...config,
    };
    this.platform = getPlatform();
  }

  getState(): RecordingState {
    return this.state;
  }

  getElapsedTime(): number {
    if (this.state === "idle") return 0;
    if (this.state === "paused") {
      return this.pauseStartTime - this.startTime - this.pausedDuration;
    }
    return Date.now() - this.startTime - this.pausedDuration;
  }

  /**
   * Build FFmpeg arguments based on configuration
   */
  private buildFFmpegArgs(): string[] {
    const args: string[] = ["-y"]; // Overwrite output

    const { micDevice, systemDevice, outputPath, mixAudio, bitrate } =
      this.config;

    // Add input devices
    if (micDevice) {
      args.push(...getDeviceInputArgs(micDevice, this.platform));
    }

    if (systemDevice) {
      args.push(...getDeviceInputArgs(systemDevice, this.platform));
    }

    // If we have both devices and want to mix
    if (micDevice && systemDevice && mixAudio) {
      args.push(
        "-filter_complex",
        "[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=2[a]",
        "-map",
        "[a]"
      );
    } else if (micDevice && systemDevice && !mixAudio) {
      // Keep as separate tracks (useful for post-processing)
      args.push("-map", "0:a", "-map", "1:a");
    }

    // Output codec settings
    const format = this.config.outputFormat || "m4a";
    if (format === "m4a") {
      // Use AAC codec with proper settings for M4A container
      args.push(
        "-c:a", "aac",
        "-b:a", bitrate || "192k",
        "-ar", "44100",  // Sample rate
        "-ac", "2"       // Stereo
      );
    } else if (format === "mp3") {
      args.push(
        "-c:a", "libmp3lame",
        "-b:a", bitrate || "192k",
        "-ar", "44100",
        "-ac", "2"
      );
    } else if (format === "wav") {
      args.push(
        "-c:a", "pcm_s16le",
        "-ar", "44100",
        "-ac", "2"
      );
    }
    // mkv: let FFmpeg choose appropriate codec

    args.push(outputPath);

    return args;
  }

  /**
   * Start recording
   */
  async start(): Promise<void> {
    if (this.state !== "idle") {
      throw new Error(`Cannot start recording in state: ${this.state}`);
    }

    const { micDevice, systemDevice } = this.config;

    if (!micDevice && !systemDevice) {
      throw new Error("At least one audio device must be configured");
    }

    const args = this.buildFFmpegArgs();

    try {
      this.process = Bun.spawn(["ffmpeg", ...args], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "pipe",
      });

      this.state = "recording";
      this.startTime = Date.now();
      this.pausedDuration = 0;
      this.emit("stateChange", this.state);

      // Handle stderr for progress info
      this.handleStderr();

      // Handle process exit
      this.process.exited.then((code) => {
        if (code === 0) {
          const duration = this.getElapsedTime();
          this.emit("finished", {
            outputPath: this.config.outputPath,
            duration,
          });
        }
        this.state = "idle";
        this.emit("stateChange", this.state);
      });
    } catch (error) {
      this.state = "idle";
      this.emit("error", error as Error);
      throw error;
    }
  }

  /**
   * Parse FFmpeg stderr for progress information
   */
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

        const text = decoder.decode(value);
        // Parse progress info from FFmpeg output
        // Example: size=    1234kB time=00:01:23.45 bitrate= 123.4kbits/s
        const sizeMatch = text.match(/size=\s*(\d+)/);
        const timeMatch = text.match(/time=(\d+):(\d+):(\d+)/);

        if (sizeMatch || timeMatch) {
          let duration = 0;
          if (timeMatch) {
            const hours = parseInt(timeMatch[1] || "0", 10);
            const minutes = parseInt(timeMatch[2] || "0", 10);
            const seconds = parseInt(timeMatch[3] || "0", 10);
            duration = hours * 3600 + minutes * 60 + seconds;
          }
          const size = sizeMatch ? parseInt(sizeMatch[1] || "0", 10) * 1024 : 0;
          this.emit("progress", { duration, size });
        }
      }
    } catch {
      // Stream closed, ignore
    }
  }

  /**
   * Stop recording
   */
  async stop(): Promise<void> {
    if (this.state !== "recording" && this.state !== "paused") {
      throw new Error(`Cannot stop recording in state: ${this.state}`);
    }

    // If paused, resume first so FFmpeg can finalize
    if (this.state === "paused" && this.platform !== "win32" && this.process) {
      this.process.kill("SIGCONT");
    }

    this.state = "stopping";
    this.emit("stateChange", this.state);

    if (this.process) {
      // Send SIGINT (Ctrl+C) to FFmpeg for graceful shutdown
      // This allows FFmpeg to properly finalize the output file
      this.process.kill("SIGINT");

      // Wait for process to exit with timeout
      const timeout = new Promise<void>((resolve) => {
        setTimeout(() => {
          // Force kill if it doesn't exit gracefully
          if (this.process) {
            this.process.kill("SIGKILL");
          }
          resolve();
        }, 5000);
      });

      await Promise.race([this.process.exited, timeout]);
    }

    this.process = null;
  }

  /**
   * Force kill the recording (for emergencies)
   */
  kill(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.state = "idle";
    this.emit("stateChange", this.state);
  }

  /**
   * Pause recording (only works with certain setups)
   * Note: FFmpeg doesn't natively support pause, so this is simulated
   */
  pause(): void {
    if (this.state !== "recording") {
      throw new Error(`Cannot pause in state: ${this.state}`);
    }

    // Send SIGSTOP to pause the process (Unix only)
    if (this.platform !== "win32" && this.process) {
      this.process.kill("SIGSTOP");
      this.state = "paused";
      this.pauseStartTime = Date.now();
      this.emit("stateChange", this.state);
    }
  }

  /**
   * Resume recording
   */
  resume(): void {
    if (this.state !== "paused") {
      throw new Error(`Cannot resume in state: ${this.state}`);
    }

    // Send SIGCONT to resume the process (Unix only)
    if (this.platform !== "win32" && this.process) {
      this.process.kill("SIGCONT");
      this.pausedDuration += Date.now() - this.pauseStartTime;
      this.state = "recording";
      this.emit("stateChange", this.state);
    }
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
 * Format duration in seconds to HH:MM:SS
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

/**
 * Format file size in bytes to human readable
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
