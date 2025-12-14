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
import { type ToolCallRequestInfo, CompressionStatus } from '../core/turn.js';
import { ChatCompressionService } from '../services/chatCompressionService.js';
import { getDirectoryContextString } from '../utils/environmentContext.js';
import {
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  LS_TOOL_NAME,
  MEMORY_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  READ_MANY_FILES_TOOL_NAME,
  SHELL_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from '../tools/tool-names.js';
import { promptIdContext } from '../utils/promptIdContext.js';
import {
  logAgentStart,
  logAgentFinish,
  logRecoveryAttempt,
} from '../telemetry/loggers.js';
import {
  AgentStartEvent,
  AgentFinishEvent,
  RecoveryAttemptEvent,
} from '../telemetry/types.js';
import type {
  AgentDefinition,
  AgentInputs,
  ModelConfig,
  OllamaModelConfig,
  OutputObject,
  SubagentActivityEvent,
  PromptConfig,
} from './types.js';
import { AgentTerminateMode } from './types.js';
import { templateString } from './utils.js';
import { parseThought } from '../utils/thoughtUtils.js';
import { type z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { debugLogger } from '../utils/debugLogger.js';
import type { Part as OllamaPart } from '../core/ollamaChat.js';
// import { extractValidJson } from '../utils/json.js';
import { stripJsonMarkdown } from '../utils/json.js';
import * as fs from 'node:fs/promises';
import type { AnsiOutput } from '../utils/terminalSerializer.js';
import {
  signalManager,
  // SINGLE_INTERRUPT,
  // DOUBLE_INTERRUPT,
} from '../common/abort-signal-manager.js';

import { SummarizationService } from '../services/summarizer.js';

/** A callback function to report on agent activity. */
export type ActivityCallback = (activity: SubagentActivityEvent) => void;

const TASK_COMPLETE_TOOL_NAME = 'complete_task';
const GRACE_PERIOD_MS = 60 * 1000; // 1 min

/** The possible outcomes of a single agent turn. */
type AgentTurnResult =
  | {
      status: 'continue';
      nextMessage: GeminiContent;
    }
  | {
      status: 'stop';
      terminateReason: AgentTerminateMode;
      finalResult: string | null;
    };

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
  private readonly compressionService: ChatCompressionService;
  private readonly summarizationService: SummarizationService;
  private hasFailedCompressionAttempt = false;

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

      agentToolRegistry.sortTools();
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
    this.compressionService = new ChatCompressionService();
    this.summarizationService = new SummarizationService();

    const randomIdPart = Math.random().toString(36).slice(2, 8);
    // parentPromptId will be undefined if this agent is invoked directly
    // (top-level), rather than as a sub-agent.
    const parentPrefix = parentPromptId ? `${parentPromptId}-` : '';
    this.agentId = `${parentPrefix}${this.definition.name}-${randomIdPart}`;
  }

  /**
   * Executes a single turn of the agent's logic, from calling the model
   * to processing its response.
   *
   * @returns An {@link AgentTurnResult} object indicating whether to continue
   * or stop the agent loop.
   */
  private async executeTurn(
    chat: GeminiChat | OllamaChat,
    currentMessage: GeminiContent,
    tools: FunctionDeclaration[],
    turnCounter: number,
    turnSignal: AbortSignal,
    timeoutSignal: AbortSignal, // Pass the timeout controller's signal
  ): Promise<AgentTurnResult> {
    const promptId = `${this.agentId}#${turnCounter}`;

    debugLogger.log('Prompt ID: ' + promptId);

    if (chat instanceof GeminiChat) {
      await this.tryCompressChat(chat, promptId);
    }

    // The textResponse is not deconstructed from callModel, but it's used to emit/yield thoughts and streamed chunks to the UI.
    const { functionCalls, textResponse } = await promptIdContext.run(
      promptId,
      async () =>
        this.callModel(chat, currentMessage, tools, turnSignal, promptId),
    );

    if (turnSignal.aborted) {
      debugLogger.log(
        `[Debug] Turn aborted after callModel. Hard abort status: ${signalManager.isCurrentInterruptHard()}.`,
      );

      if (signalManager.isCurrentInterruptHard()) {
        return {
          status: 'stop',
          terminateReason: timeoutSignal.aborted
            ? AgentTerminateMode.TIMEOUT
            : AgentTerminateMode.ABORTED,
          finalResult: null, // 'run' method will set the final timeout string
        };
      } else {
        // Soft interrupt
        let userInterruptMessage: string | null;

        if (this.runtimeContext.isSubagentInterruptHandled()) {
          debugLogger.log(
            `[Debug] User interrupt already handled: ${this.runtimeContext.getSubagentInterruptUserInput()}`,
          );
          // The UI has already handled the interrupt and collected the user's input.
          userInterruptMessage =
            this.runtimeContext.getSubagentInterruptUserInput();

          // Reset the interrupt state for the next turn.
          this.runtimeContext.setSubagentInterruptHandled(false);
          this.runtimeContext.setSubagentInterruptUserInput(null);
        } else {
          // The UI has not handled the interrupt, so we need to wait for the user's input.
          debugLogger.log(
            `[Debug] Soft interrupt detected. Waiting for user input...`,
          );
          const userInterruptPromise = new Promise<string>((resolve) => {
            this.runtimeContext.setSubagentInterruptResolver(resolve);
          });
          this.runtimeContext.setSubagentInterruptPromise(userInterruptPromise);
          userInterruptMessage = await userInterruptPromise;
          this.runtimeContext.setSubagentInterruptResolver(undefined);
          this.runtimeContext.setSubagentInterruptPromise(undefined);
        }

        if (userInterruptMessage === null) {
          // This can happen if the promise resolves with nothing, though it shouldn't.
          // We'll treat it as a hard abort to be safe.
          return {
            status: 'stop',
            terminateReason: AgentTerminateMode.ABORTED,
            finalResult: null,
          };
        }

        debugLogger.log(
          `[Debug] User interrupt received: ${userInterruptMessage}`,
        );

        // signalManager.reset();

        return {
          status: 'continue',
          nextMessage: {
            role: 'user',
            parts: [
              {
                text: userInterruptMessage,
              },
            ],
          },
        };
      }
    }

    // If the model stops calling tools without calling complete_task, it's an error.
    if (functionCalls.length === 0) {
      this.emitActivity('ERROR', {
        error: `Agent stopped calling tools but did not call '${TASK_COMPLETE_TOOL_NAME}' to finalize the session.`,
        context: 'protocol_violation',
      });
      return {
        status: 'stop',
        terminateReason: AgentTerminateMode.ERROR_NO_COMPLETE_TASK_CALL,
        finalResult: null,
      };
    }

    const { nextMessage, submittedOutput, taskCompleted } =
      await this.processFunctionCalls(functionCalls, turnSignal, promptId);

    if (taskCompleted) {
      let finalResult = submittedOutput ?? 'Task completed successfully.';

      // Remove the complete_task tool call from the final result.
      // This condition is only hit if outputConfig is not set (subagent
      // doesn't have structured response/json/schema).
      if (submittedOutput === 'Task completed successfully.') {
        finalResult = textResponse
          .replace('```json\n{"name": "complete_task"}\n```', '')
          .trim();
      }

      return {
        status: 'stop',
        terminateReason: AgentTerminateMode.GOAL,
        finalResult,
      };
    }

    // debugLogger.log(
    //   `[Executor] Next message: ${JSON.stringify(nextMessage, null, 2)}`,
    // );

    // Task is not complete, continue to the next turn.
    return {
      status: 'continue',
      nextMessage,
    };
  }

  /**
   * Generates a specific warning message for the agent's final turn.
   */
  private getFinalWarningMessage(
    reason:
      | AgentTerminateMode.TIMEOUT
      | AgentTerminateMode.MAX_TURNS
      | AgentTerminateMode.ERROR_NO_COMPLETE_TASK_CALL,
  ): string {
    let explanation = '';
    switch (reason) {
      case AgentTerminateMode.TIMEOUT:
        explanation = 'You have exceeded the time limit.';
        break;
      case AgentTerminateMode.MAX_TURNS:
        explanation = 'You have exceeded the maximum number of turns.';
        break;
      case AgentTerminateMode.ERROR_NO_COMPLETE_TASK_CALL:
        explanation = 'You have stopped calling tools without finishing.';
        break;
      default:
        throw new Error(`Unknown terminate reason: ${reason}`);
    }
    return `${explanation} You have one final chance to complete the task with a short grace period. You MUST call \`${TASK_COMPLETE_TOOL_NAME}\` immediately with your best answer and explain that your investigation was interrupted. Do not call any other tools.`;
  }

  /**
   * Attempts a single, final recovery turn if the agent stops for a recoverable reason.
   * Gives the agent a grace period to call `complete_task`.
   *
   * @returns The final result string if recovery was successful, or `null` if it failed.
   */
  private async executeFinalWarningTurn(
    chat: GeminiChat | OllamaChat,
    tools: FunctionDeclaration[],
    turnCounter: number,
    reason:
      | AgentTerminateMode.TIMEOUT
      | AgentTerminateMode.MAX_TURNS
      | AgentTerminateMode.ERROR_NO_COMPLETE_TASK_CALL,
    turnSignal: AbortSignal,
  ): Promise<string | null> {
    this.emitActivity('THOUGHT_CHUNK', {
      text: `Execution limit reached (${reason}). Attempting one final recovery turn with a grace period.`,
    });

    const recoveryStartTime = Date.now();
    let success = false;

    const gracePeriodMs = GRACE_PERIOD_MS;
    const graceTimeoutController = new AbortController();
    const graceTimeoutId = setTimeout(
      () => graceTimeoutController.abort(new Error('Grace period timed out.')),
      gracePeriodMs,
    );

    try {
      const recoveryMessage: GeminiContent = {
        role: 'user',
        parts: [{ text: this.getFinalWarningMessage(reason) }],
      };

      // We monitor both the external signal and our new grace period timeout
      const combinedSignal = AbortSignal.any([
        turnSignal,
        graceTimeoutController.signal,
      ]);

      const turnResult = await this.executeTurn(
        chat,
        recoveryMessage,
        tools,
        turnCounter, // This will be the "last" turn number
        combinedSignal,
        graceTimeoutController.signal, // Pass grace signal to identify a *grace* timeout
      );

      if (
        turnResult.status === 'stop' &&
        turnResult.terminateReason === AgentTerminateMode.GOAL
      ) {
        // Success!
        this.emitActivity('THOUGHT_CHUNK', {
          text: 'Graceful recovery succeeded.',
        });
        success = true;
        return turnResult.finalResult ?? 'Task completed during grace period.';
      }

      // Any other outcome (continue, error, non-GOAL stop) is a failure.
      this.emitActivity('ERROR', {
        error: `Graceful recovery attempt failed. Reason: ${turnResult.status}`,
        context: 'recovery_turn',
      });
      return null;
    } catch (error) {
      // This catch block will likely catch the 'Grace period timed out' error.
      this.emitActivity('ERROR', {
        error: `Graceful recovery attempt failed: ${String(error)}`,
        context: 'recovery_turn',
      });
      return null;
    } finally {
      clearTimeout(graceTimeoutId);
      logRecoveryAttempt(
        this.runtimeContext,
        new RecoveryAttemptEvent(
          this.agentId,
          this.definition.name,
          reason,
          Date.now() - recoveryStartTime,
          success,
          turnCounter,
        ),
      );
    }
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

    const { max_time_minutes } = this.definition.runConfig;
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(
      () => timeoutController.abort(new Error('Agent timed out.')),
      max_time_minutes * 60 * 1000,
    );

    logAgentStart(
      this.runtimeContext,
      new AgentStartEvent(this.agentId, this.definition.name),
    );

    let chat: GeminiChat | OllamaChat | undefined;
    let tools: FunctionDeclaration[] | undefined;
    try {
      signalManager.startAgentSession();
      chat = await this.createChatObject(inputs);
      tools = this.prepareToolsList();
      const query = this.definition.promptConfig.query
        ? templateString(this.definition.promptConfig.query, inputs)
        : 'Get Started!';
      let currentMessage: GeminiContent = {
        role: 'user',
        parts: [{ text: query }],
      };

      while (true) {
        debugLogger.log(
          `[AgentExecutor] Starting turn ${turnCounter} for agent ${this.agentId}`,
        );
        // Get the current signal for this turn. It might have been reset.
        const turnAbortController = new AbortController();
        signalManager.setCurrentTurnController(turnAbortController);

        // Combine the per-turn signal with the overall timeout signal.
        const combinedSignal = AbortSignal.any([
          turnAbortController.signal,
          timeoutController.signal,
        ]);

        // Check for termination conditions like max turns.
        const reason = this.checkTermination(startTime, turnCounter);
        if (reason) {
          terminateReason = reason;
          break;
        }

        const turnResult = await this.executeTurn(
          chat,
          currentMessage,
          tools,
          turnCounter++,
          combinedSignal,
          timeoutController.signal,
        );

        if (turnResult.status === 'stop') {
          terminateReason = turnResult.terminateReason;

          // Only set finalResult if the turn provided one (e.g., error or goal).
          if (turnResult.finalResult) {
            finalResult = turnResult.finalResult;
          }
          break; // Exit the loop for *any* other stop reason.
        } else {
          // If status is 'continue', update message for the next loop
          currentMessage = turnResult.nextMessage;
        }
      }

      // === UNIFIED RECOVERY BLOCK ===
      // Only attempt recovery if it's a known recoverable reason.
      // We don't recover from GOAL (already done) or ABORTED (user cancelled).
      if (
        terminateReason !== AgentTerminateMode.ERROR &&
        terminateReason !== AgentTerminateMode.ABORTED &&
        terminateReason !== AgentTerminateMode.GOAL
      ) {
        // Get the current signal for this turn. It might have been reset.
        const turnAbortController = new AbortController();

        const recoveryResult = await this.executeFinalWarningTurn(
          chat,
          tools,
          turnCounter, // Use current turnCounter for the recovery attempt
          terminateReason,
          turnAbortController.signal, // Pass the turn signal
        );

        if (recoveryResult !== null) {
          // Recovery Succeeded
          terminateReason = AgentTerminateMode.GOAL;
          finalResult = recoveryResult;
        } else {
          // Recovery Failed. Set the final error message based on the *original* reason.
          if (terminateReason === AgentTerminateMode.TIMEOUT) {
            finalResult = `Agent timed out after ${this.definition.runConfig.max_time_minutes} minutes.`;
            this.emitActivity('ERROR', {
              error: finalResult,
              context: 'timeout',
            });
          } else if (terminateReason === AgentTerminateMode.MAX_TURNS) {
            finalResult = `Agent reached max turns limit (${this.definition.runConfig.max_turns}).`;
            this.emitActivity('ERROR', {
              error: finalResult,
              context: 'max_turns',
            });
          } else if (
            terminateReason === AgentTerminateMode.ERROR_NO_COMPLETE_TASK_CALL
          ) {
            // The finalResult was already set by executeTurn, but we re-emit just in case.
            finalResult =
              finalResult ||
              `Agent stopped calling tools but did not call '${TASK_COMPLETE_TOOL_NAME}'.`;
            this.emitActivity('ERROR', {
              error: finalResult,
              context: 'protocol_violation',
            });
          }
        }
      }

      // === FINAL RETURN LOGIC ===
      if (terminateReason === AgentTerminateMode.GOAL) {
        return {
          result: finalResult || 'Task completed.',
          terminate_reason: terminateReason,
        };
      }

      debugLogger.log(
        `[AgentExecutor] Final termination reason: ${terminateReason}`,
      );

      return {
        result:
          finalResult || 'Agent execution was terminated before completion.',
        terminate_reason: terminateReason,
      };
    } catch (error) {
      debugLogger.log(
        '[AgentExecutor] Caught error in run(): ' + String(error),
      );
      // Check if the error is an AbortError. This will now catch both the
      // master timeout and the turn-specific aborts.
      if (error instanceof Error && error.name === 'AbortError') {
        // If the timeout controller was the one that aborted, it's a timeout.
        if (timeoutController.signal.aborted) {
          terminateReason = AgentTerminateMode.TIMEOUT;
          // Also use the unified recovery logic here
          if (chat && tools) {
            // Get the current signal for this turn. It might have been reset.
            const turnAbortController = new AbortController();

            const recoveryResult = await this.executeFinalWarningTurn(
              chat,
              tools,
              turnCounter, // Use current turnCounter
              AgentTerminateMode.TIMEOUT,
              turnAbortController.signal,
            );

            if (recoveryResult !== null) {
              // Recovery Succeeded
              terminateReason = AgentTerminateMode.GOAL;
              finalResult = recoveryResult;
              return {
                result: finalResult,
                terminate_reason: terminateReason,
              };
            }
          }
          // Recovery failed or wasn't possible
          finalResult = `Agent timed out after ${this.definition.runConfig.max_time_minutes} minutes.`;
          this.emitActivity('ERROR', {
            error: finalResult,
            context: 'timeout',
          });
          return {
            result: finalResult,
            terminate_reason: terminateReason,
          };
        } else {
          // Otherwise, it was an abort from the per-turn signal. We re-throw
          // to let the SubagentInvocation handle it as an interruption.
          throw error;
        }
      }

      this.emitActivity('ERROR', { error: String(error) });
      throw error; // Re-throw other errors.
    } finally {
      clearTimeout(timeoutId);
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
      signalManager.endAgentSession();
    }
  }

  private async tryCompressChat(
    chat: GeminiChat,
    prompt_id: string,
  ): Promise<void> {
    const model = this.definition.modelConfig.model;

    const { newHistory, info } = await this.compressionService.compress(
      chat,
      prompt_id,
      false,
      model,
      this.runtimeContext,
      this.hasFailedCompressionAttempt,
    );

    if (
      info.compressionStatus ===
      CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT
    ) {
      this.hasFailedCompressionAttempt = true;
    } else if (info.compressionStatus === CompressionStatus.COMPRESSED) {
      if (newHistory) {
        chat.setHistory(newHistory);
        this.hasFailedCompressionAttempt = false;
      }
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
    // const strippedText = extractValidJson(text);
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
        // debugLogger.log(
        //   `[Debug] Parsed Ollama tool calls from JSON: ${JSON.stringify(
        //     functionCalls,
        //   )}`,
        // );
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
      if (signal.aborted) {
        debugLogger.log(
          '[Debug] Signal aborted, breaking Ollama response stream.',
        );
        break;
      }

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

    await fs.writeFile(
      `${this.definition.name}_prompt.txt`,
      systemInstruction ?? '',
    );
    debugLogger.log(
      `[DEBUG] System Instruction saved to ${this.definition.name}_prompt.txt`,
    );

    // debugLogger.log(
    //   `[AgentExecutor] Created system instruction: ${systemInstruction}`,
    // );

    if ('host' in modelConfig) {
      const populatedPromptConfig: PromptConfig = {
        ...promptConfig,
        systemPrompt: systemInstruction ?? '',
        directive: this.definition.promptConfig.directive,
        query: this.definition.promptConfig.query
          ? templateString(this.definition.promptConfig.query, inputs)
          : 'Get Started!',
      };
      return new OllamaChat(
        modelConfig as OllamaModelConfig,
        systemInstruction,
        startHistory,
        populatedPromptConfig,
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
        const outputUpdateHandler = (
          toolCallId: string,
          outputChunk: string | AnsiOutput,
        ) => {
          let text = '';
          if (typeof outputChunk === 'string') {
            text = outputChunk;
          } else {
            for (const line of outputChunk) {
              for (const token of line) {
                text += token.text;
              }
              text += '\n';
            }
          }
          // debugLogger.log(
          //   `[AgentExecutor] Tool output chunk from ${toolCallId}: ${text}`,
          // );
          this.emitActivity('TOOL_OUTPUT_CHUNK', {
            toolCallId,
            text,
          });
        };

        debugLogger.log(
          `[AgentExecutor] Executing tool call: ${functionCall.name} (ID: ${callId})`,
        );

        const { response: toolResponse } = await executeToolCall(
          this.runtimeContext,
          requestInfo,
          signal,
          outputUpdateHandler,
        );

        debugLogger.log(
          `[AgentExecutor] Tool call completed: ${functionCall.name} (ID: ${callId})`,
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

        const toolResponsePartsToReturn: GeminiPart[] =
          toolResponse.responseParts;

        // Apply summarization if enabled and content is present
        if (this.definition.runConfig.summarizeToolOutput) {
          const summary = await this.summarizationService.summarize(
            toolResponse.responseParts,
            this.definition.modelConfig,
          );
          if (summary) {
            debugLogger.log(
              `[AgentExecutor] Summarized output for tool: ${functionCall.name} (ID: ${callId})`,
            );
            for (const part of toolResponsePartsToReturn) {
              if ('functionResponse' in part && part.functionResponse) {
                // This is a bit awkward, but `response` is just `object`
                // in the type, so we have to cast.
                const responseObject = part.functionResponse.response as {
                  llmContent?: unknown;
                };
                if (responseObject.llmContent) {
                  responseObject.llmContent = summary;
                  break; // Assume only one functionResponse part
                }
              }
            }
          }
        }

        return toolResponsePartsToReturn;
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
    };

    if (outputConfig) {
      const jsonSchema = zodToJsonSchema(outputConfig.schema);
      const {
        $schema: _$schema,
        definitions: _definitions,
        ...schema
      } = jsonSchema;
      completeTool.parameters = {
        type: Type.OBJECT,
        properties: {
          [outputConfig.outputName]: schema as Schema,
        },
        required: [outputConfig.outputName],
      };
    }

    // Gemma subagent will response in fully formatted text instead of json.
    toolsList.push(completeTool);

    return toolsList;
  }

  /**
   * Formats tool declarations for Gemma's function calling format.
   * This involves removing descriptions from parameters and converting
   * `parametersJsonSchema` to `parameters`.
   */
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

  /** Builds the system prompt from the agent definition and inputs. */
  private async buildSystemPrompt(inputs: AgentInputs): Promise<string> {
    const { promptConfig } = this.definition;
    if (!promptConfig.systemPrompt) {
      return '';
    }

    const templateInputs: Record<string, unknown> = { ...inputs };

    if (promptConfig.directive) {
      templateInputs['directive'] = promptConfig.directive;
    }

    if (promptConfig.systemPrompt.includes('${tool_code}')) {
      const tools = this.prepareToolsList();
      const toolCode = this._prepareGemmaToolCode(tools);
      templateInputs['tool_code'] = toolCode;
    }

    debugLogger.log(
      '[AgentExecutor] Preparing system prompt with template inputs: ',
      templateInputs,
    );

    // TODO: verify this reminder works with tool call injection.
    if (
      promptConfig.reminder &&
      promptConfig.reminder.includes('${tool_code}')
    ) {
      debugLogger.log(
        '[AgentExecutor] Preparing tool code for reminder template.',
      );
      const reminderTemplateInputs: Record<string, unknown> = {};
      const tools = this.prepareToolsList();
      const toolCode = this._prepareGemmaToolCode(tools);
      reminderTemplateInputs['tool_code'] = toolCode;
      promptConfig.reminder = templateString(
        promptConfig.reminder,
        reminderTemplateInputs,
      );
    }

    // Inject user inputs and tool code (if applicable) into the prompt template.
    let finalPrompt = templateString(promptConfig.systemPrompt, templateInputs);

    // Append environment context (CWD and folder structure).
    const dirContext = await getDirectoryContextString(
      this.runtimeContext,
      this.definition.modelConfig.model,
    );
    finalPrompt += `\n\n# Environment Context\n${dirContext}`;

    // Append standard rules for non-interactive execution.
    finalPrompt += `
Important Rules:
* You are running in a non-interactive mode. You CANNOT ask the user for input or clarification.
* Work systematically using available tools to complete your task.
* Always use absolute paths for file operations. Construct them using the provided "Environment Context".`;

    finalPrompt += `
    * When you have completed your task, you MUST call the \`${TASK_COMPLETE_TOOL_NAME}\` tool.
    * Do not call any other tools in the same turn as \`${TASK_COMPLETE_TOOL_NAME}\`.
    * This is the ONLY way to complete your mission. If you stop calling tools without calling this, you have failed.`;

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
      SHELL_TOOL_NAME,
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
