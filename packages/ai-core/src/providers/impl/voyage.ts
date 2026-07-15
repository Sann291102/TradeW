import { EmbeddingProvider } from '../interfaces';
import { EmbeddingRequest, EmbeddingResponse } from '../types';

export interface VoyageConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  dimensions?: number;
}

/** Voyage AI embeddings — primary embedding provider per config. */
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'voyage';
  readonly dimensions: number;
  private baseUrl: string;
  private model: string;

  constructor(private config: VoyageConfig) {
    this.baseUrl = (config.baseUrl ?? 'https://api.voyageai.com').replace(/\/$/, '');
    this.model = config.model ?? 'voyage-3';
    this.dimensions = config.dimensions ?? 1024;
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: request.texts,
        ...(request.inputType ? { input_type: request.inputType } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`voyage embeddings failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      data: { embedding: number[] }[];
      usage?: { total_tokens: number };
      model?: string;
    };
    return {
      embeddings: data.data.map((d) => d.embedding),
      dimensions: data.data[0]?.embedding.length ?? this.dimensions,
      usage: data.usage ? { totalTokens: data.usage.total_tokens } : undefined,
      servedBy: { provider: this.name, model: data.model ?? this.model },
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.apiKey}` },
        body: JSON.stringify({ model: this.model, input: ['ping'] }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
