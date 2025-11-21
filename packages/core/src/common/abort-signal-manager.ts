/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { debugLogger } from '../utils/debugLogger.js';

/**
 * A reason for an AbortController to be aborted.
 */

export const SINGLE_INTERRUPT = 'SINGLE_INTERRUPT';
export const DOUBLE_INTERRUPT = 'DOUBLE_INTERRUPT';

interface AgentContext {
  currentTurnController: AbortController | null;
  isHardAbort: boolean;
}

class AbortSignalManager {
  private contextStack: AgentContext[] = [];

  startAgentSession(): void {
    debugLogger.log('[AbortSignalManager]', 'Starting new agent session.');
    this.contextStack.push({
      currentTurnController: null,
      isHardAbort: false,
    });
  }

  endAgentSession(): void {
    debugLogger.log('[AbortSignalManager]', 'Ending current agent session.');
    this.contextStack.pop();
  }

  setCurrentTurnController(controller: AbortController): void {
    debugLogger.log('[AbortSignalManager]', 'Setting current turn controller.');
    const currentContext = this.getCurrentContext();
    if (currentContext) {
      currentContext.currentTurnController = controller;
      currentContext.isHardAbort = false; // Reset for the new turn.
    }
  }

  setHardAbort(isHard: boolean): void {
    const currentContext = this.getCurrentContext();
    if (currentContext) {
      debugLogger.log(
        '[AbortSignalManager]',
        `Setting hard abort status to: ${isHard}`,
      );
      currentContext.isHardAbort = isHard;
    }
  }

  abortCurrent(): void {
    const currentContext = this.getCurrentContext();
    if (!currentContext || !currentContext.currentTurnController) {
      return;
    }

    if (currentContext.isHardAbort) {
      debugLogger.log('[AbortSignalManager]', 'Hard abort detected.');
      currentContext.currentTurnController.abort(DOUBLE_INTERRUPT);
    } else {
      debugLogger.log('[AbortSignalManager]', 'Soft abort detected.');
      currentContext.currentTurnController.abort(SINGLE_INTERRUPT);
    }
  }

  getStackSize(): number {
    return this.contextStack.length;
  }

  isCurrentInterruptHard(): boolean {
    const currentContext = this.getCurrentContext();
    return currentContext ? currentContext.isHardAbort : false;
  }

  private getCurrentContext(): AgentContext | undefined {
    debugLogger.log(
      '[AbortSignalManager]',
      'Retrieving current agent context at position ' +
        this.contextStack.length +
        '.',
    );
    return this.contextStack[this.contextStack.length - 1];
  }
}

export const signalManager = new AbortSignalManager();
