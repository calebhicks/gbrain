import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  toolLoop,
  classifyToolLoopFallbackFailure,
  __setChatTransportForTests,
  configureGateway,
  resetGateway,
  type ChatBlock,
  type ToolLoopFallbackEvent,
  type ToolHandler,
} from '../../src/core/ai/gateway.ts';
import { AIConfigError, AITransientError } from '../../src/core/ai/errors.ts';

describe('gateway.toolLoop (v0.38 D11 — provider-agnostic loop control)', () => {
  beforeEach(() => {
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      expansion_model: 'anthropic:claude-haiku-4-5',
      env: { ANTHROPIC_API_KEY: 'stub', OPENAI_API_KEY: 'stub' },
    });
  });
  afterEach(() => {
    __setChatTransportForTests(null);
    resetGateway();
  });

  it('exits cleanly on end stop_reason with no tools', async () => {
    __setChatTransportForTests(async () => ({
      text: 'hello world',
      blocks: [{ type: 'text', text: 'hello world' }] as ChatBlock[],
      stopReason: 'end',
      usage: { input_tokens: 5, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    }));

    const result = await toolLoop({
      initialMessages: [{ role: 'user', content: 'hi' }],
      tools: [],
      toolHandlers: new Map(),
    });

    expect(result.stopReason).toBe('end');
    expect(result.finalText).toBe('hello world');
    expect(result.totalTurns).toBe(0); // First turn ended cleanly without tool dispatch
    expect(result.totalUsage.input_tokens).toBe(5);
    expect('fallbackEvents' in result).toBe(false);
  });

  it("propagates 'length' when a zero-tool-call turn hit the output cap (#4088)", async () => {
    __setChatTransportForTests(async () => ({
      text: 'truncated partial outp',
      blocks: [{ type: 'text', text: 'truncated partial outp' }] as ChatBlock[],
      stopReason: 'length',
      usage: { input_tokens: 22000, output_tokens: 8192, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    }));

    const result = await toolLoop({
      initialMessages: [{ role: 'user', content: 'hi' }],
      tools: [],
      toolHandlers: new Map(),
    });

    // NOT 'end' — an output-cap hit must stay distinguishable from a clean finish.
    expect(result.stopReason).toBe('length');
    expect(result.finalText).toBe('truncated partial outp');
  });

  it('dispatches a single tool call and feeds the result back to the next turn', async () => {
    let turn = 0;
    __setChatTransportForTests(async () => {
      turn++;
      if (turn === 1) {
        return {
          text: '',
          blocks: [
            { type: 'tool-call', toolCallId: 'tc1', toolName: 'search', input: { q: 'foo' } },
          ] as ChatBlock[],
          stopReason: 'tool_calls',
          usage: { input_tokens: 10, output_tokens: 4, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'anthropic:claude-sonnet-4-6',
          providerId: 'anthropic',
        };
      }
      return {
        text: 'final answer',
        blocks: [{ type: 'text', text: 'final answer' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 15, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-sonnet-4-6',
        providerId: 'anthropic',
      };
    });

    let toolWasCalled = false;
    const handler: ToolHandler = {
      idempotent: true,
      async execute(input) {
        toolWasCalled = true;
        expect(input).toEqual({ q: 'foo' });
        return { ok: true, results: [{ slug: 'foo/bar' }] };
      },
    };

    const result = await toolLoop({
      initialMessages: [{ role: 'user', content: 'find foo' }],
      tools: [{ name: 'search', description: 'search the brain', inputSchema: { type: 'object' } }],
      toolHandlers: new Map([['search', handler]]),
    });

    expect(toolWasCalled).toBe(true);
    expect(result.stopReason).toBe('end');
    expect(result.finalText).toBe('final answer');
    expect(result.totalUsage.input_tokens).toBe(25); // 10 + 15
    expect(result.totalUsage.output_tokens).toBe(9); // 4 + 5
  });

  it('captures persistence callbacks in order: assistant → tool start → tool complete', async () => {
    let turn = 0;
    __setChatTransportForTests(async () => {
      turn++;
      if (turn === 1) {
        return {
          text: '',
          blocks: [
            { type: 'tool-call', toolCallId: 'tc1', toolName: 'echo', input: { msg: 'hi' } },
          ] as ChatBlock[],
          stopReason: 'tool_calls',
          usage: { input_tokens: 5, output_tokens: 3, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'anthropic:claude-sonnet-4-6',
          providerId: 'anthropic',
        };
      }
      return {
        text: 'done',
        blocks: [{ type: 'text', text: 'done' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 5, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-sonnet-4-6',
        providerId: 'anthropic',
      };
    });

    const events: string[] = [];

    await toolLoop({
      initialMessages: [{ role: 'user', content: 'echo hi' }],
      tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }],
      toolHandlers: new Map([['echo', {
        idempotent: true,
        async execute(input) { events.push(`execute(${JSON.stringify(input)})`); return input; },
      }]]),
      onAssistantTurn: async (turnIdx, _msgIdx, _blocks, _usage, _model) => {
        events.push(`onAssistantTurn(${turnIdx})`);
      },
      onToolCallStart: async (turnIdx, _msgIdx, ordinal, toolName, _input, providerToolCallId) => {
        events.push(`onToolCallStart(turn=${turnIdx}, ordinal=${ordinal}, name=${toolName}, providerCallId=${providerToolCallId})`);
        return { gbrainToolUseId: `gb-${turnIdx}-${ordinal}` };
      },
      onToolCallComplete: async (gbrainToolUseId, _output) => {
        events.push(`onToolCallComplete(${gbrainToolUseId})`);
      },
    });

    // Write-ordering invariant: assistant persisted BEFORE pending tool row;
    // pending row persisted BEFORE execute; execute BEFORE complete.
    expect(events[0]).toBe('onAssistantTurn(0)');
    expect(events[1]).toMatch(/onToolCallStart\(turn=0, ordinal=0, name=echo/);
    expect(events[2]).toMatch(/execute/);
    expect(events[3]).toMatch(/onToolCallComplete\(gb-0-0\)/);
    expect(events[4]).toBe('onAssistantTurn(1)'); // final assistant turn
  });

  it('persists the tool-result user turn via onToolResultTurn before the next chat', async () => {
    let turn = 0;
    __setChatTransportForTests(async () => {
      turn++;
      if (turn === 1) {
        return {
          text: '',
          blocks: [{ type: 'tool-call', toolCallId: 'tc1', toolName: 'search', input: { q: 'x' } }] as ChatBlock[],
          stopReason: 'tool_calls',
          usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'anthropic:claude-sonnet-4-6',
          providerId: 'anthropic',
        };
      }
      return {
        text: 'done',
        blocks: [{ type: 'text', text: 'done' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-sonnet-4-6',
        providerId: 'anthropic',
      };
    });

    const resultTurns: Array<{ turnIdx: number; messageIdx: number; blocks: ChatBlock[] }> = [];
    await toolLoop({
      initialMessages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'search', description: 's', inputSchema: { type: 'object' } }],
      toolHandlers: new Map([['search', { idempotent: true, async execute() { return { hits: 1 }; } }]]),
      onToolResultTurn: async (turnIdx, messageIdx, blocks) => {
        resultTurns.push({ turnIdx, messageIdx, blocks });
      },
    });

    // Fired exactly once, for the single tool round, carrying the tool-result.
    expect(resultTurns).toHaveLength(1);
    expect(resultTurns[0].turnIdx).toBe(0);
    expect(resultTurns[0].blocks[0].type).toBe('tool-result');
    expect((resultTurns[0].blocks[0] as Extract<ChatBlock, { type: 'tool-result' }>).toolCallId).toBe('tc1');
  });

  it('replay short-circuits a complete prior tool execution', async () => {
    let chatCalls = 0;
    __setChatTransportForTests(async () => {
      chatCalls++;
      // Turn 1 emits a tool call. Turn 2 finishes.
      if (chatCalls === 1) {
        return {
          text: '',
          blocks: [
            { type: 'tool-call', toolCallId: 'provider-id-1', toolName: 'work', input: { x: 1 } },
          ] as ChatBlock[],
          stopReason: 'tool_calls',
          usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'anthropic:claude-sonnet-4-6',
          providerId: 'anthropic',
        };
      }
      return {
        text: 'fin',
        blocks: [{ type: 'text', text: 'fin' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-sonnet-4-6',
        providerId: 'anthropic',
      };
    });

    let executed = false;
    const result = await toolLoop({
      initialMessages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'work', description: 'w', inputSchema: { type: 'object' } }],
      toolHandlers: new Map([['work', {
        idempotent: false,
        async execute() { executed = true; return 'fresh'; },
      }]]),
      onToolCallStart: async () => ({ gbrainToolUseId: 'gb-replay-key' }),
      replayState: {
        priorMessages: [],
        priorTools: new Map([['gb-replay-key', {
          status: 'complete' as const,
          output: 'from-prior-run',
        }]]),
        nextTurnIdx: 0,
        nextMessageIdx: 0,
      },
    });

    expect(executed).toBe(false); // replay short-circuit
    expect(result.stopReason).toBe('end');
    expect(result.finalText).toBe('fin');
  });

  it('refuses replay of non-idempotent pending tool with unrecoverable error', async () => {
    __setChatTransportForTests(async () => ({
      text: '',
      blocks: [
        { type: 'tool-call', toolCallId: 'tc-non-idem', toolName: 'mutate', input: {} },
      ] as ChatBlock[],
      stopReason: 'tool_calls',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    }));

    await expect(
      toolLoop({
        initialMessages: [{ role: 'user', content: 'go' }],
        tools: [{ name: 'mutate', description: 'm', inputSchema: { type: 'object' } }],
        toolHandlers: new Map([['mutate', { idempotent: false, async execute() { return null; } }]]),
        onToolCallStart: async () => ({ gbrainToolUseId: 'gb-pending-key' }),
        replayState: {
          priorMessages: [],
          priorTools: new Map([['gb-pending-key', { status: 'pending' as const }]]),
          nextTurnIdx: 0,
          nextMessageIdx: 0,
        },
      }),
    ).rejects.toThrow(/non-idempotent.*pending/i);
  });

  it('defaults max output tokens per model: 4096 for non-thinking, 32000 for routed Claude 5', async () => {
    const seen: Array<number | undefined> = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts.maxTokens);
      return {
        text: 'ok',
        blocks: [{ type: 'text', text: 'ok' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: opts.model ?? 'anthropic:claude-sonnet-4-6',
        providerId: 'anthropic',
      };
    });

    await toolLoop({ model: 'openai:gpt-4o', initialMessages: [{ role: 'user', content: 'hi' }], tools: [], toolHandlers: new Map() });
    await toolLoop({ model: 'anthropic:claude-sonnet-4-6', initialMessages: [{ role: 'user', content: 'hi' }], tools: [], toolHandlers: new Map() });
    await toolLoop({ model: 'anthropic:claude-sonnet-5', initialMessages: [{ role: 'user', content: 'hi' }], tools: [], toolHandlers: new Map() });
    await toolLoop({ model: 'anthropic:claude-fable-5', initialMessages: [{ role: 'user', content: 'hi' }], tools: [], toolHandlers: new Map() });
    await toolLoop({ model: 'openrouter:anthropic/claude-sonnet-5', initialMessages: [{ role: 'user', content: 'hi' }], tools: [], toolHandlers: new Map() });
    await toolLoop({ model: 'openrouter:openai/gpt-5.2', initialMessages: [{ role: 'user', content: 'hi' }], tools: [], toolHandlers: new Map() });

    // Non-thinking / non-Claude-5 stay 4096 (safe under openai-compat caps);
    // thinking-by-default Claude 5 models get 32000 headroom, even when
    // reached through an OpenRouter provider prefix.
    expect(seen).toEqual([4096, 4096, 32000, 32000, 32000, 4096]);
  });

  it('hits max_turns when the model keeps calling tools', async () => {
    __setChatTransportForTests(async () => ({
      text: '',
      blocks: [
        { type: 'tool-call', toolCallId: `tc-${Math.random()}`, toolName: 'loop', input: {} },
      ] as ChatBlock[],
      stopReason: 'tool_calls',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    }));

    const result = await toolLoop({
      initialMessages: [{ role: 'user', content: 'loop' }],
      tools: [{ name: 'loop', description: 'l', inputSchema: { type: 'object' } }],
      toolHandlers: new Map([['loop', { idempotent: true, async execute() { return null; } }]]),
      maxTurns: 3,
    });

    expect(result.stopReason).toBe('max_turns');
    expect(result.totalTurns).toBeGreaterThanOrEqual(3);
  });

  it('returns refusal reason without dispatching tools when stopReason=refusal', async () => {
    __setChatTransportForTests(async () => ({
      text: 'I cannot help with that',
      blocks: [{ type: 'text', text: 'I cannot help with that' }] as ChatBlock[],
      stopReason: 'refusal',
      usage: { input_tokens: 1, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    }));

    let toolWasCalled = false;
    const result = await toolLoop({
      initialMessages: [{ role: 'user', content: 'bad request' }],
      tools: [{ name: 'work', description: 'w', inputSchema: { type: 'object' } }],
      toolHandlers: new Map([['work', { idempotent: true, async execute() { toolWasCalled = true; return null; } }]]),
    });

    expect(toolWasCalled).toBe(false);
    expect(result.stopReason).toBe('refusal');
    expect(result.finalText).toBe('I cannot help with that');
  });

  it('does not touch fallback models when the primary succeeds', async () => {
    const seenModels: Array<string | undefined> = [];
    __setChatTransportForTests(async (opts) => {
      seenModels.push(opts.model);
      return {
        text: 'primary',
        blocks: [{ type: 'text', text: 'primary' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: opts.model ?? 'anthropic:claude-sonnet-4-6',
        providerId: 'anthropic',
      };
    });

    const result = await toolLoop({
      model: 'anthropic:claude-sonnet-4-6',
      fallbackModels: ['openai:gpt-4o'],
      initialMessages: [{ role: 'user', content: 'hi' }],
      tools: [],
      toolHandlers: new Map(),
    });

    expect(result.finalText).toBe('primary');
    expect(seenModels).toEqual(['anthropic:claude-sonnet-4-6']);
    expect(result.fallbackEvents).toEqual([]);
  });

  it('falls back on eligible provider infrastructure failure and persists the actual model', async () => {
    const seenModels: string[] = [];
    const persistedModels: string[] = [];
    const fallbackEvents: ToolLoopFallbackEvent[] = [];
    __setChatTransportForTests(async (opts) => {
      seenModels.push(opts.model ?? 'default');
      if (opts.model === 'anthropic:claude-sonnet-4-6') {
        const err = new Error('rate limit') as Error & { status: number };
        err.status = 429;
        throw err;
      }
      return {
        text: 'fallback answer',
        blocks: [{ type: 'text', text: 'fallback answer' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 2, output_tokens: 3, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'openai:gpt-4o',
        providerId: 'openai',
      };
    });

    const result = await toolLoop({
      model: 'anthropic:claude-sonnet-4-6',
      fallbackModels: ['openai:gpt-4o'],
      initialMessages: [{ role: 'user', content: 'hi' }],
      tools: [],
      toolHandlers: new Map(),
      onAssistantTurn: async (_turnIdx, _messageIdx, _blocks, _usage, model) => {
        persistedModels.push(model);
      },
      onModelFallback: async (event) => {
        fallbackEvents.push(event);
      },
    });

    expect(result.finalText).toBe('fallback answer');
    expect(seenModels).toEqual(['anthropic:claude-sonnet-4-6', 'openai:gpt-4o']);
    expect(persistedModels).toEqual(['openai:gpt-4o']);
    expect(fallbackEvents).toEqual([{
      turnIdx: 0,
      primaryModel: 'anthropic:claude-sonnet-4-6',
      failedModel: 'anthropic:claude-sonnet-4-6',
      fallbackModel: 'openai:gpt-4o',
      reason: 'rate_limit',
      error: 'rate limit',
    }]);
    expect(result.fallbackEvents).toEqual(fallbackEvents);
  });

  it('classifies provider HTTP 408 and ETIMEDOUT as fallback-eligible timeouts', () => {
    const http408 = new Error('request timeout') as Error & { status: number };
    http408.status = 408;
    expect(classifyToolLoopFallbackFailure(http408)).toEqual({ eligible: true, reason: 'timeout' });
    expect(classifyToolLoopFallbackFailure(new Error('connect ETIMEDOUT upstream')))
      .toEqual({ eligible: true, reason: 'timeout' });
  });

  it('falls back after chat normalizes a real transport HTTP 408', async () => {
    const seenModels: string[] = [];
    __setChatTransportForTests(async (opts) => {
      seenModels.push(opts.model ?? 'default');
      if (opts.model === 'anthropic:claude-sonnet-4-6') {
        const err = new Error('provider request timeout') as Error & { status: number };
        err.status = 408;
        throw err;
      }
      return {
        text: 'recovered from 408',
        blocks: [{ type: 'text', text: 'recovered from 408' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 2, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'openai:gpt-4o',
        providerId: 'openai',
      };
    });

    const result = await toolLoop({
      model: 'anthropic:claude-sonnet-4-6',
      fallbackModels: ['openai:gpt-4o'],
      initialMessages: [{ role: 'user', content: 'hi' }],
      tools: [],
      toolHandlers: new Map(),
    });

    expect(result.finalText).toBe('recovered from 408');
    expect(seenModels).toEqual(['anthropic:claude-sonnet-4-6', 'openai:gpt-4o']);
    expect(result.fallbackEvents?.[0]).toMatchObject({
      failedModel: 'anthropic:claude-sonnet-4-6',
      fallbackModel: 'openai:gpt-4o',
      reason: 'timeout',
    });
  });

  it('does not fall back on ineligible request/config failures', async () => {
    const original = new AIConfigError('bad request', 'fix it');
    let calls = 0;
    __setChatTransportForTests(async () => {
      calls++;
      throw original;
    });

    try {
      await toolLoop({
        model: 'anthropic:claude-sonnet-4-6',
        fallbackModels: ['openai:gpt-4o'],
        initialMessages: [{ role: 'user', content: 'hi' }],
        tools: [],
        toolHandlers: new Map(),
      });
      throw new Error('expected toolLoop to throw');
    } catch (err) {
      expect(err).toBe(original);
    }
    expect(calls).toBe(1);
  });

  it('throws the last eligible provider error after exhausting the fallback chain', async () => {
    const seenModels: string[] = [];
    __setChatTransportForTests(async (opts) => {
      seenModels.push(opts.model ?? 'default');
      const err = new AITransientError(`provider unavailable: ${opts.model}`);
      (err as AITransientError & { status: number }).status = 503;
      throw err;
    });

    await expect(toolLoop({
      model: 'anthropic:claude-sonnet-4-6',
      fallbackModels: ['openai:gpt-4o', 'google:gemini-2.5-pro'],
      initialMessages: [{ role: 'user', content: 'hi' }],
      tools: [],
      toolHandlers: new Map(),
    })).rejects.toThrow(/provider unavailable: google:gemini-2\.5-pro/);
    expect(seenModels).toEqual([
      'anthropic:claude-sonnet-4-6',
      'openai:gpt-4o',
      'google:gemini-2.5-pro',
    ]);
  });

  it('does not replay tool handlers when a later turn falls back', async () => {
    let calls = 0;
    let executes = 0;
    const seen: Array<{ model: string | undefined; messages: number }> = [];
    __setChatTransportForTests(async (opts) => {
      calls++;
      seen.push({ model: opts.model, messages: opts.messages.length });
      if (calls === 1) {
        return {
          text: '',
          blocks: [{ type: 'tool-call', toolCallId: 'tc1', toolName: 'search', input: { q: 'x' } }] as ChatBlock[],
          stopReason: 'tool_calls',
          usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'anthropic:claude-sonnet-4-6',
          providerId: 'anthropic',
        };
      }
      if (opts.model === 'anthropic:claude-sonnet-4-6') {
        const err = new Error('upstream 500') as Error & { status: number };
        err.status = 500;
        throw err;
      }
      return {
        text: 'done',
        blocks: [{ type: 'text', text: 'done' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'openai:gpt-4o',
        providerId: 'openai',
      };
    });

    const result = await toolLoop({
      model: 'anthropic:claude-sonnet-4-6',
      fallbackModels: ['openai:gpt-4o'],
      initialMessages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'search', description: 's', inputSchema: { type: 'object' } }],
      toolHandlers: new Map([['search', {
        idempotent: true,
        async execute() {
          executes++;
          return { hits: 1 };
        },
      }]]),
      onToolCallStart: async () => ({ gbrainToolUseId: 'gb-1' }),
    });

    expect(result.finalText).toBe('done');
    expect(executes).toBe(1);
    expect(seen).toEqual([
      { model: 'anthropic:claude-sonnet-4-6', messages: 1 },
      { model: 'anthropic:claude-sonnet-4-6', messages: 3 },
      { model: 'openai:gpt-4o', messages: 3 },
    ]);
  });

  it('skips invalid fallback models deterministically', async () => {
    const seenModels: string[] = [];
    __setChatTransportForTests(async (opts) => {
      seenModels.push(opts.model ?? 'default');
      if (opts.model === 'anthropic:claude-sonnet-4-6') {
        const err = new Error('provider down') as Error & { status: number };
        err.status = 503;
        throw err;
      }
      return {
        text: 'valid fallback',
        blocks: [{ type: 'text', text: 'valid fallback' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'openai:gpt-4o',
        providerId: 'openai',
      };
    });

    const result = await toolLoop({
      model: 'anthropic:claude-sonnet-4-6',
      fallbackModels: ['gpt-4o', 'voyage:voyage-3-large', 'openai:gpt-4o'],
      initialMessages: [{ role: 'user', content: 'hi' }],
      tools: [],
      toolHandlers: new Map(),
    });

    expect(result.finalText).toBe('valid fallback');
    expect(seenModels).toEqual(['anthropic:claude-sonnet-4-6', 'openai:gpt-4o']);
  });

  it('preserves exact no-fallback error propagation', async () => {
    const original = new Error('raw transport failure');
    let calls = 0;
    __setChatTransportForTests(async () => {
      calls++;
      throw original;
    });

    try {
      await toolLoop({
        model: 'anthropic:claude-sonnet-4-6',
        fallbackModels: [],
        initialMessages: [{ role: 'user', content: 'hi' }],
        tools: [],
        toolHandlers: new Map(),
      });
      throw new Error('expected toolLoop to throw');
    } catch (err) {
      expect(err).toBe(original);
    }
    expect(calls).toBe(1);
  });

  it('classifies only explicit provider infrastructure failures as fallback-eligible', () => {
    const rate = new Error('too many') as Error & { status: number };
    rate.status = 429;
    expect(classifyToolLoopFallbackFailure(rate)).toEqual({ eligible: true, reason: 'rate_limit' });

    const unavailable = new Error('bad gateway') as Error & { statusCode: number };
    unavailable.statusCode = 502;
    expect(classifyToolLoopFallbackFailure(unavailable)).toEqual({ eligible: true, reason: 'provider_unavailable' });

    expect(classifyToolLoopFallbackFailure(new AITransientError('fetch failed: ECONNRESET'))).toEqual({ eligible: true, reason: 'network' });
    expect(classifyToolLoopFallbackFailure(new DOMException('The operation timed out.', 'TimeoutError'))).toEqual({ eligible: true, reason: 'timeout' });
    expect(classifyToolLoopFallbackFailure(new AIConfigError('401 unauthorized'))).toEqual({ eligible: false, reason: 'auth_or_config' });
    expect(classifyToolLoopFallbackFailure(new Error('malformed model output'))).toEqual({ eligible: false, reason: 'tool_or_validation' });
  });

  describe('acquireTurnPermit hook (#4194 CDX-7 — per-turn rate leases on the gateway path)', () => {
    it('acquires before EVERY provider call and releases after each (incl. the final turn)', async () => {
      const events: string[] = [];
      let turn = 0;
      __setChatTransportForTests(async () => {
        events.push(`chat${turn}`);
        turn++;
        if (turn === 1) {
          return {
            text: '',
            blocks: [{ type: 'tool-call', toolCallId: 'tc1', toolName: 'work', input: {} }] as ChatBlock[],
            stopReason: 'tool_calls',
            usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
            model: 'anthropic:claude-sonnet-4-6',
            providerId: 'anthropic',
          };
        }
        return {
          text: 'done',
          blocks: [{ type: 'text', text: 'done' }] as ChatBlock[],
          stopReason: 'end',
          usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'anthropic:claude-sonnet-4-6',
          providerId: 'anthropic',
        };
      });

      const result = await toolLoop({
        initialMessages: [{ role: 'user', content: 'go' }],
        tools: [{ name: 'work', description: 'w', inputSchema: { type: 'object' } }],
        toolHandlers: new Map([['work', { idempotent: true, async execute() { return null; } }]]),
        acquireTurnPermit: async () => {
          events.push('acquire');
          return () => { events.push('release'); };
        },
      });

      expect(result.stopReason).toBe('end');
      // Strict bracketing: acquire → chat → release, once per provider call.
      expect(events).toEqual(['acquire', 'chat0', 'release', 'acquire', 'chat1', 'release']);
    });

    it('releases the permit even when the provider call throws', async () => {
      const events: string[] = [];
      __setChatTransportForTests(async () => {
        throw new Error('provider exploded');
      });

      await expect(toolLoop({
        initialMessages: [{ role: 'user', content: 'go' }],
        tools: [],
        toolHandlers: new Map(),
        acquireTurnPermit: async () => {
          events.push('acquire');
          return () => { events.push('release'); };
        },
      })).rejects.toThrow('provider exploded');

      expect(events).toEqual(['acquire', 'release']); // no leaked lease
    });

    it('an acquire failure (lease full) propagates to the caller WITHOUT a provider call', async () => {
      let chatCalls = 0;
      __setChatTransportForTests(async () => {
        chatCalls++;
        throw new Error('should never be reached');
      });

      class FakeLeaseFull extends Error {}
      await expect(toolLoop({
        initialMessages: [{ role: 'user', content: 'go' }],
        tools: [],
        toolHandlers: new Map(),
        acquireTurnPermit: async () => { throw new FakeLeaseFull('bucket full'); },
      })).rejects.toThrow('bucket full');

      expect(chatCalls).toBe(0); // permit gates the provider call, not just accounting
    });

    it('object-form permit: release runs, and aborting the permit signal aborts the in-flight call', async () => {
      const events: string[] = [];
      const leaseLost = new AbortController();
      __setChatTransportForTests(async (opts: any) =>
        new Promise((_, reject) => {
          opts.abortSignal?.addEventListener('abort', () =>
            reject(new DOMException('lease pruned mid-call', 'AbortError')));
        }));

      const loop = toolLoop({
        initialMessages: [{ role: 'user', content: 'go' }],
        tools: [],
        toolHandlers: new Map(),
        acquireTurnPermit: async () => ({
          release: () => { events.push('release'); },
          signal: leaseLost.signal,
        }),
      });
      setTimeout(() => leaseLost.abort(), 20);
      await expect(loop).rejects.toThrow('lease pruned mid-call');
      // The permit was still released (finally bracket) even on abort.
      expect(events).toEqual(['release']);
    });

    it('a throwing release is swallowed (best-effort) and the loop result is unaffected', async () => {
      __setChatTransportForTests(async () => ({
        text: 'fine',
        blocks: [{ type: 'text', text: 'fine' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-sonnet-4-6',
        providerId: 'anthropic',
      }));

      const result = await toolLoop({
        initialMessages: [{ role: 'user', content: 'go' }],
        tools: [],
        toolHandlers: new Map(),
        acquireTurnPermit: async () => async () => { throw new Error('release hiccup'); },
      });

      expect(result.stopReason).toBe('end');
      expect(result.finalText).toBe('fine');
    });
  });
});
