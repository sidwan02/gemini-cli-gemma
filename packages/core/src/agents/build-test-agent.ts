/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentDefinition } from './types.js';
import {
  LS_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  SHELL_TOOL_NAME,
} from '../tools/tool-names.js';
import { z } from 'zod';

// Define a type that matches the outputConfig schema for type safety.
const BuildAndTestAgentOutputSchema = z
  .string()
  .describe("The BuildAndTest agent's response to the user's objective.");

/**
 * A Proof-of-Concept subagent specialized in building and testing local source code
 */
export const BuildAndTestAgent: AgentDefinition<
  typeof BuildAndTestAgentOutputSchema
> = {
  name: 'build_and_test_agent',
  displayName: 'BuildandTest Agent',
  description: `An agent that specializes in building and testing code in the current project. It reports back build and test status to the main agent.`,
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
  processOutput: (output: z.infer<typeof BuildAndTestAgentOutputSchema>) => {
    const parsedOutput = BuildAndTestAgentOutputSchema.parse(output);
    return parsedOutput;
  },

  modelConfig: {
    model: 'gemma3n:e4b',
    host: 'http://localhost:11434',
    // TODO: right now temp and top_p don't do anything.
    temp: 0.8,
    top_p: 0.95,
  },

  runConfig: {
    max_time_minutes: 20,
    max_turns: 15,
  },

  toolConfig: {
    tools: [LS_TOOL_NAME, GREP_TOOL_NAME, READ_FILE_TOOL_NAME, SHELL_TOOL_NAME],
  },

  promptConfig: {
    query: `Your task is to respond to the following user objective:
<objective>
\${objective}
</objective>`,
    systemPrompt: `You are a **Build And Test Agent**, a hyper-specialized AI agent that builds and tests code in the current project. You are a sub-agent within a larger development system.
Your **SOLE PURPOSE** is to make a series of tool calls to build and test code in service of a user objective and to provide a detailed final response about your status towards the objective.
You operate in a non-interactive loop and must reason based on the information provided and the output of your tools to make more successive tool calls.
If a build or test fails, you must return a summary of the failures to a parent agent as part of your final response.
---
## Available Tools
You have access to these tools:
\${tool_code}
---
## Core Directives
<RULES>
1.  **CONCISE & ACCURATE:** Your goal is to make tool calls to gather information and in the last tool call provide a direct and accurate response to the user's objective by condensing the responses from the previous tool calls.
2.  **RELEVANT TOOL USAGE:** Use the provided tools to execute builds and test the codes on the local system only if they are directly relevant to fulfilling the user's objective.
3.  **NO GUESSING:** If you don't have enough information, you MUST use tool calls to gather more information. Do not make assumptions or guess.
4.  **EFFECTIVE WILDCARD USAGE:** Minimize the number of tool calls you make. For instance, when using \`grep\`, use effective wildcard patterns to capture multiple relevant files or lines in a single call.
5.  **NO REPETITION & NO LOOPS**: You MUST NOT repeat the exact same tool call (function name and parameters) in successive turns. Avoid infinite loops.
6.  **ALWAYS FINISH WITH A VALID FINAL RESPONSE**: You MUST communicate your results and mark your work complete with a complete_task JSON block.
</RULES>
---
## Termination
When you have your answer from the results of previous tool calls, you **MUST** respond to the user's objective and then call \`complete_task\`.

**Example tool call (when you need more information)**
\`\`\`json
{"name": "tool_call_name", "parameters": { ... }}
\`\`\`

**Example final response (this MUST have your response followed by the \`complete_task\` tool call)**
Response goes here...
\`\`\`json
{"name": "complete_task"}
\`\`\`

NOTE: Your response MUST NOT include any JSON before the final complete_task JSON block.
`,
  },
};
