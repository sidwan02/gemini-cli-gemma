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
  // Count interrupts within a single turn.
  interruptCount: number;
}

class AbortSignalManager {
  private contextStack: AgentContext[] = [];

  startAgentSession(): void {
    debugLogger.log('[AbortSignalManager]', 'Starting new agent session.');
    this.contextStack.push({
      currentTurnController: null,
      interruptCount: 0,
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
      currentContext.interruptCount = 0; // Reset for the new turn.
    }
  }

  abortCurrent(): void {
    const currentContext = this.getCurrentContext();
    if (!currentContext || !currentContext.currentTurnController) {
      return;
    }

    currentContext.interruptCount++;

    if (currentContext.interruptCount > 1) {
      debugLogger.log('[AbortSignalManager]', 'Double interrupt detected.');
      // Second Ctrl+C.
      currentContext.currentTurnController.abort(DOUBLE_INTERRUPT);
    } else {
      debugLogger.log('[AbortSignalManager]', 'Single interrupt detected.');
      // First Ctrl+C.
      currentContext.currentTurnController.abort(SINGLE_INTERRUPT);
    }
  }

  getStackSize(): number {
    return this.contextStack.length;
  }

  getCurrentInterruptCount(): number {
    const currentContext = this.getCurrentContext();
    return currentContext ? currentContext.interruptCount : 0;
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
