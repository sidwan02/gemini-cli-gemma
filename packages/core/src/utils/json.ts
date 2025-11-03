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
