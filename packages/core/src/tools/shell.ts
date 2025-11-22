/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import os, { EOL } from 'node:os';
import crypto from 'node:crypto';
import type { Config } from '../config/config.js';
import { debugLogger, type AnyToolInvocation } from '../index.js';
import { ToolErrorType } from './tool-error.js';
import type {
  ToolInvocation,
  ToolResult,
  ToolCallConfirmationDetails,
  ToolExecuteConfirmationDetails,
} from './tools.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  ToolConfirmationOutcome,
  Kind,
} from './tools.js';
import { ApprovalMode } from '../policy/types.js';

import { getErrorMessage } from '../utils/errors.js';
// import { summarizeToolOutput } from '../utils/summarizer.js';
import type {
  ShellExecutionConfig,
  ShellOutputEvent,
} from '../services/shellExecutionService.js';
import { ShellExecutionService } from '../services/shellExecutionService.js';
import { formatMemoryUsage } from '../utils/formatters.js';
import type { AnsiOutput } from '../utils/terminalSerializer.js';
import {
  getCommandRoots,
  initializeShellParsers,
  isCommandAllowed,
  isShellInvocationAllowlisted,
  stripShellWrapper,
} from '../utils/shell-utils.js';

import { SHELL_TOOL_NAME } from './tool-names.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
// import { debugLogger } from '../utils/debugLogger.js';

export const OUTPUT_UPDATE_INTERVAL_MS = 1000;

/**
 * Cleans terminal output text by:
 * 1. Replacing escaped newlines (`\n`) with actual newlines.
 * 2. Removing all pipe characters (`│`).
 * 3. Trimming leading/trailing whitespace from each line.
 * 4. Collapsing all consecutive whitespace within each line into a single space.
 *
 * @param text The raw output string from the log.
 * @returns The cleaned and formatted log text.
 */
function stripPtyFrame(text: string): string {
  // Step 1: Replace the escaped newlines ('\n') with actual newlines ('\n').
  // This correctly separates the log lines that are currently on the same string line.
  let lines = text.replace(/\\n/g, '\n');

  // Step 2: Split the text into individual lines and process them.
  lines = lines
    .split('\n')
    .map((line) => {
      // Remove the pipe character ('│').
      let cleanedLine = line.replace(/│/g, '');

      // Trim leading and trailing whitespace from the line.
      // This removes the line-start padding and the large amount of padding spaces.
      cleanedLine = cleanedLine.trim();

      // Collapse all sequences of one or more whitespace characters (spaces, tabs, etc.)
      // into a single space. This fulfills the request to "remove all the consecutive whitespaces"
      // and is essential for cleaning up the huge padding columns in the middle.
      cleanedLine = cleanedLine.replace(/\s+/g, ' ');

      return cleanedLine;
    })
    // Step 3: Filter out any lines that became empty after trimming and processing.
    .filter((line) => line.length > 0)
    // Step 4: Join the clean lines back together with a proper newline character.
    .join('\n');

  return lines;
}

export interface ShellToolParams {
  command: string;
  description?: string;
  dir_path?: string;
}

export class ShellToolInvocation extends BaseToolInvocation<
  ShellToolParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: ShellToolParams,
    private readonly allowlist: Set<string>,
    messageBus?: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, messageBus, _toolName, _toolDisplayName);
  }

  getDescription(): string {
    let description = `${this.params.command}`;
    // append optional [in directory]
    // note description is needed even if validation fails due to absolute path
    if (this.params.dir_path) {
      description += ` [in ${this.params.dir_path}]`;
    } else {
      description += ` [current working directory ${process.cwd()}]`;
    }
    // append optional (description), replacing any line breaks with spaces
    if (this.params.description) {
      description += ` (${this.params.description.replace(/\n/g, ' ')})`;
    }
    return description;
  }

  protected override async getConfirmationDetails(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    const command = stripShellWrapper(this.params.command);
    const rootCommands = [...new Set(getCommandRoots(command))];

    // In non-interactive mode, we need to prevent the tool from hanging while
    // waiting for user input. If a tool is not fully allowed (e.g. via
    // --allowed-tools="ShellTool(wc)"), we should throw an error instead of
    // prompting for confirmation. This check is skipped in YOLO mode.
    if (
      !this.config.isInteractive() &&
      this.config.getApprovalMode() !== ApprovalMode.YOLO
    ) {
      if (this.isInvocationAllowlisted(command)) {
        // If it's an allowed shell command, we don't need to confirm execution.
        return false;
      }

      throw new Error(
        `Command "${command}" is not in the list of allowed tools for non-interactive mode.`,
      );
    }

    const commandsToConfirm = rootCommands.filter(
      (command) => !this.allowlist.has(command),
    );

    if (commandsToConfirm.length === 0) {
      return false; // already approved and allowlisted
    }

    const confirmationDetails: ToolExecuteConfirmationDetails = {
      type: 'exec',
      title: 'Confirm Shell Command',
      command: this.params.command,
      rootCommand: commandsToConfirm.join(', '),
      onConfirm: async (outcome: ToolConfirmationOutcome) => {
        if (outcome === ToolConfirmationOutcome.ProceedAlways) {
          commandsToConfirm.forEach((command) => this.allowlist.add(command));
        }
      },
    };
    return confirmationDetails;
  }

  async execute(
    signal: AbortSignal,
    updateOutput?: (output: string | AnsiOutput) => void,
    shellExecutionConfig?: ShellExecutionConfig,
    setPidCallback?: (pid: number) => void,
  ): Promise<ToolResult> {
    const strippedCommand = stripShellWrapper(this.params.command);

    if (signal.aborted) {
      debugLogger.log('[ShellToolInvocation] Execution aborted before start.');
      return {
        llmContent: 'Command was cancelled by user before it could start.',
        returnDisplay: 'Command cancelled by user.',
      };
    }

    const isWindows = os.platform() === 'win32';
    const tempFileName = `shell_pgrep_${crypto
      .randomBytes(6)
      .toString('hex')}.tmp`;
    const tempFilePath = path.join(os.tmpdir(), tempFileName);

    try {
      // pgrep is not available on Windows, so we can't get background PIDs
      const commandToExecute = isWindows
        ? strippedCommand
        : (() => {
            // wrap command to append subprocess pids (via pgrep) to temporary file
            let command = strippedCommand.trim();
            if (!command.endsWith('&')) command += ';';
            return `{ ${command} }; __code=$?; pgrep -g 0 >${tempFilePath} 2>&1; exit $__code;`;
          })();

      const cwd = this.params.dir_path
        ? path.resolve(this.config.getTargetDir(), this.params.dir_path)
        : this.config.getTargetDir();

      let cumulativeOutput: string | AnsiOutput = '';
      let lastUpdateTime = Date.now();
      let isBinaryStream = false;

      const { result: resultPromise, pid } =
        await ShellExecutionService.execute(
          commandToExecute,
          cwd,
          (event: ShellOutputEvent) => {
            if (!updateOutput) {
              return;
            }

            let shouldUpdate = false;

            switch (event.type) {
              case 'data':
                if (isBinaryStream) break;
                cumulativeOutput = event.chunk;
                shouldUpdate = true;
                break;
              case 'binary_detected':
                isBinaryStream = true;
                cumulativeOutput =
                  '[Binary output detected. Halting stream...]';
                shouldUpdate = true;
                break;
              case 'binary_progress':
                isBinaryStream = true;
                cumulativeOutput = `[Receiving binary output... ${formatMemoryUsage(
                  event.bytesReceived,
                )} received]`;
                if (Date.now() - lastUpdateTime > OUTPUT_UPDATE_INTERVAL_MS) {
                  shouldUpdate = true;
                }
                break;
              default: {
                throw new Error('An unhandled ShellOutputEvent was found.');
              }
            }

            if (shouldUpdate) {
              updateOutput(cumulativeOutput);
              lastUpdateTime = Date.now();
            }
          },
          signal,
          this.config.getEnableInteractiveShell(),
          shellExecutionConfig ?? {},
        );

      if (pid && setPidCallback) {
        setPidCallback(pid);
      }

      const result = await resultPromise;

      // TODO: formatted output doesn't jitter.
      //       result.output = `
      //       > @google/gemini-cli@0.12.0-nightly.20251022.0542de95 test
      // > npm run test --workspaces --if-present --parallel src/tools/glob.test.ts
      // > @google/gemini-cli-a2a-server@0.12.0-nightly.20251022.0542de95 test
      // > vitest run src/tools/glob.test.ts
      // RUN v3.2.4 /Users/siddharthdiwan/Desktop/gemini-cli-gemma/packages/a2a-server
      // Coverage enabled with v8
      // No test files found, exiting with code 1
      // filter: src/tools/glob.test.ts
      // include: **/*.{test,spec}.?(c|m)[jt]s?(x)
      // exclude: **/node_modules/**, **/dist/**
      // JUNIT report written to /Users/siddharthdiwan/Desktop/gemini-cli-gemma/packages/a2a-server/junit.xml
      // % Coverage report from v8
      // npm error Lifecycle script  failed with error:
      // npm error code 1
      // npm error path /Users/siddharthdiwan/Desktop/gemini-cli-gemma/packages/a2a-server
      // npm error workspace @google/gemini-cli-a2a-server@0.12.0-nightly.20251022.0542de95
      // npm error location /Users/siddharthdiwan/Desktop/gemini-cli-gemma/packages/a2a-server
      // npm error command failed
      // npm error command sh -c vitest run src/tools/glob.test.ts
      // > @google/gemini-cli@0.12.0-nightly.20251022.0542de95 test
      // > vitest run src/tools/glob.test.ts
      // RUN v3.2.4 /Users/siddharthdiwan/Desktop/gemini-cli-gemma/packages/cli
      // Coverage enabled with v8
      // No test files found, exiting with code 1
      // filter: src/tools/glob.test.ts
      // include: **/*.{test,spec}.?(c|m)[jt]s?(x), config.test.ts
      // exclude: **/node_modules/**, **/dist/**, **/cypress/**
      // JUNIT report written to /Users/siddharthdiwan/Desktop/gemini-cli-gemma/packages/cli/junit.xml
      // % Coverage report from v8
      // npm error Lifecycle script  failed with error:
      // npm error code 1
      // npm error path /Users/siddharthdiwan/Desktop/gemini-cli-gemma/packages/cli
      // npm error workspace @google/gemini-cli@0.12.0-nightly.20251022.0542de95
      // npm error location /Users/siddharthdiwan/Desktop/gemini-cli-gemma/packages/cli
      // npm error command failed
      // npm error command sh -c vitest run src/tools/glob.test.ts
      // > @google/gemini-cli-core@0.12.0-nightly.20251022.0542de95 test
      // > vitest run src/tools/glob.test.ts
      // RUN v3.2.4 /Users/siddharthdiwan/Desktop/gemini-cli-gemma/packages/core
      // Coverage enabled with v8
      // (node:29205) MaxListenersExceededWarning: Possible EventTarget memory leak detected. 11 abort listeners added to [AbortSignal]. MaxListeners is 10.
      // Use event
      // s.setMaxListeners() to increase limit
      // (Use  to show where the warning was created)
      // ✓ src/tools/glob.test.ts (38 tests) 1794ms
      // ✓ GlobTool > execute > should find files matching a simple pattern in the root 75ms
      // ✓ GlobTool > execute > should find files case-sensitively when case_sensitive is true 56ms
      // ✓ GlobTool > execute > should find files case-insensitively by default (pattern: *.TXT) 57ms
      // ✓ GlobTool > execute > should find files case-insensitively when case_sensitive is false (pattern: *.TXT) 55ms
      // ✓ GlobTool > execute > should find files using a pattern that includes a subdirectory 56ms
      // ✓ GlobTool > execute > should find files in a specified relative path (relative to rootDir) 56ms
      // ✓ GlobTool > execute > should find files using a deep globstar pattern (e.g., **/*.log) 58ms
      // ✓ GlobTool > execute > should return "No files found" message when pattern matches nothing 56ms
      // ✓ GlobTool > execute > should find files with special characters in the name 57ms
      // ✓ GlobTool > execute > should find files with special characters like [] and () in the path 59ms
      // ✓ GlobTool > execute > should correctly sort files by modification time (newest first) 59ms
      // ✓ GlobTool > execute > should return a PATH_NOT_IN_WORKSPACE error if path is outside workspace 55ms
      // ✓ GlobTool > execute > should return a GLOB_EXECUTION_ERROR on glob failure 59ms
      // ✓ GlobTool > validateToolParams > should return null for valid parameters (pattern only) 56ms
      // ✓ GlobTool > validateToolParams > should return null for valid parameters (pattern and path) 57ms
      // ✓ GlobTool > validateToolParams > should return null for valid parameters (pattern, path, and case_sensitive) 55ms
      // ✓ GlobTool > validateToolParams > should return error if pattern is missing (schema validation) 56ms
      // ✓ GlobTool > validateToolParams > should return error if pattern is an empty string 56ms
      // ✓ GlobTool > validateToolParams > should return error if pattern is only whitespace 56ms
      // ✓ GlobTool > validateToolParams > should return error if path is provided but is not a string (schema validation) 57ms
      // ✓ GlobTool > validateToolParams > should return error if case_sensitive is provided but is not a boolean (schema validation) 56ms
      // ✓ GlobTool > validateToolParams > should return error if search path resolves outside the tool's root directory 56ms
      // ✓ GlobTool > validateToolParams > should return error if specified search path does not exist 55ms
      // ✓ GlobTool > validateToolParams > should return error if specified search path is a file, not a directory 56ms
      // ✓ GlobTool > workspace boundary validation > should validate search paths are within workspace boundaries 56ms
      // ✓ GlobTool > workspace boundary validation > should provide clear error messages when path is outside workspace 57ms
      // ✓ GlobTool > workspace boundary validation > should work with paths in workspace subdirectories 56ms
      // ✓ GlobTool > ignore file handling > should respect .gitignore files by default 61ms
      // ✓ GlobTool > ignore file handling > should respect .geminiignore files by default 72ms
      // ✓ GlobTool > ignore file handling > should not respect .gitignore when respect_git_ignore is false 58ms
      // ✓ GlobTool > ignore file handling > should not respect .geminiignore when respect_gemini_ignore is false 57ms
      // ✓ sortFileEntries > should sort a mix of recent and older files correctly 1ms
      // ✓ sortFileEntries > should sort only recent files by mtime descending 0ms
      // ✓ sortFileEntries > should sort only older files alphabetically by path 0ms
      // ✓ sortFileEntries > should handle an empty array 0ms
      // ✓ sortFileEntries > should correctly sort files when mtimes are identical for older files 0ms
      // ✓ sortFileEntries > should correctly sort files when mtimes are identical for recent files (maintaining mtime sort) 0ms
      //       `;

      // debugLogger.log(`[Debug] ShellToolInvocation result: ${result.output}`);
      result.output = stripPtyFrame(result.output);
      // debugLogger.log(
      //   `[Debug] ShellToolInvocation stripped output: ${result.output}`,
      // );

      const backgroundPIDs: number[] = [];
      if (os.platform() !== 'win32') {
        if (fs.existsSync(tempFilePath)) {
          const pgrepLines = fs
            .readFileSync(tempFilePath, 'utf8')
            .split(EOL)
            .filter(Boolean);
          for (const line of pgrepLines) {
            if (!/^\d+$/.test(line)) {
              debugLogger.error(`pgrep: ${line}`);
            }
            const pid = Number(line);
            if (pid !== result.pid) {
              backgroundPIDs.push(pid);
            }
          }
        } else {
          if (!signal.aborted) {
            debugLogger.error('missing pgrep output');
          }
        }
      }

      let llmContent = '';
      if (result.aborted) {
        llmContent = 'Command was cancelled by user before it could complete.';
        if (result.output.trim()) {
          llmContent += ` Below is the output before it was cancelled:\n${result.output}`;
        } else {
          llmContent += ' There was no output before it was cancelled.';
        }
      } else {
        // Create a formatted error string for display, replacing the wrapper command
        // with the user-facing command.
        const finalError = result.error
          ? result.error.message.replace(commandToExecute, this.params.command)
          : '(none)';

        llmContent = [
          `Command: ${this.params.command}`,
          `Directory: ${this.params.dir_path || '(root)'}`,
          `Output: ${result.output || '(empty)'}`,
          `Error: ${finalError}`, // Use the cleaned error string.
          `Exit Code: ${result.exitCode ?? '(none)'}`,
          `Signal: ${result.signal ?? '(none)'}`,
          `Background PIDs: ${
            backgroundPIDs.length ? backgroundPIDs.join(', ') : '(none)'
          }`,
          `Process Group PGID: ${result.pid ?? '(none)'}`,
        ].join('\n');
      }

      let returnDisplayMessage = '';
      if (this.config.getDebugMode()) {
        returnDisplayMessage = llmContent;
      } else {
        if (result.output.trim()) {
          returnDisplayMessage = result.output;
        } else {
          if (result.aborted) {
            returnDisplayMessage = 'Command cancelled by user.';
          } else if (result.signal) {
            returnDisplayMessage = `Command terminated by signal: ${result.signal}`;
          } else if (result.error) {
            returnDisplayMessage = `Command failed: ${getErrorMessage(
              result.error,
            )}`;
          } else if (result.exitCode !== null && result.exitCode !== 0) {
            returnDisplayMessage = `Command exited with code: ${result.exitCode}`;
          }
          // If output is empty and command succeeded (code 0, no error/signal/abort),
          // returnDisplayMessage will remain empty, which is fine.
        }
      }

      // const summarizeConfig = this.config.getSummarizeToolOutputConfig();
      const executionError = result.error
        ? {
            error: {
              message: result.error.message,
              type: ToolErrorType.SHELL_EXECUTE_ERROR,
            },
          }
        : {};
      //       if (summarizeConfig && summarizeConfig[SHELL_TOOL_NAME]) {
      //         const summary = await summarizeToolOutput(
      //           this.config,
      //           { model: 'summarizer-shell' },
      //           llmContent,
      //           this.config.getGeminiClient(),
      //           signal,
      //         );
      //         return {
      //           llmContent: summary,
      //           returnDisplay: returnDisplayMessage,
      //           ...executionError,
      //         };
      //       }

      debugLogger.log(`[ShellToolInvocation] Execution completed.`);

      return {
        llmContent,
        returnDisplay: returnDisplayMessage,
        ...executionError,
      };
    } finally {
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    }
  }

  private isInvocationAllowlisted(command: string): boolean {
    const allowedTools = this.config.getAllowedTools() || [];
    if (allowedTools.length === 0) {
      return false;
    }

    const invocation = { params: { command } } as unknown as AnyToolInvocation;
    return isShellInvocationAllowlisted(invocation, allowedTools);
  }
}

function getShellToolDescription(): string {
  const returnedInfo = `

      The following information is returned:

      Command: Executed command.
      Directory: Directory where command was executed, or \`(root)\`.
      Stdout: Output on stdout stream. Can be \`(empty)\` or partial on error and for any unwaited background processes.
      Stderr: Output on stderr stream. Can be \`(empty)\` or partial on error and for any unwaited background processes.
      Error: Error or \`(none)\` if no error was reported for the subprocess.
      Exit Code: Exit code or \`(none)\` if terminated by signal.
      Signal: Signal number or \`(none)\` if no signal was received.
      Background PIDs: List of background processes started or \`(none)\`.
      Process Group PGID: Process group started or \`(none)\``;

  if (os.platform() === 'win32') {
    return `This tool executes a given shell command as \`powershell.exe -NoProfile -Command <command>\`. Command can start background processes using PowerShell constructs such as \`Start-Process -NoNewWindow\` or \`Start-Job\`.${returnedInfo}`;
  } else {
    return `This tool executes a given shell command as \`bash -c <command>\`. Command can start background processes using \`&\`. Command is executed as a subprocess that leads its own process group. Command process group can be terminated as \`kill -- -PGID\` or signaled as \`kill -s SIGNAL -- -PGID\`.${returnedInfo}`;
  }
}

function getCommandDescription(): string {
  if (os.platform() === 'win32') {
    return 'Exact command to execute as `powershell.exe -NoProfile -Command <command>`';
  } else {
    return 'Exact bash command to execute as `bash -c <command>`';
  }
}

export class ShellTool extends BaseDeclarativeTool<
  ShellToolParams,
  ToolResult
> {
  static readonly Name = SHELL_TOOL_NAME;

  private allowlist: Set<string> = new Set();

  constructor(
    private readonly config: Config,
    messageBus?: MessageBus,
  ) {
    void initializeShellParsers().catch(() => {
      // Errors are surfaced when parsing commands.
    });
    super(
      ShellTool.Name,
      'Shell',
      getShellToolDescription(),
      Kind.Execute,
      {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: getCommandDescription(),
          },
          description: {
            type: 'string',
            description:
              'Brief description of the command for the user. Be specific and concise. Ideally a single sentence. Can be up to 3 sentences for clarity. No line breaks.',
          },
          dir_path: {
            type: 'string',
            description:
              '(OPTIONAL) The path of the directory to run the command in. If not provided, the project root directory is used. Must be a directory within the workspace and must already exist.',
          },
        },
        required: ['command'],
      },
      false, // output is not markdown
      true, // output can be updated
      messageBus,
    );
  }

  protected override validateToolParamValues(
    params: ShellToolParams,
  ): string | null {
    if (!params.command.trim()) {
      return 'Command cannot be empty.';
    }

    const commandCheck = isCommandAllowed(params.command, this.config);
    if (!commandCheck.allowed) {
      if (!commandCheck.reason) {
        debugLogger.error(
          'Unexpected: isCommandAllowed returned false without a reason',
        );
        return `Command is not allowed: ${params.command}`;
      }
      return commandCheck.reason;
    }
    if (getCommandRoots(params.command).length === 0) {
      return 'Could not identify command root to obtain permission from user.';
    }
    if (params.dir_path) {
      const resolvedPath = path.resolve(
        this.config.getTargetDir(),
        params.dir_path,
      );
      const workspaceContext = this.config.getWorkspaceContext();
      if (!workspaceContext.isPathWithinWorkspace(resolvedPath)) {
        return `Directory '${resolvedPath}' is not within any of the registered workspace directories.`;
      }
    }
    return null;
  }

  protected createInvocation(
    params: ShellToolParams,
    messageBus?: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<ShellToolParams, ToolResult> {
    return new ShellToolInvocation(
      this.config,
      params,
      this.allowlist,
      messageBus,
      _toolName,
      _toolDisplayName,
    );
  }
}
