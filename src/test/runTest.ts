import assert from 'node:assert/strict';

type ConfigChangeListener = (event: { affectsConfiguration: (section: string) => boolean }) => void;

type UpdateCall = {
  key: string;
  value: unknown;
  target: unknown;
};

type VendorModelRecord = {
  name: string;
  description?: string;
  apiStyle?: 'openai-chat' | 'openai-responses' | 'anthropic';
  temperature?: number;
  topP?: number;
  capabilities?: {
    tools?: boolean;
    vision?: boolean;
  };
  contextSize?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
};

type VendorRecord = {
  name: string;
  baseUrl: string;
  defaultApiStyle?: 'openai-chat' | 'openai-responses' | 'anthropic';
  defaultTemperature?: number;
  defaultTopP?: number;
  defaultVision?: boolean;
  apiStyle?: 'openai-chat' | 'openai-responses' | 'anthropic';
  models: VendorModelRecord[];
};

type MockState = {
  vendors: unknown[];
  updates: UpdateCall[];
  listeners: Set<ConfigChangeListener>;
};

type ConfigStoreModule = typeof import('../config/configStore');
type ConfigStoreCtor = ConfigStoreModule['ConfigStore'];
type BaseProviderModule = typeof import('../providers/baseProvider');
type GenericProviderModule = typeof import('../providers/genericProvider');
type TokenUsageModule = typeof import('../providers/tokenUsage');
type ProtocolsModule = typeof import('../providers/genericProviderProtocols');

type TestContext = {
  state: MockState;
  changeCount: () => number;
};

type TestCase = {
  name: string;
  initialVendors: VendorRecord[];
  discoveredModels?: VendorModelRecord[];
  run?: (configStore: InstanceType<ConfigStoreCtor>) => Promise<void>;
  verify: (context: TestContext) => void;
};

class FakeDisposable {
  constructor(private readonly callback: () => void = () => {}) {}

  dispose(): void {
    this.callback();
  }
}

class FakeEventEmitter<T> {
  private listeners = new Set<(event: T) => void>();

  public readonly event = (listener: (event: T) => void): FakeDisposable => {
    this.listeners.add(listener);
    return new FakeDisposable(() => {
      this.listeners.delete(listener);
    });
  };

  fire(event: T): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

function createState(vendors: unknown[]): MockState {
  return {
    vendors,
    updates: [],
    listeners: new Set<ConfigChangeListener>()
  };
}

let activeState = createState([]);

function createVscodeMock() {
  const configurationTarget = {
    WorkspaceFolder: 1,
    Workspace: 2,
    Global: 3
  };

  class FakeLanguageModelTextPart {
    constructor(public readonly value: string) {}
  }

  class FakeLanguageModelToolCallPart {
    constructor(
      public readonly callId: string,
      public readonly name: string,
      public readonly input: unknown
    ) {}
  }

  class FakeLanguageModelToolResultPart {
    constructor(
      public readonly callId: string,
      public readonly content: unknown[]
    ) {}
  }

  class FakeLanguageModelDataPart {
    constructor(
      public readonly data: Uint8Array,
      public readonly mimeType: string
    ) {}
  }

  class FakeLanguageModelChatMessage {
    public readonly content: unknown[];

    constructor(
      public readonly role: number,
      content: string | unknown[],
      public readonly name?: string
    ) {
      this.content = typeof content === 'string' ? [new FakeLanguageModelTextPart(content)] : content;
    }
  }

  const fakeLanguageModelChatMessageCtor = FakeLanguageModelChatMessage as unknown as Record<string, unknown>;
  fakeLanguageModelChatMessageCtor['User'] = (content: string | unknown[], name?: string) => new FakeLanguageModelChatMessage(1, content, name);
  fakeLanguageModelChatMessageCtor['Assistant'] = (content: string | unknown[], name?: string) => new FakeLanguageModelChatMessage(2, content, name);

  class FakeChatRequestTurn {
    constructor(public readonly prompt: string) {}
  }

  class FakeMarkdownString {
    constructor(public readonly value: string) {}
  }

  class FakeChatResponseMarkdownPart {
    constructor(value: string) {
      this.value = new FakeMarkdownString(value);
    }

    public readonly value: FakeMarkdownString;
  }

  class FakeChatResponseTurn {
    constructor(public readonly response: unknown[]) {}
  }

  class FakeLanguageModelError extends Error {}

  return {
    EventEmitter: FakeEventEmitter,
    Disposable: FakeDisposable,
    ConfigurationTarget: configurationTarget,
    LanguageModelTextPart: FakeLanguageModelTextPart,
    LanguageModelToolCallPart: FakeLanguageModelToolCallPart,
    LanguageModelToolResultPart: FakeLanguageModelToolResultPart,
    LanguageModelDataPart: FakeLanguageModelDataPart,
    LanguageModelChatMessage: FakeLanguageModelChatMessage,
    LanguageModelChatToolMode: {
      Auto: 1,
      Required: 2
    },
    LanguageModelChatMessageRole: {
      User: 1,
      Assistant: 2
    },
    ChatRequestTurn: FakeChatRequestTurn,
    ChatResponseTurn: FakeChatResponseTurn,
    ChatResponseMarkdownPart: FakeChatResponseMarkdownPart,
    LanguageModelError: FakeLanguageModelError,
    Uri: {
      joinPath(...parts: unknown[]): string {
        return parts.map(String).join('/');
      }
    },
    window: {
      createOutputChannel() {
        return {
          appendLine(): void {
            return undefined;
          },
          dispose(): void {
            return undefined;
          }
        };
      }
    },
    lm: {
      async invokeTool(_name: string, _options: unknown): Promise<{ content: unknown[] }> {
        return { content: [new FakeLanguageModelTextPart('tool-result')] };
      }
    },
    workspace: {
      onDidChangeConfiguration(listener: ConfigChangeListener): FakeDisposable {
        activeState.listeners.add(listener);
        return new FakeDisposable(() => {
          activeState.listeners.delete(listener);
        });
      },
      getConfiguration(section: string) {
        assert.equal(section, 'coding-plans');
        return {
          get<T>(key: string, defaultValue: T): T {
            return key === 'vendors' ? (activeState.vendors as T) : defaultValue;
          },
          inspect<T>(key: string): { globalValue: T } {
            assert.equal(key, 'vendors');
            return { globalValue: activeState.vendors as T };
          },
          async update(key: string, value: unknown, target: unknown): Promise<void> {
            activeState.updates.push({ key, value, target });
            if (key === 'vendors') {
              activeState.vendors = value as unknown[];
              for (const listener of [...activeState.listeners]) {
                listener({
                  affectsConfiguration(changedSection: string): boolean {
                    return changedSection === 'coding-plans.vendors';
                  }
                });
              }
            }
          }
        };
      }
    }
  };
}

function installVscodeMock(): () => void {
  const moduleLoader = require('node:module') as Record<string, unknown>;
  const originalLoad = moduleLoader['_load'] as (request: string, parent: unknown, isMain: boolean) => unknown;
  const vscodeMock = createVscodeMock();

  moduleLoader['_load'] = function patchedLoad(request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'vscode') {
      return vscodeMock;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  return () => {
    moduleLoader['_load'] = originalLoad;
  };
}

function createExtensionContext(): { secrets: { get(): Promise<undefined>; store(): Promise<void>; delete(): Promise<void>; }; } {
  return {
    secrets: {
      async get(): Promise<undefined> {
        return undefined;
      },
      async store(): Promise<void> {
        return undefined;
      },
      async delete(): Promise<void> {
        return undefined;
      }
    }
  };
}

function createVendorWithSpacedModelName(): VendorRecord {
  return {
    name: 'Vendor',
    baseUrl: 'https://example.test/v1',
    models: [
      {
        name: ' gpt-4o ',
        description: 'Keep me',
        temperature: 0.25,
        topP: 0.95,
        capabilities: { tools: true, vision: false },
        maxInputTokens: 64000,
        maxOutputTokens: 64000
      }
    ]
  };
}

function getUpdatedVendor(state: MockState): VendorRecord {
  return (state.vendors as VendorRecord[])[0];
}

function verifyNoWriteback(context: TestContext, message: string): void {
  assert.equal(context.state.updates.length, 0, `${message}时不应写回 vendors 配置`);
  assert.equal(context.changeCount(), 0, `${message}时不应触发 ConfigStore 变更事件`);
}

const testCases: TestCase[] = [
  {
    name: '仅名称前后空格不同不写回',
    initialVendors: [createVendorWithSpacedModelName()],
    discoveredModels: [{ name: 'gpt-4o' }],
    verify(context) {
      verifyNoWriteback(context, '仅名称空格差异');
    }
  },
  {
    name: '仅大小写不同不写回',
    initialVendors: [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        models: [
          {
            name: 'GPT-4o',
            description: 'Case stable',
            capabilities: { tools: true, vision: false },
            maxInputTokens: 64000,
            maxOutputTokens: 64000
          }
        ]
      }
    ],
    discoveredModels: [{ name: 'gpt-4o' }],
    verify(context) {
      verifyNoWriteback(context, '仅名称大小写差异');
    }
  },
  {
    name: '成员变化时规范化旧名称并保留字段',
    initialVendors: [createVendorWithSpacedModelName()],
    discoveredModels: [{ name: 'gpt-4o' }, { name: 'gpt-4.1' }],
    verify(context) {
      assert.equal(context.state.updates.length, 1, '成员变化时应写回一次 vendors 配置');
      assert.equal(context.changeCount(), 2, '成员变化时应触发两次 ConfigStore 变更事件（配置变更 + 手动通知）');

      const updatedVendor = getUpdatedVendor(context.state);
      const existingModel = updatedVendor.models.find(model => model.name === 'gpt-4o');
      const newModel = updatedVendor.models.find(model => model.name === 'gpt-4.1');

      assert.ok(existingModel, '已有模型应保留且名称被规范化');
      assert.equal(existingModel?.description, 'Keep me');
      assert.equal(existingModel?.temperature, 0.25);
      assert.equal(existingModel?.topP, 0.95);
      assert.deepEqual(existingModel?.capabilities, { tools: true, vision: false });
      assert.equal(existingModel?.maxInputTokens, 64000);
      assert.equal(existingModel?.maxOutputTokens, 64000);
      assert.ok(newModel, '新模型应被追加到配置中');
      assert.equal(newModel?.description, undefined);
      assert.ok(!updatedVendor.models.some(model => model.name === ' gpt-4o '), '写回配置时不应保留带空格名称');
    }
  },
  {
    name: '新增模型写回时保留发现到的字段',
    initialVendors: [createVendorWithSpacedModelName()],
    discoveredModels: [
      { name: 'gpt-4o' },
        {
          name: 'gpt-4.1',
          description: 'Fresh from /models',
          capabilities: { tools: true, vision: true },
          maxInputTokens: 128000,
          maxOutputTokens: 128000
        }
    ],
    verify(context) {
      assert.equal(context.state.updates.length, 1, '新增模型时应写回一次 vendors 配置');

      const updatedVendor = getUpdatedVendor(context.state);
      const newModel = updatedVendor.models.find(model => model.name === 'gpt-4.1');

      assert.ok(newModel, '新增模型应被写回到配置');
      assert.equal(newModel?.description, 'Fresh from /models');
      assert.equal(newModel?.temperature, undefined);
      assert.equal(newModel?.topP, undefined);
      assert.deepEqual(newModel?.capabilities, { tools: true, vision: true });
      assert.equal(newModel?.maxInputTokens, 128000);
      assert.equal(newModel?.maxOutputTokens, 128000);
    }
  },
  {
    name: '重复刷新两次后不再写回',
    initialVendors: [createVendorWithSpacedModelName()],
    async run(configStore) {
      await configStore.updateVendorModels('Vendor', [{ name: 'gpt-4o' }, { name: 'gpt-4.1' }]);
      await configStore.updateVendorModels('Vendor', [{ name: 'gpt-4o' }, { name: 'gpt-4.1' }]);
    },
    verify(context) {
      assert.equal(context.state.updates.length, 1, '同一发现结果连续刷新两次时只应写回一次');
      assert.equal(context.changeCount(), 2, '第二次刷新不应再触发新的 ConfigStore 变更事件');

      const updatedVendor = getUpdatedVendor(context.state);
      assert.ok(updatedVendor.models.some(model => model.name === 'gpt-4o'), '第一次刷新后的规范化名称应被保留');
      assert.ok(updatedVendor.models.some(model => model.name === 'gpt-4.1'), '第一次刷新新增的模型应被保留');
      assert.ok(!updatedVendor.models.some(model => model.name === ' gpt-4o '), '第二次刷新后仍不应写回带空格名称');
    }
  },
  {
    name: '首次稳定顺序后相同集合换序不写回',
    initialVendors: [createVendorWithSpacedModelName()],
    async run(configStore) {
      await configStore.updateVendorModels('Vendor', [{ name: 'gpt-4o' }, { name: 'gpt-4.1' }]);
      await configStore.updateVendorModels('Vendor', [{ name: 'gpt-4.1' }, { name: 'gpt-4o' }]);
    },
    verify(context) {
      assert.equal(context.state.updates.length, 1, '相同集合仅顺序变化时第二次刷新不应再次写回');
      assert.equal(context.changeCount(), 2, '相同集合仅顺序变化时第二次刷新不应新增事件');

      const updatedVendor = getUpdatedVendor(context.state);
      assert.deepEqual(
        updatedVendor.models.map(model => model.name),
        ['gpt-4.1', 'gpt-4o'],
        '第一次刷新后模型顺序应稳定，第二次换序不应改写顺序'
      );
    }
  },
  {
    name: '发现列表含重复模型名时只写回一次且结果去重',
    initialVendors: [createVendorWithSpacedModelName()],
    async run(configStore) {
      await configStore.updateVendorModels('Vendor', [
        { name: 'gpt-4o' },
        { name: 'gpt-4.1' },
        { name: 'gpt-4o' },
        { name: 'GPT-4.1' }
      ]);
      await configStore.updateVendorModels('Vendor', [
        { name: 'gpt-4o' },
        { name: 'gpt-4.1' },
        { name: 'gpt-4o' },
        { name: 'GPT-4.1' }
      ]);
    },
    verify(context) {
      assert.equal(context.state.updates.length, 1, '发现列表有重复模型名时只应写回一次');
      assert.equal(context.changeCount(), 2, '第二次相同重复发现结果不应新增事件');

      const updatedVendor = getUpdatedVendor(context.state);
      assert.deepEqual(
        updatedVendor.models.map(model => model.name),
        ['gpt-4.1', 'gpt-4o'],
        '写回配置时应按名称去重并保持稳定顺序'
      );
    }
  },
  {
    name: '发现列表含空名称时被忽略且不影响幂等',
    initialVendors: [createVendorWithSpacedModelName()],
    async run(configStore) {
      await configStore.updateVendorModels('Vendor', [
        { name: 'gpt-4o' },
        { name: '' },
        { name: '   ' },
        { name: 'gpt-4.1' }
      ]);
      await configStore.updateVendorModels('Vendor', [
        { name: 'gpt-4o' },
        { name: '   ' },
        { name: '' },
        { name: 'gpt-4.1' }
      ]);
    },
    verify(context) {
      assert.equal(context.state.updates.length, 1, '空名称和空白名称不应导致额外写回');
      assert.equal(context.changeCount(), 2, '第二次仅空名称顺序变化时不应新增事件');

      const updatedVendor = getUpdatedVendor(context.state);
      assert.deepEqual(
        updatedVendor.models.map(model => model.name),
        ['gpt-4.1', 'gpt-4o'],
        '空名称和空白名称应被忽略，最终结果只保留有效模型'
      );
    }
  },
  {
    name: '未知 vendor 名称时不写回且不触发事件',
    initialVendors: [createVendorWithSpacedModelName()],
    async run(configStore) {
      await configStore.updateVendorModels('Unknown Vendor', [
        { name: 'gpt-4o' },
        { name: 'gpt-4.1' }
      ]);
    },
    verify(context) {
      assert.equal(context.state.updates.length, 0, '未知 vendor 名称时不应写回 vendors 配置');
      assert.equal(context.changeCount(), 0, '未知 vendor 名称时不应触发 ConfigStore 变更事件');

      const updatedVendor = getUpdatedVendor(context.state);
      assert.deepEqual(
        updatedVendor.models.map(model => model.name),
        [' gpt-4o '],
        '未知 vendor 名称时应保持原始配置不变'
      );
    }
  },
  {
    name: '空 vendorName 时直接 no-op',
    initialVendors: [createVendorWithSpacedModelName()],
    async run(configStore) {
      await configStore.updateVendorModels('', [
        { name: 'gpt-4o' },
        { name: 'gpt-4.1' }
      ]);
      await configStore.updateVendorModels('   ', [
        { name: 'gpt-4o' },
        { name: 'gpt-4.1' }
      ]);
    },
    verify(context) {
      assert.equal(context.state.updates.length, 0, '空 vendorName 或空白 vendorName 时不应写回 vendors 配置');
      assert.equal(context.changeCount(), 0, '空 vendorName 或空白 vendorName 时不应触发 ConfigStore 变更事件');

      const updatedVendor = getUpdatedVendor(context.state);
      assert.deepEqual(
        updatedVendor.models.map(model => model.name),
        [' gpt-4o '],
        '空 vendorName 或空白 vendorName 时应保持原始配置不变'
      );
    }
  },
  {
    name: 'models 为空数组时清空已有模型且二次调用幂等',
    initialVendors: [createVendorWithSpacedModelName()],
    async run(configStore) {
      await configStore.updateVendorModels('Vendor', []);
      await configStore.updateVendorModels('Vendor', []);
    },
    verify(context) {
      assert.equal(context.state.updates.length, 1, '首次传入空数组时应只写回一次以清空模型');
      assert.equal(context.changeCount(), 2, '二次传入空数组时不应新增事件');

      const updatedVendor = getUpdatedVendor(context.state);
      assert.deepEqual(updatedVendor.models, [], '传入空数组时应正确清空已有模型');
    }
  }
];

async function runTestCase(configStoreCtor: ConfigStoreCtor, testCase: TestCase): Promise<void> {
  activeState = createState(testCase.initialVendors);

  const configStore = new configStoreCtor(createExtensionContext() as never);
  let changeCount = 0;
  const subscription = configStore.onDidChange(() => {
    changeCount += 1;
  });

  try {
    if (testCase.run) {
      await testCase.run(configStore as InstanceType<ConfigStoreCtor>);
    } else {
      await configStore.updateVendorModels('Vendor', testCase.discoveredModels ?? []);
    }

    testCase.verify({
      state: activeState,
      changeCount: () => changeCount
    });
    console.log(`PASS ${testCase.name}`);
  } finally {
    subscription.dispose();
    configStore.dispose();
  }
}

async function runConfigNormalizationTests(configStoreCtor: ConfigStoreCtor): Promise<void> {
  activeState = createState([{
    name: 'Vendor',
    baseUrl: 'https://example.test/v1',
    apiStyle: 'anthropic',
    defaultVision: true,
    models: [{ name: 'claude-3' }]
  }]);

  let configStore = new configStoreCtor(createExtensionContext() as never);
  try {
    const vendor = configStore.getVendors()[0];
    assert.equal(vendor?.defaultApiStyle, 'anthropic');
    assert.equal(vendor?.models[0]?.apiStyle, 'anthropic');
    assert.deepEqual(vendor?.models[0]?.capabilities, { tools: true, vision: true });
    assert.equal(vendor?.models[0]?.maxOutputTokens, 0);
    assert.equal(vendor?.defaultTemperature, undefined);
    assert.equal(vendor?.defaultTopP, undefined);
    console.log('PASS 兼容旧 apiStyle、补齐模型默认能力并将 maxOutputTokens 默认归一化为 0');
  } finally {
    configStore.dispose();
  }

  activeState = createState([{
    name: 'Vendor',
    baseUrl: 'https://example.test/v1',
    defaultApiStyle: 'openai-chat',
    defaultVision: false,
    models: [{
      name: 'r1',
      apiStyle: 'anthropic',
      capabilities: { tools: false }
    }]
  }]);

  configStore = new configStoreCtor(createExtensionContext() as never);
  try {
    const vendor = configStore.getVendors()[0];
    assert.equal(vendor?.models[0]?.apiStyle, 'anthropic');
    assert.deepEqual(vendor?.models[0]?.capabilities, { tools: false, vision: false });
    assert.equal(vendor?.models[0]?.temperature, undefined);
    assert.equal(vendor?.models[0]?.topP, undefined);
    console.log('PASS 模型级 apiStyle 覆盖供应商默认值');
  } finally {
    configStore.dispose();
  }

  activeState = createState([{
    name: 'Vendor',
    baseUrl: 'https://example.test/v1',
    defaultApiStyle: 'openai-responses',
    defaultVision: true,
    models: []
  }]);

  configStore = new configStoreCtor(createExtensionContext() as never);
  try {
    await configStore.updateVendorModels('Vendor', [{ name: 'gpt-4.1' } as VendorModelRecord]);
    const updatedVendor = getUpdatedVendor(activeState);
    assert.equal(updatedVendor.models[0]?.apiStyle, 'openai-responses');
    assert.deepEqual(updatedVendor.models[0]?.capabilities, { tools: true, vision: true });
    assert.equal(updatedVendor.models[0]?.maxOutputTokens, 0);
    assert.equal(updatedVendor.models[0]?.temperature, undefined);
    assert.equal(updatedVendor.models[0]?.topP, undefined);
    console.log('PASS updateVendorModels 写回模型默认 apiStyle、capabilities 与 maxOutputTokens=0');
  } finally {
    configStore.dispose();
  }

  activeState = createState([{
    name: 'Vendor',
    baseUrl: 'https://example.test/v1',
    defaultApiStyle: 'openai-chat',
    defaultVision: false,
    defaultTemperature: 0.2,
    defaultTopP: 1,
    models: [{
      name: 'coder',
      temperature: 0.35,
      topP: 0.92,
      capabilities: { tools: true, vision: false }
    }]
  }]);

  configStore = new configStoreCtor(createExtensionContext() as never);
  try {
    const vendor = configStore.getVendors()[0];
    assert.equal(vendor?.defaultTemperature, 0.2);
    assert.equal(vendor?.defaultTopP, 1);
    assert.equal(vendor?.models[0]?.temperature, 0.35);
    assert.equal(vendor?.models[0]?.topP, 0.92);
    console.log('PASS 供应商级与模型级采样参数可正确归一化');
  } finally {
    configStore.dispose();
  }

  activeState = createState([{
    name: 'Vendor',
    baseUrl: 'https://example.test/v1',
    defaultApiStyle: 'openai-chat',
    defaultVision: false,
    models: [{
      name: 'context-capped',
      contextSize: 64000,
      maxInputTokens: 128000,
      maxOutputTokens: 96000
    }]
  }]);

  configStore = new configStoreCtor(createExtensionContext() as never);
  try {
    const vendor = configStore.getVendors()[0];
    assert.equal(vendor?.models[0]?.contextSize, 64000);
    assert.equal(vendor?.models[0]?.maxInputTokens, 64000);
    assert.equal(vendor?.models[0]?.maxOutputTokens, 64000);
    console.log('PASS contextSize 存在时会收敛超出的输入输出上限');
  } finally {
    configStore.dispose();
  }

  activeState = createState([{
    name: 'Vendor',
    baseUrl: 'https://example.test/v1',
    defaultApiStyle: 'openai-chat',
    defaultVision: false,
    models: [{
      name: 'context-preserved',
      contextSize: 64000,
      maxInputTokens: 32000,
      maxOutputTokens: 16000
    }]
  }]);

  configStore = new configStoreCtor(createExtensionContext() as never);
  try {
    const vendor = configStore.getVendors()[0];
    assert.equal(vendor?.models[0]?.contextSize, 64000);
    assert.equal(vendor?.models[0]?.maxInputTokens, 32000);
    assert.equal(vendor?.models[0]?.maxOutputTokens, 16000);
    console.log('PASS contextSize 存在且输入输出均较小时保持原值');
  } finally {
    configStore.dispose();
  }

  activeState = createState([{
    name: 'Vendor',
    baseUrl: 'https://example.test/v1',
    defaultApiStyle: 'openai-chat',
    defaultVision: false,
    models: [{
      name: 'zero-unset',
      contextSize: 131072,
      maxInputTokens: 0,
      maxOutputTokens: 0
    }]
  }]);

  configStore = new configStoreCtor(createExtensionContext() as never);
  try {
    const vendor = configStore.getVendors()[0];
    assert.equal(vendor?.models[0]?.contextSize, 131072);
    assert.equal(vendor?.models[0]?.maxInputTokens, 0);
    assert.equal(vendor?.models[0]?.maxOutputTokens, 0);
    console.log('PASS maxInputTokens/maxOutputTokens 为 0 时保留为显式 unset 配置');
  } finally {
    configStore.dispose();
  }
}

function runTokenWindowResolutionTests(baseProviderModule: BaseProviderModule): void {
  const { BaseAIProvider } = baseProviderModule;

  class TestProvider extends BaseAIProvider {
    getVendor(): string {
      return 'test';
    }

    getConfigSection(): string {
      return 'test';
    }

    getBaseUrl(): string {
      return 'https://example.test/v1';
    }

    getApiKey(): string {
      return 'configured';
    }

    getPredefinedModels(): any[] {
      return [];
    }

    convertMessages(_messages: any[]): any[] {
      return [];
    }

    async sendRequest(): Promise<never> {
      throw new Error('not implemented');
    }

    protected createModel(_modelInfo: any): any {
      throw new Error('not implemented');
    }
  }

  const provider = new TestProvider(createExtensionContext() as never) as unknown as {
    resolveTokenWindowLimits(
      totalContextWindow: number | undefined,
      explicitMaxInputTokens: number | undefined,
      explicitMaxOutputTokens: number | undefined
    ): {
      maxTokens: number;
      maxInputTokens: number;
      maxOutputTokens: number;
    };
    dispose(): void;
  };

  try {
    const capped = provider.resolveTokenWindowLimits(64000, 128000, 96000);
    assert.deepEqual(capped, {
      maxTokens: 64000,
      maxInputTokens: 64000,
      maxOutputTokens: 64000
    });
    console.log('PASS runtime token window 解析优先使用 contextSize');

    const preserved = provider.resolveTokenWindowLimits(64000, 32000, 16000);
    assert.deepEqual(preserved, {
      maxTokens: 64000,
      maxInputTokens: 32000,
      maxOutputTokens: 16000
    });
    console.log('PASS runtime token window 在上下限较小时保持原值');
  } finally {
    provider.dispose();
  }
}

function runGenericProviderContextSizeTests(
  configStoreCtor: ConfigStoreCtor,
  genericProviderModule: GenericProviderModule
): void {
  const { GenericAIProvider } = genericProviderModule;
  activeState = createState([{
    name: 'Vendor',
    baseUrl: 'https://example.test/v1',
    defaultApiStyle: 'openai-chat',
    defaultVision: false,
    models: [{
      name: 'context-priority',
      contextSize: 64000,
      maxInputTokens: 32000,
      maxOutputTokens: 16000
    }]
  }]);

  const configStore = new configStoreCtor(createExtensionContext() as never);
  const provider = new GenericAIProvider(createExtensionContext() as never, configStore) as unknown as {
    buildConfiguredModelsForVendor(vendor: VendorRecord): Array<{
      maxTokens: number;
      maxInputTokens: number;
      maxOutputTokens: number;
    }>;
    dispose(): void;
  };

  try {
    const vendor = configStore.getVendors()[0] as VendorRecord;
    const models = provider.buildConfiguredModelsForVendor(vendor);
    assert.equal(models[0]?.maxTokens, 64000);
    assert.equal(models[0]?.maxInputTokens, 32000);
    assert.equal(models[0]?.maxOutputTokens, 16000);
    console.log('PASS GenericAIProvider 构建 language model 配置时优先使用 contextSize');
  } finally {
    provider.dispose();
    configStore.dispose();
  }

  activeState = createState([{
    name: 'Vendor',
    baseUrl: 'https://example.test/v1',
    defaultApiStyle: 'openai-chat',
    defaultVision: false,
    models: [{
      name: 'context-output-capped',
      contextSize: 131072,
      maxInputTokens: 200000,
      maxOutputTokens: 200000
    }]
  }]);

  const cappedConfigStore = new configStoreCtor(createExtensionContext() as never);
  const cappedProvider = new GenericAIProvider(createExtensionContext() as never, cappedConfigStore) as unknown as {
    buildConfiguredModelsForVendor(vendor: VendorRecord): Array<{
      id: string;
      maxTokens: number;
      maxInputTokens: number;
      maxOutputTokens: number;
    }>;
    models: Array<{
      id: string;
      maxTokens: number;
      maxOutputTokens: number;
    }>;
    resolveRequestedOutputLimit(request: { modelId: string }): number;
    dispose(): void;
  };

  try {
    const vendor = cappedConfigStore.getVendors()[0] as VendorRecord;
    const models = cappedProvider.buildConfiguredModelsForVendor(vendor);
    cappedProvider.models = models as Array<{ id: string; maxTokens: number; maxOutputTokens: number }>;
    assert.equal(models[0]?.maxTokens, 131072);
    assert.equal(models[0]?.maxOutputTokens, 131072);
    assert.equal(cappedProvider.resolveRequestedOutputLimit({ modelId: models[0]!.id }), 131072);
    console.log('PASS GenericAIProvider 请求上游时不再做本地 prompt token 预算裁剪');
  } finally {
    cappedProvider.dispose();
    cappedConfigStore.dispose();
  }

  activeState = createState([{
    name: 'Vendor',
    baseUrl: 'https://example.test/v1',
    defaultApiStyle: 'openai-chat',
    defaultVision: false,
    models: [{
      name: 'zero-unset-runtime',
      contextSize: 131072,
      maxInputTokens: 0,
      maxOutputTokens: 0
    }]
  }]);

  const zeroUnsetConfigStore = new configStoreCtor(createExtensionContext() as never);
  const zeroUnsetProvider = new GenericAIProvider(createExtensionContext() as never, zeroUnsetConfigStore) as unknown as {
    buildConfiguredModelsForVendor(vendor: VendorRecord): Array<{
      maxTokens: number;
      maxInputTokens: number;
      maxOutputTokens: number;
    }>;
    dispose(): void;
  };

  try {
    const vendor = zeroUnsetConfigStore.getVendors()[0] as VendorRecord;
    const models = zeroUnsetProvider.buildConfiguredModelsForVendor(vendor);
    assert.equal(models[0]?.maxTokens, 131072);
    assert.equal(models[0]?.maxInputTokens, 123072);
    assert.equal(models[0]?.maxOutputTokens, 8000);
    console.log('PASS 运行时会把 0 视为未设置并按 contextSize 推导默认输入输出上限');
  } finally {
    zeroUnsetProvider.dispose();
    zeroUnsetConfigStore.dispose();
  }
}

function runGenericProviderEmptyResponseTests(
  configStoreCtor: ConfigStoreCtor,
  genericProviderModule: GenericProviderModule
): void {
  const { GenericAIProvider } = genericProviderModule;
  activeState = createState([{
    name: 'Vendor',
    baseUrl: 'https://example.test/v1',
    defaultApiStyle: 'openai-chat',
    defaultVision: false,
    models: [{
      name: 'empty-response-guard',
      contextSize: 64000,
      maxInputTokens: 32000,
      maxOutputTokens: 16000
    }]
  }]);

  const configStore = new configStoreCtor(createExtensionContext() as never);
  const provider = new GenericAIProvider(createExtensionContext() as never, configStore) as unknown as {
    ensureNonEmptyCompletion(
      protocol: 'openai-chat' | 'openai-responses' | 'anthropic',
      trace: { traceId: string },
      vendor: VendorRecord,
      modelName: string,
      content: string,
      toolCalls: unknown[] | undefined
    ): void;
    dispose(): void;
  };

  const vendor = configStore.getVendors()[0] as VendorRecord;

  try {
    assert.throws(
      () => provider.ensureNonEmptyCompletion(
        'openai-chat',
        { traceId: 'trace_empty' },
        vendor,
        'empty-response-guard',
        '   ',
        []
      ),
      /requestFailed|empty response|空响应/i
    );
    console.log('PASS GenericAIProvider 会把空 completion 视为上游错误');

    assert.doesNotThrow(() => provider.ensureNonEmptyCompletion(
      'openai-chat',
      { traceId: 'trace_text' },
      vendor,
      'empty-response-guard',
      'fix: keep content',
      []
    ));

    assert.doesNotThrow(() => provider.ensureNonEmptyCompletion(
      'openai-chat',
      { traceId: 'trace_tool' },
      vendor,
      'empty-response-guard',
      '',
      [{}]
    ));
    console.log('PASS GenericAIProvider 在存在文本或工具调用时保留 completion');
  } finally {
    provider.dispose();
    configStore.dispose();
  }
}

async function runGenericProviderOutputLimitToggleTests(
  configStoreCtor: ConfigStoreCtor,
  genericProviderModule: GenericProviderModule
): Promise<void> {
  const { GenericAIProvider } = genericProviderModule;
  const originalFetch = globalThis.fetch;

  async function capturePayload(vendors: VendorRecord[], modelId: string): Promise<Record<string, unknown>> {
    activeState = createState(vendors);
    const configStore = new configStoreCtor(createExtensionContext() as never);
    const provider = new GenericAIProvider(createExtensionContext() as never, configStore) as unknown as {
      refreshModels(): Promise<void>;
      sendRequest(
        request: {
          modelId: string;
          messages: Array<{ role: string; content: Array<{ value: string }> }>;
          capabilities: { toolCalling: boolean; imageInput: boolean };
          options?: { tools?: unknown[] };
        }
      ): Promise<unknown>;
      dispose(): void;
    };

    let payload: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      payload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(JSON.stringify({
        id: 'chatcmpl_test',
        created: 0,
        model: 'coder',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: 'ok'
          },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2
        }
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      });
    }) as typeof globalThis.fetch;

    try {
      (configStore as unknown as { getApiKey(vendorName: string): Promise<string> }).getApiKey = async (vendorName: string) => (
        vendorName === 'Vendor' ? 'configured' : ''
      );
      await provider.refreshModels();
      await provider.sendRequest({
        modelId,
        messages: [{
          role: 'user',
          content: [{ value: 'reply with ok' }]
        }],
        capabilities: { toolCalling: false, imageInput: false },
        options: { tools: [] }
      });
      assert.ok(payload);
      return payload;
    } finally {
      globalThis.fetch = originalFetch;
      provider.dispose();
      configStore.dispose();
    }
  }

  const zeroOutputDisabledPayload = await capturePayload([{
    name: 'Vendor',
    baseUrl: 'https://example.test/v1',
    defaultApiStyle: 'openai-chat',
    defaultVision: false,
    models: [{
      name: 'coder',
      contextSize: 64000,
      maxInputTokens: 32000,
      maxOutputTokens: 0,
      capabilities: { tools: true, vision: false }
    }]
  }], 'Vendor/coder');
  assert.equal('max_tokens' in zeroOutputDisabledPayload, false);
  console.log('PASS maxOutputTokens 为 0 时不会向 openai-chat 下发 max_tokens');

  const positiveOutputPayload = await capturePayload([{
    name: 'Vendor',
    baseUrl: 'https://example.test/v1',
    defaultApiStyle: 'openai-chat',
    defaultVision: false,
    models: [{
      name: 'coder',
      contextSize: 64000,
      maxInputTokens: 32000,
      maxOutputTokens: 16000,
      capabilities: { tools: true, vision: false }
    }]
  }], 'Vendor/coder');
  assert.equal(positiveOutputPayload.max_tokens, 16000);
  console.log('PASS maxOutputTokens 为正数时会向 openai-chat 下发 max_tokens');
}

function runProtocolStreamTests(protocolsModule: ProtocolsModule): void {
  const {
    createOpenAIChatStreamState,
    applyOpenAIChatStreamChunk,
    finalizeOpenAIChatStreamState,
    createOpenAIResponsesStreamState,
    applyOpenAIResponsesStreamEvent,
    finalizeOpenAIResponsesStreamState,
    createAnthropicStreamState,
    applyAnthropicStreamEvent,
    finalizeAnthropicStreamState
  } = protocolsModule;

  const openAIChatState = createOpenAIChatStreamState();
  const chatDelta = applyOpenAIChatStreamChunk(openAIChatState, {
    id: 'chat_1',
    choices: [{
      index: 0,
      delta: {
        content: 'hello ',
        tool_calls: [{
          index: 0,
          id: 'call_1',
          function: {
            name: 'search',
            arguments: '{'
          }
        }]
      }
    }]
  }, () => 'generated_call');
  applyOpenAIChatStreamChunk(openAIChatState, {
    choices: [{
      index: 0,
      delta: {
        content: 'world',
        tool_calls: [{
          index: 0,
          function: {
            arguments: '"q":"repo"}'
          }
        }]
      },
      finish_reason: 'stop'
    }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14
    }
  }, () => 'generated_call');
  const finalizedChat = finalizeOpenAIChatStreamState(openAIChatState, () => 'generated_call');
  assert.equal(chatDelta.textDelta, 'hello ');
  assert.equal(finalizedChat.content, 'hello world');
  assert.deepEqual(finalizedChat.toolCalls, [{
    id: 'call_1',
    type: 'function',
    function: {
      name: 'search',
      arguments: '{"q":"repo"}'
    }
  }]);
  assert.deepEqual(finalizedChat.usage, {
    prompt_tokens: 10,
    completion_tokens: 4,
    total_tokens: 14
  });
  console.log('PASS openai-chat 流式文本与工具调用可正确累积');

  const responsesState = createOpenAIResponsesStreamState();
  const responsesDelta = applyOpenAIResponsesStreamEvent(responsesState, 'response.output_text.delta', {
    delta: 'partial '
  }, () => 'resp_call');
  applyOpenAIResponsesStreamEvent(responsesState, 'response.function_call_arguments.delta', {
    item: {
      id: 'item_1',
      call_id: 'resp_call',
      name: 'lookup'
    },
    delta: '{"id":'
  }, () => 'resp_call');
  applyOpenAIResponsesStreamEvent(responsesState, 'response.output_item.done', {
    item: {
      id: 'item_1',
      type: 'function_call',
      call_id: 'resp_call',
      name: 'lookup',
      arguments: '{"id":42}'
    }
  }, () => 'resp_call');
  applyOpenAIResponsesStreamEvent(responsesState, 'response.completed', {
    response: {
      id: 'resp_1',
      output_text: 'partial done',
      usage: {
        input_tokens: 12,
        output_tokens: 5,
        total_tokens: 17
      }
    }
  }, () => 'resp_call');
  const finalizedResponses = finalizeOpenAIResponsesStreamState(responsesState, () => 'resp_call');
  assert.equal(responsesDelta.textDelta, 'partial ');
  assert.equal(finalizedResponses.content, 'partial ');
  assert.deepEqual(finalizedResponses.toolCalls, [{
    id: 'resp_call',
    type: 'function',
    function: {
      name: 'lookup',
      arguments: '{"id":42}'
    }
  }]);
  assert.deepEqual(finalizedResponses.usage, {
    input_tokens: 12,
    output_tokens: 5,
    total_tokens: 17
  });
  console.log('PASS openai-responses 流式事件可正确累积文本与工具调用');

  const anthropicState = createAnthropicStreamState();
  const anthropicDelta = applyAnthropicStreamEvent(anthropicState, 'content_block_start', {
    index: 0,
    content_block: {
      type: 'text',
      text: 'Hi '
    }
  });
  applyAnthropicStreamEvent(anthropicState, 'content_block_delta', {
    index: 0,
    delta: {
      type: 'text_delta',
      text: 'there'
    }
  });
  applyAnthropicStreamEvent(anthropicState, 'content_block_start', {
    index: 1,
    content_block: {
      type: 'tool_use',
      id: 'toolu_1',
      name: 'run'
    }
  });
  applyAnthropicStreamEvent(anthropicState, 'content_block_delta', {
    index: 1,
    delta: {
      type: 'input_json_delta',
      partial_json: '{"cmd":"npm test"}'
    }
  });
  applyAnthropicStreamEvent(anthropicState, 'message_delta', {
    usage: {
      input_tokens: 9,
      output_tokens: 3
    },
    delta: {
      type: 'message_delta',
      stop_reason: 'end_turn'
    }
  });
  const finalizedAnthropic = finalizeAnthropicStreamState(anthropicState, () => 'tool_generated');
  assert.equal(anthropicDelta.textDelta, 'Hi ');
  assert.equal(finalizedAnthropic.content, 'Hi there');
  assert.deepEqual(finalizedAnthropic.toolCalls, [{
    id: 'toolu_1',
    type: 'function',
    function: {
      name: 'run',
      arguments: '{"cmd":"npm test"}'
    }
  }]);
  assert.deepEqual(finalizedAnthropic.usage, {
    input_tokens: 9,
    output_tokens: 3
  });
  console.log('PASS anthropic 流式事件可正确累积文本与工具调用');
}

function runTokenUsageNormalizationTests(tokenUsageModule: TokenUsageModule): void {
  const { normalizeTokenUsage, readAttachedTokenUsage, attachTokenUsage } = tokenUsageModule;

  const openAIChatUsage = normalizeTokenUsage('openai-chat', {
    prompt_tokens: 1014,
    completion_tokens: 140,
    total_tokens: 1154
  }, 200000);
  assert.deepEqual(openAIChatUsage, {
    promptTokens: 1014,
    completionTokens: 140,
    totalTokens: 1154,
    outputBuffer: 200000
  });
  console.log('PASS openai-chat usage 正常映射');

  const openAIResponsesUsage = normalizeTokenUsage('openai-responses', {
    input_tokens: 1147,
    output_tokens: 104,
    total_tokens: 1251
  }, 65500);
  assert.deepEqual(openAIResponsesUsage, {
    promptTokens: 1147,
    completionTokens: 104,
    totalTokens: 1251,
    outputBuffer: 65500
  });
  console.log('PASS openai-responses usage 正常映射');

  const anthropicUsage = normalizeTokenUsage('anthropic', {
    input_tokens: 321,
    output_tokens: 79
  }, 8192);
  assert.deepEqual(anthropicUsage, {
    promptTokens: 321,
    completionTokens: 79,
    totalTokens: 400,
    outputBuffer: 8192
  });
  console.log('PASS anthropic usage 正常映射');

  const correctedUsage = normalizeTokenUsage('openai-chat', {
    prompt_tokens: 1000,
    completion_tokens: 100,
    total_tokens: 1300
  });
  assert.deepEqual(correctedUsage, {
    promptTokens: 1000,
    completionTokens: 300,
    totalTokens: 1300,
    outputBuffer: undefined
  });
  console.log('PASS totalTokens 与 prompt+completion 不一致时按 totalTokens 纠偏');

  const fallbackUsage = normalizeTokenUsage('openai-responses', {
    input_tokens: 900,
    output_tokens: 120
  });
  assert.deepEqual(fallbackUsage, {
    promptTokens: 900,
    completionTokens: 120,
    totalTokens: 1020,
    outputBuffer: undefined
  });
  console.log('PASS 缺失 totalTokens 时回退到 prompt+completion');

  const attachedRecord: Record<string, unknown> = {};
  attachTokenUsage(attachedRecord, correctedUsage);
  assert.deepEqual(readAttachedTokenUsage(attachedRecord), correctedUsage);
  console.log('PASS 响应对象可读回归一化 usage');
}

async function main(): Promise<void> {
  const restore = installVscodeMock();
  try {
    const { ConfigStore } = require('../config/configStore') as ConfigStoreModule;
    const baseProviderModule = require('../providers/baseProvider') as BaseProviderModule;
    const genericProviderModule = require('../providers/genericProvider') as GenericProviderModule;
    const tokenUsageModule = require('../providers/tokenUsage') as TokenUsageModule;
    const protocolsModule = require('../providers/genericProviderProtocols') as ProtocolsModule;
    for (const testCase of testCases) {
      await runTestCase(ConfigStore, testCase);
    }
    await runConfigNormalizationTests(ConfigStore);
    runTokenWindowResolutionTests(baseProviderModule);
    runGenericProviderContextSizeTests(ConfigStore, genericProviderModule);
    runGenericProviderEmptyResponseTests(ConfigStore, genericProviderModule);
    await runGenericProviderOutputLimitToggleTests(ConfigStore, genericProviderModule);
    runProtocolStreamTests(protocolsModule);
    runTokenUsageNormalizationTests(tokenUsageModule);
  } finally {
    restore();
  }

  console.log('All tests passed.');
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});







