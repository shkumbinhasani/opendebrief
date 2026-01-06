// Audio device detection module for macOS, Windows, and Linux

export interface AudioDevice {
  index: number;
  name: string;
  type: "audio" | "video";
}

export interface SystemAudioDevice extends AudioDevice {
  isSystemAudio: boolean;
  isBlackHole?: boolean;
  isStereoMix?: boolean;
  isMonitor?: boolean;
}

export type Platform = "darwin" | "win32" | "linux";

export function getPlatform(): Platform {
  return process.platform as Platform;
}

/**
 * Parse FFmpeg device list output for macOS (avfoundation)
 */
function parseMacOSDevices(output: string): AudioDevice[] {
  const devices: AudioDevice[] = [];
  const lines = output.split("\n");
  let inAudioSection = false;

  for (const line of lines) {
    if (line.includes("AVFoundation audio devices:")) {
      inAudioSection = true;
      continue;
    }
    if (line.includes("AVFoundation video devices:")) {
      inAudioSection = false;
      continue;
    }

    if (inAudioSection) {
      // Match lines like: [AVFoundation indev @ 0x...] [0] MacBook Pro Microphone
      const match = line.match(/\[(\d+)\]\s+(.+)$/);
      if (match && match[1] && match[2]) {
        devices.push({
          index: parseInt(match[1], 10),
          name: match[2].trim(),
          type: "audio",
        });
      }
    }
  }

  return devices;
}

/**
 * Parse FFmpeg device list output for Windows (dshow)
 */
function parseWindowsDevices(output: string): AudioDevice[] {
  const devices: AudioDevice[] = [];
  const lines = output.split("\n");
  let inAudioSection = false;
  let index = 0;

  for (const line of lines) {
    if (line.includes("DirectShow audio devices")) {
      inAudioSection = true;
      continue;
    }
    if (line.includes("DirectShow video devices")) {
      inAudioSection = false;
      continue;
    }

    if (inAudioSection) {
      // Match lines like: [dshow @ 0x...] "Microphone (Realtek Audio)"
      const match = line.match(/"([^"]+)"/);
      if (match && match[1] && !line.includes("Alternative name")) {
        devices.push({
          index: index++,
          name: match[1],
          type: "audio",
        });
      }
    }
  }

  return devices;
}

/**
 * Parse PulseAudio/PipeWire source list for Linux
 */
function parseLinuxDevices(output: string): AudioDevice[] {
  const devices: AudioDevice[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    // Format: index name module sample_spec
    const parts = line.trim().split(/\s+/);
    const indexStr = parts[0];
    const name = parts[1];
    if (indexStr && name) {
      const index = parseInt(indexStr, 10);
      if (!isNaN(index)) {
        devices.push({
          index,
          name,
          type: "audio",
        });
      }
    }
  }

  return devices;
}

/**
 * List available audio devices using FFmpeg/system tools
 */
export async function listAudioDevices(): Promise<AudioDevice[]> {
  const platform = getPlatform();

  try {
    if (platform === "darwin") {
      // macOS: Use avfoundation
      const proc = Bun.spawn(
        ["ffmpeg", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
        {
          stdout: "pipe",
          stderr: "pipe",
        }
      );

      const stderr = await new Response(proc.stderr).text();
      await proc.exited;
      return parseMacOSDevices(stderr);
    } else if (platform === "win32") {
      // Windows: Use dshow
      const proc = Bun.spawn(
        ["ffmpeg", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
        {
          stdout: "pipe",
          stderr: "pipe",
        }
      );

      const stderr = await new Response(proc.stderr).text();
      await proc.exited;
      return parseWindowsDevices(stderr);
    } else {
      // Linux: Use PulseAudio
      const proc = Bun.spawn(["pactl", "list", "sources", "short"], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      return parseLinuxDevices(stdout);
    }
  } catch (error) {
    console.error("Error listing audio devices:", error);
    return [];
  }
}

/**
 * Identify system audio devices (BlackHole, Stereo Mix, monitors)
 */
export function identifySystemAudioDevices(
  devices: AudioDevice[]
): SystemAudioDevice[] {
  const platform = getPlatform();

  return devices.map((device) => {
    const systemDevice: SystemAudioDevice = {
      ...device,
      isSystemAudio: false,
    };

    const nameLower = device.name.toLowerCase();

    if (platform === "darwin") {
      // macOS: Look for BlackHole or similar virtual audio devices
      if (
        nameLower.includes("blackhole") ||
        nameLower.includes("loopback") ||
        nameLower.includes("soundflower")
      ) {
        systemDevice.isSystemAudio = true;
        systemDevice.isBlackHole = nameLower.includes("blackhole");
      }
    } else if (platform === "win32") {
      // Windows: Look for Stereo Mix or WASAPI loopback
      if (
        nameLower.includes("stereo mix") ||
        nameLower.includes("what u hear") ||
        nameLower.includes("loopback")
      ) {
        systemDevice.isSystemAudio = true;
        systemDevice.isStereoMix = true;
      }
    } else {
      // Linux: Look for monitor sources
      if (nameLower.includes(".monitor")) {
        systemDevice.isSystemAudio = true;
        systemDevice.isMonitor = true;
      }
    }

    return systemDevice;
  });
}

/**
 * Find the best microphone device
 */
export function findMicrophoneDevice(
  devices: SystemAudioDevice[]
): SystemAudioDevice | null {
  // Prefer non-system audio devices
  const microphones = devices.filter((d) => !d.isSystemAudio);

  if (microphones.length === 0) {
    return null;
  }

  // Prefer devices with "mic" or "microphone" in the name
  const preferredMic = microphones.find(
    (d) =>
      d.name.toLowerCase().includes("mic") ||
      d.name.toLowerCase().includes("microphone")
  );

  return preferredMic ?? microphones[0] ?? null;
}

/**
 * Find the best system audio device
 */
export function findSystemAudioDevice(
  devices: SystemAudioDevice[]
): SystemAudioDevice | null {
  const systemDevices = devices.filter((d) => d.isSystemAudio);
  return systemDevices[0] ?? null;
}

/**
 * Check if FFmpeg is installed
 */
export async function checkFFmpegInstalled(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["ffmpeg", "-version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Get device input arguments for FFmpeg based on platform
 */
export function getDeviceInputArgs(
  device: AudioDevice,
  platform: Platform
): string[] {
  if (platform === "darwin") {
    // macOS: Use avfoundation - ":index" means audio only (no video)
    return ["-f", "avfoundation", "-i", `:${device.index}`];
  } else if (platform === "win32") {
    // Windows: Use dshow
    return ["-f", "dshow", "-i", `audio=${device.name}`];
  } else {
    // Linux: Use pulse
    return ["-f", "pulse", "-i", device.name];
  }
}
