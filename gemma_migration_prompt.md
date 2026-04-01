# Gemma Subagent Migration Instructions

You are tasked with porting the `gemma_agent` and Ollama integration code into
this fresh codebase from a stale branch.

## Step 1: Gather Context

Read the file `gemma_files_links.md` in this directory. It contains a list of
GitHub URLs pointing to the exact state of the files in the stale branch. Use
your `web_fetch` tool to read the contents of these files to understand the
implementation details.

## Step 2: Create New Files

The feature introduces a few entirely new files. Create them directly based on
the fetched content:

- `packages/core/src/agents/gemma.ts`
- `packages/core/src/core/ollamaClient.ts`
- `packages/core/src/core/ollamaChat.ts`

## Step 3: Surgically Update Existing Files

The rest of the links in `gemma_files_links.md` point to files that already
exist in this repository but need to be updated. **Do not completely overwrite
local files with the stale branch versions.** The local files may have other
recent updates. Instead, use `grep_search` and `read_file` to understand the
local structure, and use `replace` to surgically insert the Gemma/Ollama logic.

Key areas to integrate:

1. **Configuration (`settingsSchema.ts`, `config.ts`):** Add `useGemmaRouting`
   and `gemmaSubagentSettings` types and default configurations.
2. **Types (`agents/types.ts`):** Add `OllamaModelConfig` and any related
   interfaces.
3. **Registry (`registry.ts`):** Import and register the `GemmaAgent`.
4. **Executor (`executor.ts`):** Add the logic to format tool code for Gemma
   (`_prepareGemmaToolCode`) and handle Gemma-specific execution paths.
5. **Routing & Services (`classifierStrategy.ts`, `toolCallService.ts`,
   `summarizer.ts`):** Integrate the `OllamaClient` and `OllamaChat` for local
   routing and summarization.
6. **Utilities (`toolCallParser.ts`):** Ensure the Ollama tool call parsing
   logic is added.

## Step 4: Verification

After applying the changes, run the project's verification commands to ensure no
TypeScript or linting errors were introduced:

```bash
npm run typecheck
npm run lint
```

Fix any errors that arise during verification.
