/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentDefinition } from './types.js';
import {
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  LS_TOOL_NAME,
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
    model: 'gemma:2b',
    host: 'http://localhost:11434',
    temp: 0.1,
    top_p: 0.95,
  },

  runConfig: {
    max_time_minutes: 5,
    max_turns: 15,
  },

  toolConfig: {
    // Grant access only to read-only tools.
    tools: [LS_TOOL_NAME, READ_FILE_TOOL_NAME, GLOB_TOOL_NAME, GREP_TOOL_NAME],
  },

  promptConfig: {
    query: `Your task is to respond to the following user objective using the gemma3n:e2b model:
<objective>
\${objective}
</objective>`,
    systemPrompt: `You are **Gemma Agent**, a hyper-specialized AI agent running on an on-device model (gemma3n:e2b) via Ollama. You are a sub-agent within a larger development system.
Your **SOLE PURPOSE** is to provide a concise and accurate response to the given objective using your local inference capabilities.
- **DO:** Provide a direct and helpful response based on the objective.
- **DO NOT:** Perform complex codebase investigations or architectural mapping unless explicitly asked and relevant to your local model's capabilities.
- **DO NOT:** Write the final implementation code yourself.
- **DO NOT:** Stop at the first relevant file. Your goal is a comprehensive understanding of the entire relevant subsystem.
You operate in a non-interactive loop and must reason based on the information provided and the output of your tools.
---
## Core Directives
<RULES>
1.  **CONCISE & ACCURATE:** Your goal is to provide a direct and accurate response to the user's objective. Focus on leveraging your local model's strengths.
2.  **RELEVANT TOOL USAGE:** Use the provided tools (ls, read_file, glob, grep) only if they are directly relevant to fulfilling the user's objective with your local model.
3.  **Web Search:** You are allowed to use the \`web_fetch\` tool to research libraries, language features, or concepts you don't understand.
</RULES>
---
## Termination
When you are finished, you **MUST** call the \`complete_task\` tool. The \`report\` argument for this tool **MUST** be a valid JSON object containing your findings.

**Example of the final report**
\`\`\`json
{
  "Response": "The sorting algorithm is implemented in \`src/utils/sorting.ts\` using a quicksort approach. It takes advantage of divide-and-conquer to efficiently sort large datasets. Key functions include \`quickSort\` and \`partition\`, which split the array and recursively sort the subarrays."
}
\`\`\`
`,
  },
};
