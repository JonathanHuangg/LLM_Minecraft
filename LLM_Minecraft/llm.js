// llm.js — provider-agnostic LLM client for the Minecraft agent.
//
// Supports Gemini and OpenAI through their REST APIs using Node's built-in
// fetch, so no extra dependency is needed. API keys come from environment
// variables ONLY (GEMINI_API_KEY / OPENAI_API_KEY); nothing in this repo
// reads a key from disk, and keys are never logged or committed.
//
// When no key is configured, detectLLMConfig() returns null and the agent
// runs in demo mode (deterministic graph planner picks the action) — see
// agent.js. A live LLM call has NOT been verified in this environment
// (no key is available here); the client itself is tested with a mocked
// fetch in scripts/test-agent.js.

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

const DEFAULT_MODELS = {
  gemini: 'gemini-2.0-flash',
  openai: 'gpt-4o-mini',
}

/**
 * Detect LLM configuration from the environment.
 * @param {object} env - defaults to process.env; injectable for tests
 * @returns {{provider: string, apiKey: string, model: string} | null}
 *   null when no provider is configured (demo mode).
 */
function detectLLMConfig(env = process.env) {
  const provider = String(env.LLM_PROVIDER || 'auto').toLowerCase()
  const geminiKey = env.GEMINI_API_KEY || ''
  const openaiKey = env.OPENAI_API_KEY || ''

  if (provider === 'gemini') {
    return geminiKey
      ? { provider: 'gemini', apiKey: geminiKey, model: env.LLM_MODEL || DEFAULT_MODELS.gemini }
      : null
  }
  if (provider === 'openai') {
    return openaiKey
      ? { provider: 'openai', apiKey: openaiKey, model: env.LLM_MODEL || DEFAULT_MODELS.openai }
      : null
  }
  // auto: prefer Gemini when its key is set, else OpenAI
  if (geminiKey) {
    return { provider: 'gemini', apiKey: geminiKey, model: env.LLM_MODEL || DEFAULT_MODELS.gemini }
  }
  if (openaiKey) {
    return { provider: 'openai', apiKey: openaiKey, model: env.LLM_MODEL || DEFAULT_MODELS.openai }
  }
  return null
}

/**
 * Build a client for a detected config.
 * @param {{provider: string, apiKey: string, model: string}} config
 * @param {function} fetchImpl - defaults to global fetch; injectable for tests
 */
function createLLM(config, fetchImpl = globalThis.fetch) {
  if (!config || !config.apiKey) throw new Error('createLLM: missing apiKey')
  if (typeof fetchImpl !== 'function') throw new Error('createLLM: fetch is not available')

  async function completeGemini({ system, user, temperature = 0.2 }) {
    const url = `${GEMINI_BASE}/${encodeURIComponent(config.model)}:generateContent`
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': config.apiKey,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature },
      }),
    })
    if (!res.ok) {
      const snippet = String(await res.text().catch(() => '')).slice(0, 300)
      throw new Error(`Gemini request failed (HTTP ${res.status}): ${snippet}`)
    }
    const data = await res.json()
    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text || '')
      .join('')
      .trim()
    if (!text) throw new Error('Gemini returned an empty response')
    return text
  }

  async function completeOpenAI({ system, user, temperature = 0.2 }) {
    const res = await fetchImpl(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature,
      }),
    })
    if (!res.ok) {
      const snippet = String(await res.text().catch(() => '')).slice(0, 300)
      throw new Error(`OpenAI request failed (HTTP ${res.status}): ${snippet}`)
    }
    const data = await res.json()
    const text = String(data.choices?.[0]?.message?.content ?? '').trim()
    if (!text) throw new Error('OpenAI returned an empty response')
    return text
  }

  return {
    provider: config.provider,
    model: config.model,
    /** @returns {Promise<string>} the model's raw text reply */
    async complete(args) {
      if (config.provider === 'gemini') return completeGemini(args)
      if (config.provider === 'openai') return completeOpenAI(args)
      throw new Error(`unknown LLM provider: ${config.provider}`)
    },
  }
}

module.exports = { detectLLMConfig, createLLM, DEFAULT_MODELS }
