// Meeting Transcriber TUI Application

import {
  createCliRenderer,
  type CliRenderer,
  BoxRenderable,
  TextRenderable,
  SelectRenderable,
  ASCIIFontRenderable,
  KeyEvent,
  t,
  dim,
  bold,
  fg,
  bg,
  type StyledText,
} from "@opentui/core";

// OpenCode theme colors (dark mode)
const colors = {
  primary: "#fab283",      // warm peach/orange
  secondary: "#5c9cf5",    // bright blue
  accent: "#9d7cd8",       // purple
  text: "#eeeeee",         // normal text
  textMuted: "#808080",    // muted text
  success: "#7fd88f",      // success
  warning: "#f5a742",      // orange/warning
  error: "#e06c75",        // red
  info: "#56b6c2",         // secondary
  background: "#0a0a0a",   // main background
  backgroundPanel: "#141414", // panel background
  backgroundElement: "#1e1e1e", // element background
  border: "#484848",       // border
  borderActive: "#606060", // active border
};

// Color helper functions using OpenCode theme
const primary = fg(colors.primary);
const secondary = fg(colors.secondary);
const accent = fg(colors.accent);
const text = fg(colors.text);
const muted = fg(colors.textMuted);
const success = fg(colors.success);
const warning = fg(colors.warning);
const error = fg(colors.error);
const info = fg(colors.info);
const successBg = bg(colors.success);
const warningBg = bg(colors.warning);

import { homedir } from "os";
import { join } from "path";
import { mkdir } from "fs/promises";

import {
  NativeAudioRecorder,
  listNativeDevices,
  findMicrophones,
  findSystemAudio,
  isNativeRecorderAvailable,
  checkScreenRecordingPermission,
  formatDuration,
  type NativeDevice,
  type RecordingState,
} from "./audio/native-recorder";

import { Clipboard } from "./util/clipboard";
import { configManager, type Config } from "./config";
import { authManager, Providers, type ProviderID } from "./auth";
import { transcribeAndSave, isTranscriptionAvailable, getAvailableProviders, formatTimestamp, type TranscriptionResult } from "./ai/transcribe";
import { summarizeTranscript, saveSummary, isSummarizationAvailable, hasSummary, loadSummary, type SummaryResult } from "./ai/summarize";
import { VERSION } from "./version";

// Auth status type
interface AuthStatus {
  openai: { authenticated: boolean; source: "env" | "file" | "none" };
  elevenlabs: { authenticated: boolean; source: "env" | "file" | "none" };
}

// Application state
// Recording file info for the recordings list
interface RecordingInfo {
  path: string;
  name: string;
  date: Date;
  hasTranscript: boolean;
  transcriptPath?: string;
  sizeBytes: number;
}

interface AppState {
  screen: "main" | "device-select" | "recording" | "error" | "info" | "auth" | "auth-input" | "transcribing" | "transcript" | "recordings" | "summarizing" | "summary";
  devices: NativeDevice[];
  selectedMic: NativeDevice | null;
  selectedSystemAudio: NativeDevice | null;
  recordingState: RecordingState;
  elapsedTime: number;
  outputPath: string;
  transcriptPath: string;
  errorMessage: string;
  deviceSelectType: "mic" | "system";
  recordBoth: boolean;
  // Auth state
  authStatus: AuthStatus;
  // Transcription state
  isTranscribing: boolean;
  lastRecordingPath: string;
  lastTranscription: TranscriptionResult | null;
  transcriptScrollOffset: number;
  authInputProvider: ProviderID | null;
  authInputValue: string;
  // Recordings list state
  recordings: RecordingInfo[];
  recordingsSelectedIndex: number;
  recordingsScrollOffset: number;
  // Summary state
  isSummarizing: boolean;
  lastSummary: SummaryResult | null;
  summaryScrollOffset: number;
  // Update notification
  updateAvailable: boolean;
  latestVersion: string;
  upgradeCommand: string;
  // Permissions
  screenRecordingPermission: boolean | null; // null = not checked yet
  permissionError: string | null;
  // Toast notification
  toast: {
    visible: boolean;
    title?: string;
    message: string;
    variant: "info" | "success" | "warning" | "error";
  } | null;
}

export class MeetingTranscriberApp {
  private renderer!: CliRenderer;
  private state: AppState;
  private config!: Config;
  private recorder: NativeAudioRecorder | null = null;
  private updateInterval: ReturnType<typeof setInterval> | null = null;

  // UI Components
  private mainContainer!: BoxRenderable;
  private leftPanel!: BoxRenderable;
  private rightPanel!: BoxRenderable;
  private recordingsListText!: TextRenderable;
  private statusText!: TextRenderable;
  private contentText!: TextRenderable;
  private helpText!: TextRenderable;
  private deviceSelect!: SelectRenderable;
  private toastContainer!: BoxRenderable;
  private toastText!: TextRenderable;

  constructor() {
    this.state = {
      screen: "main",
      devices: [],
      selectedMic: null,
      selectedSystemAudio: null,
      recordingState: "idle",
      elapsedTime: 0,
      outputPath: "",
      transcriptPath: "",
      errorMessage: "",
      deviceSelectType: "mic",
      recordBoth: false,
      // Auth state
      authStatus: {
        openai: { authenticated: false, source: "none" },
        elevenlabs: { authenticated: false, source: "none" },
      },
      authInputProvider: null,
      authInputValue: "",
      // Transcription state
      isTranscribing: false,
      lastRecordingPath: "",
      lastTranscription: null,
      transcriptScrollOffset: 0,
      // Recordings list state
      recordings: [] as RecordingInfo[],
      recordingsSelectedIndex: 0,
      recordingsScrollOffset: 0,
      // Summary state
      isSummarizing: false,
      lastSummary: null,
      summaryScrollOffset: 0,
      // Update notification (set by CLI via env vars)
      updateAvailable: process.env.OPENDEBRIEF_UPDATE_AVAILABLE === "1",
      latestVersion: process.env.OPENDEBRIEF_LATEST_VERSION || "",
      upgradeCommand: process.env.OPENDEBRIEF_UPGRADE_COMMAND || "npm install -g opendebrief@latest",
      // Permissions
      screenRecordingPermission: null,
      permissionError: null,
      // Toast
      toast: null,
    };
  }
  
  private toastTimeout: ReturnType<typeof setTimeout> | null = null;
  
  private showToast(options: {
    title?: string;
    message: string;
    variant: "info" | "success" | "warning" | "error";
    duration?: number;
  }): void {
    const { duration = 5000, ...toastData } = options;
    
    this.state.toast = { visible: true, ...toastData };
    this.updateUI();
    
    if (this.toastTimeout) {
      clearTimeout(this.toastTimeout);
    }
    
    this.toastTimeout = setTimeout(() => {
      this.state.toast = null;
      this.updateUI();
    }, duration);
  }

  private getRecordingsDir(): string {
    // Use custom directory from config if set, otherwise default
    return this.config?.output?.directory || join(homedir(), "MeetingRecordings");
  }

  private async ensureRecordingsDir(): Promise<void> {
    const dir = this.getRecordingsDir();
    await mkdir(dir, { recursive: true });
  }

  private generateOutputPath(): string {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    return join(this.getRecordingsDir(), `recording_${timestamp}.m4a`);
  }

  private async scanRecordings(): Promise<RecordingInfo[]> {
    const dir = this.getRecordingsDir();
    const recordings: RecordingInfo[] = [];

    try {
      const glob = new Bun.Glob("*.m4a");
      const files = await Array.fromAsync(glob.scan({ cwd: dir, absolute: true }));

      for (const filePath of files) {
        const file = Bun.file(filePath);
        const stat = await file.stat();
        if (!stat) continue;

        const name = filePath.split("/").pop() || filePath;
        const transcriptPath = filePath.replace(/\.m4a$/, ".txt");
        const transcriptFile = Bun.file(transcriptPath);
        const hasTranscript = await transcriptFile.exists();

        recordings.push({
          path: filePath,
          name,
          date: new Date(stat.mtime),
          hasTranscript,
          transcriptPath: hasTranscript ? transcriptPath : undefined,
          sizeBytes: stat.size,
        });
      }

      // Sort by date, newest first
      recordings.sort((a, b) => b.date.getTime() - a.date.getTime());
    } catch (error) {
      // Directory might not exist yet
    }

    return recordings;
  }

  private formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  private formatDate(date: Date): string {
    return date.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  private formatDateCompact(date: Date): string {
    return date.toLocaleString("en-US", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }

  async init(): Promise<void> {
    // Check native recorder
    const hasNative = await isNativeRecorderAvailable();
    if (!hasNative) {
      console.error("Native recorder not found. Please compile it first:");
      console.error("  cd native && swiftc -O -o recorder recorder.swift");
      process.exit(1);
    }

    // Load config
    this.config = await configManager.get();

    // Load auth status
    this.state.authStatus = await authManager.getStatus();

    // Create renderer
    this.renderer = await createCliRenderer({
      exitOnCtrlC: false,
      useMouse: true,
      useAlternateScreen: true,
    });

    // Load devices and apply saved preferences
    await this.loadDevices();

    // Check screen recording permission (triggers prompt if needed)
    await this.checkPermissions();

    // Load recordings list
    this.state.recordings = await this.scanRecordings();

    // Generate initial output path
    this.state.outputPath = this.generateOutputPath();

    // Build UI
    this.buildUI();

    // Setup keyboard handlers
    this.setupKeyboardHandlers();

    // Start render loop
    this.renderer.start();

    // Initial render
    this.updateUI();

    // Show update notification toast if available
    if (this.state.updateAvailable && this.state.latestVersion) {
      this.showToast({
        title: "Update Available",
        message: `v${this.state.latestVersion} is available\n${this.state.upgradeCommand}`,
        variant: "info",
        duration: 8000,
      });
    }
  }

  private async loadDevices(): Promise<void> {
    try {
      this.state.devices = await listNativeDevices();
      const mics = findMicrophones(this.state.devices);
      this.state.selectedSystemAudio = findSystemAudio(this.state.devices);

      // Try to restore saved microphone from config
      const savedMicId = this.config.audio.selectedMicId;
      const savedMicName = this.config.audio.selectedMicName;

      if (savedMicId || savedMicName) {
        // First try to match by ID
        let savedMic = mics.find((m) => m.id === savedMicId);
        // Fall back to matching by name
        if (!savedMic && savedMicName) {
          savedMic = mics.find((m) => m.name === savedMicName);
        }
        this.state.selectedMic = savedMic ?? mics[0] ?? null;
      } else {
        this.state.selectedMic = mics[0] ?? null;
      }

      // Restore recording mode from config
      const savedMode = this.config.audio.recordingMode;
      if (savedMode === "both" && this.state.selectedSystemAudio) {
        this.state.recordBoth = true;
      } else if (savedMode === "system" && this.state.selectedSystemAudio) {
        this.state.recordBoth = false;
        this.state.selectedMic = null;
      } else {
        // Default to mic mode
        this.state.recordBoth = false;
      }
    } catch (error) {
      this.state.errorMessage = `Failed to load devices: ${(error as Error).message}`;
    }
  }

  private async checkPermissions(): Promise<void> {
    // Only check if system audio is available (selected)
    if (this.state.selectedSystemAudio) {
      const status = await checkScreenRecordingPermission();
      this.state.screenRecordingPermission = status.screenRecording;
      this.state.permissionError = status.errorMessage || null;
    } else {
      // No system audio selected, permission not needed
      this.state.screenRecordingPermission = true;
      this.state.permissionError = null;
    }
  }

  private buildUI(): void {
    const { root } = this.renderer;

    // Main container - vertical layout
    this.mainContainer = new BoxRenderable(this.renderer, {
      width: "100%",
      height: "100%",
      flexDirection: "column",
      padding: 1,
      backgroundColor: colors.background,
    });
    root.add(this.mainContainer);

    // Content area - horizontal split (left: status, right: recordings)
    const contentArea = new BoxRenderable(this.renderer, {
      width: "100%",
      flexGrow: 1,
      flexDirection: "row",
      gap: 1,
    });
    this.mainContainer.add(contentArea);

    // Left panel - Status/Content
    this.leftPanel = new BoxRenderable(this.renderer, {
      width: "65%",
      height: "100%",
      flexDirection: "column",
      padding: 1,
      border: true,
      borderStyle: "rounded",
      borderColor: colors.primary,
    });
    contentArea.add(this.leftPanel);

    // ASCII Art Title
    const asciiTitle = new ASCIIFontRenderable(this.renderer, {
      text: "opendebrief",
      font: "tiny",
      color: [colors.primary, colors.secondary, colors.accent],
    });
    this.leftPanel.add(asciiTitle);

    // Status header
    this.statusText = new TextRenderable(this.renderer, {
      content: "READY",
      marginTop: 1,
    });
    this.leftPanel.add(this.statusText);

    // Main content area
    this.contentText = new TextRenderable(this.renderer, {
      content: "Loading...",
      marginTop: 1,
    });
    this.leftPanel.add(this.contentText);

    // Device select (hidden initially)
    this.deviceSelect = new SelectRenderable(this.renderer, {
      width: "100%",
      height: 8,
      options: [],
      visible: false,
      marginTop: 1,
      backgroundColor: colors.backgroundElement,
      focusedBackgroundColor: colors.borderActive,
      selectedBackgroundColor: colors.primary,
    });
    this.leftPanel.add(this.deviceSelect);

    // Right panel - Recordings list (compact)
    this.rightPanel = new BoxRenderable(this.renderer, {
      width: "35%",
      height: "100%",
      flexDirection: "column",
      padding: 1,
      border: true,
      borderStyle: "rounded",
      borderColor: colors.border,
    });
    contentArea.add(this.rightPanel);

    const rightTitle = new TextRenderable(this.renderer, {
      content: t`${bold(primary("RECORDINGS"))}`,
    });
    this.rightPanel.add(rightTitle);

    this.recordingsListText = new TextRenderable(this.renderer, {
      content: "Loading...",
      marginTop: 1,
    });
    this.rightPanel.add(this.recordingsListText);

    // Help text at bottom
    const helpBox = new BoxRenderable(this.renderer, {
      width: "100%",
      height: 3,
      marginTop: 1,
      padding: 1,
      border: true,
      borderStyle: "rounded",
      borderColor: colors.border,
    });
    this.mainContainer.add(helpBox);

    this.helpText = new TextRenderable(this.renderer, {
      content: this.getHelpText(),
    });
    helpBox.add(this.helpText);

    // Toast notification container (absolute positioned, top-right)
    this.toastContainer = new BoxRenderable(this.renderer, {
      position: "absolute",
      top: 2,
      right: 2,
      width: 40,
      padding: 1,
      border: true,
      borderStyle: "rounded",
      borderColor: colors.info,
      backgroundColor: colors.backgroundPanel,
      visible: false,
    });
    root.add(this.toastContainer);

    this.toastText = new TextRenderable(this.renderer, {
      content: "",
    });
    this.toastContainer.add(this.toastText);
  }

  private getHelpText(): StyledText {
    switch (this.state.screen) {
      case "main":
        if (this.state.recordingState === "recording") {
          return t`${error("[x]")} Stop  ${dim("[q]")} Quit`;
        }
        if (this.state.lastRecordingPath && this.state.errorMessage.includes("saved")) {
          return t`${success("[t]")} Transcribe  ${secondary("[r]")} Record  ${dim("[l]")} List  ${dim("[a]")} Keys  ${dim("[q]")} Quit`;
        }
        const hasSystem = this.state.selectedSystemAudio !== null;
        if (hasSystem) {
          return t`${success("[r]")} Record  ${secondary("[m]")} Mic  ${secondary("[s]")} Sys  ${secondary("[b]")} Both  ${dim("[l]")} List  ${dim("[a]")} Keys  ${dim("[q]")} Quit`;
        }
        return t`${success("[r]")} Record  ${secondary("[m]")} Mic  ${dim("[l]")} List  ${dim("[a]")} Keys  ${dim("[q]")} Quit`;
      case "device-select":
        return t`${success("[Enter]")} Select  ${dim("[Esc]")} Back  ${dim("[↑/↓]")} Navigate`;
      case "auth":
        return t`${secondary("[1]")} OpenAI  ${secondary("[2]")} ElevenLabs  ${warning("[d]")} Delete  ${dim("[Esc]")} Back`;
      case "auth-input":
        return t`${success("[Enter]")} Save  ${secondary("[v]")} Paste  ${dim("[c]")} Clear  ${dim("[Esc]")} Back`;
      case "transcribing":
        return t`${warning("Transcribing...")}`;
      case "transcript":
        const canSummarize = this.state.authStatus.openai.authenticated;
        if (canSummarize) {
          return t`${success("[s]")} Summarize  ${dim("[↑/↓]")} Scroll  ${secondary("[c]")} Copy  ${dim("[Esc]")} Back`;
        }
        return t`${dim("[↑/↓]")} Scroll  ${secondary("[c]")} Copy  ${dim("[Esc]")} Back`;
      case "summarizing":
        return t`${warning("Summarizing with AI...")}`;
      case "summary":
        return t`${dim("[↑/↓]")} Scroll  ${secondary("[c]")} Copy  ${dim("[Esc]")} Back to transcript`;
      case "recordings":
        const hasApi = this.state.authStatus.openai.authenticated || 
                       this.state.authStatus.elevenlabs.authenticated;
        if (hasApi) {
          return t`${success("[Enter]")} Transcribe  ${secondary("[v]")} View  ${warning("[d]")} Delete  ${dim("[↑/↓]")} Nav  ${dim("[Esc]")} Back`;
        }
        return t`${secondary("[v]")} View  ${warning("[d]")} Delete  ${dim("[↑/↓]")} Navigate  ${dim("[Esc]")} Back`;
      case "info":
        return t`${dim("[Esc]")} Back`;
      default:
        return t`${dim("[q]")} Quit`;
    }
  }

  private setupKeyboardHandlers(): void {
    this.renderer.keyInput.on("keypress", (key: KeyEvent) => {
      this.handleKeypress(key);
    });
  }

  private handleKeypress(key: KeyEvent): void {
    // Global quit handler
    if (key.ctrl && key.name === "c") {
      this.quit();
      return;
    }

    switch (this.state.screen) {
      case "main":
        this.handleMainScreenKeys(key);
        break;
      case "device-select":
        this.handleDeviceSelectKeys(key);
        break;
      case "auth":
        this.handleAuthScreenKeys(key);
        break;
      case "auth-input":
        this.handleAuthInputKeys(key);
        break;
      case "info":
        this.handleInfoScreenKeys(key);
        break;
      case "transcript":
        this.handleTranscriptScreenKeys(key);
        break;
      case "recordings":
        this.handleRecordingsScreenKeys(key);
        break;
      case "summary":
        this.handleSummaryScreenKeys(key);
        break;
    }
  }

  private handleMainScreenKeys(key: KeyEvent): void {
    if (this.state.recordingState === "idle") {
      switch (key.name) {
        case "r":
          this.startRecording();
          break;
        case "m":
          this.showDeviceSelect("mic");
          break;
        case "s":
          if (this.state.selectedSystemAudio) {
            this.state.recordBoth = false;
            this.state.selectedMic = null;
            // Save mode to config
            configManager.setRecordingMode("system");
            this.updateUI();
          }
          break;
        case "b":
          if (this.state.selectedSystemAudio) {
            this.state.recordBoth = true;
            const mics = findMicrophones(this.state.devices);
            // Restore saved mic or use first available
            const savedMicId = this.config.audio.selectedMicId;
            const savedMic = savedMicId 
              ? mics.find((m) => m.id === savedMicId) 
              : null;
            this.state.selectedMic = savedMic ?? mics[0] ?? null;
            // Save mode to config
            configManager.setRecordingMode("both");
            this.updateUI();
          }
          break;
        case "t":
          // Transcribe last recording
          const canTranscribe = this.state.authStatus.openai.authenticated || 
                                this.state.authStatus.elevenlabs.authenticated;
          if (this.state.lastRecordingPath && canTranscribe) {
            this.startTranscription();
          }
          break;
        case "c":
          this.copyOutputPath();
          break;
        case "a":
          this.showAuthScreen();
          break;
        case "i":
          this.showSystemAudioInfo();
          break;
        case "l":
          this.showRecordingsList();
          break;
        case "q":
          this.quit();
          break;
      }
    } else if (this.state.recordingState === "recording") {
      switch (key.name) {
        case "x":
          this.stopRecording();
          break;
        case "q":
          this.stopRecording().then(() => this.quit());
          break;
      }
    }
  }

  private async handleDeviceSelectKeys(key: KeyEvent): Promise<void> {
    if (key.name === "escape") {
      this.state.screen = "main";
      this.deviceSelect.visible = false;
      this.updateUI();
    } else if (key.name === "return" || key.name === "enter") {
      const selected = this.deviceSelect.getSelectedOption();
      if (selected?.value) {
        if (this.state.deviceSelectType === "mic") {
          const device = selected.value as NativeDevice;
          this.state.selectedMic = device;
          // If not in "both" mode, switch to mic mode
          if (!this.state.recordBoth) {
            await configManager.setRecordingMode("mic");
          }
          // Save microphone selection to config
          await configManager.setSelectedMic(device.id, device.name);
        } else {
          this.state.selectedSystemAudio = selected.value as NativeDevice;
        }
      }
      this.state.screen = "main";
      this.deviceSelect.visible = false;
      this.updateUI();
    }
  }

  private handleInfoScreenKeys(key: KeyEvent): void {
    if (key.name === "escape" || key.name === "i" || key.name === "q") {
      this.state.screen = "main";
      this.state.errorMessage = "";
      this.updateUI();
    }
  }

  private handleTranscriptScreenKeys(key: KeyEvent): void {
    switch (key.name) {
      case "escape":
        this.state.screen = "main";
        this.state.transcriptScrollOffset = 0;
        this.updateUI();
        break;
      case "q":
        this.quit();
        break;
      case "up":
        if (this.state.transcriptScrollOffset > 0) {
          this.state.transcriptScrollOffset--;
          this.updateUI();
        }
        break;
      case "down":
        this.state.transcriptScrollOffset++;
        this.updateUI();
        break;
      case "pageup":
        this.state.transcriptScrollOffset = Math.max(0, this.state.transcriptScrollOffset - 10);
        this.updateUI();
        break;
      case "pagedown":
        this.state.transcriptScrollOffset += 10;
        this.updateUI();
        break;
      case "c":
        // Copy transcript to clipboard
        if (this.state.lastTranscription) {
          this.copyTranscriptToClipboard();
        }
        break;
      case "s":
        // Summarize with AI
        if (this.state.lastTranscription && this.state.authStatus.openai.authenticated) {
          this.startSummarization();
        }
        break;
    }
  }

  private async startSummarization(): Promise<void> {
    if (!this.state.lastTranscription) return;
    
    // Check if summary already exists
    if (this.state.transcriptPath) {
      const existingSummary = await loadSummary(this.state.transcriptPath);
      if (existingSummary) {
        this.state.lastSummary = existingSummary;
        this.state.summaryScrollOffset = 0;
        this.state.screen = "summary";
        this.state.errorMessage = "";
        this.updateUI();
        return;
      }
    }
    
    this.state.isSummarizing = true;
    this.state.screen = "summarizing";
    this.state.errorMessage = "";
    this.updateUI();

    try {
      const summary = await summarizeTranscript({
        transcript: this.state.lastTranscription,
      });
      
      // Save summary if we have a transcript path
      if (this.state.transcriptPath) {
        await saveSummary(this.state.transcriptPath, summary);
      }
      
      this.state.lastSummary = summary;
      this.state.isSummarizing = false;
      this.state.summaryScrollOffset = 0;
      this.state.screen = "summary";
    } catch (error) {
      this.state.isSummarizing = false;
      this.state.screen = "transcript";
      this.state.errorMessage = `Summary failed: ${(error as Error).message}`;
    }
    
    this.updateUI();
  }

  private handleSummaryScreenKeys(key: KeyEvent): void {
    switch (key.name) {
      case "escape":
        this.state.screen = "transcript";
        this.state.summaryScrollOffset = 0;
        this.updateUI();
        break;
      case "q":
        this.quit();
        break;
      case "up":
        if (this.state.summaryScrollOffset > 0) {
          this.state.summaryScrollOffset--;
          this.updateUI();
        }
        break;
      case "down":
        this.state.summaryScrollOffset++;
        this.updateUI();
        break;
      case "c":
        // Copy summary to clipboard
        if (this.state.lastSummary) {
          this.copySummaryToClipboard();
        }
        break;
    }
  }

  private async copySummaryToClipboard(): Promise<void> {
    if (!this.state.lastSummary) return;
    
    const summary = this.state.lastSummary;
    let text = `## Summary\n${summary.summary}\n\n`;
    
    if (summary.keyPoints.length > 0) {
      text += `## Key Points\n${summary.keyPoints.map(p => `- ${p}`).join("\n")}\n\n`;
    }
    
    if (summary.actionItems.length > 0) {
      text += `## Action Items\n${summary.actionItems.map(i => `- ${i}`).join("\n")}`;
    }
    
    await Clipboard.copy(text);
    this.state.errorMessage = "Summary copied!";
    this.updateUI();
    
    setTimeout(() => {
      if (this.state.errorMessage === "Summary copied!") {
        this.state.errorMessage = "";
        this.updateUI();
      }
    }, 2000);
  }

  private async copyTranscriptToClipboard(): Promise<void> {
    if (!this.state.lastTranscription) return;
    
    const transcript = this.state.lastTranscription;
    let text = transcript.text;
    
    // If we have speakers, format with speaker labels
    if (transcript.speakers && transcript.speakers.length > 1) {
      text = transcript.segments
        .map(s => `${s.speakerId ? `[${s.speakerId}] ` : ""}${s.text.trim()}`)
        .join("\n");
    }
    
    await Clipboard.copy(text);
    this.state.errorMessage = "Transcript copied to clipboard!";
    this.updateUI();
    
    setTimeout(() => {
      if (this.state.errorMessage === "Transcript copied to clipboard!") {
        this.state.errorMessage = "";
        this.updateUI();
      }
    }, 2000);
  }

  private handleRecordingsScreenKeys(key: KeyEvent): void {
    const recordings = this.state.recordings;
    const maxVisible = 6;

    switch (key.name) {
      case "escape":
        this.state.screen = "main";
        this.state.recordingsSelectedIndex = 0;
        this.state.recordingsScrollOffset = 0;
        this.updateUI();
        break;
      case "q":
        this.quit();
        break;
      case "up":
        if (this.state.recordingsSelectedIndex > 0) {
          this.state.recordingsSelectedIndex--;
          // Adjust scroll if needed
          if (this.state.recordingsSelectedIndex < this.state.recordingsScrollOffset) {
            this.state.recordingsScrollOffset = this.state.recordingsSelectedIndex;
          }
          this.updateUI();
        }
        break;
      case "down":
        if (this.state.recordingsSelectedIndex < recordings.length - 1) {
          this.state.recordingsSelectedIndex++;
          // Adjust scroll if needed
          if (this.state.recordingsSelectedIndex >= this.state.recordingsScrollOffset + maxVisible) {
            this.state.recordingsScrollOffset = this.state.recordingsSelectedIndex - maxVisible + 1;
          }
          this.updateUI();
        }
        break;
      case "return":
      case "enter":
        // Transcribe selected recording
        {
          const selected = recordings[this.state.recordingsSelectedIndex];
          if (selected) {
            const canTranscribe = this.state.authStatus.openai.authenticated || 
                                  this.state.authStatus.elevenlabs.authenticated;
            if (canTranscribe && !selected.hasTranscript) {
              this.state.lastRecordingPath = selected.path;
              this.state.screen = "main";
              this.startTranscription();
            } else if (selected.hasTranscript) {
              this.state.errorMessage = "Already transcribed. Press [v] to view.";
              this.updateUI();
              setTimeout(() => {
                if (this.state.errorMessage === "Already transcribed. Press [v] to view.") {
                  this.state.errorMessage = "";
                  this.updateUI();
                }
              }, 2000);
            }
          }
        }
        break;
      case "v":
        // View transcript if available
        {
          const selected = recordings[this.state.recordingsSelectedIndex];
          if (selected) {
            if (selected.hasTranscript && selected.transcriptPath) {
              this.viewTranscriptFile(selected.transcriptPath);
            } else {
              this.state.errorMessage = "No transcript available. Press [Enter] to transcribe.";
              this.updateUI();
              setTimeout(() => {
                if (this.state.errorMessage === "No transcript available. Press [Enter] to transcribe.") {
                  this.state.errorMessage = "";
                  this.updateUI();
                }
              }, 2000);
            }
          }
        }
        break;
      case "d":
        // Delete recording
        if (recordings.length > 0) {
          this.deleteRecording(this.state.recordingsSelectedIndex);
        }
        break;
    }
  }

  private async showRecordingsList(): Promise<void> {
    this.state.recordings = await this.scanRecordings();
    this.state.recordingsSelectedIndex = 0;
    this.state.recordingsScrollOffset = 0;
    this.state.screen = "recordings";
    this.state.errorMessage = "";
    this.updateUI();
  }

  private async viewTranscriptFile(transcriptPath: string): Promise<void> {
    try {
      const content = await Bun.file(transcriptPath).text();
      // Create a mock TranscriptionResult for the transcript viewer
      this.state.lastTranscription = {
        text: content,
        segments: [],
        provider: "openai", // doesn't matter for viewing
      };
      this.state.transcriptPath = transcriptPath;
      this.state.transcriptScrollOffset = 0;
      this.state.screen = "transcript";
      this.updateUI();
    } catch (error) {
      this.state.errorMessage = `Failed to read transcript: ${(error as Error).message}`;
      this.updateUI();
    }
  }

  private async deleteRecording(index: number): Promise<void> {
    const recording = this.state.recordings[index];
    if (!recording) return;

    try {
      // Delete audio file
      const { unlink } = await import("fs/promises");
      await unlink(recording.path);
      
      // Delete transcript if exists
      if (recording.hasTranscript && recording.transcriptPath) {
        await unlink(recording.transcriptPath);
      }

      // Refresh recordings list
      this.state.recordings = await this.scanRecordings();
      
      // Adjust selected index if needed
      if (this.state.recordingsSelectedIndex >= this.state.recordings.length) {
        this.state.recordingsSelectedIndex = Math.max(0, this.state.recordings.length - 1);
      }

      this.state.errorMessage = "Recording deleted";
      this.updateUI();

      setTimeout(() => {
        if (this.state.errorMessage === "Recording deleted") {
          this.state.errorMessage = "";
          this.updateUI();
        }
      }, 2000);
    } catch (error) {
      this.state.errorMessage = `Delete failed: ${(error as Error).message}`;
      this.updateUI();
    }
  }

  private handleAuthScreenKeys(key: KeyEvent): void {
    switch (key.name) {
      case "escape":
        this.state.screen = "main";
        this.state.errorMessage = "";
        this.updateUI();
        break;
      case "1":
        this.startAuthInput("openai");
        break;
      case "2":
        this.startAuthInput("elevenlabs");
        break;
      case "d":
        // Delete key - show delete options
        this.showAuthDeleteOptions();
        break;
    }
  }

  private handleAuthInputKeys(key: KeyEvent): void {
    if (key.name === "escape") {
      this.state.screen = "auth";
      this.state.authInputValue = "";
      this.state.authInputProvider = null;
      this.updateUI();
      return;
    }

    if (key.name === "return" || key.name === "enter") {
      this.saveAuthInput();
      return;
    }

    if (key.name === "backspace") {
      this.state.authInputValue = this.state.authInputValue.slice(0, -1);
      this.updateUI();
      return;
    }

    // Paste from clipboard with 'v' key
    if (key.name === "v" || (key.ctrl && key.name === "v")) {
      this.pasteFromClipboard();
      return;
    }

    // Clear input with 'c' key
    if (key.name === "c" && !key.ctrl) {
      this.state.authInputValue = "";
      this.updateUI();
      return;
    }

    // Handle paste (multiple characters) or single character input
    if (key.sequence && !key.ctrl && !key.meta) {
      // Filter out control characters, allow printable ASCII and pasted content
      const printable = key.sequence.replace(/[\x00-\x1F\x7F]/g, "");
      if (printable.length > 0) {
        this.state.authInputValue += printable;
        this.updateUI();
      }
    }
  }

  private async pasteFromClipboard(): Promise<void> {
    try {
      const content = await Clipboard.read();
      if (content?.data) {
        // Clean the pasted content - remove textspace and newlines
        const cleaned = content.data.trim().replace(/[\r\n]/g, "");
        this.state.authInputValue = cleaned;
        this.state.errorMessage = "Pasted from clipboard";
        this.updateUI();
        
        // Clear the message after a short delay
        setTimeout(() => {
          if (this.state.errorMessage === "Pasted from clipboard") {
            this.state.errorMessage = "";
            this.updateUI();
          }
        }, 1500);
      } else {
        this.state.errorMessage = "Clipboard is empty";
        this.updateUI();
      }
    } catch (error) {
      this.state.errorMessage = "Failed to read clipboard";
      this.updateUI();
    }
  }

  private showAuthScreen(): void {
    this.state.screen = "auth";
    this.state.errorMessage = "";
    this.updateUI();
  }

  private startAuthInput(provider: ProviderID): void {
    this.state.screen = "auth-input";
    this.state.authInputProvider = provider;
    this.state.authInputValue = "";
    this.state.errorMessage = "";
    this.updateUI();
  }

  private async saveAuthInput(): Promise<void> {
    const provider = this.state.authInputProvider;
    const key = this.state.authInputValue.trim();

    if (!provider) return;

    // Validate
    const validation = authManager.validate(provider, key);
    if (!validation.valid) {
      this.state.errorMessage = validation.error || "Invalid API key";
      this.updateUI();
      return;
    }

    // Save
    try {
      await authManager.set(provider, key);
      this.state.authStatus = await authManager.getStatus();
      this.state.errorMessage = `${Providers[provider].name} API key saved!`;
      this.state.screen = "auth";
      this.state.authInputValue = "";
      this.state.authInputProvider = null;
    } catch (error) {
      this.state.errorMessage = `Failed to save: ${(error as Error).message}`;
    }
    this.updateUI();
  }

  private async showAuthDeleteOptions(): Promise<void> {
    // For simplicity, just show which keys can be deleted
    const status = this.state.authStatus;
    const deletable: string[] = [];

    if (status.openai.source === "file") deletable.push("OpenAI (press 1)");
    if (status.elevenlabs.source === "file") deletable.push("ElevenLabs (press 2)");

    if (deletable.length === 0) {
      this.state.errorMessage = "No stored API keys to delete";
    } else {
      this.state.errorMessage = `Delete: ${deletable.join(", ")}`;
    }
    this.updateUI();
  }

  private async startTranscription(): Promise<void> {
    if (!this.state.lastRecordingPath) {
      this.state.errorMessage = "No recording to transcribe";
      this.updateUI();
      return;
    }

    // Determine which provider will be used
    const providers = await getAvailableProviders();
    const provider = providers[0]; // ElevenLabs is preferred if available
    const providerName = provider === "elevenlabs" ? "ElevenLabs Scribe" : "OpenAI Whisper";

    this.state.screen = "transcribing";
    this.state.isTranscribing = true;
    this.state.errorMessage = `Transcribing with ${providerName}...`;
    this.updateUI();

    try {
      const { transcriptPath, result } = await transcribeAndSave(this.state.lastRecordingPath, {
        diarize: true, // Enable speaker diarization for meetings
      });
      
      this.state.transcriptPath = transcriptPath;
      this.state.lastTranscription = result;
      this.state.isTranscribing = false;
      this.state.transcriptScrollOffset = 0;
      this.state.screen = "transcript"; // Show transcript screen
      this.state.errorMessage = "";
    } catch (error) {
      this.state.isTranscribing = false;
      this.state.screen = "main";
      this.state.errorMessage = `Transcription failed: ${(error as Error).message}`;
    }
    
    this.updateUI();
  }

  private showDeviceSelect(type: "mic" | "system"): void {
    const devices = type === "mic" 
      ? findMicrophones(this.state.devices)
      : this.state.devices.filter(d => d.type === "system");

    const options = devices.map((d) => ({
      name: d.name,
      description: d.type === "system" ? "(System Audio)" : "(Microphone)",
      value: d,
    }));

    if (options.length === 0) {
      this.state.errorMessage = "No audio devices found";
      this.updateUI();
      return;
    }

    this.state.deviceSelectType = type;
    this.deviceSelect.options = options;
    this.deviceSelect.visible = true;
    this.deviceSelect.focus();
    this.state.screen = "device-select";

    this.updateUI();
  }

  private showSystemAudioInfo(): void {
    this.state.screen = "info";
    const infoText = `
SYSTEM AUDIO CAPTURE

This app uses ScreenCaptureKit to capture system audio.
No additional software (like BlackHole) is needed!

FIRST TIME SETUP:
1. When you start recording system audio, macOS will ask
   for Screen Recording permission
2. Go to: System Settings -> Privacy & Security -> Screen Recording
3. Enable permission for Terminal (or your terminal app)
4. Restart the app

The system audio option should appear automatically if
your macOS version is 12.3 or later.
    `.trim();

    this.state.errorMessage = infoText;
    this.updateUI();
  }

  private isStartingRecording = false;
  
  private async startRecording(): Promise<void> {
    // Guard against double-start (use flag since this is async)
    if (this.isStartingRecording || this.recorder || this.state.recordingState !== "idle") {
      return;
    }
    this.isStartingRecording = true;
    
    const recordMic = this.state.selectedMic !== null;
    const recordSystem = this.state.selectedSystemAudio !== null && 
      (this.state.recordBoth || !recordMic);

    if (!recordMic && !recordSystem) {
      this.state.errorMessage = "Please select at least one audio source";
      this.updateUI();
      return;
    }

    // Ensure recordings directory exists
    await this.ensureRecordingsDir();

    this.state.outputPath = this.generateOutputPath();
    this.state.errorMessage = "";

    this.recorder = new NativeAudioRecorder({
      outputPath: this.state.outputPath,
      recordMic,
      recordSystem,
    });

    this.recorder.on("stateChange", (state) => {
      this.state.recordingState = state;
      this.updateUI();
    });

    this.recorder.on("error", (error) => {
      this.state.errorMessage = error.message;
      this.updateUI();
    });

    this.recorder.on("stopped", ({ outputPath }) => {
      this.state.lastRecordingPath = outputPath;
      const hasElevenLabs = this.state.authStatus.elevenlabs.authenticated;
      const hasOpenAI = this.state.authStatus.openai.authenticated;
      
      if (hasElevenLabs || hasOpenAI) {
        const provider = hasElevenLabs ? "ElevenLabs Scribe" : "OpenAI Whisper";
        const extra = hasElevenLabs ? " (with speaker detection)" : "";
        this.state.errorMessage = `Recording saved: ${outputPath}\nPress [t] to transcribe with ${provider}${extra}`;
      } else {
        this.state.errorMessage = `Recording saved: ${outputPath}`;
      }
      this.updateUI();
    });

    try {
      await this.recorder.start();
      this.startUpdateInterval();
    } catch (error) {
      this.state.errorMessage = (error as Error).message;
      this.updateUI();
    } finally {
      this.isStartingRecording = false;
    }
  }

  private async stopRecording(): Promise<void> {
    if (this.recorder) {
      this.stopUpdateInterval();
      try {
        await this.recorder.stop();
        // Refresh recordings list to show new recording
        this.state.recordings = await this.scanRecordings();
      } catch (error) {
        this.state.errorMessage = (error as Error).message;
      }
      this.recorder = null;
      this.updateUI();
    }
  }

  private async copyOutputPath(): Promise<void> {
    if (this.state.outputPath) {
      await Clipboard.copy(this.state.outputPath);
      const prevMessage = this.state.errorMessage;
      this.state.errorMessage = "Path copied to clipboard!";
      this.updateUI();

      setTimeout(() => {
        if (this.state.errorMessage === "Path copied to clipboard!") {
          this.state.errorMessage = prevMessage;
          this.updateUI();
        }
      }, 2000);
    }
  }

  private startUpdateInterval(): void {
    this.updateInterval = setInterval(() => {
      if (this.recorder) {
        this.state.elapsedTime = this.recorder.getElapsedTime();
        this.updateUI();
      }
    }, 100);
  }

  private stopUpdateInterval(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  private updateUI(): void {
    // Always update the left panel with recordings list
    this.updateRecordingsPanel();

    // Update right panel based on current screen
    this.updateRightPanel();

    // Update help text
    this.helpText.content = this.getHelpText();

    // Update toast notification
    this.updateToast();

    // Request render
    this.renderer.requestRender();
  }

  private updateToast(): void {
    const toast = this.state.toast;
    
    if (!toast || !toast.visible) {
      this.toastContainer.visible = false;
      return;
    }

    this.toastContainer.visible = true;
    
    // Set border color based on variant
    switch (toast.variant) {
      case "success":
        this.toastContainer.borderColor = colors.success;
        break;
      case "warning":
        this.toastContainer.borderColor = colors.warning;
        break;
      case "error":
        this.toastContainer.borderColor = colors.error;
        break;
      case "info":
      default:
        this.toastContainer.borderColor = colors.info;
        break;
    }

    // Build toast content
    const parts: StyledText[] = [];
    
    if (toast.title) {
      switch (toast.variant) {
        case "success":
          parts.push(t`${bold(success(toast.title))}\n`);
          break;
        case "warning":
          parts.push(t`${bold(warning(toast.title))}\n`);
          break;
        case "error":
          parts.push(t`${bold(error(toast.title))}\n`);
          break;
        case "info":
        default:
          parts.push(t`${bold(info(toast.title))}\n`);
          break;
      }
    }
    
    parts.push(t`${text(toast.message)}`);
    
    this.toastText.content = this.combineStyledTexts(parts);
  }

  private updateRecordingsPanel(): void {
    const recordings = this.state.recordings;
    const selectedIdx = this.state.recordingsSelectedIndex;
    const scrollOffset = this.state.recordingsScrollOffset;
    const maxVisible = 8;
    const isRecordingsScreen = this.state.screen === "recordings";

    if (recordings.length === 0) {
      this.recordingsListText.content = t`${dim("No recordings")}\n${secondary("[r] to start")}`;
      return;
    }

    const visibleRecordings = recordings.slice(scrollOffset, scrollOffset + maxVisible);
    const styledParts: StyledText[] = [];

    for (let i = 0; i < visibleRecordings.length; i++) {
      const recording = visibleRecordings[i];
      if (!recording) continue;
      const actualIndex = scrollOffset + i;
      const isSelected = isRecordingsScreen && actualIndex === selectedIdx;
      
      // Format date compactly
      const date = this.formatDateCompact(recording.date);
      const size = this.formatFileSize(recording.sizeBytes);
      
      // Compact card style with colors
      if (isSelected) {
        if (recording.hasTranscript) {
          styledParts.push(t`${success(">")}${success("T")} ${bold(date)} ${info(size)}\n`);
        } else {
          styledParts.push(t`${warning(">")}${dim("○")} ${bold(date)} ${secondary(size)}\n`);
        }
      } else {
        if (recording.hasTranscript) {
          styledParts.push(t` ${success("T")} ${text(date)} ${dim(size)}\n`);
        } else {
          styledParts.push(t` ${dim("○")} ${dim(date)} ${dim(size)}\n`);
        }
      }
    }

    // Show scroll info if needed
    if (recordings.length > maxVisible) {
      const start = scrollOffset + 1;
      const end = Math.min(scrollOffset + maxVisible, recordings.length);
      styledParts.push(t`${dim(`${start}-${end}/${recordings.length}`)}`);
    }

    this.recordingsListText.content = this.combineStyledTexts(styledParts);
  }

  private combineStyledTexts(texts: StyledText[]): StyledText {
    const allChunks: any[] = [];
    for (const text of texts) {
      allChunks.push(...text.chunks);
    }
    return { chunks: allChunks } as StyledText;
  }

  private updateRightPanel(): void {
    // Handle auth screen
    if (this.state.screen === "auth") {
      this.statusText.content = t`${bold("API KEYS")}`;
      
      const openaiStatus = this.state.authStatus.openai;
      const elevenlabsStatus = this.state.authStatus.elevenlabs;
      
      const parts: StyledText[] = [];
      
      if (openaiStatus.authenticated) {
        parts.push(t`${success("●")} ${bold("[1]")} OpenAI Whisper ${dim("✓")}\n`);
      } else {
        parts.push(t`${dim("○")} ${bold("[1]")} OpenAI Whisper\n`);
      }
      
      if (elevenlabsStatus.authenticated) {
        parts.push(t`${success("●")} ${bold("[2]")} ElevenLabs Scribe ${dim("✓")}\n\n`);
      } else {
        parts.push(t`${dim("○")} ${bold("[2]")} ElevenLabs Scribe\n\n`);
      }
      
      parts.push(t`${secondary("Tip:")} Scribe identifies speakers\n`);
      
      if (this.state.errorMessage) {
        parts.push(t`\n${warning(this.state.errorMessage)}`);
      }
      
      this.contentText.content = this.combineStyledTexts(parts);
      return;
    }

    // Handle auth-input screen
    if (this.state.screen === "auth-input") {
      const provider = this.state.authInputProvider;
      const providerName = provider ? Providers[provider].name : "Unknown";
      
      this.statusText.content = t`${bold(`ENTER ${providerName.toUpperCase()} KEY`)}`;
      
      const maskedKey = this.state.authInputValue.length > 0
        ? "*".repeat(Math.min(this.state.authInputValue.length, 30))
        : "(type or paste key)";
      
      const parts: StyledText[] = [];
      parts.push(t`${secondary("Key:")} ${maskedKey}\n\n`);
      parts.push(t`${dim("Stored in:")}\n${dim("~/.local/share/opendebrief/")}`);
      
      if (this.state.errorMessage) {
        parts.push(t`\n\n${warning(this.state.errorMessage)}`);
      }
      
      this.contentText.content = this.combineStyledTexts(parts);
      return;
    }

    // Handle recordings selection screen
    if (this.state.screen === "recordings") {
      const recording = this.state.recordings[this.state.recordingsSelectedIndex];
      
      if (recording) {
        this.statusText.content = t`${bold("SELECTED")}`;
        
        const parts: StyledText[] = [];
        const name = recording.name.replace("recording_", "").replace(".m4a", "");
        parts.push(t`${bold(secondary(name))}\n\n`);
        parts.push(t`${dim("Date:")}  ${text(this.formatDate(recording.date))}\n`);
        parts.push(t`${dim("Size:")}  ${text(this.formatFileSize(recording.sizeBytes))}\n`);
        
        if (recording.hasTranscript) {
          parts.push(t`${dim("Status:")} ${success("Transcribed ✓")}\n`);
        } else {
          parts.push(t`${dim("Status:")} ${warning("Not transcribed")}\n`);
        }
        
        if (this.state.errorMessage) {
          parts.push(t`\n${warning(this.state.errorMessage)}`);
        }
        
        this.contentText.content = this.combineStyledTexts(parts);
      } else {
        this.statusText.content = t`${bold("RECORDINGS")}`;
        this.contentText.content = t`${dim("Select a recording")}`;
      }
      return;
    }

    // Handle transcribing screen
    if (this.state.screen === "transcribing") {
      this.statusText.content = t`${bold(warning("TRANSCRIBING..."))}`;
      
      const filename = this.state.lastRecordingPath.split("/").pop() || "";
      const parts: StyledText[] = [];
      parts.push(t`${secondary("Processing:")}\n${text(filename)}\n\n`);
      parts.push(t`${dim("Please wait...")}`);
      
      if (this.state.errorMessage) {
        parts.push(t`\n\n${warning(this.state.errorMessage)}`);
      }
      
      this.contentText.content = this.combineStyledTexts(parts);
      return;
    }

    // Handle transcript display screen
    if (this.state.screen === "transcript") {
      const transcript = this.state.lastTranscription;
      if (!transcript) {
        this.state.screen = "main";
        this.updateRightPanel();
        return;
      }

      const providerName = transcript.provider === "elevenlabs" ? "Scribe" : "Whisper";
      const speakerCount = transcript.speakers?.length || 0;
      
      this.statusText.content = t`${bold("TRANSCRIPT")} ${dim(`(${providerName})`)}`;

      // Build transcript content with scrolling
      const parts: StyledText[] = [];
      
      if (speakerCount > 0) {
        parts.push(t`${secondary(`${speakerCount} speaker${speakerCount > 1 ? "s" : ""} detected`)}\n\n`);
      }
      
      if (transcript.segments.length > 0) {
        const maxVisibleLines = 6;
        const totalSegments = transcript.segments.length;
        const maxOffset = Math.max(0, totalSegments - maxVisibleLines);
        
        if (this.state.transcriptScrollOffset > maxOffset) {
          this.state.transcriptScrollOffset = maxOffset;
        }

        const visibleSegments = transcript.segments.slice(
          this.state.transcriptScrollOffset,
          this.state.transcriptScrollOffset + maxVisibleLines
        );

        for (const segment of visibleSegments) {
          const time = formatTimestamp(segment.startSecond);
          if (segment.speakerId) {
            parts.push(t`${dim(time)} ${secondary(`[${segment.speakerId}]`)}\n`);
          } else {
            parts.push(t`${dim(time)}\n`);
          }
          parts.push(t`  ${text(segment.text.trim())}\n`);
        }
        
        if (totalSegments > maxVisibleLines) {
          const pct = maxOffset > 0 ? Math.round((this.state.transcriptScrollOffset / maxOffset) * 100) : 0;
          parts.push(t`\n${dim(`─── ${pct}% ───`)}`);
        }
      } else {
        const textLines = transcript.text.split("\n").slice(0, 8);
        for (const line of textLines) {
          parts.push(t`${text(line)}\n`);
        }
      }

      if (this.state.errorMessage) {
        parts.push(t`\n${success(this.state.errorMessage)}`);
      }

      this.contentText.content = this.combineStyledTexts(parts);
      return;
    }

    // Handle summarizing screen
    if (this.state.screen === "summarizing") {
      this.statusText.content = t`${bold(warning("SUMMARIZING..."))}`;
      
      const parts: StyledText[] = [];
      parts.push(t`${secondary("Analyzing transcript with AI...")}\n\n`);
      parts.push(t`${dim("This may take a moment...")}`);
      
      if (this.state.errorMessage) {
        parts.push(t`\n\n${warning(this.state.errorMessage)}`);
      }
      
      this.contentText.content = this.combineStyledTexts(parts);
      return;
    }

    // Handle summary display screen
    if (this.state.screen === "summary") {
      const summary = this.state.lastSummary;
      if (!summary) {
        this.state.screen = "transcript";
        this.updateRightPanel();
        return;
      }

      this.statusText.content = t`${bold(success("SUMMARY"))}`;

      const parts: StyledText[] = [];
      const allLines: string[] = [];
      
      // Build all content lines
      allLines.push("─── Summary ───");
      const summaryLines = summary.summary.split(/[.!?]+/).filter(s => s.trim());
      for (const line of summaryLines) {
        if (line.trim()) allLines.push(line.trim() + ".");
      }
      allLines.push("");
      
      if (summary.keyPoints.length > 0) {
        allLines.push("─── Key Points ───");
        for (const point of summary.keyPoints) {
          allLines.push(`• ${point}`);
        }
        allLines.push("");
      }
      
      if (summary.actionItems.length > 0) {
        allLines.push("─── Action Items ───");
        for (const item of summary.actionItems) {
          allLines.push(`☐ ${item}`);
        }
      }

      // Apply scrolling
      const maxVisibleLines = 10;
      const totalLines = allLines.length;
      const maxOffset = Math.max(0, totalLines - maxVisibleLines);
      
      if (this.state.summaryScrollOffset > maxOffset) {
        this.state.summaryScrollOffset = maxOffset;
      }

      const visibleLines = allLines.slice(
        this.state.summaryScrollOffset,
        this.state.summaryScrollOffset + maxVisibleLines
      );

      for (const line of visibleLines) {
        if (line.startsWith("───")) {
          parts.push(t`${secondary(line)}\n`);
        } else if (line.startsWith("•")) {
          parts.push(t`${success("•")} ${text(line.slice(2))}\n`);
        } else if (line.startsWith("☐")) {
          parts.push(t`${warning("☐")} ${text(line.slice(2))}\n`);
        } else if (line === "") {
          parts.push(t`\n`);
        } else {
          parts.push(t`${text(line)}\n`);
        }
      }
      
      if (totalLines > maxVisibleLines) {
        const pct = maxOffset > 0 ? Math.round((this.state.summaryScrollOffset / maxOffset) * 100) : 0;
        parts.push(t`\n${dim(`─── ${pct}% ───`)}`);
      }

      if (this.state.errorMessage) {
        parts.push(t`\n${success(this.state.errorMessage)}`);
      }

      this.contentText.content = this.combineStyledTexts(parts);
      return;
    }

    // Default: main screen
    const parts: StyledText[] = [];
    
    switch (this.state.recordingState) {
      case "idle":
        this.statusText.content = t`${bold(success("READY"))} ${dim(`v${VERSION}`)}`;
        break;
      case "recording":
        this.statusText.content = t`${bold(error("● RECORDING"))}`;
        break;
      case "stopping":
        this.statusText.content = t`${bold(warning("STOPPING..."))}`;
        break;
    }

    const micName = this.state.selectedMic?.name || "None";
    const sysName = this.state.selectedSystemAudio?.name || "N/A";
    
    let mode = "Mic";
    if (this.state.recordBoth && this.state.selectedMic && this.state.selectedSystemAudio) {
      mode = "Mic + System";
    } else if (!this.state.selectedMic && this.state.selectedSystemAudio) {
      mode = "System";
    }
    
    if (this.state.recordingState === "recording") {
      const duration = formatDuration(this.state.elapsedTime);
      parts.push(t`${dim("Duration:")} ${bold(info(duration))}\n\n`);
      parts.push(t`${dim("Mode:")} ${text(mode)}\n`);
      if (this.state.outputPath) {
        const filename = this.state.outputPath.split("/").pop() || "";
        parts.push(t`\n${dim("File:")} ${dim(filename)}`);
      }
    } else {
      parts.push(t`${dim("Mode:")}   ${bold(secondary(mode))}\n\n`);
      parts.push(t`${dim("Mic:")}    ${text(micName)}\n`);
      parts.push(t`${dim("System:")} ${text(sysName)}\n`);
      
      // Show auth status
      const apis: string[] = [];
      if (this.state.authStatus.openai.authenticated) apis.push("OpenAI");
      if (this.state.authStatus.elevenlabs.authenticated) apis.push("ElevenLabs");
      if (apis.length > 0) {
        parts.push(t`\n${dim("APIs:")}   ${success(apis.join(", "))}`);
      } else {
        parts.push(t`\n${dim("APIs:")}   ${warning("None configured")}`);
      }

      // Show screen recording permission status (only if system audio is selected)
      if (this.state.selectedSystemAudio && (this.state.recordBoth || !this.state.selectedMic)) {
        if (this.state.screenRecordingPermission === null) {
          parts.push(t`\n${dim("Screen:")} ${warning("Checking...")}`);
        } else if (this.state.screenRecordingPermission) {
          parts.push(t`\n${dim("Screen:")} ${success("Granted")}`);
        } else {
          parts.push(t`\n${dim("Screen:")} ${error("Not granted")}`);
          if (this.state.permissionError) {
            parts.push(t`\n\n${error("System audio requires Screen Recording permission.")}`);
            parts.push(t`\n${warning("Go to: System Settings > Privacy & Security > Screen Recording")}`);
            parts.push(t`\n${warning("Add your terminal app and restart it.")}`);
          }
        }
      }

      // Show update notification
      if (this.state.updateAvailable) {
        parts.push(t`\n\n${warning("Update available:")} ${info(this.state.latestVersion)}`);
        parts.push(t`\n${dim(this.state.upgradeCommand)}`);
      }
    }

    if (this.state.errorMessage) {
      parts.push(t`\n\n${warning(this.state.errorMessage)}`);
    }

    this.contentText.content = this.combineStyledTexts(parts);
  }

  private quit(): void {
    this.stopUpdateInterval();
    if (this.recorder) {
      this.recorder.kill();
    }
    this.renderer.destroy();
    process.exit(0);
  }
}

// Main entry point - only runs when executed directly via `bun run src/app.ts`
// Not when imported by CLI
if (process.argv[1]?.endsWith("app.ts")) {
  const app = new MeetingTranscriberApp();
  app.init().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
