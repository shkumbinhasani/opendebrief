// Cross-platform clipboard utility
// Based on opencode's implementation

import { $ } from "bun";
import { platform } from "os";
import clipboardy from "clipboardy";

// Lazy initialization helper
function lazy<T>(fn: () => T): () => T {
  let value: T | undefined;
  return () => {
    if (value === undefined) {
      value = fn();
    }
    return value;
  };
}

export namespace Clipboard {
  export interface Content {
    data: string;
    mime: string;
  }

  /**
   * Get the appropriate copy method for the current platform
   */
  const getCopyMethod = lazy(() => {
    const os = platform();

    // macOS: Use osascript
    if (os === "darwin" && Bun.which("osascript")) {
      return async (text: string) => {
        const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        await $`osascript -e ${"set the clipboard to \"" + escaped + "\""}`.nothrow().quiet();
      };
    }

    // Linux: Try various clipboard tools
    if (os === "linux") {
      // Wayland
      if (process.env["WAYLAND_DISPLAY"] && Bun.which("wl-copy")) {
        return async (text: string) => {
          const proc = Bun.spawn(["wl-copy"], {
            stdin: "pipe",
            stdout: "ignore",
            stderr: "ignore",
          });
          if (proc.stdin && typeof proc.stdin !== "number") {
            proc.stdin.write(text);
            proc.stdin.end();
          }
          await proc.exited.catch(() => {});
        };
      }

      // X11 with xclip
      if (Bun.which("xclip")) {
        return async (text: string) => {
          const proc = Bun.spawn(["xclip", "-selection", "clipboard"], {
            stdin: "pipe",
            stdout: "ignore",
            stderr: "ignore",
          });
          if (proc.stdin && typeof proc.stdin !== "number") {
            proc.stdin.write(text);
            proc.stdin.end();
          }
          await proc.exited.catch(() => {});
        };
      }

      // X11 with xsel
      if (Bun.which("xsel")) {
        return async (text: string) => {
          const proc = Bun.spawn(["xsel", "--clipboard", "--input"], {
            stdin: "pipe",
            stdout: "ignore",
            stderr: "ignore",
          });
          if (proc.stdin && typeof proc.stdin !== "number") {
            proc.stdin.write(text);
            proc.stdin.end();
          }
          await proc.exited.catch(() => {});
        };
      }
    }

    // Windows: Use PowerShell
    if (os === "win32" && Bun.which("powershell")) {
      return async (text: string) => {
        const escaped = text.replace(/"/g, '`"').replace(/\$/g, "`$");
        await $`powershell -command ${'Set-Clipboard -Value "' + escaped + '"'}`.nothrow().quiet();
      };
    }

    // Fallback: Use clipboardy
    return async (text: string) => {
      await clipboardy.write(text).catch(() => {});
    };
  });

  /**
   * Get the appropriate read method for the current platform
   */
  const getReadMethod = lazy(() => {
    const os = platform();

    // macOS
    if (os === "darwin" && Bun.which("osascript")) {
      return async (): Promise<string> => {
        const result = await $`osascript -e 'the clipboard'`.nothrow().quiet().text();
        return result.trim();
      };
    }

    // Linux Wayland
    if (os === "linux" && process.env["WAYLAND_DISPLAY"] && Bun.which("wl-paste")) {
      return async (): Promise<string> => {
        const result = await $`wl-paste`.nothrow().quiet().text();
        return result.trim();
      };
    }

    // Linux X11
    if (os === "linux" && Bun.which("xclip")) {
      return async (): Promise<string> => {
        const result = await $`xclip -selection clipboard -o`.nothrow().quiet().text();
        return result.trim();
      };
    }

    // Windows
    if (os === "win32" && Bun.which("powershell")) {
      return async (): Promise<string> => {
        const result = await $`powershell -command Get-Clipboard`.nothrow().quiet().text();
        return result.trim();
      };
    }

    // Fallback
    return async (): Promise<string> => {
      return clipboardy.read().catch(() => "");
    };
  });

  /**
   * Copy text to clipboard
   */
  export async function copy(text: string): Promise<void> {
    const method = getCopyMethod();
    await method(text);
  }

  /**
   * Read text from clipboard
   */
  export async function read(): Promise<Content | undefined> {
    try {
      const method = getReadMethod();
      const text = await method();
      if (text) {
        return {
          data: text,
          mime: "text/plain",
        };
      }
    } catch {
      // Ignore errors
    }
    return undefined;
  }

  /**
   * Copy text and also emit OSC52 escape sequence for terminal clipboard sync
   * Useful for remote terminals and tmux sessions
   */
  export async function copyWithOSC52(
    text: string,
    writeOut: (data: string) => void
  ): Promise<void> {
    // Send OSC52 escape sequence
    const base64 = Buffer.from(text).toString("base64");
    const osc52 = `\x1b]52;c;${base64}\x07`;

    // Wrap for tmux if needed
    const finalOsc52 = process.env["TMUX"]
      ? `\x1bPtmux;\x1b${osc52}\x1b\\`
      : osc52;

    writeOut(finalOsc52);

    // Also copy using native method
    await copy(text);
  }
}
