/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { TOOL_STATUS } from '../../constants.js';
import { GeminiRespondingSpinner } from '../GeminiRespondingSpinner.js';
import type {
  // SubagentHistoryItem,
  SubagentToolCallHistoryItem,
  SubagentToolResponseHistoryItem,
} from '../../types.js';
import { debugLogger } from '@google/gemini-cli-core';

const STATUS_INDICATOR_WIDTH = 2;

type SubagentToolCallDisplayProps = {
  toolCall: SubagentToolCallHistoryItem;
  toolResponse?: SubagentToolResponseHistoryItem;
  terminalWidth: number;
};

export const SubagentToolCallDisplay: React.FC<
  SubagentToolCallDisplayProps
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
> = ({ toolCall, toolResponse, terminalWidth }) => {
  debugLogger.log(
    `[SubagentToolCallDisplay] Rendering with subagentHistory: ${JSON.stringify(
      undefined,
    )}`,
  );
  const status = toolResponse
    ? toolResponse.data.isError
      ? 'error'
      : 'success'
    : 'executing';

  // The width passed is the total available width.
  // The Box component's width is for the content area, so we must subtract
  // space for padding and borders to make the whole component fit.
  // const innerContentWidth = terminalWidth - 4 - STATUS_INDICATOR_WIDTH;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border.default}
      paddingX={1}
      width="100%"
    >
      <Box>
        <ToolStatusIndicator status={status} />
        <ToolInfo
          name={toolCall.data.name}
          description={JSON.stringify(toolCall.data.args)}
        />
      </Box>
      {toolResponse && typeof toolResponse.data.output === 'string' && (
        <Box paddingLeft={STATUS_INDICATOR_WIDTH} marginTop={1}>
          <Box flexDirection="column">
            {toolResponse.data.output.split('\n').map((line, index) => (
              <Box key={index}>
                <Text wrap="wrap" color={theme.text.primary}>
                  {line}
                </Text>
              </Box>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  );
};

type ToolStatusIndicatorProps = {
  status: 'executing' | 'success' | 'error';
};

const ToolStatusIndicator: React.FC<ToolStatusIndicatorProps> = ({
  status,
}) => (
  <Box minWidth={STATUS_INDICATOR_WIDTH}>
    {status === 'executing' && (
      <GeminiRespondingSpinner
        spinnerType="toggle"
        nonRespondingDisplay={TOOL_STATUS.EXECUTING}
      />
    )}
    {status === 'success' && (
      <Text color={theme.status.success}>{TOOL_STATUS.SUCCESS}</Text>
    )}
    {status === 'error' && (
      <Text color={theme.status.error} bold>
        {TOOL_STATUS.ERROR}
      </Text>
    )}
  </Box>
);

type ToolInfoProps = {
  name: string;
  description: string;
};

const ToolInfo: React.FC<ToolInfoProps> = ({ name, description }) => (
  <Box>
    <Text>
      <Text color={theme.text.primary} bold>
        {name}
      </Text>{' '}
      <Text color={theme.text.secondary} wrap="truncate">
        {description}
      </Text>
    </Text>
  </Box>
);
