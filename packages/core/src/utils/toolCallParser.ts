/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FunctionCall } from '@google/genai';
import { stripJsonMarkdown } from './json.js';
import { debugLogger } from './debugLogger.js';

import { z } from 'zod';

/**
 * Parses a string containing Ollama tool calls into an array of FunctionCall objects.
 * @param text The string to parse.
 * @returns An array of FunctionCall objects.
 */
export function parseToolCalls(text: string, promptId: string): FunctionCall[] {
  const strippedText = stripJsonMarkdown(text);
  debugLogger.log(
    `[Debug] Parsing Ollama tool calls from text: ${strippedText}`,
  );
  const functionCalls: FunctionCall[] = [];

  try {
    const parsedJson = JSON.parse(strippedText) as unknown;

    const processJsonToolCall = (
      toolCall: unknown,
      _index: number,
    ): FunctionCall | null => {
      const ToolCallSchema = z
        .object({
          name: z.string(),
          goal: z.string().optional(),
          parameters: z.record(z.unknown()).optional(),
        })
        .passthrough();

      const result = ToolCallSchema.safeParse(toolCall);
      if (!result.success) return null;

      const tc = result.data;
      // Handle dynamic tool calls with 'goal'
      if (tc.goal !== undefined) {
        debugLogger.log(`[Debug] Processing dynamic tool call with goal.`);
        return {
          name: tc.name,
          args: { goal: tc.goal },
        };
      } else {
        // Handle static tool calls with 'parameters'
        return {
          name: tc.name,
          args: tc.parameters ?? {},
        };
      }
    };

    if (Array.isArray(parsedJson)) {
      for (const [index, item] of parsedJson.entries()) {
        const functionCall = processJsonToolCall(item, index);
        if (functionCall) {
          functionCalls.push(functionCall);
        }
      }
    } else {
      const functionCall = processJsonToolCall(parsedJson, 0);
      if (functionCall) {
        functionCalls.push(functionCall);
      }
    }

    if (functionCalls.length > 0) {
      return functionCalls;
    }
  } catch (e) {
    // Not a valid JSON, proceed with regex parsing
    debugLogger.log(
      '[Debug] Failed to parse tool calls as JSON, falling back to regex.',
      e,
    );
  }

  // This regex finds patterns like `function_name(anything_inside)`.
  const toolCallRegex = /(\w+)\((.*?)\)/g;
  let match;

  // The model might return tool calls wrapped in [].
  const content =
    strippedText.trim().startsWith('[') && strippedText.trim().endsWith(']')
      ? strippedText.trim().slice(1, -1)
      : strippedText.trim();

  while ((match = toolCallRegex.exec(content)) !== null) {
    const name = match[1];
    const argsString = match[2];
    debugLogger.log(
      `[Debug] Found tool call: ${name} with args: ${argsString}`,
    );
    const args: { [key: string]: unknown } = {};

    if (argsString) {
      // This regex handles key-value pairs, including quoted values that may contain commas.
      const argRegex = /(\w+)=(".*?"|'.*?'|[^,]+)/g;
      let argMatch;
      while ((argMatch = argRegex.exec(argsString)) !== null) {
        const key = argMatch[1];
        let value: unknown = argMatch[2].trim();

        // Basic type inference
        if (typeof value === 'string') {
          if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith(`'`) && value.endsWith(`'`))
          ) {
            value = value.slice(1, -1);
          } else if (!isNaN(Number(value)) && value.trim() !== '') {
            value = Number(value);
          } else if (value === 'true') {
            value = true;
          } else if (value === 'false') {
            value = false;
          }
        }
        args[key] = value;
      }
    }
    functionCalls.push({
      id: `${promptId}-ollama-${functionCalls.length}`,
      name,
      args,
    });
  }
  return functionCalls;
}
