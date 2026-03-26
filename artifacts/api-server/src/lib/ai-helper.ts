/**
 * Local AI helper — thin wrapper around @workspace/integrations-gemini-ai.
 * All fallback logic, dual-key rotation, and circuit breaker live in the shared lib.
 */

export { ai, ai2, DUAL_KEY } from "@workspace/integrations-gemini-ai";
export {
  generateWithFallback,
  promptAI as prompt,
  FALLBACK_MODELS as AI_MODELS,
} from "@workspace/integrations-gemini-ai";
