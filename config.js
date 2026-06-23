/**
 * hopeOS runtime config (CLIENT-SIDE — shipped to the browser).
 * ────────────────────────────────────────────────────────────────
 * NO SECRETS HERE. All keys now live server-side in the Vercel proxy
 * (api/claude.js, api/openai.js, api/sketchfab.js), read from environment
 * variables. The browser calls /api/* and never sees a key.
 *
 * Set the real keys in Vercel → Settings → Environment Variables:
 *   ANTHROPIC_API_KEY · OPENAI_API_KEY · SKETCHFAB_TOKEN
 *
 * Local dev: run `vercel dev` so the /api/* functions are served too.
 * (Leaving the *_API_KEY fields below empty routes everything through the proxy.)
 */
const CONFIG = {
  CLAUDE_API_KEY: '',                 // server-side now → /api/claude
  CLAUDE_MODEL:   'claude-sonnet-4-6',
  OPENAI_API_KEY: '',                 // server-side now → /api/openai
  WHISPER_MODEL:  'gpt-4o-transcribe',
  SKETCHFAB_TOKEN: '',                // server-side now → /api/sketchfab
  VOICE_DEFAULT_ON: false,            // site asks for mic only when the user toggles voice on
};
export default CONFIG;
