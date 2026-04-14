/**
 * Silra.cn API Provider for memory-lancedb-pro
 * 
 * Provides OpenAI-compatible embedding and LLM services for China mainland users.
 * 
 * @see https://silra.cn
 * @see https://docs.silra.cn
 */

import { EmbeddingProvider, LLMProvider, RerankProvider } from '../types';
import { logger } from '../utils/logger';

interface SilraConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  dimensions?: number;
  timeout?: number;
  maxRetries?: number;
}

const DEFAULT_BASE_URL = 'https://api.silra.cn/v1';
const DEFAULT_TIMEOUT = 30000;
const DEFAULT_MAX_RETRIES = 3;

/**
 * Silra.cn Embedding Provider
 */
export class SilraEmbeddingProvider implements EmbeddingProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private dimensions?: number;
  private timeout: number;
  private maxRetries: number;

  constructor(config: SilraConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || DEFAULT_BASE_URL;
    this.model = config.model || 'text-embedding-v4';
    this.dimensions = config.dimensions;
    this.timeout = config.timeout || DEFAULT_TIMEOUT;
    this.maxRetries = config.maxRetries || DEFAULT_MAX_RETRIES;
  }

  async embedQuery(query: string, task?: string): Promise<number[]> {
    const embeddings = await this.embedDocuments([query], task);
    return embeddings[0];
  }

  async embedDocuments(documents: string[], task?: string): Promise<number[][]> {
    const url = `${this.baseUrl}/embeddings`;
    
    const payload = {
      model: this.model,
      input: documents,
      ...(this.dimensions && { dimensions: this.dimensions }),
      ...(task && { task: task }),
    };

    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    
    if (!data.data || !Array.isArray(data.data)) {
      throw new Error(`Invalid response from Silra API: ${JSON.stringify(data)}`);
    }

    // Sort by index to ensure correct order
    const embeddings = data.data
      .sort((a: any, b: any) => a.index - b.index)
      .map((item: any) => item.embedding);

    logger.debug(`[Silra] Embedded ${embeddings.length} documents`);
    return embeddings;
  }

  private async fetchWithRetry(url: string, options: RequestInit, attempt = 1): Promise<Response> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);
      
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);

      if (response.status === 429 && attempt <= this.maxRetries) {
        // Rate limited - retry with exponential backoff
        const delay = Math.pow(2, attempt) * 1000;
        logger.warn(`[Silra] Rate limited, retrying in ${delay}ms (attempt ${attempt}/${this.maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.fetchWithRetry(url, options, attempt + 1);
      }

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Silra API error (${response.status}): ${error}`);
      }

      return response;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Silra API request timeout after ${this.timeout}ms`);
      }
      
      if (attempt < this.maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        logger.warn(`[Silra] Request failed, retrying in ${delay}ms: ${error}`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.fetchWithRetry(url, options, attempt + 1);
      }
      
      throw error;
    }
  }
}

/**
 * Silra.cn LLM Provider
 */
export class SilraLLMProvider implements LLMProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private timeout: number;
  private maxRetries: number;

  constructor(config: SilraConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || DEFAULT_BASE_URL;
    this.model = config.model || 'qwen3-8b';
    this.timeout = config.timeout || DEFAULT_TIMEOUT;
    this.maxRetries = config.maxRetries || DEFAULT_MAX_RETRIES;
  }

  async generate(prompt: string, options?: {
    system?: string;
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
  }): Promise<string> {
    const url = `${this.baseUrl}/chat/completions`;
    
    const messages: any[] = [];
    
    if (options?.system) {
      messages.push({ role: 'system', content: options.system });
    }
    
    messages.push({ role: 'user', content: prompt });

    const payload = {
      model: this.model,
      messages,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 2048,
      ...(options?.jsonMode && { response_format: { type: 'json_object' } }),
    };

    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    
    if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
      throw new Error(`Invalid response from Silra API: ${JSON.stringify(data)}`);
    }

    const content = data.choices[0].message?.content;
    
    if (!content) {
      throw new Error('Empty response from Silra LLM');
    }

    logger.debug(`[Silra] Generated ${content.length} characters`);
    return content;
  }

  private async fetchWithRetry(url: string, options: RequestInit, attempt = 1): Promise<Response> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);
      
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);

      if (response.status === 429 && attempt <= this.maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        logger.warn(`[Silra] Rate limited, retrying in ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.fetchWithRetry(url, options, attempt + 1);
      }

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Silra API error (${response.status}): ${error}`);
      }

      return response;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Silra API request timeout after ${this.timeout}ms`);
      }
      
      if (attempt < this.maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.fetchWithRetry(url, options, attempt + 1);
      }
      
      throw error;
    }
  }
}

/**
 * Silra.cn Rerank Provider (Optional)
 */
export class SilraRerankProvider implements RerankProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private timeout: number;

  constructor(config: SilraConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || DEFAULT_BASE_URL;
    this.model = config.model || 'bge-reranker-v2-m3';
    this.timeout = config.timeout || DEFAULT_TIMEOUT;
  }

  async rerank(query: string, documents: Array<{ text: string; index: number }>, topK?: number): Promise<Array<{ text: string; index: number; score: number }>> {
    const url = `${this.baseUrl}/rerank`;
    
    const payload = {
      model: this.model,
      query,
      documents: documents.map(d => d.text),
      top_n: topK || documents.length,
    };

    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    
    if (!data.results || !Array.isArray(data.results)) {
      throw new Error(`Invalid response from Silra API: ${JSON.stringify(data)}`);
    }

    return data.results.map((result: any) => ({
      text: documents[result.index].text,
      index: result.index,
      score: result.relevance_score || result.score,
    }));
  }

  private async fetchWithRetry(url: string, options: RequestInit, attempt = 1): Promise<Response> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);
      
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Silra API error (${response.status}): ${error}`);
      }

      return response;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Silra API request timeout after ${this.timeout}ms`);
      }
      throw error;
    }
  }
}

/**
 * Factory function to create Silra providers
 */
export function createSilraProvider(config: SilraConfig) {
  return {
    embedding: new SilraEmbeddingProvider(config),
    llm: new SilraLLMProvider(config),
    rerank: config.model?.includes('rerank') ? new SilraRerankProvider(config) : undefined,
  };
}
