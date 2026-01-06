// Transcription service supporting OpenAI Whisper and ElevenLabs Scribe

import OpenAI from "openai";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { createReadStream } from "fs";
import { authManager } from "../auth";

export type TranscriptionProvider = "openai" | "elevenlabs";

export interface TranscriptionSegment {
  text: string;
  startSecond: number;
  endSecond: number;
  speakerId?: string; // ElevenLabs only - speaker diarization
}

export interface TranscriptionResult {
  text: string;
  segments: TranscriptionSegment[];
  language?: string;
  durationInSeconds?: number;
  provider: TranscriptionProvider;
  // ElevenLabs specific
  speakers?: string[]; // List of unique speaker IDs
}

export interface TranscribeOptions {
  /** Path to the audio file */
  audioPath: string;
  /** Which provider to use */
  provider?: TranscriptionProvider;
  /** Optional language hint (ISO-639-1 code like "en") */
  language?: string;
  /** Enable speaker diarization (ElevenLabs only) */
  diarize?: boolean;
  /** Number of speakers (ElevenLabs only, helps with diarization) */
  numSpeakers?: number;
}

/**
 * Transcribe using OpenAI Whisper
 */
async function transcribeWithOpenAI(
  audioPath: string,
  language?: string
): Promise<TranscriptionResult> {
  const apiKey = await authManager.getApiKey("openai");
  if (!apiKey) {
    throw new Error("OpenAI API key not configured. Press [a] to add your API key.");
  }

  const openai = new OpenAI({ apiKey });

  const response = await openai.audio.transcriptions.create({
    file: createReadStream(audioPath),
    model: "whisper-1",
    response_format: "verbose_json",
    language: language,
  });

  const segments: TranscriptionSegment[] = [];
  if ("segments" in response && Array.isArray(response.segments)) {
    for (const seg of response.segments) {
      segments.push({
        text: seg.text,
        startSecond: seg.start,
        endSecond: seg.end,
      });
    }
  }

  return {
    text: response.text,
    segments,
    language: "language" in response ? response.language : undefined,
    durationInSeconds: "duration" in response ? response.duration : undefined,
    provider: "openai",
  };
}

/**
 * Transcribe using ElevenLabs Scribe
 */
async function transcribeWithElevenLabs(
  audioPath: string,
  options: { language?: string; diarize?: boolean; numSpeakers?: number }
): Promise<TranscriptionResult> {
  const apiKey = await authManager.getApiKey("elevenlabs");
  if (!apiKey) {
    throw new Error("ElevenLabs API key not configured. Press [a] to add your API key.");
  }

  const client = new ElevenLabsClient({ apiKey });

  // Read file as blob
  const audioFile = Bun.file(audioPath);
  const audioBlob = await audioFile.arrayBuffer();

  const response = await client.speechToText.convert({
    file: new Blob([audioBlob], { type: "audio/mp4" }),
    modelId: "scribe_v1",
    languageCode: options.language,
    diarize: options.diarize ?? true, // Enable diarization by default for meetings
    numSpeakers: options.numSpeakers,
    tagAudioEvents: true, // Tag laughter, etc.
    timestampsGranularity: "word",
  });

  // Parse response - handle both single and multichannel responses
  // Type guard to check if it's a chunk response (not webhook)
  const isChunkResponse = (r: any): r is { text: string; words: any[]; languageCode: string } => {
    return "text" in r && "words" in r;
  };

  const transcript = "transcripts" in response ? response.transcripts[0] : response;

  if (!transcript || !isChunkResponse(transcript)) {
    throw new Error("No transcript returned from ElevenLabs");
  }

  // Build segments from words, grouping by speaker
  const segments: TranscriptionSegment[] = [];
  const speakers = new Set<string>();
  
  let currentSegment: TranscriptionSegment | null = null;
  let currentSpeaker: string | undefined = undefined;

  for (const word of transcript.words || []) {
    if (word.type === "word") {
      const speakerId = word.speakerId || undefined;
      if (speakerId) speakers.add(speakerId);

      // Start new segment if speaker changes or gap is too long
      if (!currentSegment || speakerId !== currentSpeaker) {
        if (currentSegment) {
          segments.push(currentSegment);
        }
        currentSegment = {
          text: word.text,
          startSecond: word.start || 0,
          endSecond: word.end || 0,
          speakerId,
        };
        currentSpeaker = speakerId;
      } else {
        // Append to current segment
        currentSegment.text += " " + word.text;
        currentSegment.endSecond = word.end || currentSegment.endSecond;
      }
    }
  }

  // Don't forget the last segment
  if (currentSegment) {
    segments.push(currentSegment);
  }

  return {
    text: transcript.text,
    segments,
    language: transcript.languageCode,
    provider: "elevenlabs",
    speakers: Array.from(speakers),
  };
}

/**
 * Transcribe an audio file
 */
export async function transcribeAudio(
  options: TranscribeOptions
): Promise<TranscriptionResult> {
  const { audioPath, provider, language, diarize, numSpeakers } = options;

  // Check if file exists
  const audioFile = Bun.file(audioPath);
  const exists = await audioFile.exists();
  if (!exists) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  // Determine provider - prefer ElevenLabs for meetings (has diarization)
  let selectedProvider = provider;
  if (!selectedProvider) {
    // Auto-select based on available API keys
    const hasElevenLabs = await authManager.isAuthenticated("elevenlabs");
    const hasOpenAI = await authManager.isAuthenticated("openai");
    
    if (hasElevenLabs) {
      selectedProvider = "elevenlabs"; // Prefer ElevenLabs for speaker diarization
    } else if (hasOpenAI) {
      selectedProvider = "openai";
    } else {
      throw new Error("No transcription API configured. Press [a] to add OpenAI or ElevenLabs API key.");
    }
  }

  if (selectedProvider === "elevenlabs") {
    return transcribeWithElevenLabs(audioPath, { language, diarize, numSpeakers });
  } else {
    return transcribeWithOpenAI(audioPath, language);
  }
}

/**
 * Transcribe and save to a text file alongside the audio
 */
export async function transcribeAndSave(
  audioPath: string,
  options?: { 
    language?: string; 
    provider?: TranscriptionProvider;
    diarize?: boolean;
    numSpeakers?: number;
  }
): Promise<{ transcriptPath: string; result: TranscriptionResult }> {
  const result = await transcribeAudio({
    audioPath,
    provider: options?.provider,
    language: options?.language,
    diarize: options?.diarize,
    numSpeakers: options?.numSpeakers,
  });

  // Save transcript alongside audio file
  const transcriptPath = audioPath.replace(/\.[^.]+$/, ".txt");

  // Format transcript with timestamps
  let content = `# Transcript\n`;
  content += `# Audio: ${audioPath}\n`;
  content += `# Provider: ${result.provider === "elevenlabs" ? "ElevenLabs Scribe" : "OpenAI Whisper"}\n`;
  if (result.language) {
    content += `# Language: ${result.language}\n`;
  }
  if (result.durationInSeconds) {
    content += `# Duration: ${formatDuration(result.durationInSeconds)}\n`;
  }
  if (result.speakers && result.speakers.length > 0) {
    content += `# Speakers: ${result.speakers.length} identified\n`;
  }
  content += `\n`;

  // Add full text
  content += result.text;
  content += `\n`;

  // Add segments with timestamps and speakers
  if (result.segments.length > 0) {
    content += `\n# Segments with timestamps\n\n`;
    for (const segment of result.segments) {
      const start = formatTimestamp(segment.startSecond);
      const end = formatTimestamp(segment.endSecond);
      const speaker = segment.speakerId ? `[${segment.speakerId}] ` : "";
      content += `[${start} - ${end}] ${speaker}${segment.text.trim()}\n`;
    }
  }

  await Bun.write(transcriptPath, content);

  return { transcriptPath, result };
}

/**
 * Format seconds to HH:MM:SS
 */
function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Format seconds to MM:SS.ms timestamp
 */
export function formatTimestamp(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${secs.toFixed(1).padStart(4, "0")}`;
}

/**
 * Check if any transcription provider is available
 */
export async function isTranscriptionAvailable(): Promise<boolean> {
  const hasOpenAI = await authManager.isAuthenticated("openai");
  const hasElevenLabs = await authManager.isAuthenticated("elevenlabs");
  return hasOpenAI || hasElevenLabs;
}

/**
 * Get available transcription providers
 */
export async function getAvailableProviders(): Promise<TranscriptionProvider[]> {
  const providers: TranscriptionProvider[] = [];
  if (await authManager.isAuthenticated("elevenlabs")) {
    providers.push("elevenlabs");
  }
  if (await authManager.isAuthenticated("openai")) {
    providers.push("openai");
  }
  return providers;
}
