// ─────────────────────────────────────────────────────────────
// KI-Anbindung: OpenAI-kompatible Chat-API (Ollama, LM Studio,
// OpenRouter, OpenAI, eigene Server) mit Streaming & Tool-Calls
// ─────────────────────────────────────────────────────────────
import { prefs } from '../store.js';
import { uid } from '../utils.js';

export const PRESETS = {
  ollama: { label: 'Ollama (lokal)', baseUrl: 'http://localhost:11434/v1', needsKey: false, local: true, hint: 'Läuft auf deinem Mac – privat, kostenlos, offline.' },
  lmstudio: { label: 'LM Studio (lokal)', baseUrl: 'http://localhost:1234/v1', needsKey: false, local: true, hint: 'In LM Studio unter „Developer“ den Server starten und CORS aktivieren.' },
  openrouter: { label: 'OpenRouter (Claude, GPT, Gemini, Qwen …)', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true, keyUrl: 'https://openrouter.ai/keys', hint: 'Ein Key für sehr viele Modelle. Modell-ID z. B. „qwen/qwen3-235b-a22b“.' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', needsKey: true, keyUrl: 'https://platform.openai.com/api-keys', hint: 'Modell-ID z. B. „gpt-4.1-mini“.' },
  custom: { label: 'Eigener Server (OpenAI-kompatibel)', baseUrl: 'http://localhost:8080/v1', needsKey: false, hint: 'Jeder Server mit /v1/chat/completions (llama.cpp, vLLM, Jan, …).' },
};

// ── Profile ─────────────────────────────────────────────────
function cfg() { return prefs.get('ai') || { profiles: [], activeId: null }; }
function saveCfg(c) { prefs.set('ai', c); window.dispatchEvent(new CustomEvent('lp-ai-config')); }
export const profiles = () => cfg().profiles;
export function activeProfile() {
  const c = cfg();
  return c.profiles.find((p) => p.id === c.activeId) || c.profiles[0] || null;
}
export function setActive(id) { const c = cfg(); c.activeId = id; saveCfg(c); }
export function upsertProfile(p) {
  const c = cfg();
  if (!p.id) p.id = uid('ai_');
  const i = c.profiles.findIndex((x) => x.id === p.id);
  if (i >= 0) c.profiles[i] = p; else c.profiles.push(p);
  if (!c.activeId) c.activeId = p.id;
  saveCfg(c);
  return p;
}
export function deleteProfile(id) {
  const c = cfg();
  c.profiles = c.profiles.filter((p) => p.id !== id);
  if (c.activeId === id) c.activeId = c.profiles[0]?.id || null;
  saveCfg(c);
}
export function newProfile(preset = 'ollama', model = '') {
  return { id: null, name: '', preset, baseUrl: PRESETS[preset].baseUrl, apiKey: '', model, reasoning: preset === 'ollama' ? 'none' : 'default', tools: 'auto', vision: 'auto' };
}
export const profileName = (p) => p ? (p.name || `${p.model || 'Modell'} · ${PRESETS[p.preset]?.label.split(' (')[0] || 'Server'}`) : '–';

/** Beim ersten Start: lokales Ollama suchen und ein Profil anlegen (Qwen bevorzugt) */
export async function autoSetup() {
  if (profiles().length) return activeProfile();
  const models = await listOllama();
  if (!models?.length) return null;
  const pick = models.find((m) => /qwen/i.test(m)) || models[0];
  return upsertProfile({ ...newProfile('ollama', pick), name: `${pick} (lokal)` });
}

// ── Modelle & Fähigkeiten ───────────────────────────────────
const ollamaRoot = (base) => base.replace(/\/v1\/?$/, '');
export async function listOllama(base = PRESETS.ollama.baseUrl) {
  try {
    const r = await fetch(ollamaRoot(base) + '/api/tags', { signal: AbortSignal.timeout(2000) });
    const j = await r.json();
    return (j.models || []).map((m) => m.name);
  } catch { return null; }
}
export async function listModels(p) {
  if (p.preset === 'ollama') { const m = await listOllama(p.baseUrl); if (m) return m; }
  const r = await fetch(p.baseUrl.replace(/\/$/, '') + '/models', { headers: headers(p), signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Modelle konnten nicht geladen werden (HTTP ${r.status})`);
  const j = await r.json();
  return (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
}
const capCache = new Map();
/** Fähigkeiten: { tools, vision, thinking } – bei Ollama exakt, sonst Annahmen/Einstellung */
export async function capabilities(p) {
  const key = `${p.baseUrl}|${p.model}|${p.tools}|${p.vision}`;
  if (capCache.has(key)) return capCache.get(key);
  let caps = { tools: true, vision: false, thinking: false, known: false };
  if (p.preset === 'ollama') {
    try {
      const r = await fetch(ollamaRoot(p.baseUrl) + '/api/show', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: p.model }), signal: AbortSignal.timeout(4000) });
      const j = await r.json();
      const c = j.capabilities || [];
      caps = { tools: c.includes('tools'), vision: c.includes('vision'), thinking: c.includes('thinking'), known: true, context: Object.entries(j.model_info || {}).find(([k]) => k.endsWith('.context_length'))?.[1] };
    } catch {}
  } else if (/vision|vl|gpt-4o|gpt-4\.1|gpt-5|claude|gemini|qwen3\.[5-9]|llava|pixtral/i.test(p.model)) caps.vision = true;
  if (p.tools === 'on') caps.tools = true;
  if (p.tools === 'off') caps.tools = false;
  if (p.vision === 'on') caps.vision = true;
  if (p.vision === 'off') caps.vision = false;
  capCache.set(key, caps);
  return caps;
}

function headers(p) {
  const h = { 'Content-Type': 'application/json' };
  if (p.apiKey) h.Authorization = `Bearer ${p.apiKey}`;
  if (p.preset === 'openrouter') { h['HTTP-Referer'] = location.origin; h['X-Title'] = 'Lichtplan'; }
  return h;
}

export class AIError extends Error {
  constructor(msg, status, kind) { super(msg); this.status = status; this.kind = kind; }
}
function classify(status, text) {
  let msg = text;
  try { const j = JSON.parse(text); msg = j.error?.message || j.error || j.message || text; } catch {}
  msg = String(msg).slice(0, 400);
  let kind = 'other';
  if (/does not support tools|tool.{0,20}not supported|tools are not supported|function calling/i.test(msg)) kind = 'no-tools';
  else if (/think|reasoning/i.test(msg) && status === 400) kind = 'no-reasoning';
  else if (/image|vision|multimodal/i.test(msg) && status === 400) kind = 'no-vision';
  else if (status === 401 || status === 403) kind = 'auth';
  else if (status === 404 && /model/i.test(msg)) kind = 'model';
  return new AIError(msg, status, kind);
}

/** Splittet Qwen/DeepSeek-artige <think>…</think>-Blöcke aus dem Text */
export function splitThink(text) {
  const m = text.match(/^\s*<think>([\s\S]*?)(<\/think>\s*|$)/);
  if (!m) return { reasoning: '', text };
  return { reasoning: m[1], text: text.slice(m[0].length), open: !m[2] };
}

/**
 * Streaming-Chat. Liefert { content, reasoning, toolCalls, finish, usage }
 * opts: { tools, signal, onContent(text), onReasoning(text) }
 */
export async function chat(p, messages, opts = {}) {
  const body = { model: p.model, messages, stream: true };
  if (opts.tools?.length) body.tools = opts.tools;
  if (p.reasoning && p.reasoning !== 'default' && !opts.noReasoning) body.reasoning_effort = p.reasoning;
  if (p.preset !== 'ollama' && p.preset !== 'lmstudio') body.stream_options = { include_usage: true };
  let res;
  try {
    res = await fetch(p.baseUrl.replace(/\/$/, '') + '/chat/completions', { method: 'POST', headers: headers(p), body: JSON.stringify(body), signal: opts.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new AIError(PRESETS[p.preset]?.local
      ? `Keine Verbindung zu ${p.baseUrl}. Läuft ${p.preset === 'ollama' ? 'Ollama' : 'der lokale Server'}?`
      : `Keine Verbindung zu ${p.baseUrl} (offline oder vom Anbieter blockiert).`, 0, 'network');
  }
  if (!res.ok) throw classify(res.status, await res.text());

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', content = '', reasoning = '', finish = null, usage = null;
  const calls = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let j; try { j = JSON.parse(data); } catch { continue; }
      if (j.error) throw new AIError(j.error.message || JSON.stringify(j.error), 500, 'stream');
      if (j.usage) usage = j.usage;
      const ch = j.choices?.[0];
      if (!ch) continue;
      const d = ch.delta || {};
      const r = d.reasoning ?? d.reasoning_content;
      if (r) { reasoning += r; opts.onReasoning?.(reasoning); }
      if (d.content) { content += d.content; opts.onContent?.(content); }
      for (const tc of d.tool_calls || []) {
        const i = tc.index ?? calls.length;
        const cur = (calls[i] ||= { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.function.name = tc.function.name;
        if (tc.function?.arguments) cur.function.arguments += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
      }
      if (ch.finish_reason) finish = ch.finish_reason;
    }
  }
  const sp = splitThink(content);
  if (sp.reasoning) { reasoning += sp.reasoning; content = sp.text; }
  const toolCalls = calls.filter((c) => c && c.function.name).map((c, i) => ({ ...c, id: c.id || `call_${Date.now().toString(36)}_${i}` }));
  return { content: content.trim(), reasoning, toolCalls, finish, usage };
}

/** Kurzer Verbindungstest: { ok, ms, text } */
export async function testProfile(p) {
  const t0 = performance.now();
  const r = await chat(p, [{ role: 'user', content: 'Antworte nur mit: OK' }], {});
  return { ok: true, ms: Math.round(performance.now() - t0), text: r.content.slice(0, 80) };
}
