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
  usageUrl?: string;
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
type ContextUsageStateModule = typeof import('../contextUsageState');
type LMChatProviderAdapterModule = typeof import('../providers/lmChatProviderAdapter');
type PlanUsageStatusModule = typeof import('../planUsageStatus');

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
  const statusBarAlignment = {
    Left: 1,
    Right: 2
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
    StatusBarAlignment: statusBarAlignment,
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
      },
      createStatusBarItem() {
        return {
          text: '',
          tooltip: '',
          name: '',
          show(): void {
            return undefined;
          },
          hide(): void {
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
    assert.equal(updatedVendor.models[0]?.maxInputTokens, undefined);
    assert.equal(updatedVendor.models[0]?.maxOutputTokens, undefined);
    assert.equal(updatedVendor.models[0]?.temperature, undefined);
    assert.equal(updatedVendor.models[0]?.topP, undefined);
    console.log('PASS updateVendorModels 写回模型默认 apiStyle、capabilities，但不再默认落 maxInputTokens/maxOutputTokens');
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

  activeState = createState([{
    name: 'Vendor',
    baseUrl: 'https://example.test/v1',
    usageUrl: ' https://example.test/usage ',
    defaultApiStyle: 'openai-chat',
    defaultVision: false,
    models: []
  }]);

  configStore = new configStoreCtor(createExtensionContext() as never);
  try {
    const vendor = configStore.getVendors()[0];
    assert.equal(vendor?.usageUrl, 'https://example.test/usage');
    console.log('PASS usageUrl 可被归一化并保留');
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
    buildToolDefinitions(options?: { tools?: Array<{ name: string; description?: string; inputSchema?: object }> }): Array<{
      type: 'function';
      function: {
        name: string;
        description?: string;
        parameters?: object;
      };
    }> | undefined;
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
    const sanitizedTools = provider.buildToolDefinitions({
      tools: [{
        name: 'search_codebase',
        description: 'Searching codebase for "{1}"',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Use "{1}" as the semantic query.'
            }
          }
        }
      }]
    });
    assert.deepEqual(sanitizedTools, [{
      type: 'function',
      function: {
        name: 'search_codebase',
        description: 'Searching codebase for "value"',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Use "value" as the semantic query.'
            }
          }
        }
      }
    }]);
    console.log('PASS 工具定义中的未替换占位符会在转发前被清洗');
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
    assert.equal(cappedProvider.resolveRequestedOutputLimit({ modelId: models[0]!.id }), 30000);
    console.log('PASS GenericAIProvider 请求上游时默认输出预算会按配置与模型上限收敛');
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
    assert.equal(models[0]?.maxInputTokens, 101072);
    assert.equal(models[0]?.maxOutputTokens, 30000);
    console.log('PASS 运行时会把 0 视为未设置并应用默认输出预算');
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
  genericProviderModule: GenericProviderModule,
  tokenUsageModule: TokenUsageModule
): Promise<void> {
  const { GenericAIProvider } = genericProviderModule;
  const { readAttachedTokenUsage } = tokenUsageModule;
  const originalFetch = globalThis.fetch;

  async function capturePayload(
    vendors: VendorRecord[],
    modelId: string
  ): Promise<{ payload: Record<string, unknown>; response: unknown }> {
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
      const response = await provider.sendRequest({
        modelId,
        messages: [{
          role: 'user',
          content: [{ value: 'reply with ok' }]
        }],
        capabilities: { toolCalling: false, imageInput: false },
        options: { tools: [] }
      });
      assert.ok(payload);
      return {
        payload,
        response
      };
    } finally {
      globalThis.fetch = originalFetch;
      provider.dispose();
      configStore.dispose();
    }
  }

  async function capturePayloadWithRequiredMaxTokensRetry(
    vendors: VendorRecord[],
    modelId: string
  ): Promise<{ payloads: Record<string, unknown>[]; response: unknown }> {
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

    const payloads: Record<string, unknown>[] = [];
    let callCount = 0;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const payload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      payloads.push(payload);
      callCount += 1;

      if (callCount === 1) {
        return new Response(JSON.stringify({
          error: {
            type: 'invalid_request_error',
            message: 'missing field max_tokens at line 1 column 42'
          }
        }), {
          status: 400,
          headers: {
            'content-type': 'application/json'
          }
        });
      }

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
      const response = await provider.sendRequest({
        modelId,
        messages: [{
          role: 'user',
          content: [{ value: 'reply with ok' }]
        }],
        capabilities: { toolCalling: false, imageInput: false },
        options: { tools: [] }
      });
      return {
        payloads,
        response
      };
    } finally {
      globalThis.fetch = originalFetch;
      provider.dispose();
      configStore.dispose();
    }
  }

  const zeroOutputDisabledResult = await capturePayload([{
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
  assert.equal('max_tokens' in zeroOutputDisabledResult.payload, false);
  assert.equal(readAttachedTokenUsage(zeroOutputDisabledResult.response)?.outputBuffer, undefined);
  console.log('PASS maxOutputTokens 为 0 时不会向 openai-chat 下发 max_tokens，且不显示 Reserved Output');

  const requiredMaxTokensRetryResult = await capturePayloadWithRequiredMaxTokensRetry([{
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
  assert.equal(requiredMaxTokensRetryResult.payloads.length, 2);
  assert.equal('max_tokens' in requiredMaxTokensRetryResult.payloads[0], false);
  assert.equal(requiredMaxTokensRetryResult.payloads[1]?.max_tokens, 30000);
  assert.equal(requiredMaxTokensRetryResult.payloads[1]?.stream, false);
  assert.equal(readAttachedTokenUsage(requiredMaxTokensRetryResult.response)?.outputBuffer, 30000);
  console.log('PASS 上游要求 max_tokens 时会自动重试并补发 max_tokens');

  const positiveOutputResult = await capturePayload([{
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
  assert.equal(positiveOutputResult.payload.max_tokens, 16000);
  assert.equal(readAttachedTokenUsage(positiveOutputResult.response)?.outputBuffer, 16000);
  console.log('PASS maxOutputTokens 为正数时会向 openai-chat 下发 max_tokens');
}

async function runGenericProviderAnthropicStreamFallbackTests(
  configStoreCtor: ConfigStoreCtor,
  genericProviderModule: GenericProviderModule
): Promise<void> {
  const { GenericAIProvider } = genericProviderModule;
  const originalFetch = globalThis.fetch;

  activeState = createState([{
    name: 'Vendor',
    baseUrl: 'https://example.test/anthropic/v1',
    defaultApiStyle: 'anthropic',
    defaultVision: false,
    models: [{
      name: 'coder',
      contextSize: 64000,
      maxInputTokens: 32000,
      maxOutputTokens: 16000,
      capabilities: { tools: true, vision: false }
    }]
  }]);

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
    ): Promise<{ text: AsyncIterable<string> }>;
    dispose(): void;
  };

  const payloads: Record<string, unknown>[] = [];
  let callCount = 0;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const payload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    payloads.push(payload);
    callCount += 1;

    if (callCount === 1) {
      const sseBody = [
        'event: message_start',
        `data: ${JSON.stringify({
          type: 'message_start',
          message: {
            id: 'msg_stream',
            type: 'message',
            role: 'assistant',
            model: 'coder',
            content: [],
            usage: {
              input_tokens: 11,
              output_tokens: 2
            }
          }
        })}`,
        '',
        'event: content_block_start',
        `data: ${JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'toolu_stream',
            name: 'read_file'
          }
        })}`,
        '',
        'event: content_block_delta',
        `data: ${JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: '{1}'
          }
        })}`,
        '',
        'event: message_delta',
        `data: ${JSON.stringify({
          type: 'message_delta',
          delta: {
            stop_reason: 'tool_use'
          },
          usage: {
            input_tokens: 11,
            output_tokens: 2
          }
        })}`,
        '',
        'data: [DONE]',
        ''
      ].join('\n');

      return new Response(sseBody, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream'
        }
      });
    }

    return new Response(JSON.stringify({
      id: 'msg_fallback',
      type: 'message',
      role: 'assistant',
      model: 'coder',
      content: [{
        type: 'text',
        text: 'fallback answer'
      }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 13,
        output_tokens: 4
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
    const firstResponse = await provider.sendRequest({
      modelId: 'Vendor/coder',
      messages: [{
        role: 'user',
        content: [{ value: 'read the file' }]
      }],
      capabilities: { toolCalling: true, imageInput: false },
      options: { tools: [] }
    });
    const textChunks: string[] = [];
    for await (const chunk of firstResponse.text) {
      textChunks.push(chunk);
    }

    const secondResponse = await provider.sendRequest({
      modelId: 'Vendor/coder',
      messages: [{
        role: 'user',
        content: [{ value: 'read the file again' }]
      }],
      capabilities: { toolCalling: true, imageInput: false },
      options: { tools: [] }
    });
    const secondTextChunks: string[] = [];
    for await (const chunk of secondResponse.text) {
      secondTextChunks.push(chunk);
    }

    assert.equal(payloads.length, 3);
    assert.equal(payloads[0]?.stream, true);
    assert.equal(payloads[1]?.stream, false);
    assert.equal(payloads[2]?.stream, false);
    assert.deepEqual(textChunks, ['fallback answer']);
    assert.deepEqual(secondTextChunks, ['fallback answer']);
    console.log('PASS anthropic 流式 tool 参数退化后当前会话会持续使用非流式');
  } finally {
    globalThis.fetch = originalFetch;
    provider.dispose();
    configStore.dispose();
  }
}

async function runGenericProviderAnthropicStreamErrorEventTests(
  configStoreCtor: ConfigStoreCtor,
  genericProviderModule: GenericProviderModule
): Promise<void> {
  const { GenericAIProvider } = genericProviderModule;
  const originalFetch = globalThis.fetch;

  activeState = createState([{
    name: 'Vendor',
    baseUrl: 'https://example.test/anthropic/v1',
    defaultApiStyle: 'anthropic',
    defaultVision: false,
    models: [{
      name: 'coder',
      contextSize: 64000,
      maxInputTokens: 32000,
      maxOutputTokens: 16000,
      capabilities: { tools: true, vision: false }
    }]
  }]);

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
    ): Promise<{ text: AsyncIterable<string> }>;
    dispose(): void;
  };
  const payloads: Record<string, unknown>[] = [];

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    payloads.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    const sseBody = [
      'event: error',
      `data: ${JSON.stringify({
        type: 'error',
        error: {
          type: 'overloaded_error',
          message: 'model overloaded'
        },
        request_id: 'req_stream_error'
      })}`,
      '',
      'data: [DONE]',
      ''
    ].join('\n');

    return new Response(sseBody, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream'
      }
    });
  }) as typeof globalThis.fetch;

  try {
    (configStore as unknown as { getApiKey(vendorName: string): Promise<string> }).getApiKey = async (vendorName: string) => (
      vendorName === 'Vendor' ? 'configured' : ''
    );
    await provider.refreshModels();
    const response = await provider.sendRequest({
      modelId: 'Vendor/coder',
      messages: [{
        role: 'user',
        content: [{ value: 'hello' }]
      }],
      capabilities: { toolCalling: true, imageInput: false },
      options: { tools: [] }
    });

    await assert.rejects(async () => {
      for await (const chunk of response.text) {
        void chunk;
        // consume stream
      }
    }, error => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /requestFailed/);
      assert.doesNotMatch(message, /emptyModelResponse/);
      return true;
    });

    const secondResponse = await provider.sendRequest({
      modelId: 'Vendor/coder',
      messages: [{
        role: 'user',
        content: [{ value: 'hello again' }]
      }],
      capabilities: { toolCalling: true, imageInput: false },
      options: { tools: [] }
    });
    await assert.rejects(async () => {
      for await (const chunk of secondResponse.text) {
        void chunk;
      }
    }, error => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /requestFailed/);
      return true;
    });
    assert.equal(payloads[0]?.stream, true);
    assert.equal(payloads[1]?.stream, false);
    console.log('PASS anthropic 流式 error 事件后当前会话会持续使用非流式');
  } finally {
    globalThis.fetch = originalFetch;
    provider.dispose();
    configStore.dispose();
  }
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
    finalizeAnthropicStreamState,
    toAnthropicMessages
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

  const reasoningOnlyChatState = createOpenAIChatStreamState();
  const reasoningOnlyChatDelta = applyOpenAIChatStreamChunk(reasoningOnlyChatState, {
    choices: [{
      index: 0,
      delta: {
        reasoning_content: [{ type: 'reasoning', text: 'fallback ' }]
      }
    }]
  }, () => 'generated_call');
  applyOpenAIChatStreamChunk(reasoningOnlyChatState, {
    choices: [{
      index: 0,
      message: {
        reasoning: [{ type: 'reasoning', text: 'text' }]
      }
    }]
  }, () => 'generated_call');
  const finalizedReasoningOnlyChat = finalizeOpenAIChatStreamState(reasoningOnlyChatState, () => 'generated_call');
  assert.equal(reasoningOnlyChatDelta.textDelta, '');
  assert.equal(finalizedReasoningOnlyChat.content, 'fallback text');

  const mixedProxyChatState = createOpenAIChatStreamState();
  applyOpenAIChatStreamChunk(mixedProxyChatState, {
    choices: [{
      index: 0,
      delta: {
        reasoning_content: [{ type: 'reasoning', text: 'proxy ' }]
      }
    }]
  }, () => 'generated_call');
  const mixedProxyChatDelta = applyOpenAIChatStreamChunk(mixedProxyChatState, {
    choices: [{
      index: 0,
      message: {
        content: [{ type: 'text', text: 'reply' }]
      }
    }]
  }, () => 'generated_call');
  const finalizedMixedProxyChat = finalizeOpenAIChatStreamState(mixedProxyChatState, () => 'generated_call');
  assert.equal(mixedProxyChatDelta.textDelta, 'reply');
  assert.equal(finalizedMixedProxyChat.content, 'reply');
  console.log('PASS openai-chat 可兼容代理常见的非标准 chunk 字段');

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

  const anthropicNormalized = toAnthropicMessages([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: {
          name: 'read_file',
          arguments: '{"path":"/tmp/a"}'
        }
      }, {
        id: 'call_2',
        type: 'function',
        function: {
          name: 'read_file',
          arguments: '{"path":"/tmp/b"}'
        }
      }]
    },
    {
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'A'
    },
    {
      role: 'tool',
      tool_call_id: 'call_2',
      content: 'B'
    }
  ], () => 'generated_call');
  assert.equal(anthropicNormalized.messages.length, 2);
  const mergedToolResults = anthropicNormalized.messages[1]?.content;
  assert.ok(Array.isArray(mergedToolResults));
  assert.equal(mergedToolResults.length, 2);
  assert.deepEqual(mergedToolResults[0], {
    type: 'tool_result',
    tool_use_id: 'call_1',
    content: 'A'
  });
  assert.deepEqual(mergedToolResults[1], {
    type: 'tool_result',
    tool_use_id: 'call_2',
    content: 'B'
  });
  console.log('PASS anthropic 会将同一轮连续 tool_result 合并到一个 user 消息');
  const anthropicMergedTurn = toAnthropicMessages([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_3',
        type: 'function',
        function: {
          name: 'read_file',
          arguments: '{"path":"/tmp/c"}'
        }
      }]
    },
    {
      role: 'tool',
      tool_call_id: 'call_3',
      content: 'C'
    },
    {
      role: 'user',
      content: '继续总结 C'
    }
  ], () => 'generated_call');
  assert.equal(anthropicMergedTurn.messages.length, 2);
  const mergedTurnContent = anthropicMergedTurn.messages[1]?.content;
  assert.ok(Array.isArray(mergedTurnContent));
  assert.deepEqual(mergedTurnContent, [{
    type: 'tool_result',
    tool_use_id: 'call_3',
    content: 'C'
  }, {
    type: 'text',
    text: '继续总结 C'
  }]);
  console.log('PASS anthropic 会将同一轮的 tool_result 与后续用户文本合并为单个 user turn');

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

  const anthropicServerToolState = createAnthropicStreamState();
  applyAnthropicStreamEvent(anthropicServerToolState, 'content_block_start', {
    index: 0,
    content_block: {
      type: 'server_tool_use',
      id: 'srvtool_1',
      name: 'str_replace_editor'
    }
  });
  applyAnthropicStreamEvent(anthropicServerToolState, 'content_block_delta', {
    index: 0,
    delta: {
      type: 'input_json_delta',
      partial_json: '{"command":"view","path":"README.md"}'
    }
  });
  const finalizedAnthropicServerTool = finalizeAnthropicStreamState(anthropicServerToolState, () => 'tool_generated');
  assert.equal(finalizedAnthropicServerTool.content, '');
  assert.deepEqual(finalizedAnthropicServerTool.toolCalls, [{
    id: 'srvtool_1',
    type: 'function',
    function: {
      name: 'str_replace_editor',
      arguments: '{"command":"view","path":"README.md"}'
    }
  }]);
  console.log('PASS anthropic 流式事件可兼容 server_tool_use 工具块');

  const anthropicCompatState = createAnthropicStreamState();
  applyAnthropicStreamEvent(anthropicCompatState, 'content_block_start', {
    index: 0,
    content_block: {
      type: 'text',
      text: ''
    }
  });
  const compatDeltaWithoutType = applyAnthropicStreamEvent(anthropicCompatState, 'content_block_delta', {
    index: 0,
    delta: {
      text: 'compat '
    }
  });
  applyAnthropicStreamEvent(anthropicCompatState, 'content_block_delta', {
    index: 0,
    delta: {
      type: 'unsupported_delta_type',
      text: 'text'
    }
  });
  const finalizedAnthropicCompat = finalizeAnthropicStreamState(anthropicCompatState, () => 'tool_generated');
  assert.equal(compatDeltaWithoutType.textDelta, 'compat ');
  assert.equal(finalizedAnthropicCompat.content, 'compat text');
  assert.deepEqual(finalizedAnthropicCompat.toolCalls, []);
  console.log('PASS anthropic 流式文本兼容无 type/非标准 delta.type 事件');

  const parsedAnthropicServerTool = protocolsModule.parseAnthropicResponse({
    id: 'msg_server_tool',
    role: 'assistant',
    content: [{
      type: 'server_tool_use',
      id: 'srvtool_2',
      name: 'web_fetch',
      input: {
        url: 'https://example.test'
      }
    }]
  }, () => 'tool_generated');
  assert.deepEqual(parsedAnthropicServerTool, {
    content: '',
    toolCalls: [{
      id: 'srvtool_2',
      type: 'function',
      function: {
        name: 'web_fetch',
        arguments: '{"url":"https://example.test"}'
      }
    }]
  });
  console.log('PASS anthropic 非流式响应可兼容 server_tool_use 工具块');
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

  const anthropicCompatUsage = normalizeTokenUsage('anthropic', {
    input_tokens: 350,
    cache_read_input_tokens: 23296,
    completion_tokens: 525,
    prompt_tokens: 331,
    total_tokens: 856
  }, 30000);
  assert.deepEqual(anthropicCompatUsage, {
    promptTokens: 331,
    completionTokens: 525,
    totalTokens: 856,
    outputBuffer: 30000
  });
  console.log('PASS anthropic 兼容接口会优先使用 prompt/completion/total 统计');

  const anthropicCachedUsage = normalizeTokenUsage('anthropic', {
    input_tokens: 350,
    cache_creation_input_tokens: 24,
    cache_read_input_tokens: 23296,
    output_tokens: 75
  });
  assert.deepEqual(anthropicCachedUsage, {
    promptTokens: 23670,
    completionTokens: 75,
    totalTokens: 23745,
    outputBuffer: undefined
  });
  console.log('PASS anthropic 缺失 prompt_tokens 时会把 cache 输入计入上下文占用');

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

function runContextUsageStateTests(contextUsageStateModule: ContextUsageStateModule): void {
  const {
    ContextUsageState,
    buildContextStatusText,
    buildContextStatusTooltip
  } = contextUsageStateModule;

  const state = new ContextUsageState();
  assert.equal(buildContextStatusText(undefined), 'CodingPlans Context --');
  assert.match(buildContextStatusTooltip(undefined), /CodingPlans Context/);

  state.update({
    provider: 'coding-plans',
    modelId: 'vendor/model',
    modelName: 'model',
    totalContextWindow: 131072,
    traceId: 'trace-1',
    recordedAt: Date.UTC(2026, 2, 20, 8, 52, 11),
    promptTokens: 21770,
    completionTokens: 8,
    totalTokens: 21778,
    outputBuffer: 1
  });

  const snapshot = state.getSnapshot();
  assert.ok(snapshot);
  assert.equal(buildContextStatusText(snapshot), 'CodingPlans Context 17%');
  const tooltip = buildContextStatusTooltip(snapshot);
  assert.match(tooltip, /16\.6% of 131\.1K/);
  assert.match(tooltip, /- Prompt: 21\.8K/);
  assert.match(tooltip, /- Completion: 8/);
  assert.match(tooltip, /- Total: 21\.8K/);
  assert.match(tooltip, /- Reserved Output: 1/);
  assert.match(tooltip, /- Occupied Context: 21\.8K/);
  const reservedSnapshot = {
    ...snapshot,
    totalContextWindow: 128000,
    promptTokens: 331,
    completionTokens: 525,
    totalTokens: 856,
    outputBuffer: 60000
  };
  assert.equal(buildContextStatusText(reservedSnapshot), 'CodingPlans Context 48%');
  const reservedTooltip = buildContextStatusTooltip(reservedSnapshot);
  assert.match(reservedTooltip, /47\.5% of 128K/);
  assert.match(reservedTooltip, /- Occupied Context: 60\.9K/);
  assert.match(tooltip, /- Model: model/);
  assert.match(tooltip, /- Updated: 2026-03-20T08:52:11\.000Z/);
  state.dispose();
  console.log('PASS ContextUsageState 与状态栏文案正常生成');
}

function runPlanUsageStatusTests(planUsageStatusModule: PlanUsageStatusModule): void {
  const {
    buildCodingPlanDetailsHtml,
    buildCodingPlanStatusText,
    buildCodingPlanStatusTooltip,
    buildPlanUsageStatusText,
    buildPlanUsageStatusTooltip,
    parseVendorPlanUsageSnapshot
  } = planUsageStatusModule;

  assert.equal(buildPlanUsageStatusText(undefined), 'CodingPlans Usage --');
  assert.match(buildPlanUsageStatusTooltip(undefined), /CodingPlans Usage/);

  const snapshot = parseVendorPlanUsageSnapshot(
    'zhipu',
    'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
    {
      code: 200,
      success: true,
      data: {
        productName: 'GLM Coding Max',
        limits: [
          {
            type: 'TOKENS_LIMIT',
            unit: 3,
            number: 5,
            usage: 800000000,
            currentValue: 127694464,
            remaining: 672305536,
            percentage: 15,
            nextResetTime: Date.UTC(2026, 2, 30, 10, 0, 0)
          },
          {
            type: 'TIME_LIMIT',
            unit: 5,
            number: 1,
            usage: 4000,
            currentValue: 1828,
            remaining: 2172,
            percentage: 45,
            usageDetails: [
              { modelCode: 'search-prime', usage: 1433 },
              { modelCode: 'web-reader', usage: 395 }
            ]
          }
        ]
      }
    },
    Date.UTC(2026, 2, 30, 8, 0, 0)
  );

  assert.ok(snapshot, '智谱 usage 响应应可被解析');
  assert.equal(snapshot?.vendor, 'zhipu');
  assert.equal(snapshot?.productName, 'GLM Coding Max');
  assert.deepEqual(
    snapshot?.limits.map(limit => ({
      label: limit.label,
      percentage: limit.percentage,
      used: limit.used,
      limit: limit.limit
    })),
    [
      {
        label: '5h',
        percentage: 15,
        used: 127694464,
        limit: 800000000
      },
      {
        label: 'MCP',
        percentage: 45,
        used: 1828,
        limit: 4000
      }
    ]
  );

  assert.equal(buildPlanUsageStatusText(snapshot), 'CodingPlans Usage 5h 15% | MCP 45%');
  const tooltip = buildPlanUsageStatusTooltip(snapshot);
  assert.match(tooltip, /GLM Coding Max/);
  assert.match(tooltip, /- 5h: 15% \(127\.7M \/ 800M\)/);
  assert.match(tooltip, /- MCP: 45% \(1828 \/ 4000\)/);
  assert.match(tooltip, /search-prime: 1433/);
  assert.match(tooltip, /web-reader: 395/);
  assert.match(tooltip, /Updated: 2026-03-30T08:00:00\.000Z/);
  assert.doesNotMatch(tooltip, /Source:/);
  assert.doesNotMatch(tooltip, /open\.bigmodel\.cn\/api\/monitor\/usage\/quota\/limit/);

  const contextSnapshot = {
    provider: 'coding-plans',
    modelId: 'zhipu/glm-4.7',
    modelName: 'glm-4.7',
    totalContextWindow: 131072,
    traceId: 'trace-usage-1',
    recordedAt: Date.UTC(2026, 2, 30, 8, 2, 0),
    promptTokens: 21770,
    completionTokens: 8,
    totalTokens: 21778,
    outputBuffer: 1
  };
  assert.equal(
    buildCodingPlanStatusText(contextSnapshot, snapshot),
    'CodingPlans 5h 15% | MCP 45% | Ctx 17%'
  );
  const mergedTooltip = buildCodingPlanStatusTooltip(contextSnapshot, snapshot);
  assert.match(mergedTooltip, /\*\*Plan Usage\*\*/);
  assert.match(mergedTooltip, /\*\*Context\*\*/);
  assert.match(mergedTooltip, /- 5h: 15% \(127\.7M \/ 800M\)/);
  assert.match(mergedTooltip, /- MCP: 45% \(1828 \/ 4000\)/);
  assert.match(mergedTooltip, /- Context: 16\.6% of 131\.1K/);
  assert.match(mergedTooltip, /- Prompt: 21\.8K/);
  assert.match(mergedTooltip, /- Model: glm-4\.7/);
  assert.match(mergedTooltip, /Click the status bar item to keep these details open/);
  assert.doesNotMatch(mergedTooltip, /Source:/);
  assert.doesNotMatch(mergedTooltip, /open\.bigmodel\.cn\/api\/monitor\/usage\/quota\/limit/);

  const detailsHtml = buildCodingPlanDetailsHtml(contextSnapshot, snapshot);
  assert.match(detailsHtml, /Pinned details for the status bar item/);
  assert.match(detailsHtml, /<h2>Plan Usage<\/h2>/);
  assert.match(detailsHtml, /<h2>Context<\/h2>/);
  assert.match(detailsHtml, /GLM Coding Max/);
  assert.match(detailsHtml, /glm-4\.7/);
  assert.doesNotMatch(detailsHtml, /Source:/);
  assert.doesNotMatch(detailsHtml, /open\.bigmodel\.cn\/api\/monitor\/usage\/quota\/limit/);
  console.log('PASS 智谱 usage 响应与状态栏文案可正确解析');
}

async function runLMChatProviderAdapterProvideTokenCountTests(
  contextUsageStateModule: ContextUsageStateModule,
  lmChatProviderAdapterModule: LMChatProviderAdapterModule
): Promise<void> {
  const vscode = require('vscode') as {
    Disposable: new (callback?: () => void) => { dispose(): void };
  };
  const { ContextUsageState } = contextUsageStateModule;
  const { LMChatProviderAdapter } = lmChatProviderAdapterModule;

  const fakeProvider = {
    getVendor(): string {
      return 'coding-plans';
    },
    onDidChangeModels(): { dispose(): void } {
      return new vscode.Disposable();
    }
  };

  const usageState = new ContextUsageState();
  const adapter = new LMChatProviderAdapter(fakeProvider as never, undefined, usageState);
  const model = {
    id: 'vendor/model',
    name: 'model'
  } as never;

  assert.equal(await adapter.provideTokenCount(model, 'hello', {} as never), 0);

  usageState.update({
    provider: 'coding-plans',
    modelId: 'vendor/model',
    modelName: 'model',
    totalContextWindow: 131072,
    traceId: 'trace-2',
    recordedAt: Date.now(),
    promptTokens: 1000,
    completionTokens: 20,
    totalTokens: 1020,
    outputBuffer: 10
  });

  assert.equal(await adapter.provideTokenCount(model, 'hello', {} as never), 0);
  assert.equal(await adapter.provideTokenCount(model, 'hello', {} as never), 0);

  usageState.update({
    provider: 'coding-plans',
    modelId: 'vendor/model',
    modelName: 'model',
    totalContextWindow: 131072,
    traceId: 'trace-3',
    recordedAt: Date.now(),
    promptTokens: 1200,
    completionTokens: 30,
    totalTokens: 1230,
    outputBuffer: 12
  });

  assert.equal(await adapter.provideTokenCount(model, 'hello', {} as never), 0);
  assert.equal(await adapter.provideTokenCount(model, 'hello', {} as never), 0);
  adapter.dispose();
  usageState.dispose();
  console.log('PASS LMChatProviderAdapter 的 provideTokenCount 固定返回 0');
}

async function main(): Promise<void> {
  const restore = installVscodeMock();
  try {
    const { ConfigStore } = require('../config/configStore') as ConfigStoreModule;
    const baseProviderModule = require('../providers/baseProvider') as BaseProviderModule;
    const genericProviderModule = require('../providers/genericProvider') as GenericProviderModule;
    const tokenUsageModule = require('../providers/tokenUsage') as TokenUsageModule;
    const protocolsModule = require('../providers/genericProviderProtocols') as ProtocolsModule;
    const contextUsageStateModule = require('../contextUsageState') as ContextUsageStateModule;
    const lmChatProviderAdapterModule = require('../providers/lmChatProviderAdapter') as LMChatProviderAdapterModule;
    const planUsageStatusModule = require('../planUsageStatus') as PlanUsageStatusModule;
    for (const testCase of testCases) {
      await runTestCase(ConfigStore, testCase);
    }
    await runConfigNormalizationTests(ConfigStore);
    runTokenWindowResolutionTests(baseProviderModule);
    runGenericProviderContextSizeTests(ConfigStore, genericProviderModule);
    runGenericProviderEmptyResponseTests(ConfigStore, genericProviderModule);
    await runGenericProviderOutputLimitToggleTests(ConfigStore, genericProviderModule, tokenUsageModule);
    await runGenericProviderAnthropicStreamFallbackTests(ConfigStore, genericProviderModule);
    await runGenericProviderAnthropicStreamErrorEventTests(ConfigStore, genericProviderModule);
    runProtocolStreamTests(protocolsModule);
    runTokenUsageNormalizationTests(tokenUsageModule);
    runContextUsageStateTests(contextUsageStateModule);
    runPlanUsageStatusTests(planUsageStatusModule);
    await runLMChatProviderAdapterProvideTokenCountTests(contextUsageStateModule, lmChatProviderAdapterModule);
  } finally {
    restore();
  }

  console.log('All tests passed.');
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});












