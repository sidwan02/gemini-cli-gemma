# Gemma Migration Plan

This plan outlines the steps to migrate Gemma and Ollama integration to the
current codebase. Per the latest strategy, we are focusing _only_ on the core
execution of the local Gemma agent. Advanced subagent features (interrupts,
dynamic routing, summarization) are moved to Stretch Goals.

## Phase 1: Infrastructure & Core Clients (Completed)

- [x] Create `packages/core/src/core/ollamaClient.ts`
- [x] Create `packages/core/src/core/ollamaChat.ts` (Added turn-by-turn
      `reminder` support and dynamic tool injection handling)
- [x] Create `packages/core/src/core/localGeminiClient.ts`
- [x] Update `packages/core/src/utils/environmentContext.ts`
- [x] Update `packages/core/src/config/config.ts` (Added `buildAndTestSettings`
      configuration property)
- [x] Update `packages/cli/src/config/config.ts` (Loaded `buildAndTestSettings`
      from CLI settings schema)
- [x] Update `packages/cli/src/config/settingsSchema.ts` (Exposed
      `buildAndTestSettings` and `useToolCallService`)
- [x] Create `packages/core/src/utils/toolCallParser.ts` (Created robust logic
      for extracting tool calls from both JSON blocks and regex `function(args)`
      structures)
- [x] Create `packages/core/src/utils/json.ts` (Extracted JSON sanitization
      logic)

## Phase 2: Agent Logic & Local Execution (Completed)

- [x] Create `packages/core/src/agents/gemma.ts`
- [x] Create `packages/core/src/agents/build-test-agent.ts` (Implemented
      specialized local agent for code compilation and execution testing)
- [x] Update `packages/core/src/agents/types.ts` (Added `directive` and
      `reminder` to `PromptConfig` to support OllamaModelConfig context
      steerability)
- [x] Update `packages/core/src/agents/registry.ts` (Registered `GemmaAgent` and
      `BuildAndTestAgent`)
- [x] Update `packages/core/src/agents/local-executor.ts` (Wired up
      `parseToolCalls`, formatting `parameters` via `_prepareGemmaToolCode`, and
      prompt template dynamic replacement)
- [x] Update `packages/core/src/agents/local-invocation.ts` (Verified to work
      with the updated executor)

## Phase 3: Stretch Goals (Advanced Subagent Features)

- [ ] Implement `packages/core/src/services/toolCallService.ts`
- [ ] Implement `packages/core/src/services/summarizer.ts`
- [ ] Update CLI UI Components (`SubagentInterruptDialog`,
      `SubagentHistoryDisplay`, etc.)
- [ ] Dynamic Routing (`classifierStrategy`)

## Phase 4: Verification & Cleanup

- [x] Run `npm run typecheck`
- [x] Run `npm run lint` (Ensure strict adherence to TypeScript rules, avoiding
      `any` or unsafe assertions)
- [x] Run `npm run clean && npm run build` (Ensured that both `core` and `cli`
      are building successfully)
- [ ] Final validation of type safety and documentation completeness.
