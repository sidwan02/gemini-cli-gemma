/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { OllamaModelConfig, ModelConfig } from '../agents/types.js';
import { type Part as OllamaPart, OllamaChat } from '../core/ollamaChat.js';
import type { Part as GeminiPart } from '@google/genai';
import { StreamEventType } from '../core/geminiChat.js';

const SUMMARIZER_SYSTEM_PROMPT = `You are a text summarizer. Your sole purpose is to receive text and provide a concise, factual summary of it. Do not add any commentary or analysis. Focus on the key information presented in the text.`;

export class SummarizationService {
  constructor() {}

  async summarize(
    tollResponseParts: GeminiPart[],
    modelConfig: OllamaModelConfig | ModelConfig,
  ): Promise<string | null> {
    if ('host' in modelConfig) {
      const userParts: OllamaPart[] = [];
      for (const part of tollResponseParts) {
        if ('functionResponse' in part) {
          // Singe gemma can't handle function responses, we convert it into a string.
          userParts.push({ text: JSON.stringify(part.functionResponse) });
        } else {
          userParts.push(part as OllamaPart);
        }
      }

      const chat = new OllamaChat(
        modelConfig as OllamaModelConfig,
        SUMMARIZER_SYSTEM_PROMPT,
      );

      const messageParams = {
        message: userParts,
      };

      const responseStream = await chat.sendMessageStream(
        modelConfig?.model,
        messageParams,
      );

      let textResponse = '';

      for await (const resp of responseStream) {
        if (resp.type === StreamEventType.CHUNK) {
          const chunk = resp.value;
          const parts = chunk.candidates?.[0]?.content?.parts;

          const text = parts?.map((p) => p.text).join('') || '';

          if (text) {
            textResponse = text;
          }
        }
      }

      // Just return the raw text response from the summarizer model.
      return textResponse;
    } else {
      // Summarization for non-Ollama models can be implemented here.
      throw new Error('Summarization using Gemini Model is not implemented.');
    }
  }
}
