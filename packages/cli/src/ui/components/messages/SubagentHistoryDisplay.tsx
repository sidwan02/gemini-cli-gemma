/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import type {
  SubagentHistoryItem,
  SubagentToolCallHistoryItem,
  SubagentToolResponseHistoryItem,
  SubagentThoughtHistoryItem,
} from '../../types.js';
import { MarkdownDisplay } from '../../utils/MarkdownDisplay.js';
import { SubagentToolCallDisplay } from './SubagentToolCallDisplay.js';
// import { debugLogger } from '@google/gemini-cli-core';

interface SubagentHistoryDisplayProps {
  history: SubagentHistoryItem[];
  terminalWidth: number;
}

type SubagentTurn = {
  thought?: SubagentThoughtHistoryItem;
  toolCall?: SubagentToolCallHistoryItem;
  toolResponse?: SubagentToolResponseHistoryItem;
  subagentHistory?: SubagentHistoryItem[];
};

type ProcessedHistoryItem = SubagentTurn | SubagentHistoryItem;

function isSubagentTurn(item: ProcessedHistoryItem): item is SubagentTurn {
  return !('type' in item);
}

export const SubagentHistoryDisplay: React.FC<SubagentHistoryDisplayProps> = ({
  history,
  terminalWidth,
}) => {
  // debugLogger.log(
  //   `[SubagentHistoryDisplay] Rendering with latest history: ${JSON.stringify(
  //     history[history.length - 1].data,
  //   )}`,
  // );
  const processedHistory = history.reduce((acc, item) => {
    if (
      item.type === 'start' ||
      item.type === 'error' ||
      item.type === 'interrupted'
    ) {
      const lastItem = acc.at(-1);
      // If the last item was also an interruption, replace it with the current
      // one. This ensures that only the most recent interrupt status (e.g.,
      // "interrupted" vs. "terminated") is displayed.
      if (
        lastItem &&
        'type' in lastItem &&
        lastItem.type === 'interrupted' &&
        item.type === 'interrupted'
      ) {
        acc[acc.length - 1] = item;
      } else {
        acc.push(item);
      }
      return acc;
    }

    let lastTurn = acc[acc.length - 1] as SubagentTurn;

    // Ensure lastItem is a turn, creating one if necessary.
    if (!lastTurn || !isSubagentTurn(lastTurn)) {
      lastTurn = {};
      acc.push(lastTurn);
    }

    switch (item.type) {
      case 'thought':
        if (lastTurn.thought) {
          acc.push({ thought: item });
        } else {
          lastTurn.thought = item;
        }
        break;
      case 'tool_call':
        if (lastTurn.toolCall) {
          acc.push({ toolCall: item });
        } else {
          lastTurn.toolCall = item;
        }
        break;
      // TODO: Shell tool output is very glitchy.
      // TODO: there's a bug when multiple shell tool calls are made in succession (for tool_output_chunk), they get merged into one response.
      case 'tool_response':
        if (lastTurn.toolResponse) {
          acc.push({ toolResponse: item });
        } else {
          lastTurn.toolResponse = item;
        }
        break;
      case 'tool_output_chunk':
        // A tool output chunk should be associated with a tool call.
        // Find the last turn with a tool call.
        if (lastTurn.toolCall) {
          if (lastTurn.toolResponse) {
            // Append to existing toolResponse output
            lastTurn.toolResponse.data.output =
              ((lastTurn.toolResponse.data.output as string) || '') +
              item.data.text;
          } else {
            // First chunk, create the toolResponse
            lastTurn.toolResponse = {
              type: 'tool_response',
              data: {
                name: lastTurn.toolCall.data.name, // Use name from toolCall
                output: item.data.text,
              },
            };
          }
        } else {
          // This case is unexpected. A tool_output_chunk should follow a tool_call.
          // We could log an error here. For now, we can try to handle it gracefully
          // by creating a new turn, but this indicates a logic issue elsewhere.
          // debugLogger.error(
          //   `[SubagentHistoryDisplay] Received TOOL_OUTPUT_CHUNK without a preceding TOOL_CALL.`,
          // );
          // To avoid crashing, we can create a new turn, but this is not ideal.
          acc.push({
            toolResponse: {
              type: 'tool_response',
              data: {
                name: '', // We don't know the name
                output: item.data.text,
              },
            },
          });
        }
        break;
      default:
        // debugLogger.error(`[SubagentHistoryDisplay] Unknown item type.`);
        break;
    }
    return acc;
  }, [] as ProcessedHistoryItem[]);

  // Account for the parent container's borders/padding.
  // '2' is a common value for a single left/right border. You might need to adjust this (e.g., to 4 or more)
  // depending on the parent's actual padding and border setup.
  const availableWidth = terminalWidth - 2;

  return (
    <Box flexDirection="column">
      {processedHistory.map((item, index) => {
        if (isSubagentTurn(item)) {
          // This is a SubagentTurn
          const turn = item;
          return (
            <Box key={index} flexDirection="column" marginBottom={1}>
              {turn.thought && (
                <Box
                  flexDirection="column"
                  marginBottom={1}
                  width={availableWidth}
                >
                  <Text>🤖💭</Text>
                  <MarkdownDisplay
                    text={turn.thought.data.thought}
                    isPending={false}
                    terminalWidth={availableWidth} // Also apply the adjusted width to MarkdownDisplay
                  />
                </Box>
              )}
              {turn.toolCall && (
                <Box width={availableWidth}>
                  <SubagentToolCallDisplay
                    toolCall={turn.toolCall}
                    toolResponse={turn.toolResponse}
                    terminalWidth={availableWidth} // Also apply the adjusted width to SubagentToolCallDisplay
                  />
                </Box>
              )}
            </Box>
          );
        }

        // This is a raw history item (start or error)
        if (item.type === 'start') {
          return (
            <Box
              key={index}
              flexDirection="column"
              marginBottom={1}
              width={availableWidth}
            >
              <Text>
                ⊶ Subagent &apos;{item.data.agentName}&apos; running with
                inputs: {JSON.stringify(item.data.inputs)}
              </Text>
            </Box>
          );
        }
        if (item.type === 'error') {
          return (
            <Box
              key={index}
              flexDirection="column"
              marginBottom={1}
              width={availableWidth}
            >
              <Text color="red">Error in subagent: {item.data.error}</Text>
            </Box>
          );
        }
        if (item.type === 'interrupted') {
          return (
            <Box
              key={index}
              flexDirection="column"
              marginBottom={1}
              width={availableWidth}
            >
              <Text>ℹ {item.data.message}</Text>
            </Box>
          );
        }
        return null; // Should not happen
      })}
    </Box>
  );
};
