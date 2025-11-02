/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { MarkdownDisplay } from '../../utils/MarkdownDisplay.js';
import { theme } from '../../semantic-colors.js';
import { TOOL_STATUS } from '../../constants.js';
import { GeminiRespondingSpinner } from '../GeminiRespondingSpinner.js';
import type {
  SubagentToolCallHistoryItem,
  SubagentToolResponseHistoryItem,
} from '../../types.js';

const STATUS_INDICATOR_WIDTH = 2;

type SubagentToolCallDisplayProps = {
  toolCall: SubagentToolCallHistoryItem;
  toolResponse?: SubagentToolResponseHistoryItem;
  terminalWidth: number;
};

export const SubagentToolCallDisplay: React.FC<
  SubagentToolCallDisplayProps
> = ({ toolCall, toolResponse, terminalWidth }) => {
  const status = toolResponse
    ? toolResponse.data.isError
      ? 'error'
      : 'success'
    : 'executing';

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border.default}
      paddingX={1}
      width={terminalWidth}
    >
      <Box>
        <ToolStatusIndicator status={status} />
        <ToolInfo
          name={toolCall.data.name}
          description={JSON.stringify(toolCall.data.args)}
        />
      </Box>
      {toolResponse && (
        <Box paddingLeft={STATUS_INDICATOR_WIDTH} marginTop={1}>
          <MarkdownDisplay
            text={String(toolResponse.data.output ?? 'No output')}
            isPending={false}
            terminalWidth={terminalWidth - STATUS_INDICATOR_WIDTH - 4}
          />
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
      <Text color={theme.text.secondary}>{description}</Text>
    </Text>
  </Box>
);
