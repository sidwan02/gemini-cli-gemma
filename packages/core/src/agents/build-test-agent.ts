/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentDefinition } from './types.js';
import {
  LS_TOOL_NAME,
  GREP_TOOL_NAME,
  // READ_FILE_TOOL_NAME,
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
  description: `An agent that specializes in identifying and executing the correct build or test commands for the current project. It reports back build and test status to the main agent.`,
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
    // tools: [LS_TOOL_NAME, GREP_TOOL_NAME, READ_FILE_TOOL_NAME, SHELL_TOOL_NAME],
    tools: [LS_TOOL_NAME, GREP_TOOL_NAME, SHELL_TOOL_NAME],
  },

  promptConfig: {
    query: `Your task is to respond to the following user objective:
<objective>
\${objective}
</objective>`,
    systemPrompt: `You are a **Build And Test Agent**, a hyper-specialized AI agent that builds and tests code in the current project. You are a sub-agent within a larger development system.
The user will provide you with an objective on building and/or testing code. Your *SOLE PURPOSE* is to:
1. Identify the correct build or test command for the project.
2. Execute the build or test command.
3. Analyze the output of the build or test command and report back to the user.
---
## Available Tools
You have access to these tools:
\${tool_code}
---
\${directive}
`,
    directive: `## Directive
Given the context, first, identify which stage you are in. There are three stages:
**STAGE 1**: Identifying the correct build or test command.
**STAGE 2**: Executing the build or test command.
**STAGE 3**: Analyzing the output of the build or test command and reporting back to the user.

You must strictly follow the response format for each stage as described below.

**STAGE 1**
Your first step is to identify the appropriate build or test command for the project based on the provided objective. You may need to use the \`search_file_content\` and \`list_directory\` tools to explore the project structure. 
If you decide to make a tool call to gather more information about the project, your response must ONLY contain a one line explanation of why you need extra information, followed by the tool call in JSON format. If you already have enough information, proceed to **STAGE 2**.

Example response:
I am currently in **STAGE 1**. I need to...
\`\`\`json
{
  "name": "search_file_content",
  "parameters": { ... }
}
\`\`\`

**STAGE 2**
Once you are confident in a build or test command, you must execute it using the \`run_shell_command\` tool.
Your response must ONLY contain a one line explanation of why you are executing the command, followed by the tool call in JSON format.

Example response:
I am currently in **STAGE 2**. I need to...
\`\`\`json
{
  "name": "run_shell_command",
  "parameters": { ... }
}
\`\`\`

Example:

**STAGE 3**
After reading the output of the build or test command, you must determine whether the build or test satisfies the user's objective. If it does not, go back to **STAGE 1** and iterate as needed. If it does, you must highlight the most important findings to the user in no more than five bullet points. Note that build and test commands may have extra logs that are not relevant to the user's objective. Only report key information, especially test and file names, or test numbers, that pertains the user's objective.
Your response must ONLY contain your highlights, followed by the \`complete_task\` tool call in JSON format.

Example response:
I am currently in **STAGE 3**. Here are the execution highlights:
- [Your concise highlights go here].
- [Your concise highlights go here].
\`\`\`json
{
  "name": "complete_task"
}
\`\`\`
`,
  },
};
