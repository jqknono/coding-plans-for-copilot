import assert from 'node:assert/strict';
import type * as vscode from 'vscode';
import type { ConfigStore, VendorApiStyle, VendorConfig } from '../config/configStore';
import { GenericAIProvider, GenericLanguageModel } from '../providers/genericProvider';
import { resolveRequestBudget } from '../providers/contextBudget';
import type { ResolvedModelBudget } from '../providers/contextBudget';
import { readAttachedTokenUsage } from '../providers/tokenUsage';
import { normalizeModelsDevCatalog } from '../providers/modelsDevCatalog';
import type { AIModelConfig } from '../providers/baseProvider';

function createCancellation(): { token: vscode.CancellationToken; cancel(): void; listenerCount(): number } {
  let cancelled = false;
  const listeners = new Set<() => void>();
  return {
    token: {
      get isCancellationRequested() {
        return cancelled;
      },
      onCancellationRequested: ((listener: () => void) => {
        listeners.add(listener);
        return {
          dispose: () => {
            listeners.delete(listener);
          },
        };
      }) as vscode.Event<unknown>,
    },
    cancel: () => {
      cancelled = true;
      for (const listener of listeners) {
        listener();
      }
    },
    listenerCount: () => listeners.size,
  };
}

function createHarness(apiStyle: VendorApiStyle = 'chat-completions', streaming = false) {
  const vendor: VendorConfig = {
    name: 'runtime',
    baseUrl: 'https://runtime.example.test/v1',
    defaultApiStyle: apiStyle,
    useModelsEndpoint: false,
    defaultVision: false,
    models: [
      {
        name: 'model',
        apiStyle,
        streaming,
        contextWindow: 400000,
        maxInputTokens: 300000,
        maxOutputTokens: 100000,
        limitSource: 'configured',
        contextBudget: { inputTokens: 128000, outputTokens: 64000 },
        capabilities: { thinking: true },
        supportsReasoningEffort: ['high'],
      },
    ],
  };
  let onChange: (() => void) | undefined;
  const store = {
    onDidChange: (listener: () => void) => {
      onChange = listener;
      return { dispose() {} };
    },
    getVendors: () => [vendor],
    getApiKey: async () => 'runtime-test-key',
    isAutoRefreshModelsEnabled: () => false,
  };
  const provider = new GenericAIProvider({} as vscode.ExtensionContext, store as unknown as ConfigStore);
  return { provider, vendor, store, change: () => onChange?.() };
}

async function readText(response: vscode.LanguageModelChatResponse): Promise<string> {
  let text = '';
  for await (const part of response.text) {
    text += part;
  }
  return text;
}

function responseBudget(response: vscode.LanguageModelChatResponse): ResolvedModelBudget {
  return (response as vscode.LanguageModelChatResponse & { contextBudget: ResolvedModelBudget }).contextBudget;
}

/** 独立验证发现端点的能力合并；可在共享请求预算接口更新前运行。 */
export async function runContextRuntimeDiscoveryTests(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const { provider, vendor } = createHarness();
  try {
    const catalog = normalizeModelsDevCatalog({
      models: {
        'endpoint-all': { limit: { context: 400000, input: 300000, output: 100000 } },
        'endpoint-output': { limit: { context: 400000, input: 300000, output: 100000 } },
        'catalog-only': { limit: { context: 400000, input: 300000, output: 100000 } },
      },
    });
    Reflect.set(provider, 'modelsDevCatalogPromise', Promise.resolve(catalog));
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'endpoint-all', context_length: 200000, max_input_tokens: 180000, max_output_tokens: 80000 },
            { id: 'endpoint-output', max_output_tokens: 70000 },
            { id: 'catalog-only' },
            { id: 'input-output-only', max_input_tokens: 120000, max_output_tokens: 60000 },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    const discover = Reflect.get(provider, 'discoverModelsFromApi') as (
      vendor: VendorConfig,
      key: string,
    ) => Promise<{ models: AIModelConfig[]; failed: boolean }>;
    const result = await discover.call(provider, vendor, 'runtime-test-key');
    assert.equal(result.failed, false);
    assert.equal(result.models.length, 4);
    assert.deepEqual(
      result.models.map((model) => model.tokenLimits),
      [
        { contextWindow: 200000, maxInputTokens: 180000, maxOutputTokens: 80000, limitSource: 'endpoint' },
        { contextWindow: 400000, maxInputTokens: 300000, maxOutputTokens: 70000, limitSource: 'endpoint' },
        { contextWindow: 400000, maxInputTokens: 300000, maxOutputTokens: 100000, limitSource: 'models.dev' },
        { contextWindow: undefined, maxInputTokens: 120000, maxOutputTokens: 60000, limitSource: 'endpoint' },
      ],
    );
    assert.equal(result.models[3].contextWindow, undefined, '仅提供输入输出上限时，总窗口能力保持原状');
  } finally {
    globalThis.fetch = originalFetch;
    provider.dispose();
  }
}

/** 配置变化始终本地重建，自动发现关闭时也使用最新模型配置。 */
export async function runContextRuntimeRefreshTests(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const harness = createHarness();
  try {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ data: [] }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    await harness.provider.refreshModels();
    assert.equal(harness.provider.getModel('runtime/model')?.streaming, false);
    harness.vendor.useModelsEndpoint = true;
    harness.vendor.models[0].streaming = true;
    harness.change();
    await harness.provider.refreshModels();
    assert.equal(harness.provider.getModel('runtime/model')?.streaming, true);
    assert.equal(calls, 0, '配置刷新仅本地重建');
  } finally {
    globalThis.fetch = originalFetch;
    harness.provider.dispose();
  }
}

/** 刷新等待凭据时，已发布模型及其映射继续提供服务。 */
export async function runContextRuntimeRefreshAvailabilityTests(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const { provider, vendor, store } = createHarness();
  let releaseRefresh!: (key: string) => void;
  let refreshing: Promise<void> | undefined;
  try {
    await provider.refreshModels();
    const currentModel = provider.getModel('runtime/model')!;
    vendor.baseUrl = 'https://next.example.test/v1';
    vendor.models[0].contextBudget = { inputTokens: 32000, outputTokens: 16000 };
    let keyReads = 0;
    store.getApiKey = () => {
      keyReads += 1;
      return keyReads === 1
        ? new Promise<string>((resolve) => {
            releaseRefresh = resolve;
          })
        : Promise.resolve('runtime-test-key');
    };
    refreshing = provider.refreshModels();
    const concurrentRefresh = provider.refreshModels();
    const requests: string[] = [];
    globalThis.fetch = (async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'available' } }] }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    assert.equal(provider.getModel('runtime/model'), currentModel);
    const response = await currentModel.sendRequest([]);
    assert.equal(await readText(response), 'available');
    assert.equal(responseBudget(response).outputTokens, 64000);
    assert.equal(requests[0], 'https://runtime.example.test/v1/chat/completions');

    releaseRefresh('runtime-test-key');
    await Promise.all([refreshing, concurrentRefresh]);
    const nextModel = provider.getModel('runtime/model')!;
    const nextResponse = await nextModel.sendRequest([]);
    assert.equal(await readText(nextResponse), 'available');
    assert.equal(responseBudget(nextResponse).outputTokens, 16000);
    assert.equal(requests[1], 'https://next.example.test/v1/chat/completions');
  } finally {
    releaseRefresh?.('runtime-test-key');
    await refreshing;
    globalThis.fetch = originalFetch;
    provider.dispose();
  }
}

/** adapter 可在重试循环外准备一次，后续尝试沿用端点、凭据与预算。 */
export async function runContextRuntimePreparedRequestTests(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const { provider, vendor, store } = createHarness();
  try {
    await provider.refreshModels();
    const model = provider.getModel('runtime/model') as GenericLanguageModel;
    let keyReads = 0;
    store.getApiKey = async () => {
      keyReads += 1;
      return 'captured-key';
    };
    const options = { modelOptions: { contextSize: 64000, thinkingEffort: 'high' } };
    const prepared = model.prepareRequestOptions(options);
    assert.equal(keyReads, 1, '准备阶段同步启动凭据读取');
    assert.deepEqual(prepared, options, '公开 options 保持原有字段结构');
    assert.ok(prepared !== options);
    assert.ok(prepared.modelOptions !== options.modelOptions);
    options.modelOptions.thinkingEffort = 'low';

    const requests: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url, init) => {
      requests.push({
        url: String(url),
        auth: new Headers(init?.headers).get('authorization'),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'captured' } }] }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    vendor.baseUrl = 'https://rotated.example.test/v1';
    vendor.authType = 'x-api-key';
    vendor.models[0].contextBudget = { inputTokens: 16000, outputTokens: 8000 };
    vendor.models[0].capabilities = { thinking: false };
    vendor.models[0].supportsReasoningEffort = [];
    store.getApiKey = async () => 'rotated-key';
    await provider.refreshModels();
    const first = await model.sendRequest([], prepared);
    assert.equal(await readText(first), 'captured');

    vendor.baseUrl = 'https://retry-refresh.example.test/v1';
    await provider.refreshModels();
    assert.equal(model.prepareRequestOptions(prepared), prepared);
    const retry = await model.sendRequest([], prepared);
    assert.equal(await readText(retry), 'captured');
    assert.deepEqual(responseBudget(retry), responseBudget(first));
    assert.equal(responseBudget(retry).inputTokens, 64000);
    assert.equal(responseBudget(retry).outputTokens, 64000);
    for (const request of requests) {
      assert.equal(request.url, 'https://runtime.example.test/v1/chat/completions');
      assert.equal(request.auth, 'Bearer captured-key');
      assert.equal(request.body.max_tokens, 64000);
      assert.equal(request.body.reasoning_effort, 'high');
      assert.deepEqual(Object.keys(request.body).sort(), [
        'max_tokens',
        'messages',
        'model',
        'reasoning_effort',
        'stream',
      ]);
    }
    assert.equal(requests.length, 2);
    assert.equal(keyReads, 1, '各次尝试复用捕获的凭据');
    assert.equal(provider.getModel('runtime/model')!.contextBudget.outputTokens, 8000);
  } finally {
    globalThis.fetch = originalFetch;
    provider.dispose();
  }
}

/** 安装现有 vscode mock 后调用；通过本地模拟独立验证运行时行为。 */
export async function runContextRuntimeTests(): Promise<void> {
  await runContextRuntimeDiscoveryTests();
  await runContextRuntimeRefreshTests();
  await runContextRuntimeRefreshAvailabilityTests();
  await runContextRuntimePreparedRequestTests();
  const originalFetch = globalThis.fetch;
  try {
    for (const apiStyle of ['chat-completions', 'responses', 'messages'] as const) {
      const { provider } = createHarness(apiStyle);
      try {
        await provider.refreshModels();
        const model = provider.getModel('runtime/model')!;
        const expected = resolveRequestBudget(model.contextBudget, 64000);
        let body: Record<string, unknown> = {};
        globalThis.fetch = (async (_url, init) => {
          body = JSON.parse(String(init?.body));
          const payload =
            apiStyle === 'messages'
              ? { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 2, output_tokens: 1 } }
              : apiStyle === 'responses'
                ? { output_text: 'ok', usage: { input_tokens: 2, output_tokens: 1 } }
                : { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 2, completion_tokens: 1 } };
          return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
        }) as typeof fetch;
        const cancellation = createCancellation();
        const response = await model.sendRequest([], { modelOptions: { contextSize: 64000 } }, cancellation.token);
        assert.equal(await readText(response), 'ok');
        assert.equal(body[apiStyle === 'responses' ? 'max_output_tokens' : 'max_tokens'], 64000);
        assert.deepEqual(responseBudget(response), expected);
        assert.ok(Object.isFrozen(responseBudget(response)));
        assert.equal(readAttachedTokenUsage(response)?.outputBuffer, expected.outputTokens);
        assert.equal(cancellation.listenerCount(), 0, '普通响应完成即释放取消监听');
        assert.deepEqual(model.tokenLimits, {
          contextWindow: 400000,
          maxInputTokens: 300000,
          maxOutputTokens: 100000,
          limitSource: 'configured',
        });
      } finally {
        provider.dispose();
      }
    }

    // API key 等待期间配置、模型及调用方 options 都变化，在途请求仍使用入口快照。
    const snapshot = createHarness();
    try {
      await snapshot.provider.refreshModels();
      const model = snapshot.provider.getModel('runtime/model')!;
      let releaseKey!: (key: string) => void;
      snapshot.store.getApiKey = () =>
        new Promise<string>((resolve) => {
          releaseKey = resolve;
        });
      let body: Record<string, unknown> = {};
      let requestUrl = '';
      globalThis.fetch = (async (url, init) => {
        requestUrl = String(url);
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ choices: [{ message: { content: 'snapshot' } }] }), {
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch;
      const options = { modelOptions: { contextSize: 64000, thinkingEffort: 'high' } };
      const pending = model.sendRequest([], options);
      snapshot.vendor.baseUrl = 'https://changed.example.test';
      snapshot.vendor.models[0].streaming = true;
      snapshot.vendor.models[0].capabilities = { thinking: false };
      snapshot.vendor.models[0].contextBudget = { inputTokens: 10000, outputTokens: 1000 };
      options.modelOptions.thinkingEffort = 'low';
      snapshot.store.getApiKey = async () => 'runtime-test-key';
      await snapshot.provider.refreshModels();
      releaseKey('runtime-test-key');
      const response = await pending;
      assert.equal(await readText(response), 'snapshot');
      assert.equal(requestUrl, 'https://runtime.example.test/v1/chat/completions');
      assert.equal(body.stream, false);
      assert.equal(body.reasoning_effort, 'high');
      assert.equal(body.max_tokens, 64000);
      assert.equal(responseBudget(response).inputTokens, 64000);
      assert.equal(responseBudget(response).outputTokens, 64000);
    } finally {
      snapshot.provider.dispose();
    }

    const stream = createHarness('chat-completions', true);
    try {
      await stream.provider.refreshModels();
      let finish!: () => void;
      globalThis.fetch = (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              finish = () => {
                const chunk = {
                  choices: [{ delta: { content: 'stream' } }],
                  usage: { prompt_tokens: 2, completion_tokens: 1 },
                };
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`));
                controller.close();
              };
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        )) as typeof fetch;
      const cancellation = createCancellation();
      const response = await stream.provider.getModel('runtime/model')!.sendRequest([], undefined, cancellation.token);
      assert.equal(responseBudget(response).outputTokens, 64000);
      assert.ok(Object.isFrozen(responseBudget(response)));
      assert.equal(cancellation.listenerCount(), 1, 'SSE 期间保留取消监听');
      finish();
      assert.equal(await readText(response), 'stream');
      assert.equal(readAttachedTokenUsage(response)?.outputBuffer, 64000);
      assert.equal(cancellation.listenerCount(), 0, 'SSE 结束释放取消监听');
    } finally {
      stream.provider.dispose();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}
