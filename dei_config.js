/**
 * DEI (camera-POV) config — CLIENT-SIDE, no secrets.
 * Keys live server-side in the Vercel proxy (api/openai.js, api/claude.js),
 * read from environment variables. The browser calls /api/* only.
 */
const DEI_CONFIG = {
  CLAUDE_API_KEY: '',                 // server-side now → /api/claude
  CLAUDE_MODEL:   'claude-sonnet-4-6',
  OPENAI_API_KEY: '',                 // server-side now → /api/openai
  WHISPER_MODEL: 'gpt-4o-transcribe',
};
export default DEI_CONFIG;
