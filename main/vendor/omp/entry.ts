/* Vendored @oh-my-pi provider entry point.
 *
 * Bundled by scripts/buildOmpProviders.mjs into main/vendor/omp/bundle.mjs.
 * Only the providers Min re-exports through the pi SDK extension API are
 * imported here — keep this list in sync with OMP_PROVIDER_CONFIGS in
 * main/agentOAuth.js.
 *
 * Sync workflow: `npm update @oh-my-pi/pi-ai @oh-my-pi/pi-catalog
 * @oh-my-pi/pi-utils` then `npm run buildMain`. No code is copied by hand —
 * the package sources are the vendored code. */

// chat transports (proprietary wires)
export { streamDevin } from "@oh-my-pi/pi-ai/providers/devin";
export { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
export { streamGoogleGeminiCli } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
export { streamGitLabDuo } from "@oh-my-pi/pi-ai/providers/gitlab-duo";

// standard wires reused for providers whose OAuth token doubles as an API key
export { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
export { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
export { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";

// dynamic model discovery (catalog layer)
export { fetchDevinModels } from "@oh-my-pi/pi-catalog/discovery/devin";
export { fetchCursorUsableModels } from "@oh-my-pi/pi-catalog/discovery/cursor";
export { fetchGeminiCliQuotaModels } from "@oh-my-pi/pi-catalog/discovery/gemini-cli";
export { fetchAntigravityDiscoveryModels } from "@oh-my-pi/pi-catalog/discovery/antigravity";
export { getGitLabDuoModels } from "@oh-my-pi/pi-ai/providers/gitlab-duo";

// bundled catalog — static model seeds for providers without live discovery
export { getBundledModels } from "@oh-my-pi/pi-catalog/models";
