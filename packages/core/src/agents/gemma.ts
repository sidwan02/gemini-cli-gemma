/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentDefinition } from './types.js';
import {
  GLOB_TOOL_NAME,
  // GREP_TOOL_NAME,
  // LS_TOOL_NAME,
  READ_FILE_TOOL_NAME,
} from '../tools/tool-names.js';
import { z } from 'zod';

// Define a type that matches the outputConfig schema for type safety.
const GemmaAgentOutputSchema = z.object({
  Response: z
    .string()
    .describe("The Gemma agent's response to the user's objective."),
});

/**
 * A Proof-of-Concept subagent specialized in running inference on an on-device model (gemma3n:e2b) using Ollama.
 */
export const GemmaAgent: AgentDefinition<typeof GemmaAgentOutputSchema> = {
  name: 'gemma_agent',
  displayName: 'Gemma Agent',
  description: `The specialized tool for running inference on an on-device model (gemma3n:e2b) using Ollama. 
    Invoke this tool for simple tasks that don't require complex codebase investigations or architectural mapping.`,
  inputConfig: {
    inputs: {
      objective: {
        description: `A comprehensive and detailed description of the user's ultimate goal. 
          You must include original user's objective as well as questions and any extra context and questions you may have.`,
        type: 'string',
        required: true,
      },
    },
  },
  outputConfig: {
    outputName: 'response',
    description: "The Gemma agent's response as a JSON object.",
    schema: GemmaAgentOutputSchema,
  },

  // The 'output' parameter is now strongly typed as GemmaAgentOutputSchema
  processOutput: (output: z.infer<typeof GemmaAgentOutputSchema>) =>
    JSON.stringify(output, null, 2),

  modelConfig: {
    model: 'gemma3n:e2b',
    host: 'http://localhost:11434',
    // TODO: right now temp and top_p don't do anything.
    temp: 0.1,
    top_p: 0.95,
  },

  runConfig: {
    max_time_minutes: 5,
    max_turns: 15,
  },

  toolConfig: {
    // Grant access only to read-only tools.
    // tools: [LS_TOOL_NAME, READ_FILE_TOOL_NAME, GLOB_TOOL_NAME, GREP_TOOL_NAME],
    tools: [GLOB_TOOL_NAME, READ_FILE_TOOL_NAME],
  },

  promptConfig: {
    query: `Your task is to respond to the following user objective using the gemma3n:e2b model using tools as needed:
<objective>
\${objective}
</objective>`,
    systemPrompt: `You are **Gemma Agent**, a hyper-specialized AI agent running on an on-device model  via Ollama. You are a sub-agent within a larger development system.
Your **SOLE PURPOSE** is to make a series of tool calls to gather information for the given objective and make a final tool call to provide a concise and accurate response to the given objective.
You operate in a non-interactive loop and must reason based on the information provided and the output of your tools to make more successive tool calls.
---
## Available Tools
You have access to functions. If you decide to invoke any of the function(s), you MUST put it in the format of:
\`\`\`json
{"name": "tool_call_name", "parameters": { ... }}
\`\`\`

\${tool_code}
---
## Core Directives
<RULES>
1.  **CONCISE & ACCURATE:** Your goal is to make tool calls to gather information and in the last tool call provide a direct and accurate response to the user's objective by condensing the responses from the previous tool calls.
2.  **RELEVANT TOOL USAGE:** Use the provided tools (ls, read_file, glob, grep) only if they are directly relevant to fulfilling the user's objective.
3.  **NO GUESSING:** If you don't have enough information, you MUST use tool calls to gather more information. Do not make assumptions or guess.
4.  **TOOL CALLS ONLY:** Your response MUST ONLY contain an explanation of what tool call you are making and the tool call itself.
5.  **EFFECTIVE WILDCARD USAGE:** Minimize the number of tool calls you make. When using the \`glob\` or \`grep\` tools, use effective wildcard patterns to capture multiple relevant files or lines in a single call.
6.  **CAREFUL SPELLING:** Use careful spelling and casing for all tool names and parameters.
</RULES>
---
## Termination
When you are finished, and you are very confident in your answer based on the results from your tool calls, you **MUST** call the \`complete_task\` tool. The \`response\` argument for this tool **MUST** be a valid JSON object containing your findings. Make sure that the \`Response\` field is properly formatted.

**Example tool call to gather information**
I need to...
\`\`\`json
{"name": "tool_call_name", "parameters": { ... }}
\`\`\`

**Example final tool call when you can fully satisfy the objective**
I am ready to provide the final response because (very brief rationale)...
\`\`\`json
{
  "name": "complete_task", 
  "parameters": 
  { 
    "response": 
    { 
      "Response": "Response goes here..." 
    }
  }
}
\`\`\`
`,
  },
};
