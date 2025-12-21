/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FunctionCall, FunctionDeclaration, Schema } from '@google/genai';

import type { GeminiChat } from '../core/geminiChat.js';
import { OllamaChat, StreamEventType } from '../core/ollamaChat.js';
import { debugLogger } from '../utils/debugLogger.js';
import type { ModelConfig, OllamaModelConfig } from '../agents/types.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import * as fs from 'node:fs/promises';
import { parseToolCalls } from '../utils/toolCallParser.js';

/**
 * A service that takes a tool name and chat history and generates a complete
 * tool call by making a separate LLM call.
 */
export class ToolCallService {
  constructor(private readonly toolRegistry: ToolRegistry) {}

  private _prepareGemmaToolCode(tools: FunctionDeclaration[]): string {
    // Need the tool declaration to be of a certain format for gemma: https://ai.google.dev/gemma/docs/capabilities/function-calling#function-definition
    return `${JSON.stringify(
      tools.map((tool) => {
        type ToolWithBothParams = FunctionDeclaration & {
          parametersJsonSchema?: unknown;
        };
        // Create a mutable copy of the tool to avoid modifying the original
        const newTool: ToolWithBothParams = { ...tool };

        // If 'parametersJsonSchema' exists, convert it to 'parameters'
        if ('parametersJsonSchema' in newTool) {
          newTool.parameters = newTool.parametersJsonSchema as Schema;
          delete newTool.parametersJsonSchema;
        }

        // Process parameters to remove any parameter named 'description'
        if (newTool.parameters && newTool.parameters.properties) {
          const newProperties: Record<string, Schema> = {};
          for (const propName in newTool.parameters.properties) {
            if (
              Object.prototype.hasOwnProperty.call(
                newTool.parameters.properties,
                propName,
              )
            ) {
              // Only include properties that are not named 'description'
              if (propName !== 'description') {
                newProperties[propName] =
                  newTool.parameters.properties[propName];
              }
            }
          }
          newTool.parameters = {
            ...newTool.parameters,
            properties: newProperties,
          };

          // Also update the 'required' array if 'description' was listed as required
          if (newTool.parameters.required) {
            newTool.parameters.required = newTool.parameters.required.filter(
              (reqProp) => reqProp !== 'description',
            );
          }
        }
        return newTool;
      }),
      null,
      2,
    )}`;
  }

  /**
   * Generates a tool call.
   *
   * @param toolName The name of the tool to call.
   * @param chat The chat history of the subagent.
   * @param modelConfig The model configuration for the subagent.
   * @returns The generated tool call.
   */
  async generateToolCall(
    toolName: string,
    chat: GeminiChat | OllamaChat,
    modelConfig: ModelConfig | OllamaModelConfig,
  ): Promise<FunctionCall> {
    const tool = this.toolRegistry.getTool(toolName);
    if (!tool) {
      throw new Error(`Tool "${toolName}" not found in registry.`);
    }

    const functionDeclarations =
      this.toolRegistry.getFunctionDeclarationsFiltered([toolName]);

    const formattedSchema = this._prepareGemmaToolCode(functionDeclarations);

    const chatHistory = await chat.getHistory();
    const lastMessage = chatHistory[chatHistory.length - 1];

    if (!lastMessage || !('parts' in lastMessage)) {
      throw new Error('Could not get last message from chat history');
    }

    const lastMessageText = lastMessage
      .parts!.map((part) => ('text' in part ? part.text : ''))
      .join(' ');

    const systemPrompt = `You are a tool call generator. Your task is to generate a valid tool call for the tool named "${toolName}".
You will be provided with the schema of the tool and the last user message.
Generate a tool call that best helps with the user's request.
The tool schema is:
${formattedSchema}

Respond with only the JSON for the tool call. Do not include any other text or markdown.
`;

    const tempChat = new OllamaChat(
      modelConfig as OllamaModelConfig,
      systemPrompt,
      [],
      {
        query: '',
        systemPrompt,
      },
    );

    const responseStream = await tempChat.sendMessageStream(modelConfig.model, {
      message: [{ text: lastMessageText }],
    });

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

    const responseText = textResponse;
    const functionCalls = parseToolCalls(responseText, 'tool-call-service');

    if (functionCalls.length === 0) {
      debugLogger.log(
        '[ToolCallService] Failed to parse tool call from model response.',
      );
      throw new Error('Failed to generate tool call.');
    }

    const parsedFunctionCall = functionCalls[0];

    try {
      await this._writeChatHistoryToFile(
        systemPrompt,
        lastMessageText,
        textResponse,
      );
    } catch (error) {
      debugLogger.error(
        '[DEBUG] Failed to save summarized tool output to tool_call_chat_history.txt:',
        error,
      );
    }

    return {
      name: parsedFunctionCall.name,
      args: parsedFunctionCall.args,
    };
  }

  private async _writeChatHistoryToFile(
    systemPrompt: string,
    userMessage: string,
    modelResponse: string,
  ): Promise<void> {
    let fileContent = 'Tool Call Service Chat History\n\n';
    fileContent += `--- ROLE: system ---\n${systemPrompt}\n---\n\n`;
    fileContent += `--- ROLE: user ---\n${userMessage}\n---\n\n`;
    fileContent += `--- ROLE: model ---\n${modelResponse}\n---\n\n`;
    await fs.writeFile(`tool_call_chat_history.txt`, fileContent);
  }
}
