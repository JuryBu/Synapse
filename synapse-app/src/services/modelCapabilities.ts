import type { AIModelCapabilities, AIModelOption } from '@/types/aiModel';

const DEFAULT_REASONING_EFFORTS = ['auto', 'low', 'medium', 'high', 'xhigh'];
const DEFAULT_SPEED_TIERS = ['auto', 'default', 'fast'];

function cleanModelId(raw: string): string {
  return raw.replace(/^\[.*?\]/, '');
}

function toNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function collectSupportedParameters(raw: any): string[] {
  const candidates = [
    raw?.supported_parameters,
    raw?.supportedParameters,
    raw?.parameters,
    raw?.capabilities?.supported_parameters,
    raw?.capabilities?.parameters,
  ];
  const values = candidates.flatMap(value => Array.isArray(value) ? value : []);
  return [...new Set(values.map(String).map(v => v.toLowerCase()))];
}

function collectModalities(raw: any): string[] {
  const candidates = [
    raw?.modalities,
    raw?.input_modalities,
    raw?.supported_modalities,
    raw?.architecture?.input_modalities,
    raw?.capabilities?.modalities,
  ];
  return candidates
    .flatMap(value => Array.isArray(value) ? value : [])
    .map(String)
    .map(v => v.toLowerCase());
}

function findContextWindow(id: string, raw: any): number | undefined {
  const direct = [
    raw?.context_window,
    raw?.contextWindow,
    raw?.context_length,
    raw?.contextLength,
    raw?.max_context_length,
    raw?.maxContextLength,
    raw?.input_token_limit,
    raw?.max_input_tokens,
    raw?.limits?.context,
    raw?.top_provider?.context_length,
  ].map(toNumber).find(Boolean);
  if (direct) return direct;

  const lower = id.toLowerCase();
  if (lower.includes('gemini-1.5') || lower.includes('gemini-2')) return 1_000_000;
  if (lower.includes('claude')) return 200_000;
  if (lower.includes('gpt-5') || lower.includes('gpt-4.1') || lower.includes('gpt-4o') || lower.includes('o3') || lower.includes('o4')) return 128_000;
  if (lower.includes('deepseek')) return 64_000;
  return undefined;
}

function findMaxOutputTokens(raw: any): number | undefined {
  return [
    raw?.max_output_tokens,
    raw?.maxOutputTokens,
    raw?.output_token_limit,
    raw?.max_completion_tokens,
    raw?.top_provider?.max_completion_tokens,
  ].map(toNumber).find(Boolean);
}

function hasSupportedParameter(parameters: string[], ...names: string[]): boolean {
  return names.some(name => parameters.includes(name.toLowerCase()));
}

function explicitBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function inferModelCapabilities(id: string, raw: any = {}): AIModelCapabilities {
  const lower = id.toLowerCase();
  const supportedParameters = collectSupportedParameters(raw);
  const modalities = collectModalities(raw);
  const isEmbeddingOrAudio = /(embedding|embed|whisper|tts|rerank)/i.test(lower);

  const apiVision = explicitBoolean(raw?.capabilities?.vision ?? raw?.vision);
  const apiTools = explicitBoolean(raw?.capabilities?.tools ?? raw?.tools);
  const apiThinking = explicitBoolean(raw?.capabilities?.thinking ?? raw?.capabilities?.reasoning ?? raw?.reasoning);
  const apiStreaming = explicitBoolean(raw?.capabilities?.streaming ?? raw?.streaming);

  const vision = apiVision ?? (
    modalities.some(m => m.includes('image') || m.includes('vision')) ||
    /(vision|gpt-4o|gpt-4\.1|o3|o4|gemini|claude)/i.test(lower)
  );
  const tools = apiTools ?? (
    hasSupportedParameter(supportedParameters, 'tools', 'tool_choice', 'functions', 'function_call') ||
    !isEmbeddingOrAudio
  );
  const thinking = apiThinking ?? (
    hasSupportedParameter(supportedParameters, 'reasoning_effort', 'reasoning', 'thinking') ||
    /(gpt-5|o1|o3|o4|deepseek-r1|r1|claude-3\.7|claude.*4)/i.test(lower)
  );
  const streaming = apiStreaming ?? (
    hasSupportedParameter(supportedParameters, 'stream') ||
    !isEmbeddingOrAudio
  );

  const hasApiEvidence = apiVision !== undefined || apiTools !== undefined || apiThinking !== undefined ||
    apiStreaming !== undefined || supportedParameters.length > 0;

  return {
    vision,
    tools,
    thinking,
    reasoning: thinking,
    streaming,
    contextWindow: findContextWindow(id, raw),
    maxOutputTokens: findMaxOutputTokens(raw),
    reasoningEffortOptions: thinking ? DEFAULT_REASONING_EFFORTS : ['auto'],
    speedTierOptions: /gpt-5|codex/i.test(lower) ? DEFAULT_SPEED_TIERS : ['auto'],
    supportedParameters,
    source: hasApiEvidence ? 'mixed' : 'inferred',
  };
}

export function normalizeModelOption(raw: any): AIModelOption | null {
  const normalizedRaw = typeof raw === 'string' ? { id: raw } : raw;
  const rawId = String(normalizedRaw?.id ?? normalizedRaw?.model ?? normalizedRaw?.name ?? '').trim();
  if (!rawId) return null;
  const id = cleanModelId(rawId);
  const capabilities = inferModelCapabilities(id, normalizedRaw);
  return {
    id,
    name: rawId,
    description: normalizedRaw?.description,
    capabilities,
    contextWindow: capabilities.contextWindow,
    supportedParameters: capabilities.supportedParameters,
    raw: normalizedRaw,
  };
}

export function describeCapabilities(capabilities?: AIModelCapabilities): string[] {
  if (!capabilities) return [];
  const labels: string[] = [];
  labels.push(capabilities.streaming ? 'Streaming' : 'No stream');
  if (capabilities.thinking) labels.push('Thinking');
  if (capabilities.tools) labels.push('Tools');
  if (capabilities.vision) labels.push('Vision');
  if (capabilities.contextWindow) labels.push(`${Math.round(capabilities.contextWindow / 1000)}k ctx`);
  return labels;
}
