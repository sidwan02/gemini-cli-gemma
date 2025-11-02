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

interface SubagentHistoryDisplayProps {
  history: SubagentHistoryItem[];
  terminalWidth: number;
}

type SubagentTurn = {
  thought?: SubagentThoughtHistoryItem;
  toolCall?: SubagentToolCallHistoryItem;
  toolResponse?: SubagentToolResponseHistoryItem;
};

type ProcessedHistoryItem = SubagentTurn | SubagentHistoryItem;

function isSubagentTurn(item: ProcessedHistoryItem): item is SubagentTurn {
  return !('type' in item);
}

export const SubagentHistoryDisplay: React.FC<SubagentHistoryDisplayProps> = ({
  history,
  terminalWidth,
}) => {
  const processedHistory = history.reduce((acc, item) => {
    if (item.type === 'start' || item.type === 'error') {
      acc.push(item);
      return acc;
    }

    let lastItem = acc[acc.length - 1];

    // Ensure lastItem is a turn, creating one if necessary.
    if (!lastItem || !isSubagentTurn(lastItem)) {
      lastItem = {};
      acc.push(lastItem);
    }

    const lastTurn = lastItem as SubagentTurn;

    if (item.type === 'thought') {
      if (lastTurn.thought) {
        acc.push({ thought: item });
      } else {
        lastTurn.thought = item;
      }
    } else if (item.type === 'tool_call') {
      if (lastTurn.toolCall) {
        acc.push({ toolCall: item });
      } else {
        lastTurn.toolCall = item;
      }
    } else if (item.type === 'tool_response') {
      if (lastTurn.toolResponse) {
        // This case might indicate a new turn should start,
        // but for now, we'll just overwrite.
        lastTurn.toolResponse = item;
      } else {
        lastTurn.toolResponse = item;
      }
    }

    return acc;
  }, [] as ProcessedHistoryItem[]);

  return (
    <Box flexDirection="column">
      {processedHistory.map((item, index) => {
        if (isSubagentTurn(item)) {
          // This is a SubagentTurn
          const turn = item;
          return (
            <Box key={index} flexDirection="column" marginBottom={1}>
              {turn.thought && (
                <Box flexDirection="column" marginBottom={1}>
                  <Text>🤖💭</Text>
                  <MarkdownDisplay
                    text={turn.thought.data.thought}
                    isPending={false}
                    terminalWidth={terminalWidth}
                  />
                </Box>
              )}
              {turn.toolCall && (
                <SubagentToolCallDisplay
                  toolCall={turn.toolCall}
                  toolResponse={turn.toolResponse}
                  terminalWidth={terminalWidth}
                />
              )}
            </Box>
          );
        }

        // This is a raw history item (start or error)
        if (item.type === 'start') {
          return (
            <Box key={index} flexDirection="column" marginBottom={1}>
              <Text>
                ⊶ Subagent &apos;{item.data.agentName}&apos; running with
                inputs: {JSON.stringify(item.data.inputs)}
              </Text>
            </Box>
          );
        }
        if (item.type === 'error') {
          return (
            <Box key={index} flexDirection="column" marginBottom={1}>
              <Text color="red">Error in subagent: {item.data.error}</Text>
            </Box>
          );
        }
        return null; // Should not happen
      })}
    </Box>
  );
};
