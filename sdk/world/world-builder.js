/**
 * hopeOS SDK — World Builder (conversational scene bring-up)
 * ═══════════════════════════════════════════════════════════════
 * The "build your own world" brain. A short Claude conversation that asks the
 * user what they want to inhabit, then turns it into a concrete search for a
 * downloadable 3D ENVIRONMENT on Sketchfab (or invites them to upload their own
 * GLB). The host renders the chat + the resulting thumbnail grid; whatever scene
 * the user picks is handed to WorldTemplate, which auto-scales / grounds / spawns
 * it into an instantly playable, navigable world with the full hopeOS suite.
 *
 *   const builder = new BuilderAgent({
 *     apiKey, model,
 *     onSay:    (role, text) => renderBubble(role, text),
 *     onBrowse: async (query) => { const n = await showScenes(query); return n; },
 *   });
 *   builder.greet();
 *   builder.send("a quiet japanese garden at dusk");
 *
 * Claude is an enhancer, not a gate: if the key/model is unavailable the host's
 * input box still searches Sketchfab directly, and upload/URL always work.
 */

const BUILDER_TOOLS = [
  { name: 'browse_scenes',
    description: 'Search Sketchfab for a downloadable 3D ENVIRONMENT/scene matching a concrete query and show the user thumbnails to pick from. Use specific, visual queries: "sci-fi spaceship interior", "forest clearing lowpoly", "marble gallery hall", "cyberpunk alley night". Call this once you understand the vibe.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
];

export class BuilderAgent {
  constructor({ apiKey, model, onSay, onBrowse, endpoint, useAI }) {
    this.apiKey = apiKey || '';                  // unused — key lives server-side
    this.endpoint = endpoint || '/api/claude';   // proxy that holds the Claude key
    this.useAI = useAI !== false;                // conversational builder on by default (proxy)
    this.model = model || 'claude-sonnet-4-6';
    this.onSay = onSay || (() => {});
    this.onBrowse = onBrowse || (async () => 0);
    this.messages = [];
    this.busy = false;
  }

  get hasAI() { return this.useAI; }

  _system() {
    return [
      "You are the hopeOS World Builder — a friendly spatial-design partner helping someone conjure a 3D world they'll immediately drop into and play as an avatar.",
      "Goal: understand the vibe in ONE or TWO short questions (theme, mood, indoor/outdoor, scale), then call browse_scenes with a concrete, visual Sketchfab query for a downloadable ENVIRONMENT. After browsing, tell them to click a scene to enter it, or upload their own GLB / paste a .glb URL.",
      "Whatever they pick becomes a real, walkable, collidable scene with hands, gizmo editing, asset import and an in-world AI — so reassure them it's instantly playable and editable once inside.",
      "Keep every reply to 1–2 warm, concrete sentences. Don't over-ask; if their first message is already specific, browse right away.",
    ].join(' ');
  }

  /** Opening line (no API needed). */
  greet() {
    this.onSay('agent', "Let's build a world. What do you want to step into — a place, a mood, a vibe? (Or upload your own .glb anytime.)");
  }

  /** Send a user turn; drives the Claude loop and may trigger onBrowse. */
  async send(text) {
    if (!text || !text.trim() || this.busy) return;
    this.onSay('user', text);
    if (!this.hasAI) {                       // no Claude → treat the text as a direct scene search
      this.onSay('agent', `Searching scenes for “${text}”…`);
      const n = await this.onBrowse(text.trim());
      this.onSay('agent', n ? 'Pick a scene to enter it, or upload your own.' : "No downloadable scenes found — try other words, or upload a .glb.");
      return;
    }
    this.busy = true;
    this.messages.push({ role: 'user', content: text });
    try {
      for (let turn = 0; turn < 4; turn++) {
        const res = await fetch(this.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: this.model, max_tokens: 512, system: this._system(), tools: BUILDER_TOOLS, messages: this.messages }),
        });
        const data = await res.json();
        if (data.error) { this.onSay('agent', 'AI error: ' + data.error.message); break; }
        const content = data.content || [];
        const says = content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
        if (says) this.onSay('agent', says);
        const toolUses = content.filter(b => b.type === 'tool_use');
        if (!toolUses.length) break;
        this.messages.push({ role: 'assistant', content });
        const results = [];
        for (const tu of toolUses) {
          let out = 'ok';
          if (tu.name === 'browse_scenes') {
            const n = await this.onBrowse(String(tu.input.query || '').trim());
            out = n ? `showing ${n} scenes for "${tu.input.query}" — user will click one` : 'no downloadable scenes found; suggest different words or an upload';
          }
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: out });
        }
        this.messages.push({ role: 'user', content: results });
      }
    } catch (e) {
      this.onSay('agent', 'Builder request failed: ' + e.message);
    } finally {
      this.busy = false;
    }
  }
}
