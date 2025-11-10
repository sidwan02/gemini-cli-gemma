/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Strips JSON markdown fences from a string.
 *
 * @param text The text to strip.
 * @returns The stripped text.
 */
export function stripJsonMarkdown(text: string): string {
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace > firstBrace) {
    let jsonText = text.substring(firstBrace, lastBrace + 1);
    // Remove the vertical bar character and newlines that might be present in the output.
    jsonText = jsonText.replace(/│/g, '').replace(/\n/g, '');
    return jsonText;
  }

  return text;
}

/**
 * Improves the JSON extraction logic:
 * 1. Attempts to find a JSON code block within a Markdown fence (```json ... ```).
 * 2. If no Markdown block is found, it falls back to the original brace-matching approach,
 * but adds validation using JSON.parse() to ensure the extracted text is valid JSON.
 *
 * @param text The input string potentially containing JSON.
 * @returns The extracted, valid JSON string, or the original text if no valid JSON is found.
 */
export function extractValidJson(text: string): string {
  // 1. Attempt to find JSON within a Markdown block (```json ... ```)
  const jsonMarkdownRegex = /```json\s*([\s\S]*?)\s*```/g;
  const match = jsonMarkdownRegex.exec(text);

  if (match && match[1]) {
    // Return the content captured inside the code fence
    return match[1].trim();
  }

  // ---

  // 2. Fallback: Find the broadest potential JSON subblock (first '{' to last '}')
  //    and attempt to validate it.
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace <= firstBrace) {
    // No braces found, return original text
    return text;
  }

  // Extract the entire potential block
  let jsonText = text.substring(firstBrace, lastBrace + 1);

  // Clean up common issues often seen around LLM-generated JSON
  // (e.g., the '│' character and newlines *outside* of the JSON structure)
  jsonText = jsonText.replace(/│/g, '').trim();

  try {
    // Attempt to parse the extracted text.
    // This is the most reliable way to ensure it's valid JSON.
    const parsedJson = JSON.parse(jsonText);

    // If parsing succeeds, return the stringified JSON (optional: returns clean JSON)
    // Using JSON.stringify(parsedJson) ensures that the returned string is perfectly formatted
    // and doesn't contain surrounding debris, though returning jsonText is also acceptable.
    return JSON.stringify(parsedJson, null, 2);
  } catch (e) {
    // If parsing fails, it means the subblock is not valid JSON.
    console.warn('Fallback JSON extraction failed validation:', e);
    // Return the original text as the desired fallback behavior.
    return text;
  }
}
