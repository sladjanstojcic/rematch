import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { AI_MODEL } from '../constants.js';

export type StructuredCaller = <T>(args: {
  schema: z.ZodType<T>; system: string; user: string; maxTokens?: number;
}) => Promise<T | null>;

type Usage = Pick<Anthropic.Usage, 'input_tokens' | 'output_tokens'> &
  Partial<Pick<Anthropic.Usage, 'cache_creation_input_tokens' | 'cache_read_input_tokens'>>;
type ParseClient = {
  messages: {
    parse(params: Anthropic.MessageCreateParamsNonStreaming): Promise<
      Pick<Anthropic.Message, 'stop_reason' | 'usage'> & { parsed_output: unknown }
    >;
  };
};

const INPUT_USD_PER_MTOK = 0.10;
const OUTPUT_USD_PER_MTOK = 0.50;
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

function outputFailureReason(schema: z.ZodType, content: string): string {
  let value: unknown;
  try { value = JSON.parse(content); } catch { return 'AnthropicError.output_parse'; }
  const result = schema.safeParse(value);
  const field = result.success ? undefined : result.error.issues[0]?.path[0];
  // Only a top-level field the called schema itself declares may enter persistent
  // stats. Never copy an arbitrary path, model value or the SDK's error text.
  const known = typeof field === 'string' && schema instanceof z.ZodObject && Object.hasOwn(schema.shape, field);
  return `AnthropicError.output_validation:${known ? field : 'unknown'}`;
}

function errorReason(error: unknown): string {
  // Use trusted class names, never arbitrary error text, payloads or headers.
  const name = [
    Anthropic.AuthenticationError, Anthropic.NotFoundError, Anthropic.BadRequestError,
    Anthropic.RateLimitError, Anthropic.APIConnectionTimeoutError, Anthropic.APIConnectionError,
    Anthropic.InternalServerError, Anthropic.APIError, Anthropic.AnthropicError, Error,
  ].find((ErrorType) => error instanceof ErrorType)?.name ?? 'UnknownError';
  const status = error instanceof Anthropic.APIError ? error.status : undefined;
  return status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599
    ? `${name}:${status}` : name;
}

export class UsageMeter {
  inputTokens = 0;
  outputTokens = 0;
  cacheWriteTokens = 0;
  cacheReadTokens = 0;
  failures = 0;
  failureReasons: Record<string, number> = Object.create(null);

  addFailure(reason: string): void {
    this.failures++;
    this.failureReasons[reason] = (this.failureReasons[reason] ?? 0) + 1;
  }

  add(usage: Usage): void {
    this.inputTokens += usage.input_tokens;
    this.outputTokens += usage.output_tokens;
    this.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
    this.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  }

  estCostUsd(): number {
    return (this.inputTokens * INPUT_USD_PER_MTOK + this.outputTokens * OUTPUT_USD_PER_MTOK +
      this.cacheWriteTokens * INPUT_USD_PER_MTOK * CACHE_WRITE_MULTIPLIER +
      this.cacheReadTokens * INPUT_USD_PER_MTOK * CACHE_READ_MULTIPLIER) / 1_000_000;
  }
}

export function createCaller(apiKey: string, meter: UsageMeter, client: ParseClient = new Anthropic({
  apiKey,
  defaultHeaders: { 'User-Agent': 'RematchBot/0.1 (+https://github.com/rematch-app)' },
})): StructuredCaller {
  return async ({ schema, system, user, maxTokens }) => {
    let outputFailure: string | undefined;
    try {
      const format = zodOutputFormat(schema);
      const parse = format.parse;
      format.parse = (content) => {
        try { return parse(content); } catch (error) {
          // The SDK wraps Zod issues in an AnthropicError without a typed cause.
          // Diagnose at the parse boundary before that detail is discarded.
          outputFailure = outputFailureReason(schema, content);
          throw error;
        }
      };
      const response = await client.messages.parse({
        model: AI_MODEL,
        max_tokens: maxTokens ?? 4000,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        output_config: { format, effort: 'low' },
        messages: [{ role: 'user', content: user }],
      });
      meter.add(response.usage);
      if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens' || response.parsed_output === null) {
        meter.addFailure(response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens'
          ? response.stop_reason : 'parsed_output_null');
        return null;
      }
      return schema.parse(response.parsed_output);
    } catch (error) {
      meter.addFailure(outputFailure ?? errorReason(error));
      if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.NotFoundError) throw error;
      return null;
    }
  };
}
