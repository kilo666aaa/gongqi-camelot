import { z } from 'zod';
import { AiError } from './errors';

export interface AiTextProvider {
  complete(input: { system: string; user: string }): Promise<string>;
}

export interface AiProviderFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type AiProviderFetch = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<AiProviderFetchResponse>;

const deepSeekResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string() }),
  })).min(1),
});

export function createDeepSeekProvider(options: {
  apiKey: string;
  model?: string;
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: AiProviderFetch;
}): AiTextProvider {
  const endpoint = options.endpoint ?? 'https://api.deepseek.com/chat/completions';
  const model = options.model ?? 'deepseek-chat';
  const timeoutMs = options.timeoutMs ?? 20_000;
  const fetchImpl = options.fetchImpl
    ?? ((url, init) => fetch(url, init));

  return {
    async complete({ system, user }): Promise<string> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature: 0.3,
            max_tokens: 1_200,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          }),
          signal: controller.signal,
        });
        if (!response.ok) throw new AiError('AI_UNAVAILABLE');
        const parsed = deepSeekResponseSchema.safeParse(await response.json());
        if (!parsed.success) throw new AiError('AI_INVALID_OUTPUT');
        return parsed.data.choices[0]!.message.content;
      } catch (error) {
        if (error instanceof AiError) throw error;
        if (error !== null && typeof error === 'object' && (error as { name?: string }).name === 'AbortError') {
          throw new AiError('AI_TIMEOUT');
        }
        throw new AiError('AI_UNAVAILABLE');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
