/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { OllamaModelConfig, ModelConfig } from '../agents/types.js';
import { type Part as OllamaPart, OllamaChat } from '../core/ollamaChat.js';
import type { Part as GeminiPart } from '@google/genai';
import { StreamEventType } from '../core/geminiChat.js';
import { debugLogger } from '../utils/debugLogger.js';
import * as fs from 'node:fs/promises';

const SUMMARIZER_SYSTEM_PROMPT = `## Role
You are an expert Tool Call Output Summarizer.

## Task Definition
Your task is to summarize a given tool call output. The summary must specifically highlight how the tool call output contributes to or addresses the user's overall objective.

## Instruction
When generating the summary, focus solely on the information within the \`toolcall\` that directly addresses or fulfills aspects of the \`objective\`. **The summary must be as exhaustive as possible, capturing every relevant detail from the tool call, and must be presented as a bulleted list.** Do not include extraneous details or interpret the tool call beyond its direct relevance to the objective.

## Response Format Constraints
The response **must be a bulleted list** containing **up to 20 points** (maximum). Each bullet point should be concise. DO NOT include any explicit explanations, reasoning, or thinking process outside of the bullet points. Your output must ONLY be the bulleted summary.`;

const SUMMARIZER_USER_PROMPT = `## Input
User's Objective: {{objective}}
Tool Call Output: {{toolcall}}

## Output Reminder
Take a deep breath, read the instructions again, read the inputs again. Each instruction is crucial and must be executed with utmost care and attention to detail.

Summary:`;

export class SummarizationService {
  constructor() {}

  async summarize(
    tollResponseParts: GeminiPart[],
    modelConfig: OllamaModelConfig | ModelConfig,
    objective: string,
  ): Promise<string | null> {
    debugLogger.log(
      `[SummarizationService] Starting summarization using model: ${modelConfig.model}`,
    );
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

      try {
        await fs.writeFile(
          'summarize_tool_prompt.txt',
          JSON.stringify(userParts, null, 2),
        );
        debugLogger.log(
          '[DEBUG] Summarized tool output saved to summarize_tool_prompt.txt',
        );
      } catch (error) {
        debugLogger.error(
          '[DEBUG] Failed to save summarized tool output to summarize_tool_prompt.txt:',
          error,
        );
      }

      const chat = new OllamaChat(
        modelConfig as OllamaModelConfig,
        SUMMARIZER_SYSTEM_PROMPT,
      );

      const toolCallJson = JSON.stringify(userParts);
      const userPrompt = SUMMARIZER_USER_PROMPT.replace(
        '{{objective}}',
        objective,
      ).replace('{{toolcall}}', toolCallJson);

      const messageParams = {
        message: [{ text: userPrompt }],
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

      try {
        await fs.writeFile('summarized_tool_output.txt', textResponse);
        debugLogger.log(
          '[DEBUG] Summarized tool output saved to summarized_tool_output.txt',
        );
      } catch (error) {
        debugLogger.error(
          '[DEBUG] Failed to save summarized tool output to summarized_tool_output.txt:',
          error,
        );
      }

      // Just return the raw text response from the summarizer model.
      return textResponse;
    } else {
      // Summarization for non-Ollama models can be implemented here.
      throw new Error('Summarization using Gemini Model is not implemented.');
    }
  }
}
