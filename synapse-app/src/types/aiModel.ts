export interface AIModelCapabilities {
  vision: boolean;
  tools: boolean;
  thinking: boolean;
  reasoning: boolean;
  streaming: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoningEffortOptions: string[];
  speedTierOptions: string[];
  supportedParameters: string[];
  source: 'api' | 'inferred' | 'mixed';
}

export interface AIModelOption {
  id: string;
  name: string;
  description?: string;
  capabilities: AIModelCapabilities;
  contextWindow?: number;
  supportedParameters: string[];
  raw?: Record<string, any>;
}
