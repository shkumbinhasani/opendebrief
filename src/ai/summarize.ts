// AI Summarization service using OpenAI GPT

import OpenAI from "openai";
import { authManager } from "../auth";
import type { TranscriptionResult } from "./transcribe";

export interface SummaryResult {
  summary: string;
  keyPoints: string[];
  actionItems: string[];
  participants?: string[];
}

export interface SummarizeOptions {
  /** The transcript to summarize */
  transcript: TranscriptionResult;
  /** Custom prompt/instructions */
  customPrompt?: string;
}

/**
 * Summarize a meeting transcript using OpenAI GPT
 */
export async function summarizeTranscript(
  options: SummarizeOptions
): Promise<SummaryResult> {
  const apiKey = await authManager.getApiKey("openai");
  if (!apiKey) {
    throw new Error("OpenAI API key not configured. Press [a] to add your API key.");
  }

  const openai = new OpenAI({ apiKey });
  const { transcript, customPrompt } = options;

  // Build the transcript text with speaker labels if available
  let transcriptText = "";
  if (transcript.segments.length > 0 && transcript.speakers && transcript.speakers.length > 0) {
    // Format with speaker labels
    transcriptText = transcript.segments
      .map(s => `${s.speakerId ? `[${s.speakerId}]: ` : ""}${s.text.trim()}`)
      .join("\n");
  } else {
    transcriptText = transcript.text;
  }

  const systemPrompt = `You are an expert meeting summarizer. Analyze the following meeting transcript and provide:
1. A concise summary (2-3 paragraphs)
2. Key points discussed (bullet points)
3. Action items identified (if any)
4. Participants mentioned (if identifiable from speaker labels)

Be concise but comprehensive. Focus on the most important information.`;

  const userPrompt = customPrompt 
    ? `${customPrompt}\n\nTranscript:\n${transcriptText}`
    : `Please summarize this meeting transcript:\n\n${transcriptText}`;

  const response = await openai.chat.completions.create({
    model: "gpt-5.2",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.3,
  });

  const content = response.choices[0]?.message?.content || "";

  // Parse the response into structured format
  return parseAISummary(content, transcript.speakers);
}

/**
 * Parse the AI response into structured summary
 */
function parseAISummary(content: string, speakers?: string[]): SummaryResult {
  const lines = content.split("\n");
  
  let summary = "";
  const keyPoints: string[] = [];
  const actionItems: string[] = [];
  
  let currentSection = "summary";
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    const lowerLine = trimmedLine.toLowerCase();
    
    // Detect section headers
    if (lowerLine.includes("key point") || lowerLine.includes("key discussion")) {
      currentSection = "keyPoints";
      continue;
    } else if (lowerLine.includes("action item") || lowerLine.includes("next step") || lowerLine.includes("to-do")) {
      currentSection = "actionItems";
      continue;
    } else if (lowerLine.includes("participant") || lowerLine.includes("attendee")) {
      currentSection = "participants";
      continue;
    } else if (lowerLine.includes("summary") && trimmedLine.endsWith(":")) {
      currentSection = "summary";
      continue;
    }
    
    // Skip empty lines and section headers
    if (!trimmedLine || trimmedLine.endsWith(":")) continue;
    
    // Remove bullet points and numbering
    const cleanLine = trimmedLine
      .replace(/^[-•*]\s*/, "")
      .replace(/^\d+\.\s*/, "")
      .replace(/^\[\d+\]\s*/, "");
    
    if (!cleanLine) continue;
    
    switch (currentSection) {
      case "summary":
        summary += (summary ? " " : "") + cleanLine;
        break;
      case "keyPoints":
        keyPoints.push(cleanLine);
        break;
      case "actionItems":
        actionItems.push(cleanLine);
        break;
    }
  }
  
  // If no structured parsing worked, use the whole content as summary
  if (!summary && keyPoints.length === 0) {
    summary = content;
  }

  return {
    summary: summary.trim(),
    keyPoints,
    actionItems,
    participants: speakers,
  };
}

/**
 * Save summary to a file alongside the transcript
 */
export async function saveSummary(
  transcriptPath: string,
  summary: SummaryResult
): Promise<string> {
  const summaryPath = transcriptPath.replace(/\.txt$/, "_summary.txt");
  
  let content = "# Meeting Summary\n\n";
  
  content += "## Summary\n";
  content += summary.summary + "\n\n";
  
  if (summary.keyPoints.length > 0) {
    content += "## Key Points\n";
    for (const point of summary.keyPoints) {
      content += `- ${point}\n`;
    }
    content += "\n";
  }
  
  if (summary.actionItems.length > 0) {
    content += "## Action Items\n";
    for (const item of summary.actionItems) {
      content += `- ${item}\n`;
    }
    content += "\n";
  }
  
  if (summary.participants && summary.participants.length > 0) {
    content += "## Participants\n";
    for (const participant of summary.participants) {
      content += `- ${participant}\n`;
    }
  }
  
  await Bun.write(summaryPath, content);
  return summaryPath;
}

/**
 * Check if summarization is available (requires OpenAI)
 */
export async function isSummarizationAvailable(): Promise<boolean> {
  return await authManager.isAuthenticated("openai");
}

/**
 * Get the summary file path for a transcript
 */
export function getSummaryPath(transcriptPath: string): string {
  return transcriptPath.replace(/\.txt$/, "_summary.txt");
}

/**
 * Check if a summary already exists for a transcript
 */
export async function hasSummary(transcriptPath: string): Promise<boolean> {
  const summaryPath = getSummaryPath(transcriptPath);
  const file = Bun.file(summaryPath);
  return await file.exists();
}

/**
 * Load an existing summary from file
 */
export async function loadSummary(transcriptPath: string): Promise<SummaryResult | null> {
  const summaryPath = getSummaryPath(transcriptPath);
  const file = Bun.file(summaryPath);
  
  if (!await file.exists()) {
    return null;
  }

  try {
    const content = await file.text();
    return parseSummaryFile(content);
  } catch {
    return null;
  }
}

/**
 * Parse a saved summary file back into SummaryResult
 */
function parseSummaryFile(content: string): SummaryResult {
  const lines = content.split("\n");
  
  let summary = "";
  const keyPoints: string[] = [];
  const actionItems: string[] = [];
  const participants: string[] = [];
  
  let currentSection = "";
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    
    if (trimmedLine === "## Summary") {
      currentSection = "summary";
      continue;
    } else if (trimmedLine === "## Key Points") {
      currentSection = "keyPoints";
      continue;
    } else if (trimmedLine === "## Action Items") {
      currentSection = "actionItems";
      continue;
    } else if (trimmedLine === "## Participants") {
      currentSection = "participants";
      continue;
    } else if (trimmedLine.startsWith("#")) {
      continue;
    }
    
    if (!trimmedLine) continue;
    
    const cleanLine = trimmedLine.replace(/^[-•*]\s*/, "");
    
    switch (currentSection) {
      case "summary":
        summary += (summary ? " " : "") + cleanLine;
        break;
      case "keyPoints":
        if (cleanLine) keyPoints.push(cleanLine);
        break;
      case "actionItems":
        if (cleanLine) actionItems.push(cleanLine);
        break;
      case "participants":
        if (cleanLine) participants.push(cleanLine);
        break;
    }
  }

  return {
    summary: summary.trim(),
    keyPoints,
    actionItems,
    participants: participants.length > 0 ? participants : undefined,
  };
}
