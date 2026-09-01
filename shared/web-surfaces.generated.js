// Copyright © 2026 Sonomos, Inc. All rights reserved.
// AUTO-GENERATED from shared/ai-surfaces.json by scripts/generate-surfaces.mjs.
// Do not edit by hand — run `npm run generate` after the vendored file changes.
export const WEB_HOSTS = ["aistudio.google.com","assistant.kagi.com","chat.deepseek.com","chat.mistral.ai","chat.openai.com","chat.qwen.ai","chatgpt.com","claude.ai","claude.com","console.anthropic.com","console.x.ai","copilot.microsoft.com","duck.ai","duckduckgo.com","gemini.google.com","grok.com","kagi.com","meta.ai","perplexity.ai","platform.openai.com","search.brave.com","www.bing.com","www.google.com","you.com"];
export const CAPTURE_PATHS = {"chatgpt.com":["/backend-api/conversation","/backend-api/f/conversation","/backend-anon/conversation","/backend-anon/f/conversation","/unauth-mweb/conversation/updates"],"claude.ai":["/api/organizations/*/chat_conversations/*/completion","/api/organizations/*/chat_conversations/*/retry_completion"],"www.perplexity.ai":["/rest/sse/perplexity_ask"]};
export const SKIP_PATH_SEGMENTS = [["event_logging"],["api","eval"],["mcp-registry"],["telemetry"],["usage"],["billing"],["v1","models"]];
