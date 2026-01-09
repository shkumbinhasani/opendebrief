# opendebrief

Record any meeting. Transcribe it. Know who said what.

![macOS](https://img.shields.io/badge/macOS-12.3+-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![GitHub Release](https://img.shields.io/github/v/release/shkumbinhasani/opendebrief)

## Features

- **Record Everything** - Mic, system audio, or both. No extra software needed.
- **AI Transcription** - Powered by OpenAI Whisper or ElevenLabs Scribe
- **Speaker Detection** - Know who said what in your meetings
- **Smart Summaries** - Key points and action items, automatically
- **Works in Your Terminal** - A beautiful TUI, keyboard-driven

```
 ╭──────────────────────────────────────────────────╮ ╭─────────────────────────╮
 │                                                  │ │ RECORDINGS              │
 │  █▀█ █▀█ █▀▀ █▄ █ █▀▄ █▀▀ █▄▄ █▀█ █▀▀ █ █▀▀      │ │                         │
 │  █▄█ █▀▀ ██▄ █ ▀█ █▄▀ ██▄ █▄█ █▀▄ ██▄ █ █▀       │ │  >T Jan 6, 2:30 PM      │
 │                                                  │ │     5.2 MB              │
 │  READY v0.1.3                                    │ │                         │
 │                                                  │ │   ○ Jan 5, 10:15 AM     │
 │  Mode:   Mic + System                            │ │     12.1 MB             │
 │                                                  │ │                         │
 │  Mic:    MacBook Pro Microphone                  │ ╰─────────────────────────╯
 │  System: System Audio                            │
 │                                                  │
 │  APIs:   OpenAI, ElevenLabs                      │
 │  Screen: Granted                                 │
 ╰──────────────────────────────────────────────────╯
 ╭──────────────────────────────────────────────────────────────────────────────╮
 │  [r] Record  [m] Mic  [s] Sys  [b] Both  [l] List  [a] Keys  [q] Quit        │
 ╰──────────────────────────────────────────────────────────────────────────────╯
```

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/shkumbinhasani/opendebrief/main/install | bash
```

One command. One binary. No dependencies.

### Requirements

- **macOS 12.3+** (Monterey or later)
- **FFmpeg** (optional) - Only needed for recording mic + system audio together

### From source

```bash
git clone https://github.com/shkumbinhasani/opendebrief.git
cd opendebrief
bun install
bun run build:current
./dist/darwin-arm64/opendebrief
```

## Usage

Start the application:

```bash
opendebrief
```

### Keyboard Shortcuts

#### Main Screen
| Key | Action |
|-----|--------|
| `r` | Start/stop recording |
| `m` | Select microphone |
| `s` | Select system audio mode |
| `b` | Select both (mic + system) mode |
| `l` | View recordings list |
| `a` | Manage API keys |
| `q` | Quit |

#### Recordings List
| Key | Action |
|-----|--------|
| `Enter` | Transcribe selected recording |
| `v` | View transcript |
| `d` | Delete recording |
| `↑/↓` | Navigate |
| `Esc` | Back |

#### Transcript View
| Key | Action |
|-----|--------|
| `s` | Generate AI summary |
| `c` | Copy to clipboard |
| `↑/↓` | Scroll |
| `Esc` | Back |

## Configuration

### API Keys

The app supports two transcription providers:

1. **OpenAI Whisper** - Fast and reliable transcription
2. **ElevenLabs Scribe** - Includes speaker diarization

Set API keys via environment variables:

```bash
export OPENAI_API_KEY="sk-..."
export ELEVENLABS_API_KEY="..."
```

Or configure them in the app by pressing `a` on the main screen.

### Permissions

**Screen Recording Permission** is required for system audio capture:

1. Go to **System Settings** > **Privacy & Security** > **Screen Recording**
2. Add your terminal application (Terminal, iTerm2, Warp, etc.)
3. Restart the terminal

### File Locations

| Path | Description |
|------|-------------|
| `~/MeetingRecordings/` | Default recordings directory |
| `~/.config/opendebrief/config.json` | User configuration |
| `~/.local/share/opendebrief/auth.json` | Stored API keys |

## How It Works

### Audio Capture

- **Microphone**: Uses AVFoundation's AVCaptureDevice
- **System Audio**: Uses ScreenCaptureKit (macOS 12.3+) to capture all system audio
- **Both Mode**: Records mic and system audio separately, then merges with FFmpeg

### Transcription

The app automatically selects the best available transcription provider:

1. If ElevenLabs API key is available, uses Scribe (includes speaker identification)
2. Falls back to OpenAI Whisper

### Native Recorder

A custom Swift CLI handles audio recording, compiled during installation. The recorder uses:

- `AVCaptureSession` for microphone input
- `SCStream` for system audio capture
- `AVAssetWriter` for M4A output

## CLI Commands

```bash
# Start the TUI
opendebrief

# Check for updates
opendebrief upgrade

# Show version
opendebrief version

# Show help
opendebrief help

# Debug mode (logs to ~/opendebrief-debug.log)
opendebrief --debug
```

## Development

```bash
# Install dependencies
bun install

# Build native recorder
bun run build:native

# Run in development mode
bun run dev

# Build for production
bun run build

# Type check
bunx tsc --noEmit
```

## Troubleshooting

### "Screen Recording permission not granted"

1. Open **System Settings** > **Privacy & Security** > **Screen Recording**
2. Enable your terminal app
3. Restart the terminal completely (quit and reopen)

### System audio file is 0KB

This usually means Screen Recording permission wasn't granted properly. Try:
1. Remove your terminal from Screen Recording permissions
2. Re-add it
3. Restart your terminal

### "FFmpeg not found" when using both mode

Install FFmpeg:
```bash
brew install ffmpeg
```

### Native recorder won't compile

Ensure Xcode Command Line Tools are installed:
```bash
xcode-select --install
```

## License

MIT License - see [LICENSE](LICENSE) for details.

## Author

Shkumbin Hasani ([@shkumbinhasani](https://github.com/shkumbinhasani))
