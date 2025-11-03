/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

import { Type } from '@google/genai';
import type { Config } from '../config/config.js';
import { reportError } from '../utils/errorReporting.js';
import { OllamaChat } from '../core/ollamaChat.js';
import { GeminiChat, StreamEventType } from '../core/geminiChat.js';
import type {
  Content as GeminiContent,
  Part as GeminiPart,
  FunctionCall,
  GenerateContentConfig,
  FunctionDeclaration,
  Schema,
} from '@google/genai';
import { executeToolCall } from '../core/nonInteractiveToolExecutor.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import type { ToolCallRequestInfo } from '../core/turn.js';
import { getDirectoryContextString } from '../utils/environmentContext.js';
import {
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  LS_TOOL_NAME,
  MEMORY_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  READ_MANY_FILES_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from '../tools/tool-names.js';
import { promptIdContext } from '../utils/promptIdContext.js';
import { logAgentStart, logAgentFinish } from '../telemetry/loggers.js';
import { AgentStartEvent, AgentFinishEvent } from '../telemetry/types.js';
import type {
  AgentDefinition,
  AgentInputs,
  ModelConfig,
  OllamaModelConfig,
  OutputObject,
  SubagentActivityEvent,
} from './types.js';
import { AgentTerminateMode } from './types.js';
import { templateString } from './utils.js';
import { parseThought } from '../utils/thoughtUtils.js';
import { type z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { debugLogger } from '../utils/debugLogger.js';
import type { Part as OllamaPart } from '../core/ollamaChat.js';
import { stripJsonMarkdown } from '../utils/json.js';

/** A callback function to report on agent activity. */
export type ActivityCallback = (activity: SubagentActivityEvent) => void;

const TASK_COMPLETE_TOOL_NAME = 'complete_task';

/**
 * Executes an agent loop based on an {@link AgentDefinition}.
 *
 * This executor runs the agent in a loop, calling tools until it calls the
 * mandatory `complete_task` tool to signal completion.
 */
export class AgentExecutor<TOutput extends z.ZodTypeAny> {
  readonly definition: AgentDefinition<TOutput>;

  private readonly agentId: string;
  private readonly toolRegistry: ToolRegistry;
  private readonly runtimeContext: Config;
  private readonly onActivity?: ActivityCallback;

  /**
   * Creates and validates a new `AgentExecutor` instance.
   *
   * This method ensures that all tools specified in the agent's definition are
   * safe for non-interactive use before creating the executor.
   *
   * @param definition The definition object for the agent.
   * @param runtimeContext The global runtime configuration.
   * @param onActivity An optional callback to receive activity events.
   * @returns A promise that resolves to a new `AgentExecutor` instance.
   */
  static async create<TOutput extends z.ZodTypeAny>(
    definition: AgentDefinition<TOutput>,
    runtimeContext: Config,
    onActivity?: ActivityCallback,
  ): Promise<AgentExecutor<TOutput>> {
    // Create an isolated tool registry for this agent instance.
    const agentToolRegistry = new ToolRegistry(runtimeContext);
    const parentToolRegistry = await runtimeContext.getToolRegistry();

    if (definition.toolConfig) {
      for (const toolRef of definition.toolConfig.tools) {
        if (typeof toolRef === 'string') {
          // If the tool is referenced by name, retrieve it from the parent
          // registry and register it with the agent's isolated registry.
          const toolFromParent = parentToolRegistry.getTool(toolRef);
          if (toolFromParent) {
            agentToolRegistry.registerTool(toolFromParent);
          }
        } else if (
          typeof toolRef === 'object' &&
          'name' in toolRef &&
          'build' in toolRef
        ) {
          agentToolRegistry.registerTool(toolRef);
        }
        // Note: Raw `FunctionDeclaration` objects in the config don't need to be
        // registered; their schemas are passed directly to the model later.
      }

      // Validate that all registered tools are safe for non-interactive
      // execution.
      await AgentExecutor.validateTools(agentToolRegistry, definition.name);
    }

    // Get the parent prompt ID from context
    const parentPromptId = promptIdContext.getStore();

    return new AgentExecutor(
      definition,
      runtimeContext,
      agentToolRegistry,
      parentPromptId,
      onActivity,
    );
  }

  /**
   * Constructs a new AgentExecutor instance.
   *
   * @private This constructor is private. Use the static `create` method to
   * instantiate the class.
   */
  private constructor(
    definition: AgentDefinition<TOutput>,
    runtimeContext: Config,
    toolRegistry: ToolRegistry,
    parentPromptId: string | undefined,
    onActivity?: ActivityCallback,
  ) {
    this.definition = definition;
    this.runtimeContext = runtimeContext;
    this.toolRegistry = toolRegistry;
    this.onActivity = onActivity;

    const randomIdPart = Math.random().toString(36).slice(2, 8);
    // parentPromptId will be undefined if this agent is invoked directly
    // (top-level), rather than as a sub-agent.
    const parentPrefix = parentPromptId ? `${parentPromptId}-` : '';
    this.agentId = `${parentPrefix}${this.definition.name}-${randomIdPart}`;
  }

  /**
   * Runs the agent.
   *
   * @param inputs The validated input parameters for this invocation.
   * @param signal An `AbortSignal` for cancellation.
   * @returns A promise that resolves to the agent's final output.
   */
  async run(inputs: AgentInputs, signal: AbortSignal): Promise<OutputObject> {
    const startTime = Date.now();
    let turnCounter = 0;
    let terminateReason: AgentTerminateMode = AgentTerminateMode.ERROR;
    let finalResult: string | null = null;

    logAgentStart(
      this.runtimeContext,
      new AgentStartEvent(this.agentId, this.definition.name),
    );

    try {
      const chat = await this.createChatObject(inputs);
      const tools = this.prepareToolsList();

      const query = this.definition.promptConfig.query
        ? templateString(this.definition.promptConfig.query, inputs)
        : 'Get Started!';
      let currentMessage: GeminiContent = {
        role: 'user',
        parts: [{ text: query }],
      };

      while (true) {
        // Check for termination conditions like max turns or timeout.
        const reason = this.checkTermination(startTime, turnCounter);
        if (reason) {
          terminateReason = reason;
          break;
        }
        if (signal.aborted) {
          terminateReason = AgentTerminateMode.ABORTED;
          break;
        }

        const promptId = `${this.agentId}#${turnCounter++}`;

        // The textResponse is not deconstructed from callModel, but it's used to emit/yield thoughts and streamed chunks to the UI.
        const { functionCalls } = await promptIdContext.run(
          promptId,
          async () =>
            this.callModel(chat, currentMessage, tools, signal, promptId),
        );

        if (signal.aborted) {
          terminateReason = AgentTerminateMode.ABORTED;
          break;
        }

        // If the model stops calling tools without calling complete_task, it's an error.
        if (functionCalls.length === 0) {
          terminateReason = AgentTerminateMode.ERROR;
          finalResult = `Agent stopped calling tools but did not call '${TASK_COMPLETE_TOOL_NAME}' to finalize the session.`;
          this.emitActivity('ERROR', {
            error: finalResult,
            context: 'protocol_violation',
          });
          break;
        }

        const { nextMessage, submittedOutput, taskCompleted } =
          await this.processFunctionCalls(functionCalls, signal, promptId);

        if (taskCompleted) {
          finalResult = submittedOutput ?? 'Task completed successfully.';
          terminateReason = AgentTerminateMode.GOAL;
          break;
        }

        debugLogger.log(
          `Next message: ${JSON.stringify(nextMessage, null, 2)}`,
        );

        currentMessage = nextMessage;
      }

      if (terminateReason === AgentTerminateMode.GOAL) {
        return {
          result: finalResult || 'Task completed.',
          terminate_reason: terminateReason,
        };
      }

      return {
        result:
          finalResult || 'Agent execution was terminated before completion.',
        terminate_reason: terminateReason,
      };
    } catch (error) {
      this.emitActivity('ERROR', { error: String(error) });
      throw error; // Re-throw the error for the parent context to handle.
    } finally {
      logAgentFinish(
        this.runtimeContext,
        new AgentFinishEvent(
          this.agentId,
          this.definition.name,
          Date.now() - startTime,
          turnCounter,
          terminateReason,
        ),
      );
    }
  }

  /**
   * Calls the generative model with the current context and tools.
   *
   * @returns The model's response, including any tool calls or text.
   */
  private async callModel(
    chat: GeminiChat | OllamaChat,
    message: GeminiContent,
    tools: FunctionDeclaration[],
    signal: AbortSignal,
    promptId: string,
  ): Promise<{ functionCalls: FunctionCall[]; textResponse: string }> {
    if (chat instanceof GeminiChat) {
      return this.callGeminiModel(chat, message, tools, signal, promptId);
    } else if (chat instanceof OllamaChat) {
      return this.callOllamaModel(chat, message, tools, signal, promptId);
    } else {
      throw new Error('Unsupported chat object type');
    }
  }

  /**
   * Calls the Gemini model with the given message and tools.
   */
  private async callGeminiModel(
    chat: GeminiChat,
    message: GeminiContent,
    tools: FunctionDeclaration[],
    signal: AbortSignal,
    promptId: string,
  ): Promise<{ functionCalls: FunctionCall[]; textResponse: string }> {
    const messageParams = {
      message: (message.parts || []) as GeminiPart[],
      config: {
        abortSignal: signal,
        tools: tools.length > 0 ? [{ functionDeclarations: tools }] : undefined,
      },
    };

    const responseStream = await chat.sendMessageStream(
      this.definition.modelConfig.model,
      messageParams,
      promptId,
    );

    const functionCalls: FunctionCall[] = [];
    let textResponse = '';

    for await (const resp of responseStream) {
      if (signal.aborted) break;

      if (resp.type === StreamEventType.CHUNK) {
        const chunk = resp.value;
        const parts = chunk.candidates?.[0]?.content?.parts;

        // Extract and emit any subject "thought" content from the model.
        const { subject } = parseThought(
          parts?.find((p) => 'thought' in p && p.thought)?.text || '',
        );
        if (subject) {
          this.emitActivity('THOUGHT_CHUNK', { text: subject });
        }

        // Collect any function calls requested by the model.
        if ('functionCalls' in chunk && chunk.functionCalls) {
          functionCalls.push(...chunk.functionCalls);
        }

        // Handle text response (non-thought text)
        const text =
          parts
            ?.filter((p) => !('thought' in p && p.thought) && p.text)
            .map((p) => p.text)
            .join('') || '';

        if (text) {
          textResponse += text;
        }
      }
    }

    return { functionCalls, textResponse };
  }

  // TODO: test this.
  /**
   * Parses a string containing Ollama tool calls into an array of FunctionCall objects.
   * @param text The string to parse.
   * @returns An array of FunctionCall objects.
   */
  private _parseOllamaToolCalls(
    text: string,
    promptId: string,
  ): FunctionCall[] {
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
          'name' in toolCall &&
          'parameters' in toolCall
        ) {
          const tc = toolCall as {
            name: string;
            parameters: Record<string, unknown>;
          };
          if (typeof tc.name === 'string') {
            return {
              // id: `${promptId}-ollama-${index}`,
              name: tc.name,
              args: tc.parameters,
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
        debugLogger.log(
          `[Debug] Parsed Ollama tool calls from JSON: ${JSON.stringify(
            functionCalls,
          )}`,
        );
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
    debugLogger.log(
      `[Debug] Parsed Ollama tool calls: ${JSON.stringify(functionCalls)}`,
    );
    return functionCalls;
  }

  /**
   * Calls the Ollama model with the given message.
   */
  private async callOllamaModel(
    chat: OllamaChat,
    // TODO: later this should not take in a GeminiContent but a more generic type. it's fine for now since `currentMessage` is very basic.
    // TODO: also handle conversion of toolResponseParts since that is the returned value from the `processFunctionCalls`: `nextMessage`.
    message: GeminiContent,
    tools: FunctionDeclaration[],
    signal: AbortSignal,
    promptId: string,
  ): Promise<{ functionCalls: FunctionCall[]; textResponse: string }> {
    const messageParams = {
      message: (message.parts || []) as OllamaPart[],
      config: {
        tools: tools.length > 0 ? [{ functionDeclarations: tools }] : undefined,
      },
    };

    // debugLogger.log(
    //   `[Debug] Sending message to Ollama model: ${JSON.stringify(messageParams, null, 2)}`,
    // );

    const responseStream = await chat.sendMessageStream(
      this.definition.modelConfig.model,
      messageParams,
    );

    let textResponse = '';

    for await (const resp of responseStream) {
      if (signal.aborted) break;

      if (resp.type === StreamEventType.CHUNK) {
        const chunk = resp.value;
        const parts = chunk.candidates?.[0]?.content?.parts;

        const text = parts?.map((p) => p.text).join('') || '';

        // TODO: when I do this.emitActivity('THOUGHT_CHUNK', { text }); it updates the terminal to be the new chunk every time, but if I do this.emitActivity('THOUGHT_CHUNK', { textResponse }); then it doesn't update at all, even though I am verifying in the debuglogger.log that tht textresponse is updating properly? this is in executor.ts
        if (text) {
          // textResponse += text;
          textResponse = text;
          // For Ollama, we'll treat all output as a "thought" for now
          // debugLogger.log(
          //   '[Debug] Emitting thought chunk from Ollama response: ',
          //   textResponse,
          // );
          // TODO: emitActivity only works if it's a const value.
          this.emitActivity('THOUGHT_CHUNK', { text });

          // this.emitActivity('THOUGHT_CHUNK', { textResponse });
        }
      }
    }

    let functionCalls = this._parseOllamaToolCalls(textResponse, promptId);

    // If there is no function call, it implies complete_task call.
    if (functionCalls.length === 0) {
      debugLogger.log(
        '[Debug] No function calls parsed from Ollama response, complete_task fallback.',
      );
      const outputName = this.definition.outputConfig?.outputName;
      if (outputName) {
        let args = {};
        try {
          // const strippedText = stripJsonMarkdown(textResponse);
          args = { [outputName]: JSON.parse(textResponse) };
          debugLogger.log(`[Debug] Subagent response is json.`);
        } catch (error) {
          args = { [outputName]: textResponse };
          debugLogger.log(`[Debug] Subagent response is text.`);
        }
        const completeTaskFunctionCall: FunctionCall = {
          name: TASK_COMPLETE_TOOL_NAME,
          args,
          id: 'ollama-complete-task-fallback',
        };
        functionCalls = [completeTaskFunctionCall];
      }
    }
    return { functionCalls, textResponse };
  }

  /** Initializes a `GeminiChat` instance for the agent run. */
  private async createChatObject(
    inputs: AgentInputs,
  ): Promise<GeminiChat | OllamaChat> {
    const { promptConfig, modelConfig } = this.definition;

    if (!promptConfig.systemPrompt && !promptConfig.initialMessages) {
      throw new Error(
        'PromptConfig must define either `systemPrompt` or `initialMessages`.',
      );
    }

    const startHistory = this.applyTemplateToInitialMessages(
      promptConfig.initialMessages ?? [],
      inputs,
    );

    // Build system instruction from the templated prompt string.
    const systemInstruction = promptConfig.systemPrompt
      ? await this.buildSystemPrompt(inputs)
      : undefined;

    // debugLogger.log(
    //   `[AgentExecutor] Created system instruction: ${systemInstruction}`,
    // );

    if ('host' in modelConfig) {
      return new OllamaChat(
        modelConfig as OllamaModelConfig,
        systemInstruction,
        startHistory,
      );
    } else {
      try {
        const generationConfig: GenerateContentConfig = {
          temperature: (modelConfig as ModelConfig).temp,
          topP: (modelConfig as ModelConfig).top_p,
          thinkingConfig: {
            includeThoughts: true,
            thinkingBudget: (modelConfig as ModelConfig).thinkingBudget ?? -1,
          },
        };

        if (systemInstruction) {
          generationConfig.systemInstruction = systemInstruction;
        }

        return new GeminiChat(
          this.runtimeContext,
          generationConfig,
          startHistory,
        );
      } catch (error) {
        await reportError(
          error,
          `Error initializing Gemini chat for agent ${this.definition.name}.`,
          startHistory,
          'startChat',
        );
        // Re-throw as a more specific error after reporting.
        throw new Error(`Failed to create chat object: ${error}`);
      }
    }
  }

  /**
   * Executes function calls requested by the model and returns the results.
   *
   * @returns A new `Content` object for history, any submitted output, and completion status.
   */
  private async processFunctionCalls(
    functionCalls: FunctionCall[],
    signal: AbortSignal,
    promptId: string,
  ): Promise<{
    nextMessage: GeminiContent;
    submittedOutput: string | null;
    taskCompleted: boolean;
  }> {
    debugLogger.log(
      `[AgentExecutor] Processing ${functionCalls.length} function calls.`,
    );
    const allowedToolNames = new Set(this.toolRegistry.getAllToolNames());
    debugLogger.log(
      `[AgentExecutor] Allowed tools for this agent: ${Array.from(
        allowedToolNames,
      ).join(', ')}`,
    );
    // Always allow the completion tool
    allowedToolNames.add(TASK_COMPLETE_TOOL_NAME);

    let submittedOutput: string | null = null;
    let taskCompleted = false;

    // We'll collect promises for the tool executions
    const toolExecutionPromises: Array<Promise<GeminiPart[] | void>> = [];
    // And we'll need a place to store the synchronous results (like complete_task or blocked calls)
    const syncResponseParts: GeminiPart[] = [];

    for (const [index, functionCall] of functionCalls.entries()) {
      const callId = functionCall.id ?? `${promptId}-${index}`;
      const args = (functionCall.args ?? {}) as Record<string, unknown>;
      debugLogger.log(
        `[AgentExecutor] Processing function call: ${functionCall.name} with ID: ${callId} and args: ${JSON.stringify(functionCall.args)}`,
      );

      this.emitActivity('TOOL_CALL_START', {
        name: functionCall.name,
        args,
      });

      if (functionCall.name === TASK_COMPLETE_TOOL_NAME) {
        debugLogger.log('[AgentExecutor] Processing complete_task tool call.');
        if (taskCompleted) {
          // We already have a completion from this turn. Ignore subsequent ones.
          const error =
            'Task already marked complete in this turn. Ignoring duplicate call.';
          syncResponseParts.push({
            functionResponse: {
              name: TASK_COMPLETE_TOOL_NAME,
              response: { error },
              id: callId,
            },
          });
          this.emitActivity('ERROR', {
            context: 'tool_call',
            name: functionCall.name,
            error,
          });
          continue;
        }

        const { outputConfig } = this.definition;
        taskCompleted = true; // Signal completion regardless of output presence

        if (outputConfig) {
          debugLogger.log(
            '[AgentExecutor] Validating output for complete_task tool call.',
          );
          const outputName = outputConfig.outputName;
          if (args[outputName] !== undefined) {
            const outputValue = args[outputName];
            const validationResult = outputConfig.schema.safeParse(outputValue);

            if (!validationResult.success) {
              debugLogger.log(
                '[AgentExecutor] Output validation failed:',
                validationResult.error.flatten(),
              );
              taskCompleted = false; // Validation failed, revoke completion
              const error = `Output validation failed: ${JSON.stringify(validationResult.error.flatten())}`;
              syncResponseParts.push({
                functionResponse: {
                  name: TASK_COMPLETE_TOOL_NAME,
                  response: { error },
                  id: callId,
                },
              });
              this.emitActivity('ERROR', {
                context: 'tool_call',
                name: functionCall.name,
                error,
              });
              continue;
            }

            debugLogger.log('[AgentExecutor] Output validation succeeded.');

            const validatedOutput = validationResult.data;
            if (this.definition.processOutput) {
              submittedOutput = this.definition.processOutput(validatedOutput);
            } else {
              submittedOutput =
                typeof outputValue === 'string'
                  ? outputValue
                  : JSON.stringify(outputValue, null, 2);
            }
            syncResponseParts.push({
              functionResponse: {
                name: TASK_COMPLETE_TOOL_NAME,
                response: { result: 'Output submitted and task completed.' },
                id: callId,
              },
            });
            this.emitActivity('TOOL_CALL_END', {
              name: functionCall.name,
              output: 'Output submitted and task completed.',
            });
          } else {
            // Failed to provide required output.
            taskCompleted = false; // Revoke completion status
            const error = `Missing required argument '${outputName}' for completion.`;
            syncResponseParts.push({
              functionResponse: {
                name: TASK_COMPLETE_TOOL_NAME,
                response: { error },
                id: callId,
              },
            });
            this.emitActivity('ERROR', {
              context: 'tool_call',
              name: functionCall.name,
              error,
            });
          }
        } else {
          debugLogger.log(
            '[AgentExecutor] No output expected. Just signal completion.',
          );
          // No output expected. Just signal completion.
          submittedOutput = 'Task completed successfully.';
          syncResponseParts.push({
            functionResponse: {
              name: TASK_COMPLETE_TOOL_NAME,
              response: { status: 'Task marked complete.' },
              id: callId,
            },
          });
          this.emitActivity('TOOL_CALL_END', {
            name: functionCall.name,
            output: 'Task marked complete.',
          });
        }
        continue;
      }

      // Handle standard tools
      if (!allowedToolNames.has(functionCall.name as string)) {
        const error = `Unauthorized tool call: '${functionCall.name}' is not available to this agent.`;

        debugLogger.warn(`[AgentExecutor] Blocked call: ${error}`);

        syncResponseParts.push({
          functionResponse: {
            name: functionCall.name as string,
            id: callId,
            response: { error },
          },
        });

        this.emitActivity('ERROR', {
          context: 'tool_call_unauthorized',
          name: functionCall.name,
          callId,
          error,
        });

        continue;
      }

      const requestInfo: ToolCallRequestInfo = {
        callId,
        name: functionCall.name as string,
        args,
        isClientInitiated: true,
        isSubagent: true,
        prompt_id: promptId,
      };

      // Create a promise for the tool execution
      debugLogger.log(
        `[AgentExecutor] Scheduling execution for tool: ${functionCall.name} (ID: ${callId})`,
      );
      const executionPromise = (async () => {
        const { response: toolResponse } = await executeToolCall(
          this.runtimeContext,
          requestInfo,
          signal,
        );

        if (toolResponse.error) {
          this.emitActivity('ERROR', {
            context: 'tool_call',
            name: functionCall.name,
            error: toolResponse.error.message,
          });
        } else {
          this.emitActivity('TOOL_CALL_END', {
            name: functionCall.name,
            output: toolResponse.resultDisplay,
          });
        }

        return toolResponse.responseParts;
      })();

      toolExecutionPromises.push(executionPromise);
    }

    // Wait for all tool executions to complete
    const asyncResults = await Promise.all(toolExecutionPromises);

    // Combine all response parts
    const toolResponseParts: GeminiPart[] = [...syncResponseParts];
    for (const result of asyncResults) {
      if (result) {
        toolResponseParts.push(...result);
      }
    }

    // If all authorized tool calls failed (and task isn't complete), provide a generic error.
    if (
      functionCalls.length > 0 &&
      toolResponseParts.length === 0 &&
      !taskCompleted
    ) {
      toolResponseParts.push({
        text: 'All tool calls failed or were unauthorized. Please analyze the errors and try an alternative approach.',
      });
    }

    return {
      nextMessage: { role: 'user', parts: toolResponseParts },
      submittedOutput,
      taskCompleted,
    };
  }

  /**
   * Prepares the list of tool function declarations to be sent to the model.
   */
  private prepareToolsList(): FunctionDeclaration[] {
    const toolsList: FunctionDeclaration[] = [];
    const { toolConfig, outputConfig } = this.definition;

    if (toolConfig) {
      const toolNamesToLoad: string[] = [];
      for (const toolRef of toolConfig.tools) {
        if (typeof toolRef === 'string') {
          toolNamesToLoad.push(toolRef);
        } else if (typeof toolRef === 'object' && 'schema' in toolRef) {
          // Tool instance with an explicit schema property.
          toolsList.push(toolRef.schema as FunctionDeclaration);
        } else {
          // Raw `FunctionDeclaration` object.
          toolsList.push(toolRef as FunctionDeclaration);
        }
      }
      // Add schemas from tools that were registered by name.
      toolsList.push(
        ...this.toolRegistry.getFunctionDeclarationsFiltered(toolNamesToLoad),
      );
    }

    // Always inject complete_task if want gemma subagent to response in json format.
    // Configure its schema based on whether output is expected.
    const completeTool: FunctionDeclaration = {
      name: TASK_COMPLETE_TOOL_NAME,
      description: outputConfig
        ? 'Call this tool to submit your final answer and complete the task. This is the ONLY way to finish.'
        : 'Call this tool to signal that you have completed your task. This is the ONLY way to finish.',
      parameters: {
        type: Type.OBJECT,
        properties: {},
        required: [],
      },
    };

    if (outputConfig) {
      const jsonSchema = zodToJsonSchema(outputConfig.schema);
      const {
        $schema: _$schema,
        definitions: _definitions,
        ...schema
      } = jsonSchema;
      completeTool.parameters!.properties![outputConfig.outputName] =
        schema as Schema;
      completeTool.parameters!.required!.push(outputConfig.outputName);
    }

    // Gemma subagent will response in fully formatted text instead of json.
    // toolsList.push(completeTool);

    return toolsList;
  }

  /** Builds the system prompt from the agent definition and inputs. */
  private async buildSystemPrompt(inputs: AgentInputs): Promise<string> {
    const { promptConfig } = this.definition;
    if (!promptConfig.systemPrompt) {
      return '';
    }

    const templateInputs: Record<string, unknown> = { ...inputs };

    if (promptConfig.systemPrompt.includes('${tool_code}')) {
      const tools = this.prepareToolsList();
      const toolCode = `${JSON.stringify(tools, null, 2)}`;
      templateInputs['tool_code'] = toolCode;
    }

    // Inject user inputs and tool code (if applicable) into the prompt template.
    let finalPrompt = templateString(promptConfig.systemPrompt, templateInputs);

    // Append environment context (CWD and folder structure).
    const dirContext = await getDirectoryContextString(this.runtimeContext);
    finalPrompt += `\n\n# Environment Context\n${dirContext}`;

    // Append standard rules for non-interactive execution.
    finalPrompt += `
Important Rules:
* You are running in a non-interactive mode. You CANNOT ask the user for input or clarification.
* Work systematically using available tools to complete your task.
* Always use absolute paths for file operations. Construct them using the provided "Environment Context".`;

    if (!('host' in this.definition.modelConfig)) {
      finalPrompt += `
    * When you have completed your task, you MUST call the \`${TASK_COMPLETE_TOOL_NAME}\` tool.
    * Do not call any other tools in the same turn as \`${TASK_COMPLETE_TOOL_NAME}\`.
    * This is the ONLY way to complete your mission. If you stop calling tools without calling this, you have failed.`;
    }

    return finalPrompt;
  }

  /**
   * Applies template strings to initial messages.
   *
   * @param initialMessages The initial messages from the prompt config.
   * @param inputs The validated input parameters for this invocation.
   * @returns A new array of `Content` with templated strings.
   */
  private applyTemplateToInitialMessages(
    initialMessages: GeminiContent[],
    inputs: AgentInputs,
  ): GeminiContent[] {
    return initialMessages.map((content) => {
      const newParts = (content.parts ?? []).map((part) => {
        if ('text' in part && part.text !== undefined) {
          return { text: templateString(part.text, inputs) };
        }
        return part;
      });
      return { ...content, parts: newParts };
    });
  }

  /**
   * Validates that all tools in a registry are safe for non-interactive use.
   *
   * @throws An error if a tool is not on the allow-list for non-interactive execution.
   */
  private static async validateTools(
    toolRegistry: ToolRegistry,
    agentName: string,
  ): Promise<void> {
    // Tools that are non-interactive. This is temporary until we have tool
    // confirmations for subagents.
    const allowlist = new Set([
      LS_TOOL_NAME,
      READ_FILE_TOOL_NAME,
      GREP_TOOL_NAME,
      GLOB_TOOL_NAME,
      READ_MANY_FILES_TOOL_NAME,
      MEMORY_TOOL_NAME,
      WEB_SEARCH_TOOL_NAME,
    ]);
    for (const tool of toolRegistry.getAllTools()) {
      if (!allowlist.has(tool.name)) {
        throw new Error(
          `Tool "${tool.name}" is not on the allow-list for non-interactive ` +
            `execution in agent "${agentName}". Only tools that do not require user ` +
            `confirmation can be used in subagents.`,
        );
      }
    }
  }

  /**
   * Checks if the agent should terminate due to exceeding configured limits.
   *
   * @returns The reason for termination, or `null` if execution can continue.
   */
  private checkTermination(
    startTime: number,
    turnCounter: number,
  ): AgentTerminateMode | null {
    const { runConfig } = this.definition;

    if (runConfig.max_turns && turnCounter >= runConfig.max_turns) {
      return AgentTerminateMode.MAX_TURNS;
    }

    const elapsedMinutes = (Date.now() - startTime) / (1000 * 60);
    if (elapsedMinutes >= runConfig.max_time_minutes) {
      return AgentTerminateMode.TIMEOUT;
    }

    return null;
  }

  /** Emits an activity event to the configured callback. */
  private emitActivity(
    type: SubagentActivityEvent['type'],
    data: Record<string, unknown>,
  ): void {
    if (this.onActivity) {
      const event: SubagentActivityEvent = {
        isSubagentActivityEvent: true,
        agentName: this.definition.name,
        type,
        data,
      };
      this.onActivity(event);
    }
  }
}
