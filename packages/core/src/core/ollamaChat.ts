/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Ollama } from 'ollama';
import type { OllamaModelConfig } from '../agents/types.js';
import type { Content as GeminiContent } from '@google/genai';
import { debugLogger } from '../utils/debugLogger.js';
// import { debugLogger } from '../utils/debugLogger.js';
import * as fs from 'node:fs/promises';

// #region Self-contained types
// These types are defined locally to avoid any dependency on @google/genai.

/** The role of the author of a piece of content. */
export type Role = 'user' | 'model' | 'system';

/** A part of a multi-part message. */
export interface Part {
  text: string;
}

/** The content of a message. */
export interface Content {
  role: Role;
  parts: Part[];
}

/** A response chunk from the streaming API. */
export interface GenerateContentResponse {
  candidates?: Array<{
    content: Content;
    finishReason?: 'STOP' | 'MAX_TOKENS' | 'OTHER';
  }>;
}

/** The type of event in a stream. */
export enum StreamEventType {
  CHUNK = 'chunk',
  RETRY = 'retry',
}

/** An event in the response stream. */
export type StreamEvent =
  | { type: StreamEventType.CHUNK; value: GenerateContentResponse }
  | { type: StreamEventType.RETRY };

// #endregion

/**
 * Converts an internal `Content` object to the format expected by the
 * Ollama library's `chat` method.
 */
function toOllamaMessage(content: Content) {
  const text = content.parts.map((part) => part.text).join('');
  return {
    // Ollama uses 'assistant' for the model's role.
    role: content.role === 'model' ? 'assistant' : content.role,
    content: text,
  };
}

/**
 * A chat session that communicates with an Ollama-compatible API.
 *
 * This class is designed to be a drop-in replacement for `GeminiChat` within
 * the `AgentExecutor`, by mimicking its public interface.
 */
export class OllamaChat {
  private history: Content[] = [];
  private readonly ollama: Ollama;
  private readonly systemInstruction?: string;

  constructor(
    private readonly modelConfig: OllamaModelConfig,
    systemInstruction?: string,
    history?: GeminiContent[],
  ) {
    this.ollama = new Ollama({ host: modelConfig.host });
    this.systemInstruction = systemInstruction;
    if (history) {
      this.history = history
        .filter(
          (geminiContent) =>
            geminiContent.role === 'user' || geminiContent.role === 'model',
        )
        .map((geminiContent) => ({
          role: geminiContent.role as 'user' | 'model',
          parts: (geminiContent.parts ?? [])
            .map((part) => ('text' in part ? { text: part.text } : null))
            .filter((part): part is Part => part !== null),
        }));
    }
  }

  /**
   * Sends a message to the model and returns the response as a stream of events.
   */
  async sendMessageStream(
    _model: string, // model is part of the constructor config for Ollama
    params: { message: string | Part[]; config?: Record<string, unknown> },
  ): Promise<AsyncGenerator<StreamEvent>> {
    const userParts: Part[] = [];
    if (Array.isArray(params.message)) {
      for (const part of params.message) {
        if ('functionResponse' in part) {
          // Singe gemma can't handle function responses, we convert it into a string.
          userParts.push({ text: JSON.stringify(part.functionResponse) });
        } else {
          userParts.push(part as Part);
        }
      }
    } else {
      userParts.push({ text: params.message as string });
    }

    debugLogger.log('[OllamaChat] Sending user message:', userParts);

    const userContent: Content = {
      role: 'user',
      parts: userParts,
    };

    this.history.push(userContent);

    const messages = this.history.map(toOllamaMessage);
    // TODO: environment is still being forgotten in the middle of the system instruction.
    // debugLogger.log('[OllamaChat] system instruction:', this.systemInstruction);
    await fs.writeFile('agent.txt', this.systemInstruction ?? '');
    debugLogger.log('[DEBUG] System Instruction saved to agent.txt');
    if (this.systemInstruction) {
      messages.unshift({
        role: 'system',
        content: this.systemInstruction,
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return (async function* () {
      const stream = await self.ollama.chat({
        model: self.modelConfig.model,
        messages,
        stream: true,
        options: {
          temperature: self.modelConfig.temp,
          top_p: self.modelConfig.top_p,
        },
      });

      const modelResponseParts: Part[] = [];
      let accumulatedText = '';
      for await (const chunk of stream) {
        const chunkText = chunk.message.content;
        accumulatedText += chunkText;
        // debugLogger.log('[OllamaChat] Accumulated text:', accumulatedText);
        modelResponseParts.push({ text: chunkText });

        const responseChunk: GenerateContentResponse = {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: accumulatedText }],
                // parts: [{ text: chunkText }],
              },
            },
          ],
        };

        // When the stream is done, add the finish reason.
        if (chunk.done) {
          responseChunk.candidates![0].finishReason = 'STOP';
        }

        yield { type: StreamEventType.CHUNK, value: responseChunk };
      }

      self.history.push({ role: 'model', parts: modelResponseParts });
    })();
  }

  /**
   * Returns a deep copy of the chat history.
   */
  getHistory(): Content[] {
    return structuredClone(this.history);
  }
}
