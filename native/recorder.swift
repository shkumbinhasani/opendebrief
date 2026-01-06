#!/usr/bin/env swift
// Native macOS audio recorder using ScreenCaptureKit + AVFoundation
// Compile: swiftc -O -o recorder recorder.swift
// Usage: recorder <command> [options]

import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia

// MARK: - JSON Output

struct JSONOutput: Codable {
    var success: Bool
    var message: String?
    var error: String?
    var data: [String: String]?
}

func printJSON(_ output: JSONOutput) {
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(output), let str = String(data: data, encoding: .utf8) {
        print(str)
    }
}

// MARK: - Device Listing

func listDevices() {
    var devices: [[String: String]] = []
    
    // List microphones
    let audioDevices = AVCaptureDevice.DiscoverySession(
        deviceTypes: [.builtInMicrophone, .externalUnknown],
        mediaType: .audio,
        position: .unspecified
    ).devices
    
    for (index, device) in audioDevices.enumerated() {
        devices.append([
            "index": String(index),
            "name": device.localizedName,
            "id": device.uniqueID,
            "type": "microphone"
        ])
    }
    
    // Add system audio as virtual device
    if #available(macOS 12.3, *) {
        devices.append([
            "index": "system",
            "name": "System Audio",
            "id": "system-audio",
            "type": "system"
        ])
    }
    
    let encoder = JSONEncoder()
    encoder.outputFormatting = .prettyPrinted
    if let data = try? encoder.encode(devices), let str = String(data: data, encoding: .utf8) {
        print(str)
    }
}

// MARK: - Audio File Writer

class AudioFileWriter {
    private var assetWriter: AVAssetWriter?
    private var audioInput: AVAssetWriterInput?
    private var isWriting = false
    private let outputURL: URL
    private var sampleCount = 0
    
    init(outputURL: URL) {
        self.outputURL = outputURL
    }
    
    func start() throws {
        try? FileManager.default.removeItem(at: outputURL)
        
        assetWriter = try AVAssetWriter(outputURL: outputURL, fileType: .m4a)
        
        let audioSettings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 48000,
            AVNumberOfChannelsKey: 2,
            AVEncoderBitRateKey: 192000
        ]
        
        audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
        audioInput?.expectsMediaDataInRealTime = true
        
        if let audioInput = audioInput, assetWriter?.canAdd(audioInput) == true {
            assetWriter?.add(audioInput)
        }
        
        assetWriter?.startWriting()
        // Start session at time zero - samples will have adjusted timestamps
        assetWriter?.startSession(atSourceTime: .zero)
        isWriting = true
    }
    
    func appendSampleBuffer(_ sampleBuffer: CMSampleBuffer) {
        guard isWriting, let audioInput = audioInput, audioInput.isReadyForMoreMediaData else { return }
        audioInput.append(sampleBuffer)
        sampleCount += 1
    }
    
    func stop() async {
        guard isWriting else { return }
        isWriting = false
        
        audioInput?.markAsFinished()
        await assetWriter?.finishWriting()
        
        FileHandle.standardError.write("Audio writer stopped. Samples written: \(sampleCount)\n".data(using: .utf8)!)
    }
}

// MARK: - System Audio Recorder

@available(macOS 12.3, *)
class SystemAudioRecorder: NSObject, SCStreamDelegate, SCStreamOutput {
    private var stream: SCStream?
    private var writer: AudioFileWriter?
    private var startTime: CMTime?
    var isRecording = false
    
    private func log(_ message: String) {
        FileHandle.standardError.write("[SystemAudio] \(message)\n".data(using: .utf8)!)
    }
    
    func startRecording(to url: URL) async throws {
        log("Starting system audio recording to: \(url.path)")
        
        writer = AudioFileWriter(outputURL: url)
        try writer?.start()
        log("AudioFileWriter started")
        
        log("Getting shareable content...")
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        log("Got \(content.displays.count) displays, \(content.windows.count) windows")
        
        guard let display = content.displays.first else {
            throw NSError(domain: "Recorder", code: 1, userInfo: [NSLocalizedDescriptionKey: "No display found"])
        }
        log("Using display: \(display.displayID)")
        
        let config = SCStreamConfiguration()
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.capturesAudio = true
        config.sampleRate = 48000
        config.channelCount = 2
        if #available(macOS 13.0, *) {
            config.excludesCurrentProcessAudio = true
            log("excludesCurrentProcessAudio = true")
        }
        
        let filter = SCContentFilter(display: display, excludingWindows: [])
        log("Created content filter")
        
        stream = SCStream(filter: filter, configuration: config, delegate: self)
        log("Created SCStream")
        
        try stream?.addStreamOutput(self, type: .audio, sampleHandlerQueue: .global(qos: .userInteractive))
        log("Added stream output")
        
        log("Starting capture...")
        try await stream?.startCapture()
        log("Capture started successfully")
        
        isRecording = true
        log("isRecording = true")
    }
    
    func stopRecording() async {
        log("stopRecording called, isRecording=\(isRecording)")
        guard isRecording else { return }
        isRecording = false
        log("Stopping capture...")
        try? await stream?.stopCapture()
        stream = nil
        log("Stopping writer...")
        await writer?.stop()
        writer = nil
        log("System audio recording stopped")
    }
    
    private var sampleCount = 0
    
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }
        
        if !isRecording {
            log("Received audio sample but isRecording=false, ignoring")
            return
        }
        
        sampleCount += 1
        if sampleCount == 1 {
            log("Received first audio sample!")
        }
        if sampleCount % 100 == 0 {
            log("Received \(sampleCount) audio samples")
        }
        
        // Adjust timestamp relative to start time
        if startTime == nil {
            startTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            log("Set startTime to \(startTime!.seconds)")
        }
        
        guard let startTime = startTime else { return }
        
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let adjustedTime = CMTimeSubtract(pts, startTime)
        
        if let adjustedBuffer = adjustTimestamp(of: sampleBuffer, to: adjustedTime) {
            writer?.appendSampleBuffer(adjustedBuffer)
        }
    }
    
    private func adjustTimestamp(of sampleBuffer: CMSampleBuffer, to time: CMTime) -> CMSampleBuffer? {
        var timing = CMSampleTimingInfo(
            duration: CMSampleBufferGetDuration(sampleBuffer),
            presentationTimeStamp: time,
            decodeTimeStamp: .invalid
        )
        var newBuffer: CMSampleBuffer?
        CMSampleBufferCreateCopyWithNewTiming(allocator: nil, sampleBuffer: sampleBuffer, sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleBufferOut: &newBuffer)
        return newBuffer
    }
    
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        log("Stream stopped with error: \(error)")
        log("Total samples received before error: \(sampleCount)")
        isRecording = false
    }
    
    // Check if screen recording permission is granted
    static func hasScreenRecordingPermission() -> Bool {
        if #available(macOS 12.3, *) {
            // Try to get shareable content - this will fail if no permission
            let semaphore = DispatchSemaphore(value: 0)
            var hasPermission = false
            
            Task {
                do {
                    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
                    hasPermission = !content.displays.isEmpty
                } catch {
                    hasPermission = false
                }
                semaphore.signal()
            }
            
            semaphore.wait()
            return hasPermission
        }
        return false
    }
}

// MARK: - Microphone Recorder

class MicRecorder {
    private var audioRecorder: AVAudioRecorder?
    var isRecording = false
    
    func startRecording(to url: URL, deviceID: String? = nil) throws {
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 48000,
            AVNumberOfChannelsKey: 2,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
            AVEncoderBitRateKey: 192000
        ]
        
        audioRecorder = try AVAudioRecorder(url: url, settings: settings)
        audioRecorder?.record()
        isRecording = true
    }
    
    func stopRecording() {
        audioRecorder?.stop()
        isRecording = false
    }
}

// MARK: - Recording Session

class RecordingSession {
    var micRecorder: MicRecorder?
    var systemRecorder: SystemAudioRecorder?
    var outputPath: String = ""
    var recordMic: Bool = true
    var recordSystem: Bool = false
    
    private var micPath: String?
    private var sysPath: String?
    
    private func log(_ message: String) {
        FileHandle.standardError.write("[RecordingSession] \(message)\n".data(using: .utf8)!)
    }
    
    func start() async throws {
        log("start() called - recordMic=\(recordMic), recordSystem=\(recordSystem)")
        
        if recordMic && recordSystem {
            // Record both to temp files, merge after
            let basePath = outputPath.replacingOccurrences(of: ".m4a", with: "")
            micPath = "\(basePath)_temp_mic.m4a"
            sysPath = "\(basePath)_temp_sys.m4a"
            log("Both mode - mic: \(micPath!), sys: \(sysPath!)")
            
            // Start system audio first (requires ScreenCaptureKit initialization)
            if #available(macOS 12.3, *) {
                log("Starting system recorder...")
                systemRecorder = SystemAudioRecorder()
                try await systemRecorder?.startRecording(to: URL(fileURLWithPath: sysPath!))
                log("System recorder started")
            }
            
            // Small delay to let ScreenCaptureKit stabilize
            log("Waiting 100ms for ScreenCaptureKit to stabilize...")
            try await Task.sleep(nanoseconds: 100_000_000) // 100ms
            
            // Then start mic recording
            log("Starting mic recorder...")
            micRecorder = MicRecorder()
            try micRecorder?.startRecording(to: URL(fileURLWithPath: micPath!))
            log("Mic recorder started")
        } else if recordSystem {
            if #available(macOS 12.3, *) {
                systemRecorder = SystemAudioRecorder()
                try await systemRecorder?.startRecording(to: URL(fileURLWithPath: outputPath))
            } else {
                throw NSError(domain: "Recorder", code: 2, userInfo: [NSLocalizedDescriptionKey: "System audio requires macOS 12.3+"])
            }
        } else {
            micRecorder = MicRecorder()
            try micRecorder?.startRecording(to: URL(fileURLWithPath: outputPath))
        }
    }
    
    func stop() async {
        micRecorder?.stopRecording()
        if #available(macOS 12.3, *) {
            await systemRecorder?.stopRecording()
        }
        
        // If we recorded both, merge them
        if let mic = micPath, let sys = sysPath {
            await mergeAudioFiles(mic: mic, system: sys, output: outputPath)
        }
    }
    
    private func mergeAudioFiles(mic: String, system: String, output: String) async {
        // Try FFmpeg first
        if let ffmpeg = which("ffmpeg") {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: ffmpeg)
            process.arguments = [
                "-y",
                "-i", mic,
                "-i", system,
                "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=longest[a]",
                "-map", "[a]",
                "-c:a", "aac",
                "-b:a", "192k",
                output
            ]
            
            do {
                try process.run()
                process.waitUntilExit()
                
                if process.terminationStatus == 0 {
                    // Clean up temp files
                    try? FileManager.default.removeItem(atPath: mic)
                    try? FileManager.default.removeItem(atPath: system)
                    return
                }
            } catch {
                FileHandle.standardError.write("FFmpeg merge failed: \(error)\n".data(using: .utf8)!)
            }
        }
        
        // If FFmpeg not available or failed, try afconvert (macOS built-in)
        // Just keep both files separate
        let basePath = output.replacingOccurrences(of: ".m4a", with: "")
        let micFinal = "\(basePath)_mic.m4a"
        let sysFinal = "\(basePath)_system.m4a"
        
        try? FileManager.default.moveItem(atPath: mic, toPath: micFinal)
        try? FileManager.default.moveItem(atPath: system, toPath: sysFinal)
        
        // Output path becomes a message
        FileHandle.standardError.write("Note: FFmpeg not found. Files saved separately.\n".data(using: .utf8)!)
    }
    
    private func which(_ command: String) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/which")
        process.arguments = [command]
        
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        
        do {
            try process.run()
            process.waitUntilExit()
            
            if process.terminationStatus == 0 {
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        } catch {}
        
        return nil
    }
}

// MARK: - Main

let args = Array(CommandLine.arguments.dropFirst())

guard !args.isEmpty else {
    print("""
    recorder - Native macOS audio recorder
    
    Commands:
      list-devices              List available audio devices (JSON)
      record <output> [options] Start recording
      version                   Show version
    
    Record options:
      --mic                     Record microphone (default)
      --system                  Record system audio
      --both                    Record both (creates two files)
    
    Examples:
      recorder list-devices
      recorder record output.m4a --mic
      recorder record meeting.m4a --system
      recorder record meeting.m4a --both
    
    Notes:
      - System audio requires Screen Recording permission
      - Send SIGINT (Ctrl+C) or SIGTERM to stop recording
    """)
    exit(0)
}

let command = args[0]

switch command {
case "list-devices":
    listDevices()

case "check-permissions":
    // Check screen recording permission by attempting to get shareable content
    if #available(macOS 12.3, *) {
        let semaphore = DispatchSemaphore(value: 0)
        var permissionGranted = false
        var errorMessage: String? = nil
        
        Task {
            do {
                // This will trigger the permission prompt if not granted
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
                permissionGranted = !content.displays.isEmpty
            } catch {
                errorMessage = error.localizedDescription
                permissionGranted = false
            }
            semaphore.signal()
        }
        
        // Wait with timeout
        let result = semaphore.wait(timeout: .now() + 5)
        if result == .timedOut {
            printJSON(JSONOutput(success: false, error: "Permission check timed out"))
        } else if permissionGranted {
            printJSON(JSONOutput(success: true, message: "Screen recording permission granted"))
        } else {
            printJSON(JSONOutput(success: false, error: errorMessage ?? "Screen recording permission denied. Please grant permission in System Settings > Privacy & Security > Screen Recording"))
        }
    } else {
        printJSON(JSONOutput(success: false, error: "System audio requires macOS 12.3+"))
    }
    
case "version":
    print("recorder 1.0.0")
    if #available(macOS 12.3, *) {
        print("System audio: supported")
    } else {
        print("System audio: not supported (requires macOS 12.3+)")
    }
    
case "record":
    guard args.count >= 2 else {
        printJSON(JSONOutput(success: false, error: "Missing output file path"))
        exit(1)
    }
    
    let session = RecordingSession()
    session.outputPath = args[1]
    
    // Parse options
    for arg in args.dropFirst(2) {
        switch arg {
        case "--mic":
            session.recordMic = true
            session.recordSystem = false
        case "--system":
            session.recordMic = false
            session.recordSystem = true
        case "--both":
            session.recordMic = true
            session.recordSystem = true
        default:
            break
        }
    }
    
    // Use a global flag for signal handling
    let stopSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    
    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)
    
    var shouldStop = false
    
    stopSource.setEventHandler { shouldStop = true }
    termSource.setEventHandler { shouldStop = true }
    stopSource.resume()
    termSource.resume()
    
    // Start recording
    Task {
        do {
            try await session.start()
            printJSON(JSONOutput(success: true, message: "Recording started", data: ["output": session.outputPath]))
            fflush(stdout)
            
            // Wait for stop signal
            while !shouldStop {
                try await Task.sleep(nanoseconds: 100_000_000) // 100ms
            }
            
            await session.stop()
            printJSON(JSONOutput(success: true, message: "Recording stopped", data: ["output": session.outputPath]))
            exit(0)
            
        } catch {
            printJSON(JSONOutput(success: false, error: error.localizedDescription))
            exit(1)
        }
    }
    
    RunLoop.current.run()
    
default:
    printJSON(JSONOutput(success: false, error: "Unknown command: \(command)"))
    exit(1)
}
