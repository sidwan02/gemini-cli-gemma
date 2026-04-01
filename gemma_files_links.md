# Gemma & Subagent UI Migration Links

The following are links to the exact file states from the stale branch (commit
`264d92574434c36853372453480f6bfab662371b`). You can use `web_fetch` on these
URLs to read the required code.

## New Files (To be created)

- https://github.com/sidwan02/gemini-cli-gemma/blob/264d92574434c36853372453480f6bfab662371b/packages/core/src/agents/gemma.ts
- https://github.com/sidwan02/gemini-cli-gemma/blob/264d92574434c36853372453480f6bfab662371b/packages/core/src/core/ollamaClient.ts
- https://github.com/sidwan02/gemini-cli-gemma/blob/264d92574434c36853372453480f6bfab662371b/packages/core/src/core/ollamaChat.ts
- https://github.com/sidwan02/gemini-cli-gemma/blob/264d92574434c36853372453480f6bfab662371b/packages/core/src/core/localGeminiClient.ts
- https://github.com/sidwan02/gemini-cli-gemma/blob/264d92574434c36853372453480f6bfab662371b/packages/core/src/services/toolCallService.ts
- https://github.com/sidwan02/gemini-cli-gemma/blob/264d92574434c36853372453480f6bfab662371b/packages/core/src/services/summarizer.ts
- https://github.com/sidwan02/gemini-cli-gemma/blob/264d92574434c36853372453480f6bfab662371b/packages/core/src/utils/toolCallParser.ts
- https://github.com/sidwan02/gemini-cli-gemma/blob/264d92574434c36853372453480f6bfab662371b/packages/cli/src/ui/components/SubagentInterruptDialog.tsx

## Modified Files (To be surgically updated)

### Core/Agents & Execution Logic

- https://github.com/sidwan02/gemini-cli-gemma/blob/264d92574434c36853372453480f6bfab662371b/packages/core/src/agents/types.ts
- https://github.com/sidwan02/gemini-cli-gemma/blob/264d92574434c36853372453480f6bfab662371b/packages/core/src/agents/executor.ts
- https://github.com/sidwan02/gemini-cli-gemma/blob/264d92574434c36853372453480f6bfab662371b/packages/core/src/agents/invocation.ts
- https://github.com/sidwan02/gemini-cli-gemma/blob/264d92574434c36853372453480f6bfab662371b/packages/core/src/agents/registry.ts
- https://github.com/sidwan02/gemini-cli-gemma/blob/264d92574434c36853372453480f6bfab662371b/packages/core/src/agents/build-test-agent.ts
- https://github.com/sidwan02/gemini-cli-gemma/blob/264d92574434c36853372453480f6bfab662371b/packages/core/src/common/abort-signal-manager.ts
- https://github.com/sidwan02/gemini-cli-gemma/blob/264d92574434c36853372453480f6bfab662371b/packages/core/src/services/shellExecutionService.ts
- https://github.com/sidwan02/gemini-cli-gemma/blob/264d92574434c36853372453480f6bfab662371b/packages/core/src/tools/shell.ts

### CLI UI Components (Subagent Streaming & Display)

- https://github.com/sidwan02/gemini-cli-gemma/blob/264d92574434c36853372453480f6bfab662371b/packages/cli/src/ui/AppContainer.tsx
- https://github.com/sidwan02/gemini-cli-gemma/blob/264d92574434c36853372453480f6bfab662371b/packages/cli/src/ui/components/Composer.tsx
- https://github.com/sidwan02/gemini-cli-gemma/blob/264d92574434c36853372453480f6bfab662371b/packages/cli/src/ui/components/messages/SubagentHistoryDisplay.tsx
- https://github.com/sidwan02/gemini-cli-gemma/blob/264d92574434c36853372453480f6bfab662371b/packages/cli/src/ui/components/messages/SubagentToolCallDisplay.tsx
- https://github.com/sidwan02/gemini-cli-gemma/blob/264d92574434c36853372453480f6bfab662371b/packages/cli/src/ui/contexts/UIStateContext.tsx
- https://github.com/sidwan02/gemini-cli-gemma/blob/264d92574434c36853372453480f6bfab662371b/packages/cli/src/ui/hooks/useGeminiStream.ts
- https://github.com/sidwan02/gemini-cli-gemma/blob/264d92574434c36853372453480f6bfab662371b/packages/cli/src/ui/hooks/useReactToolScheduler.ts
- https://github.com/sidwan02/gemini-cli-gemma/blob/264d92574434c36853372453480f6bfab662371b/packages/cli/src/ui/types.ts

### Routing & Services

- https://github.com/sidwan02/gemini-cli-gemma/blob/264d92574434c36853372453480f6bfab662371b/packages/core/src/routing/strategies/classifierStrategy.ts
- https://github.com/sidwan02/gemini-cli-gemma/blob/264d92574434c36853372453480f6bfab662371b/packages/core/src/routing/strategies/classifierStrategy.test.ts

### Utilities

- https://github.com/sidwan02/gemini-cli-gemma/blob/264d92574434c36853372453480f6bfab662371b/packages/core/src/utils/environmentContext.ts

### Configuration (Core & CLI)

- https://github.com/sidwan02/gemini-cli-gemma/blob/264d92574434c36853372453480f6bfab662371b/packages/core/src/config/config.ts
- https://github.com/sidwan02/gemini-cli-gemma/blob/264d92574434c36853372453480f6bfab662371b/packages/cli/src/config/config.ts
- https://github.com/sidwan02/gemini-cli-gemma/blob/264d92574434c36853372453480f6bfab662371b/packages/cli/src/config/settingsSchema.ts
