```
npm run clean; npm run build; npm start --debug
```

# Handling Tool Calls

✦ You've hit on a key point. The system prompt isn't augmented with text saying
"you can use a web search". Instead, the model is made aware of available tools
through a specific tools parameter in the API request.

The core logic for this is in packages/core/src/core/geminiChat.ts.

When a message is sent to the model using sendMessage or sendMessageStream, the
GeminiChat class does the following:

1.  It accesses the ToolRegistry that was initialized in the Config.
2.  It calls this.config.getToolRegistry().getFunctionDeclarations() to get the
    JSON schema for every registered and enabled tool.
3.  This list of tool schemas is then passed directly to the Gemini API in the
    tools field of the request payload.

✦ It's not about augmenting the text of the system prompt. Instead, the Gemini
API has a dedicated field in the request payload for declaring tools.

The GeminiChat class in packages/core/src/core/geminiChat.ts automatically
handles this. When sending a request to the model via generateContentStream, it
fetches all registered tools from the ToolRegistry and attaches their schemas to
the API call.

This process ensures the model is aware of every tool—including
google_web_search—that is available for it to use in that specific turn.
