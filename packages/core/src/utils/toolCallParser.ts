/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

import type { FunctionCall } from '@google/genai';
import { stripJsonMarkdown } from './json.js';
import { debugLogger } from './debugLogger.js';

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
    const parsedJson = JSON.parse(strippedText);

    const processJsonToolCall = (
      toolCall: unknown,
      index: number,
    ): FunctionCall | null => {
      if (
        typeof toolCall === 'object' &&
        toolCall !== null &&
        'name' in toolCall
      ) {
        const tc = toolCall as {
          name: string;
          parameters?: Record<string, unknown>;
        };
        if (typeof tc.name === 'string') {
          return {
            // id: `${promptId}-ollama-${index}`,
            name: tc.name,
            args: tc.parameters ?? {},
          };
        }
      }
      return null;
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
  // debugLogger.log(
  //   `[Debug] Parsed Ollama tool calls: ${JSON.stringify(functionCalls)}`,
  // );
  return functionCalls;
}
