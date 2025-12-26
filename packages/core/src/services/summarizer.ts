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
You are a Technical Log Extraction Specialist.

## Task Definition
Your task is to identify and extract the **top 5 most relevant sections (~5 log lines each)** from the tool call output that relate to the user's \`<objective>\`.

## Instructions
1. **Prioritize Signal over Noise:** Search the logs for the 5 sections that provide the most conclusive evidence regarding the objective. 
  - **Focus on Final Results:** Disregard verbose intermediate outputs from builds or tests; prioritize the ultimate success/failure indicators and summaries.
  - **Priority 1:** Terminal success indicators for the target (e.g., lines with \`✓\`, \`PASS\`, or \`Tests: X passed\`).
  - **Priority 2:** Detailed error messages or stack traces if the target failed (e.g., \`✕\`, \`AssertionError\`).
  - **Priority 3:** Final process summaries or exit codes.
  - **Lowest Priority:** Repetitive "No test files found" or "queued" messages.
2. **Direct Extraction:** Provide these 5 sections as **separate code blocks**. 
3. **Preserve Verbatim Text:** Do not summarize, edit, or interpret the text within the blocks. Copy them exactly as they appear in the raw log.
4. **Workspace Labels:** Before each code block, add a brief one-line label identifying the workspace the test/build was executed in (e.g., \`[Workspace: packages/core]\`).

## Constraints
- Output exactly 5 blocks (or fewer if the total log is very short).
- Do not add analysis or conclusions.
- Output ONLY the labeled code blocks.
`;

const SUMMARIZER_USER_PROMPT = `## Input
User's Objective: 
{{objective}}

Tool Call Output: 
{{toolcall}}
`;

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

      const chat = new OllamaChat(
        modelConfig as OllamaModelConfig,
        SUMMARIZER_SYSTEM_PROMPT,
      );

      let fileContents = 'Summarizer Service Chat History\n\n';
      fileContents += `--- ROLE: system ---\n${SUMMARIZER_SYSTEM_PROMPT}\n---\n\n`;
      await this._writeChatHistoryToFile(fileContents);

      const toolCallJson = JSON.stringify(userParts);
      const userPrompt = SUMMARIZER_USER_PROMPT.replace(
        '{{objective}}',
        objective,
      ).replace('{{toolcall}}', toolCallJson);

      fileContents += `--- ROLE: user ---\n${userPrompt}\n---\n\n`;
      await this._writeChatHistoryToFile(fileContents);

      const messageParams = {
        message: [{ text: userPrompt }],
      };

      const responseStream = await chat.sendMessageStream(
        modelConfig?.model,
        messageParams,
      );

      let textResponse = '';
      fileContents += `--- ROLE: model ---\n`;
      await this._writeChatHistoryToFile(fileContents);

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
      fileContents += `${textResponse}\n---\n\n`;
      await this._writeChatHistoryToFile(fileContents);

      // Just return the raw text response from the summarizer model.
      return textResponse;
    } else {
      // Summarization for non-Ollama models can be implemented here.
      throw new Error('Summarization using Gemini Model is not implemented.');
    }
  }

  private async _writeChatHistoryToFile(content: string): Promise<void> {
    try {
      await fs.writeFile(`summarizer_chat_history.txt`, content);
    } catch (error) {
      debugLogger.error(
        '[DEBUG] Failed to write to summarizer_chat_history.txt:',
        error,
      );
    }
  }
}
