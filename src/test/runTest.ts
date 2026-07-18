import assert from 'node:assert/strict';

type ConfigChangeListener = (event: { affectsConfiguration: (section: string) => boolean }) => void;

type UpdateCall = {
  key: string;
  value: unknown;
  target: unknown;
};

type VendorModelRecord = {
  name: string;
  enabled?: boolean;
  description?: string;
  apiStyle?: 'openai-chat' | 'openai-responses' | 'anthropic';
  apiType?: 'chat' | 'responses' | 'anthropic';
  temperature?: number;
  topP?: number;
  capabilities?: {
    tools?: boolean;
    vision?: boolean;
    thinking?: boolean;
  };
  toolCalling?: boolean | number;
  vision?: boolean;
  contextSize?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  streaming?: boolean;
  thinking?: boolean;
  editTools?: string[];
  supportsReasoningEffort?: Array<'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>;
  reasoningEffortFormat?: 'chat-completions' | 'responses';
  zeroDataRetentionEnabled?: boolean;
  price?: {
    inputCost?: number;
    cacheCost?: number;
    outputCost?: number;
    longContextInputCost?: number;
    longContextCacheCost?: number;
    longContextOutputCost?: number;
  };
};

type VendorRecord = {
  name: string;
  baseUrl: string;
  apiKey?: string;
  usageUrl?: string;
  apiType?: 'chat' | 'responses' | 'anthropic';
  defaultApiStyle?: 'openai-chat' | 'openai-responses' | 'anthropic';
  enableExtraRequestWrapping?: boolean;
  defaultTemperature?: number;
  defaultTopP?: number;
  defaultVision?: boolean;
  useModelsEndpoint?: boolean;
  apiStyle?: 'openai-chat' | 'openai-responses' | 'anthropic';
  models: VendorModelRecord[];
};

type MockState = {
  vendors: unknown[];
  settings: Record<string, unknown>;
  updates: UpdateCall[];
  listeners: Set<ConfigChangeListener>;
};

type ConfigStoreModule = typeof import('../config/configStore');
type ConfigStoreCtor = ConfigStoreModule['ConfigStore'];
type BaseProviderModule = typeof import('../providers/baseProvider');
type GenericProviderModule = typeof import('../providers/genericProvider');
type ModelsDevCatalogModule = typeof import('../providers/modelsDevCatalog');
type TokenUsageModule = typeof import('../providers/tokenUsage');
type ProtocolsModule = typeof import('../providers/genericProviderProtocols');
type ContextUsageStateModule = typeof import('../contextUsageState');
type LMChatProviderAdapterModule = typeof import('../providers/lmChatProviderAdapter');
type PlanUsageStatusModule = typeof import('../planUsageStatus');
type CommitMessageGeneratorModule = typeof import('../commitMessageGenerator');
type ExtensionModule = typeof import('../extension');
type I18nModule = typeof import('../i18n/i18n');

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

function createState(vendors: unknown[], settings: Record<string, unknown> = {}): MockState {
  return {
    vendors,
    settings,
    updates: [],
    listeners: new Set<ConfigChangeListener>(),
  };
}

function createStaticVendorState(vendors: VendorRecord[]): MockState {
  return createState(vendors.map((vendor) => ({ ...vendor, useModelsEndpoint: vendor.useModelsEndpoint ?? false })));
}

let activeState = createState([]);

function createVscodeMock() {
  const configurationTarget = {
    WorkspaceFolder: 1,
    Workspace: 2,
    Global: 3,
  };
  const statusBarAlignment = {
    Left: 1,
    Right: 2,
  };
  const createdStatusBarItems: Array<Record<string, unknown>> = [];
  const shownWarningMessages: Array<{ message: string; items: unknown[] }> = [];
  const shownInformationMessages: Array<{ message: string; items: unknown[] }> = [];
  const shownErrorMessages: Array<{ message: string; items: unknown[] }> = [];
  const shownQuickPicks: Array<{ items: unknown[]; options: unknown }> = [];
  const shownInputBoxes: unknown[] = [];
  const executedCommands: Array<{ command: string; args: unknown[] }> = [];
  const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
  const outputTraceMessages: string[] = [];
  const nextQuickPickSelections: unknown[] = [];
  const nextInputBoxValues: Array<string | undefined> = [];
  let nextWarningMessageSelection: unknown;
  let outputChannelLogLevel = 3;

  class FakeLanguageModelTextPart {
    constructor(public readonly value: string) {}
  }

  class FakeLanguageModelToolCallPart {
    constructor(
      public readonly callId: string,
      public readonly name: string,
      public readonly input: unknown,
    ) {}
  }

  class FakeLanguageModelToolResultPart {
    constructor(
      public readonly callId: string,
      public readonly content: unknown[],
    ) {}
  }

  class FakeLanguageModelDataPart {
    constructor(
      public readonly data: Uint8Array,
      public readonly mimeType: string,
    ) {}
  }

  class FakeLanguageModelThinkingPart {
    constructor(public readonly value: string) {}
  }

  class FakeLanguageModelChatMessage {
    public readonly content: unknown[];

    constructor(
      public readonly role: number,
      content: string | unknown[],
      public readonly name?: string,
    ) {
      this.content = typeof content === 'string' ? [new FakeLanguageModelTextPart(content)] : content;
    }
  }

  const fakeLanguageModelChatMessageCtor = FakeLanguageModelChatMessage as unknown as Record<string, unknown>;
  fakeLanguageModelChatMessageCtor['User'] = (content: string | unknown[], name?: string) =>
    new FakeLanguageModelChatMessage(1, content, name);
  fakeLanguageModelChatMessageCtor['Assistant'] = (content: string | unknown[], name?: string) =>
    new FakeLanguageModelChatMessage(2, content, name);

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
    MarkdownString: FakeMarkdownString,
    LanguageModelTextPart: FakeLanguageModelTextPart,
    LanguageModelToolCallPart: FakeLanguageModelToolCallPart,
    LanguageModelToolResultPart: FakeLanguageModelToolResultPart,
    LanguageModelDataPart: FakeLanguageModelDataPart,
    LanguageModelThinkingPart: FakeLanguageModelThinkingPart,
    LanguageModelChatMessage: FakeLanguageModelChatMessage,
    LanguageModelChatToolMode: {
      Auto: 1,
      Required: 2,
    },
    LanguageModelChatMessageRole: {
      User: 1,
      Assistant: 2,
    },
    LogLevel: {
      Off: 0,
      Trace: 1,
      Debug: 2,
      Info: 3,
      Warning: 4,
      Error: 5,
    },
    ChatRequestTurn: FakeChatRequestTurn,
    ChatResponseTurn: FakeChatResponseTurn,
    ChatResponseMarkdownPart: FakeChatResponseMarkdownPart,
    LanguageModelError: FakeLanguageModelError,
    Uri: {
      joinPath(...parts: unknown[]): string {
        return parts.map(String).join('/');
      },
    },
    window: {
      createOutputChannel(_name: string, options?: { log?: boolean }) {
        assert.equal(options?.log, true);
        return {
          get logLevel(): number {
            return outputChannelLogLevel;
          },
          trace(message: string): void {
            outputTraceMessages.push(message);
          },
          debug(): void {
            return undefined;
          },
          info(): void {
            return undefined;
          },
          warn(): void {
            return undefined;
          },
          error(): void {
            return undefined;
          },
          dispose(): void {
            return undefined;
          },
        };
      },
      createStatusBarItem() {
        const item = {
          text: '',
          tooltip: '',
          name: '',
          command: undefined,
          show(): void {
            return undefined;
          },
          hide(): void {
            return undefined;
          },
          dispose(): void {
            return undefined;
          },
        };
        createdStatusBarItems.push(item);
        return item;
      },
      async showWarningMessage(message: string, ...items: unknown[]): Promise<unknown> {
        shownWarningMessages.push({ message, items });
        const selection = nextWarningMessageSelection;
        nextWarningMessageSelection = undefined;
        return selection;
      },
      async showInformationMessage(message: string, ...items: unknown[]): Promise<unknown> {
        shownInformationMessages.push({ message, items });
        return undefined;
      },
      async showErrorMessage(message: string, ...items: unknown[]): Promise<unknown> {
        shownErrorMessages.push({ message, items });
        return undefined;
      },
      async showQuickPick(items: unknown[] | Promise<unknown[]>, options?: unknown): Promise<unknown> {
        const resolvedItems = await Promise.resolve(items);
        shownQuickPicks.push({ items: resolvedItems, options });
        const selection = nextQuickPickSelections.shift();
        if (typeof selection === 'string') {
          return resolvedItems.find(
            (item) =>
              item && typeof item === 'object' && 'label' in item && (item as { label?: unknown }).label === selection,
          );
        }
        return selection;
      },
      async showInputBox(options?: unknown): Promise<string | undefined> {
        shownInputBoxes.push(options);
        return nextInputBoxValues.shift();
      },
    },
    testState: {
      createdStatusBarItems,
      shownWarningMessages,
      shownInformationMessages,
      shownErrorMessages,
      shownQuickPicks,
      shownInputBoxes,
      executedCommands,
      registeredCommands,
      outputTraceMessages,
      setOutputChannelLogLevel(logLevel: number): void {
        outputChannelLogLevel = logLevel;
      },
      setNextWarningMessageSelection(selection: unknown): void {
        nextWarningMessageSelection = selection;
      },
      enqueueQuickPickSelection(selection: unknown): void {
        nextQuickPickSelections.push(selection);
      },
      enqueueInputBoxValue(value: string | undefined): void {
        nextInputBoxValues.push(value);
      },
      clearQueuedInputs(): void {
        nextQuickPickSelections.length = 0;
        nextInputBoxValues.length = 0;
        nextWarningMessageSelection = undefined;
      },
    },
    commands: {
      registerCommand(command: string, callback: (...args: unknown[]) => unknown): FakeDisposable {
        registeredCommands.set(command, callback);
        return new FakeDisposable(() => {
          registeredCommands.delete(command);
        });
      },
      async executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
        executedCommands.push({ command, args });
        const registered = registeredCommands.get(command);
        return registered ? registered(...args) : undefined;
      },
      async getCommands(): Promise<string[]> {
        return Array.from(registeredCommands.keys());
      },
    },
    lm: {
      registerLanguageModelChatProvider(): FakeDisposable {
        return new FakeDisposable();
      },
      async invokeTool(_name: string, _options: unknown): Promise<{ content: unknown[] }> {
        return { content: [new FakeLanguageModelTextPart('tool-result')] };
      },
    },
    env: {
      language: 'zh-cn',
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
            if (key === 'vendors') {
              return activeState.vendors as T;
            }
            return Object.prototype.hasOwnProperty.call(activeState.settings, key)
              ? (activeState.settings[key] as T)
              : defaultValue;
          },
          inspect<T>(key: string): { globalValue: T } {
            if (key === 'vendors') {
              return { globalValue: activeState.vendors as T };
            }
            return { globalValue: activeState.settings[key] as T };
          },
          async update(key: string, value: unknown, target: unknown): Promise<void> {
            activeState.updates.push({ key, value, target });
            if (key === 'vendors') {
              activeState.vendors = value as unknown[];
            } else {
              activeState.settings[key] = value;
            }
            for (const listener of [...activeState.listeners]) {
              listener({
                affectsConfiguration(changedSection: string): boolean {
                  return changedSection === `coding-plans.${key}`;
                },
              });
            }
          },
        };
      },
    },
  };
}

function readMarkdownStringValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (
    value &&
    typeof value === 'object' &&
    'value' in value &&
    typeof (value as { value?: unknown }).value === 'string'
  ) {
    return (value as { value: string }).value;
  }
  return String(value ?? '');
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

function createExtensionContext(): {
  secrets: { get(): Promise<undefined>; store(): Promise<void>; delete(): Promise<void> };
} {
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
      },
    },
  };
}

function createExtensionContextWithSecrets(): {
  context: {
    secrets: {
      get(key: string): Promise<string | undefined>;
      store(key: string, value: string): Promise<void>;
      delete(key: string): Promise<void>;
    };
  };
  secrets: Map<string, string>;
} {
  const secrets = new Map<string, string>();
  return {
    context: {
      secrets: {
        async get(key: string): Promise<string | undefined> {
          return secrets.get(key);
        },
        async store(key: string, value: string): Promise<void> {
          secrets.set(key, value);
        },
        async delete(key: string): Promise<void> {
          secrets.delete(key);
        },
      },
    },
    secrets,
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
        contextSize: 128000,
      },
    ],
  };
}

function getUpdatedVendor(state: MockState): VendorRecord {
  return (state.vendors as VendorRecord[])[0];
}

async function waitForCondition(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for test condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function refreshWithDiscovery(provider: {
  refreshModels(options?: { forceDiscoveryRetry?: boolean; discoverFromEndpoint?: boolean }): Promise<void>;
}): Promise<void> {
  await provider.refreshModels({ discoverFromEndpoint: true });
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
    },
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
            contextSize: 128000,
          },
        ],
      },
    ],
    discoveredModels: [{ name: 'gpt-4o' }],
    verify(context) {
      verifyNoWriteback(context, '仅名称大小写差异');
    },
  },
  {
    name: '成员变化时规范化旧名称并保留字段',
    initialVendors: [createVendorWithSpacedModelName()],
    discoveredModels: [{ name: 'gpt-4o' }, { name: 'gpt-4.1' }],
    verify(context) {
      assert.equal(context.state.updates.length, 1, '成员变化时应写回一次 vendors 配置');
      assert.equal(context.changeCount(), 1, '成员变化时应触发一次 ConfigStore 配置变更事件');

      const updatedVendor = getUpdatedVendor(context.state);
      const existingModel = updatedVendor.models.find((model) => model.name === 'gpt-4o');
      const newModel = updatedVendor.models.find((model) => model.name === 'gpt-4.1');

      assert.ok(existingModel, '已有模型应保留且名称被规范化');
      assert.equal(existingModel?.description, 'Keep me');
      assert.equal(existingModel?.temperature, 0.25);
      assert.equal(existingModel?.topP, 0.95);
      assert.deepEqual(existingModel?.capabilities, { tools: true, vision: false });
      assert.equal(existingModel?.contextSize, 128000);
      assert.ok(newModel, '新模型应被追加到配置中');
      assert.equal(newModel?.description, undefined);
      assert.ok(!updatedVendor.models.some((model) => model.name === ' gpt-4o '), '写回配置时不应保留带空格名称');
    },
  },
  {
    name: '成员变化时保留模型 enabled 状态并为新增模型默认开启',
    initialVendors: [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        models: [
          {
            name: 'hidden-model',
            enabled: false,
            capabilities: { tools: true, vision: false },
          },
        ],
      },
    ],
    discoveredModels: [{ name: 'hidden-model' }, { name: 'new-model' }],
    verify(context) {
      assert.equal(context.state.updates.length, 1, '成员变化时应写回一次 vendors 配置');

      const updatedVendor = getUpdatedVendor(context.state);
      const hiddenModel = updatedVendor.models.find((model) => model.name === 'hidden-model');
      const newModel = updatedVendor.models.find((model) => model.name === 'new-model');
      assert.equal(hiddenModel?.enabled, false);
      assert.equal(newModel?.enabled, true);
    },
  },
  {
    name: '新增模型写回时使用供应商 defaultVision 且不落 token 上限',
    initialVendors: [createVendorWithSpacedModelName()],
    discoveredModels: [
      { name: 'gpt-4o' },
      {
        name: 'gpt-4.1',
        description: 'Fresh from /models',
        capabilities: { tools: true, vision: true },
        maxInputTokens: 128000,
        maxOutputTokens: 128000,
      },
    ],
    verify(context) {
      assert.equal(context.state.updates.length, 1, '新增模型时应写回一次 vendors 配置');

      const updatedVendor = getUpdatedVendor(context.state);
      const newModel = updatedVendor.models.find((model) => model.name === 'gpt-4.1');

      assert.ok(newModel, '新增模型应被写回到配置');
      assert.equal(newModel?.description, 'Fresh from /models');
      assert.equal(newModel?.temperature, undefined);
      assert.equal(newModel?.topP, undefined);
      assert.deepEqual(newModel?.capabilities, { tools: true, vision: false });
      assert.equal(newModel?.contextSize, undefined);
    },
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
      assert.equal(context.changeCount(), 1, '第二次刷新不应再触发新的 ConfigStore 变更事件');

      const updatedVendor = getUpdatedVendor(context.state);
      assert.ok(
        updatedVendor.models.some((model) => model.name === 'gpt-4o'),
        '第一次刷新后的规范化名称应被保留',
      );
      assert.ok(
        updatedVendor.models.some((model) => model.name === 'gpt-4.1'),
        '第一次刷新新增的模型应被保留',
      );
      assert.ok(!updatedVendor.models.some((model) => model.name === ' gpt-4o '), '第二次刷新后仍不应写回带空格名称');
    },
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
      assert.equal(context.changeCount(), 1, '相同集合仅顺序变化时第二次刷新不应新增事件');

      const updatedVendor = getUpdatedVendor(context.state);
      assert.deepEqual(
        updatedVendor.models.map((model) => model.name),
        ['gpt-4.1', 'gpt-4o'],
        '第一次刷新后模型顺序应稳定，第二次换序不应改写顺序',
      );
    },
  },
  {
    name: '发现列表含重复模型名时只写回一次且结果去重',
    initialVendors: [createVendorWithSpacedModelName()],
    async run(configStore) {
      await configStore.updateVendorModels('Vendor', [
        { name: 'gpt-4o' },
        { name: 'gpt-4.1' },
        { name: 'gpt-4o' },
        { name: 'GPT-4.1' },
      ]);
      await configStore.updateVendorModels('Vendor', [
        { name: 'gpt-4o' },
        { name: 'gpt-4.1' },
        { name: 'gpt-4o' },
        { name: 'GPT-4.1' },
      ]);
    },
    verify(context) {
      assert.equal(context.state.updates.length, 1, '发现列表有重复模型名时只应写回一次');
      assert.equal(context.changeCount(), 1, '第二次相同重复发现结果不应新增事件');

      const updatedVendor = getUpdatedVendor(context.state);
      assert.deepEqual(
        updatedVendor.models.map((model) => model.name),
        ['gpt-4.1', 'gpt-4o'],
        '写回配置时应按名称去重并保持稳定顺序',
      );
    },
  },
  {
    name: '发现列表含空名称时被忽略且不影响幂等',
    initialVendors: [createVendorWithSpacedModelName()],
    async run(configStore) {
      await configStore.updateVendorModels('Vendor', [
        { name: 'gpt-4o' },
        { name: '' },
        { name: '   ' },
        { name: 'gpt-4.1' },
      ]);
      await configStore.updateVendorModels('Vendor', [
        { name: 'gpt-4o' },
        { name: '   ' },
        { name: '' },
        { name: 'gpt-4.1' },
      ]);
    },
    verify(context) {
      assert.equal(context.state.updates.length, 1, '空名称和空白名称不应导致额外写回');
      assert.equal(context.changeCount(), 1, '第二次仅空名称顺序变化时不应新增事件');

      const updatedVendor = getUpdatedVendor(context.state);
      assert.deepEqual(
        updatedVendor.models.map((model) => model.name),
        ['gpt-4.1', 'gpt-4o'],
        '空名称和空白名称应被忽略，最终结果只保留有效模型',
      );
    },
  },
  {
    name: '未知 vendor 名称时不写回且不触发事件',
    initialVendors: [createVendorWithSpacedModelName()],
    async run(configStore) {
      await configStore.updateVendorModels('Unknown Vendor', [{ name: 'gpt-4o' }, { name: 'gpt-4.1' }]);
    },
    verify(context) {
      assert.equal(context.state.updates.length, 0, '未知 vendor 名称时不应写回 vendors 配置');
      assert.equal(context.changeCount(), 0, '未知 vendor 名称时不应触发 ConfigStore 变更事件');

      const updatedVendor = getUpdatedVendor(context.state);
      assert.deepEqual(
        updatedVendor.models.map((model) => model.name),
        [' gpt-4o '],
        '未知 vendor 名称时应保持原始配置不变',
      );
    },
  },
  {
    name: '空 vendorName 时直接 no-op',
    initialVendors: [createVendorWithSpacedModelName()],
    async run(configStore) {
      await configStore.updateVendorModels('', [{ name: 'gpt-4o' }, { name: 'gpt-4.1' }]);
      await configStore.updateVendorModels('   ', [{ name: 'gpt-4o' }, { name: 'gpt-4.1' }]);
    },
    verify(context) {
      assert.equal(context.state.updates.length, 0, '空 vendorName 或空白 vendorName 时不应写回 vendors 配置');
      assert.equal(context.changeCount(), 0, '空 vendorName 或空白 vendorName 时不应触发 ConfigStore 变更事件');

      const updatedVendor = getUpdatedVendor(context.state);
      assert.deepEqual(
        updatedVendor.models.map((model) => model.name),
        [' gpt-4o '],
        '空 vendorName 或空白 vendorName 时应保持原始配置不变',
      );
    },
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
      assert.equal(context.changeCount(), 1, '二次传入空数组时不应新增事件');

      const updatedVendor = getUpdatedVendor(context.state);
      assert.deepEqual(updatedVendor.models, [], '传入空数组时应正确清空已有模型');
    },
  },
  {
    name: '可按模型写回 apiStyle 且保留已有模型配置',
    initialVendors: [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: 'openai-chat',
        models: [
          {
            name: 'gpt-5.5',
            description: 'Keep me',
            apiStyle: 'openai-chat',
            temperature: 0.2,
            capabilities: { tools: true, vision: false },
          },
          {
            name: 'gpt-4o',
            apiStyle: 'openai-chat',
          },
        ],
      },
    ],
    async run(configStore) {
      const changed = await configStore.updateVendorModelApiStyle('Vendor', 'gpt-5.5', 'openai-responses');
      assert.equal(changed, true);
    },
    verify(context) {
      assert.equal(context.state.updates.length, 1, '模型协议切换应写回一次 vendors 配置');
      assert.equal(context.changeCount(), 1, '模型协议切换应触发一次配置变更事件');

      const updatedVendor = getUpdatedVendor(context.state);
      const switchedModel = updatedVendor.models.find((model) => model.name === 'gpt-5.5');
      const untouchedModel = updatedVendor.models.find((model) => model.name === 'gpt-4o');
      assert.equal(switchedModel?.apiStyle, 'openai-responses');
      assert.equal(switchedModel?.description, 'Keep me');
      assert.equal(switchedModel?.temperature, 0.2);
      assert.deepEqual(switchedModel?.capabilities, { tools: true, vision: false });
      assert.equal(untouchedModel?.apiStyle, 'openai-chat');
    },
  },
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
      changeCount: () => changeCount,
    });
    console.log(`PASS ${testCase.name}`);
  } finally {
    subscription.dispose();
    configStore.dispose();
  }
}

async function runConfigNormalizationTests(configStoreCtor: ConfigStoreCtor): Promise<void> {
  activeState = createState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/v1',
      defaultApiStyle: 'anthropic',
      defaultVision: true,
      models: [{ name: 'claude-3' }],
    },
  ]);

  let configStore = new configStoreCtor(createExtensionContext() as never);
  try {
    const vendor = configStore.getVendors()[0];
    assert.equal(vendor?.defaultApiStyle, 'anthropic');
    assert.equal(vendor?.models[0]?.apiStyle, 'anthropic');
    assert.deepEqual(vendor?.models[0]?.capabilities, { tools: true, vision: true });
    assert.equal(vendor?.defaultTemperature, undefined);
    assert.equal(vendor?.defaultTopP, undefined);
    console.log('PASS defaultApiStyle 与模型默认能力归一化正常');
  } finally {
    configStore.dispose();
  }

  activeState = createState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/v1',
      defaultApiStyle: 'openai-chat',
      defaultVision: false,
      models: [
        {
          name: 'r1',
          apiStyle: 'anthropic',
          capabilities: { tools: false },
        },
      ],
    },
  ]);

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

  activeState = createState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/v1',
      defaultApiStyle: 'openai-chat',
      defaultVision: false,
      models: [{ name: 'visible' }, { name: 'hidden', enabled: false }],
    },
  ]);

  configStore = new configStoreCtor(createExtensionContext() as never);
  try {
    const vendor = configStore.getVendors()[0];
    assert.equal(vendor?.models[0]?.enabled, true);
    assert.equal(vendor?.models[1]?.enabled, false);
    console.log('PASS 模型 enabled 字段默认开启且可显式关闭');
  } finally {
    configStore.dispose();
  }

  activeState = createState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/v1',
      defaultApiStyle: 'openai-responses',
      defaultVision: true,
      models: [],
    },
  ]);

  configStore = new configStoreCtor(createExtensionContext() as never);
  try {
    await configStore.updateVendorModels('Vendor', [{ name: 'gpt-4.1' } as VendorModelRecord]);
    const updatedVendor = getUpdatedVendor(activeState);
    assert.equal(updatedVendor.models[0]?.apiStyle, undefined);
    assert.deepEqual(updatedVendor.models[0]?.capabilities, { tools: true, vision: true });
    assert.equal(updatedVendor.models[0]?.temperature, undefined);
    assert.equal(updatedVendor.models[0]?.topP, undefined);
    console.log('PASS updateVendorModels 写回新模型时不再默认落 apiStyle，仅补齐 capabilities');
  } finally {
    configStore.dispose();
  }

  activeState = createState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/v1',
      defaultApiStyle: 'openai-chat',
      defaultVision: false,
      defaultTemperature: 0.2,
      defaultTopP: 1,
      models: [
        {
          name: 'coder',
          temperature: 0.35,
          topP: 0.92,
          capabilities: { tools: true, vision: false },
        },
      ],
    },
  ]);

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

  activeState = createState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/v1',
      defaultApiStyle: 'openai-chat',
      defaultVision: false,
      defaultTemperature: null as unknown as number,
      models: [
        {
          name: 'coder',
          temperature: 'inherit' as unknown as number,
          capabilities: { tools: true, vision: false },
        },
      ],
    },
  ]);

  configStore = new configStoreCtor(createExtensionContext() as never);
  try {
    const vendor = configStore.getVendors()[0];
    assert.equal(vendor?.defaultTemperature, undefined);
    assert.equal(vendor?.models[0]?.temperature, undefined);
    console.log('PASS vendor defaultTemperature 空值与模型级 temperature=inherit 会归一化为未设置');
  } finally {
    configStore.dispose();
  }

  activeState = createState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/v1',
      defaultApiStyle: 'openai-chat',
      defaultVision: false,
      models: [
        {
          name: 'legacy-reasoner',
          thinkingEffort: 'high',
          capabilities: { tools: true, vision: false },
        },
      ] as unknown as VendorModelRecord[],
    },
  ]);

  configStore = new configStoreCtor(createExtensionContext() as never);
  try {
    await configStore.updateVendorModels('Vendor', [
      { name: 'legacy-reasoner' } as VendorModelRecord,
      { name: 'new-model' } as VendorModelRecord,
    ]);
    const updatedVendor = getUpdatedVendor(activeState);
    assert.equal('thinkingEffort' in (updatedVendor.models[0] as Record<string, unknown>), false);
    console.log('PASS updateVendorModels 写回时会清理 legacy thinkingEffort 字段');
  } finally {
    configStore.dispose();
  }

  activeState = createState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/v1',
      defaultApiStyle: 'openai-chat',
      defaultVision: false,
      models: [
        {
          name: 'legacy-disabled',
          thinking: false,
          capabilities: { tools: true, vision: false },
        },
        {
          name: 'new-field-wins',
          thinking: true,
          capabilities: { tools: true, vision: false, thinking: false },
        },
      ],
    },
  ]);

  configStore = new configStoreCtor(createExtensionContext() as never);
  try {
    await configStore.ready();
    assert.equal(activeState.updates.length, 1, '旧 thinking 字段应在初始化时自动写回迁移');
    const updatedVendor = getUpdatedVendor(activeState);
    assert.deepEqual(updatedVendor.models[0]?.capabilities, { tools: true, vision: false, thinking: false });
    assert.equal('thinking' in (updatedVendor.models[0] as Record<string, unknown>), false);
    assert.deepEqual(updatedVendor.models[1]?.capabilities, { tools: true, vision: false, thinking: false });
    assert.equal('thinking' in (updatedVendor.models[1] as Record<string, unknown>), false);
    console.log('PASS ConfigStore 初始化时自动迁移 legacy models[].thinking 到 capabilities.thinking');
  } finally {
    configStore.dispose();
  }

  activeState = createState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/v1',
      defaultApiStyle: 'openai-chat',
      defaultVision: false,
      models: [
        {
          name: 'coder',
          capabilities: { tools: true, vision: false },
        },
      ],
    },
  ]);

  configStore = new configStoreCtor(createExtensionContext() as never);
  try {
    const vendor = configStore.getVendors()[0];
    assert.equal(vendor?.defaultTemperature, undefined);
    assert.equal(vendor?.models[0]?.temperature, undefined);
    console.log('PASS 未配置 temperature 时保持留空，运行时默认不发送 temperature');
  } finally {
    configStore.dispose();
  }

  activeState = createState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/v1',
      usageUrl: ' https://example.test/usage ',
      defaultApiStyle: 'openai-chat',
      defaultVision: false,
      models: [],
    },
  ]);

  configStore = new configStoreCtor(createExtensionContext() as never);
  try {
    const vendor = configStore.getVendors()[0];
    assert.equal(vendor?.usageUrl, 'https://example.test/usage');
    console.log('PASS usageUrl 可被归一化并保留');
  } finally {
    configStore.dispose();
  }

  activeState = createState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/v1',
      defaultApiStyle: 'openai-chat',
      defaultVision: false,
      models: [],
    },
  ]);

  configStore = new configStoreCtor(createExtensionContext() as never);
  try {
    const vendor = configStore.getVendors()[0];
    assert.equal(vendor?.enableExtraRequestWrapping, true);
    console.log('PASS enableExtraRequestWrapping 默认归一化为 true');
  } finally {
    configStore.dispose();
  }

  activeState = createState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/v1',
      defaultApiStyle: 'openai-chat',
      enableExtraRequestWrapping: false,
      defaultVision: false,
      models: [],
    },
  ]);

  configStore = new configStoreCtor(createExtensionContext() as never);
  try {
    const vendor = configStore.getVendors()[0];
    assert.equal(vendor?.enableExtraRequestWrapping, false);
    console.log('PASS enableExtraRequestWrapping=false 可被保留');
  } finally {
    configStore.dispose();
  }

  activeState = createState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/v1',
      apiType: 'responses',
      defaultVision: false,
      models: [
        {
          name: 'gpt-5.5',
          apiType: 'responses',
          maxInputTokens: 400000,
          maxOutputTokens: 128000,
          toolCalling: true,
          vision: true,
          streaming: false,
          thinking: true,
          editTools: ['apply-patch'],
          supportsReasoningEffort: ['high', 'xhigh'],
          reasoningEffortFormat: 'responses',
          zeroDataRetentionEnabled: false,
          price: {
            inputCost: 4,
            cacheCost: 1,
            outputCost: 12,
            longContextInputCost: 6,
            longContextCacheCost: 2,
            longContextOutputCost: 18,
          },
        },
      ],
    },
  ]);

  configStore = new configStoreCtor(createExtensionContext() as never);
  try {
    const vendor = configStore.getVendors()[0];
    const model = vendor?.models[0];
    assert.equal(vendor?.apiType, 'responses');
    assert.equal(vendor?.defaultApiStyle, 'openai-responses');
    assert.equal(model?.apiType, 'responses');
    assert.equal(model?.apiStyle, 'openai-responses');
    assert.equal(model?.maxInputTokens, 400000);
    assert.equal(model?.maxOutputTokens, 128000);
    assert.deepEqual(model?.capabilities, { tools: true, vision: true, thinking: true });
    assert.equal(model?.streaming, false);
    assert.equal('thinking' in ((model ?? {}) as unknown as Record<string, unknown>), false);
    assert.deepEqual(model?.editTools, ['apply-patch']);
    assert.deepEqual(model?.supportsReasoningEffort, ['high', 'xhigh']);
    assert.equal(model?.reasoningEffortFormat, 'responses');
    assert.equal(model?.zeroDataRetentionEnabled, false);
    assert.deepEqual(model?.price, {
      inputCost: 4,
      cacheCost: 1,
      outputCost: 12,
      longContextInputCost: 6,
      longContextCacheCost: 2,
      longContextOutputCost: 18,
    });
    console.log('PASS Copilot 风格模型参数可归一化到现有 vendor/model 配置');
  } finally {
    configStore.dispose();
  }

  activeState = createState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/v1',
      defaultApiStyle: 'openai-responses',
      defaultVision: false,
      models: [
        {
          name: 'gpt-5.5',
          apiType: 'responses',
          editTools: ['apply-patch'],
          supportsReasoningEffort: ['high', 'xhigh'],
          streaming: false,
          zeroDataRetentionEnabled: false,
          price: {
            inputCost: 4,
            cacheCost: 1,
            outputCost: 12,
          },
        },
      ],
    },
  ]);

  configStore = new configStoreCtor(createExtensionContext() as never);
  try {
    await configStore.updateVendorModels('Vendor', [
      { name: 'gpt-5.5' } as VendorModelRecord,
      { name: 'new-model' } as VendorModelRecord,
    ]);
    const updatedVendor = getUpdatedVendor(activeState);
    const preservedModel = updatedVendor.models.find((model) => model.name === 'gpt-5.5');
    assert.equal(preservedModel?.apiType, 'responses');
    assert.deepEqual(preservedModel?.editTools, ['apply-patch']);
    assert.deepEqual(preservedModel?.supportsReasoningEffort, ['high', 'xhigh']);
    assert.equal(preservedModel?.streaming, false);
    assert.equal(preservedModel?.zeroDataRetentionEnabled, false);
    assert.deepEqual(preservedModel?.price, {
      inputCost: 4,
      cacheCost: 1,
      outputCost: 12,
    });
    console.log('PASS updateVendorModels 写回时保留 Copilot 风格模型覆盖字段');
  } finally {
    configStore.dispose();
  }
}

async function runConfigStoreVendorApiKeySecretStorageTests(configStoreCtor: ConfigStoreCtor): Promise<void> {
  activeState = createState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/v1',
      defaultApiStyle: 'openai-chat',
      useModelsEndpoint: false,
      models: [],
    },
  ]);

  let secretContext = createExtensionContextWithSecrets();
  secretContext.secrets.set('coding-plans.vendor.apiKey.Vendor', 'secret-key');
  let configStore = new configStoreCtor(secretContext.context as never);
  try {
    assert.equal(await configStore.getApiKey('Vendor'), 'secret-key');
    console.log('PASS ConfigStore 从 Secret Storage 读取 API Key');
  } finally {
    configStore.dispose();
  }

  activeState = createState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/v1',
      apiKey: ' config-key ',
      defaultApiStyle: 'openai-chat',
      models: [],
    },
  ]);

  secretContext = createExtensionContextWithSecrets();
  secretContext.secrets.set('coding-plans.vendor.apiKey.Vendor', 'secret-key');
  configStore = new configStoreCtor(secretContext.context as never);
  try {
    assert.equal(await configStore.getApiKey('Vendor'), 'config-key');
    console.log('PASS ConfigStore 优先读取 vendors[].apiKey');
  } finally {
    configStore.dispose();
  }

  activeState = createState([
    {
      name: 'test',
      baseUrl: 'http://100.64.0.14:34046/v1',
      defaultApiStyle: 'openai-chat',
      useModelsEndpoint: true,
      models: [],
    },
    {
      name: 'cliproxyapi',
      baseUrl: 'http://100.64.0.14:34046/v1/',
      apiKey: ' shared-endpoint-key ',
      defaultApiStyle: 'openai-chat',
      useModelsEndpoint: true,
      models: [],
    },
  ]);

  secretContext = createExtensionContextWithSecrets();
  configStore = new configStoreCtor(secretContext.context as never);
  try {
    assert.equal(await configStore.getApiKey('test'), 'shared-endpoint-key');
    console.log('PASS ConfigStore 可按相同 baseUrl 兜底读取 vendors[].apiKey');
  } finally {
    configStore.dispose();
  }

  activeState = createState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/v1',
      defaultApiStyle: 'openai-chat',
      useModelsEndpoint: false,
      models: [],
    },
  ]);

  secretContext = createExtensionContextWithSecrets();
  configStore = new configStoreCtor(secretContext.context as never);
  try {
    assert.equal(await configStore.getApiKey('Vendor'), '');
    console.log('PASS ConfigStore 无 Secret Storage 值时返回空 API Key');
  } finally {
    configStore.dispose();
  }

  activeState = createState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/v1',
      defaultApiStyle: 'openai-chat',
      models: [],
    },
  ]);

  secretContext = createExtensionContextWithSecrets();
  secretContext.secrets.set('coding-plans.vendor.apiKey.Vendor', 'secret-key');
  configStore = new configStoreCtor(secretContext.context as never);
  let changeCount = 0;
  const subscription = configStore.onDidChange(() => {
    changeCount += 1;
  });
  try {
    await configStore.setApiKey('Vendor', ' secret-key ');
    assert.equal(secretContext.secrets.get('coding-plans.vendor.apiKey.Vendor'), 'secret-key');
    assert.equal(changeCount, 0);
    console.log('PASS ConfigStore.setApiKey 对相同 Secret 值不重复触发变更事件');
  } finally {
    subscription.dispose();
    configStore.dispose();
  }
}

function runTokenWindowResolutionTests(baseProviderModule: BaseProviderModule): void {
  const { BaseAIProvider } = baseProviderModule;
  const vscode = require('vscode') as typeof import('vscode');

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
      explicitMaxOutputTokens: number | undefined,
    ): {
      maxTokens: number;
      maxInputTokens: number;
      maxOutputTokens: number;
    };
    buildToolDefinitions(options?: {
      tools?: Array<{
        name?: string;
        description?: string;
        inputSchema?: object;
        function?: { name?: string; description?: string; parameters?: object };
      }>;
    }):
      | Array<{
          type: 'function';
          function: {
            name: string;
            description?: string;
            parameters?: object;
          };
        }>
      | undefined;
    toProviderMessages(messages: import('vscode').LanguageModelChatMessage[]): Array<{
      role: string;
      content: string;
      tool_calls?: unknown[];
      tool_call_id?: string;
    }>;
    dispose(): void;
  };

  try {
    const defaultWindow = provider.resolveTokenWindowLimits(undefined, undefined, undefined);
    assert.deepEqual(defaultWindow, {
      maxTokens: 430000,
      maxInputTokens: 400000,
      maxOutputTokens: 30000,
    });
    console.log('PASS runtime token window 未配置时按输入+输出窗口汇总总上下文');

    const capped = provider.resolveTokenWindowLimits(64000, 128000, 96000);
    assert.deepEqual(capped, {
      maxTokens: 64000,
      maxInputTokens: 51200,
      maxOutputTokens: 12800,
    });
    console.log('PASS runtime token window contextSize 优先于 maxInputTokens');

    const preserved = provider.resolveTokenWindowLimits(64000, 32000, 16000);
    assert.deepEqual(preserved, {
      maxTokens: 64000,
      maxInputTokens: 51200,
      maxOutputTokens: 12800,
    });
    console.log('PASS runtime token window contextSize 按 80/20 拆分输入输出窗口');

    const implicitOutput = provider.resolveTokenWindowLimits(64000, undefined, undefined);
    assert.deepEqual(implicitOutput, {
      maxTokens: 64000,
      maxInputTokens: 51200,
      maxOutputTokens: 12800,
    });
    console.log('PASS runtime token window contextSize 缺省时同样按 80/20 拆分');
    const sanitizedTools = provider.buildToolDefinitions({
      tools: [
        {
          name: 'search_codebase',
          description: 'Searching codebase for "{1}"',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Use "{1}" as the semantic query.',
                enumDescriptions: ['Search "{1}"'],
              },
            },
            enumDescriptions: ['Root "{1}"'],
            markdownDescription: 'Pick "{1}"',
          },
        },
      ],
    });
    assert.deepEqual(sanitizedTools, [
      {
        type: 'function',
        function: {
          name: 'search_codebase',
          description: 'Searching codebase for "value"',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Use "value" as the semantic query.',
              },
            },
          },
        },
      },
    ]);
    console.log('PASS 工具定义转发前会清洗未替换占位符并移除 VS Code 扩展 schema 字段');

    const openAIShapeTools = provider.buildToolDefinitions({
      tools: [
        {
          function: {
            name: 'read_file',
            description: 'Read a file',
            parameters: {
              type: 'object',
              properties: {
                path: {
                  type: 'string',
                },
              },
            },
          },
        },
      ],
    });
    assert.deepEqual(openAIShapeTools, [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
              },
            },
          },
        },
      },
    ]);
    console.log('PASS 工具定义可接受运行时 OpenAI function 形态并保留 function.name');

    assert.throws(
      () =>
        provider.buildToolDefinitions({
          tools: [
            {
              description: 'Missing name',
            },
          ],
        }),
      /missing tool name/,
    );
    console.log('PASS 工具定义缺少 name 时会在扩展侧拒绝无效 payload');

    const providerMessages = provider.toProviderMessages([
      vscode.LanguageModelChatMessage.User([
        new vscode.LanguageModelTextPart('你好'),
        new vscode.LanguageModelDataPart(new TextEncoder().encode('{"ttl":300}'), 'cache_control'),
      ]),
    ] as unknown as import('vscode').LanguageModelChatMessage[]);
    assert.deepEqual(providerMessages, [
      {
        role: 'user',
        content: '你好',
      },
    ]);
    console.log('PASS 非文本 data part 不会被串成占位文本转发给上游模型');
  } finally {
    provider.dispose();
  }
}

async function runGenericProviderContextSizeTests(
  configStoreCtor: ConfigStoreCtor,
  genericProviderModule: GenericProviderModule,
): Promise<void> {
  const { GenericAIProvider } = genericProviderModule;
  activeState = createState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/v1',
      defaultApiStyle: 'openai-chat',
      defaultVision: false,
      models: [
        {
          name: 'context-budget',
          contextSize: 64000,
        },
      ],
    },
  ]);

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
    assert.equal(models[0]?.maxInputTokens, 51200);
    assert.equal(models[0]?.maxOutputTokens, 12800);
    console.log('PASS GenericAIProvider 使用 contextSize 作为优先生效的上下文窗口');
  } finally {
    provider.dispose();
    configStore.dispose();
  }

  activeState = createState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/v1',
      defaultApiStyle: 'openai-chat',
      defaultVision: false,
      models: [
        {
          name: 'context-output-budget',
          contextSize: 131072,
        },
      ],
    },
  ]);

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
    assert.equal(models[0]?.maxInputTokens, 104858);
    assert.equal(models[0]?.maxOutputTokens, 26214);
    assert.equal(cappedProvider.resolveRequestedOutputLimit({ modelId: models[0]!.id }), 26214);
    console.log('PASS GenericAIProvider 请求上游时默认输出预算会按模型上限收敛');
  } finally {
    cappedProvider.dispose();
    cappedConfigStore.dispose();
  }

  const implicitReserveScenarios = [32000, 64000, 128000, 200000];
  for (const contextSize of implicitReserveScenarios) {
    activeState = createState([
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: 'openai-chat',
        defaultVision: false,
        models: [
          {
            name: `zero-unset-runtime-${contextSize}`,
            contextSize,
            maxInputTokens: 0,
            maxOutputTokens: 0,
          },
        ],
      },
    ]);

    const zeroUnsetConfigStore = new configStoreCtor(createExtensionContext() as never);
    const zeroUnsetProvider = new GenericAIProvider(
      createExtensionContext() as never,
      zeroUnsetConfigStore,
    ) as unknown as {
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
      assert.equal(models[0]?.maxTokens, contextSize);
      assert.equal(models[0]?.maxInputTokens, contextSize - Math.floor(contextSize * 0.2));
      assert.equal(models[0]?.maxOutputTokens, Math.floor(contextSize * 0.2));
      console.log(`PASS 运行时会把 0 视为未设置并按 contextSize 80/20 拆分 (${contextSize})`);
    } finally {
      zeroUnsetProvider.dispose();
      zeroUnsetConfigStore.dispose();
    }
  }

  activeState = createState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/v1',
      defaultApiStyle: 'openai-chat',
      defaultVision: false,
      models: [
        {
          name: 'copilot-runtime',
          apiType: 'responses',
          contextSize: 640000,
          maxInputTokens: 400000,
          maxOutputTokens: 128000,
          toolCalling: true,
          vision: true,
          streaming: false,
          thinking: true,
          editTools: ['apply-patch'],
          supportsReasoningEffort: ['high', 'xhigh'],
          reasoningEffortFormat: 'responses',
          zeroDataRetentionEnabled: false,
          price: {
            inputCost: 8,
            cacheCost: 1,
            outputCost: 8,
            longContextInputCost: 10,
            longContextCacheCost: 2,
            longContextOutputCost: 20,
          },
        },
      ],
    },
  ]);

  const copilotConfigStore = new configStoreCtor(createExtensionContext() as never);
  const copilotProvider = new GenericAIProvider(createExtensionContext() as never, copilotConfigStore) as unknown as {
    buildConfiguredModelsForVendor(vendor: VendorRecord): Array<{
      apiStyle?: string;
      apiType?: string;
      maxTokens: number;
      maxInputTokens: number;
      maxOutputTokens: number;
      capabilities?: { toolCalling?: boolean | number; imageInput?: boolean; thinking?: boolean };
      streaming?: boolean;
      editTools?: string[];
      supportsReasoningEffort?: string[];
      reasoningEffortFormat?: string;
      zeroDataRetentionEnabled?: boolean;
      inputCost?: number;
      cacheCost?: number;
      outputCost?: number;
      longContextInputCost?: number;
      longContextCacheCost?: number;
      longContextOutputCost?: number;
    }>;
    dispose(): void;
  };

  try {
    const vendor = copilotConfigStore.getVendors()[0] as VendorRecord;
    const models = copilotProvider.buildConfiguredModelsForVendor(vendor);
    assert.equal(models[0]?.apiStyle, 'openai-responses');
    assert.equal(models[0]?.apiType, 'responses');
    assert.equal(models[0]?.maxTokens, 640000);
    assert.equal(models[0]?.maxInputTokens, 512000);
    assert.equal(models[0]?.maxOutputTokens, 128000);
    assert.deepEqual(models[0]?.capabilities, { toolCalling: true, imageInput: true, thinking: true });
    assert.equal(models[0]?.streaming, false);
    assert.equal('thinking' in ((models[0] ?? {}) as Record<string, unknown>), false);
    assert.equal((models[0] as { enableExtraRequestWrapping?: boolean }).enableExtraRequestWrapping, true);
    assert.deepEqual(models[0]?.editTools, ['apply-patch']);
    assert.deepEqual(models[0]?.supportsReasoningEffort, ['high', 'xhigh']);
    assert.equal(models[0]?.reasoningEffortFormat, 'responses');
    assert.equal(models[0]?.zeroDataRetentionEnabled, false);
    assert.equal(models[0]?.inputCost, 8);
    assert.equal(models[0]?.cacheCost, 1);
    assert.equal(models[0]?.outputCost, 8);
    assert.equal(models[0]?.longContextInputCost, 10);
    assert.equal(models[0]?.longContextCacheCost, 2);
    assert.equal(models[0]?.longContextOutputCost, 20);
    console.log('PASS GenericAIProvider 构建模型时应用 Copilot 风格参数');
  } finally {
    copilotProvider.dispose();
    copilotConfigStore.dispose();
  }

  activeState = createState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/v1',
      defaultApiStyle: 'openai-chat',
      enableExtraRequestWrapping: false,
      defaultVision: false,
      models: [
        {
          name: 'plain',
          contextSize: 64000,
        },
      ],
    },
  ]);

  const wrappingConfigStore = new configStoreCtor(createExtensionContext() as never);
  const wrappingProvider = new GenericAIProvider(createExtensionContext() as never, wrappingConfigStore) as unknown as {
    buildConfiguredModelsForVendor(vendor: VendorRecord): Array<{
      enableExtraRequestWrapping?: boolean;
    }>;
    dispose(): void;
  };

  try {
    const vendor = wrappingConfigStore.getVendors()[0] as VendorRecord;
    const models = wrappingProvider.buildConfiguredModelsForVendor(vendor);
    assert.equal(models[0]?.enableExtraRequestWrapping, false);
    console.log('PASS GenericAIProvider 会把 vendor enableExtraRequestWrapping 传递到运行时模型');
  } finally {
    wrappingProvider.dispose();
    wrappingConfigStore.dispose();
  }

  activeState = createState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/v1',
      defaultApiStyle: 'openai-chat',
      defaultVision: false,
      models: [
        {
          name: 'default-edit-tool',
        },
      ],
    },
  ]);

  const defaultEditToolConfigStore = new configStoreCtor(createExtensionContext() as never);
  const defaultEditToolProvider = new GenericAIProvider(
    createExtensionContext() as never,
    defaultEditToolConfigStore,
  ) as unknown as {
    refreshModels(): Promise<void>;
    getAvailableModels(): Array<{
      editTools: readonly string[];
    }>;
    dispose(): void;
  };

  try {
    await defaultEditToolProvider.refreshModels();
    assert.deepEqual(defaultEditToolProvider.getAvailableModels()[0]?.editTools, [
      'apply-patch',
      'multi-find-replace',
      'find-replace',
      'code-rewrite',
    ]);
    console.log('PASS 运行时模型默认声明四种 editTools');
  } finally {
    defaultEditToolProvider.dispose();
    defaultEditToolConfigStore.dispose();
  }
}

function runGenericProviderRequestContentLoggingTests(genericProviderModule: GenericProviderModule): void {
  const vscodeMock = require('vscode') as {
    LogLevel: { Trace: number; Debug: number; Info: number };
    testState: {
      outputTraceMessages: string[];
      setOutputChannelLogLevel(logLevel: number): void;
    };
  };
  const { GenericAIProvider } = genericProviderModule;
  const provider = new GenericAIProvider(createExtensionContext() as never, {
    getVendors(): VendorRecord[] {
      return [];
    },
    onDidChange(): FakeDisposable {
      return new FakeDisposable();
    },
  } as never) as unknown as {
    logRequestMessageContentPreviews(
      trace: {
        traceId: string;
        vendorName: string;
        modelId: string;
        modelName: string;
        protocol: 'openai-chat';
      },
      messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }>,
    ): void;
    dispose(): void;
  };
  const logPrefix = 'Language model request message content previews ';
  const longSystemContent = 's'.repeat(1200);
  const trace = {
    traceId: 'trace_content_preview',
    vendorName: 'Vendor',
    modelId: 'Vendor/coder',
    modelName: 'coder',
    protocol: 'openai-chat' as const,
  };
  const messages = [
    { role: 'system' as const, content: longSystemContent },
    { role: 'user' as const, content: 'user prompt' },
    { role: 'assistant' as const, content: 'assistant reply' },
    { role: 'tool' as const, content: 'tool output must not be logged' },
  ];

  try {
    vscodeMock.testState.outputTraceMessages.length = 0;
    vscodeMock.testState.setOutputChannelLogLevel(vscodeMock.LogLevel.Debug);
    provider.logRequestMessageContentPreviews(trace, messages);
    assert.equal(vscodeMock.testState.outputTraceMessages.length, 0);

    vscodeMock.testState.setOutputChannelLogLevel(vscodeMock.LogLevel.Trace);
    provider.logRequestMessageContentPreviews(trace, messages);
    assert.equal(vscodeMock.testState.outputTraceMessages.length, 1);
    const logMessage = vscodeMock.testState.outputTraceMessages[0] ?? '';
    assert.ok(logMessage.startsWith(logPrefix));
    const payload = JSON.parse(logMessage.slice(logPrefix.length)) as {
      contentLimit: number;
      messages: Array<{
        role: string;
        contentLength: number;
        contentPreview: string;
        truncated: boolean;
      }>;
    };
    assert.equal(payload.contentLimit, 1000);
    assert.deepEqual(
      payload.messages.map((message) => message.role),
      ['system', 'user', 'assistant'],
    );
    assert.equal(payload.messages[0]?.contentLength, 1200);
    assert.equal(payload.messages[0]?.contentPreview, 's'.repeat(1000));
    assert.equal(payload.messages[0]?.truncated, true);
    assert.equal(payload.messages[1]?.contentPreview, 'user prompt');
    assert.equal(payload.messages[1]?.truncated, false);
    assert.equal(payload.messages[2]?.contentPreview, 'assistant reply');
    assert.ok(!logMessage.includes('tool output must not be logged'));
    console.log('PASS 仅 Trace 日志记录 system/user/assistant content 前 1000 个字符并排除 tool content');
  } finally {
    vscodeMock.testState.setOutputChannelLogLevel(vscodeMock.LogLevel.Info);
    provider.dispose();
  }
}

async function runNativeLogLevelConfigurationTests(): Promise<void> {
  const vscodeMock = require('vscode') as {
    ConfigurationTarget: { Global: number };
    LogLevel: { Trace: number; Off: number };
    workspace: {
      getConfiguration(section: string): {
        update(key: string, value: unknown, target: unknown): Promise<void>;
      };
    };
    testState: {
      executedCommands: Array<{ command: string; args: unknown[] }>;
    };
  };
  const { logger: outputLogger } = require('../logging/outputChannelLogger') as typeof import('../logging/outputChannelLogger');
  const extensionId = 'techfetch-dev.coding-plans-for-copilot';
  activeState = createState([], { logLevel: 'trace' });
  vscodeMock.testState.executedCommands.length = 0;

  await outputLogger.configureNativeLogLevel(extensionId);
  assert.deepEqual(vscodeMock.testState.executedCommands.at(-1), {
    command: 'workbench.action.setDefaultLogLevel',
    args: [vscodeMock.LogLevel.Trace, extensionId],
  });

  await vscodeMock.workspace
    .getConfiguration('coding-plans')
    .update('logLevel', 'off', vscodeMock.ConfigurationTarget.Global);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(vscodeMock.testState.executedCommands.at(-1), {
    command: 'workbench.action.setDefaultLogLevel',
    args: [vscodeMock.LogLevel.Off, extensionId],
  });
  activeState = createState([]);
  console.log('PASS coding-plans.logLevel 会同步到 VS Code 原生扩展日志等级');
}

async function runModelsDevCatalogTests(modelsDevCatalogModule: ModelsDevCatalogModule): Promise<void> {
  const { normalizeModelsDevCatalog, resolveModelsDevModelConfig, inferDefaultApiStyleForModel } =
    modelsDevCatalogModule;
  const catalog = normalizeModelsDevCatalog({
    models: {
      'zhipuai/glm-5.2': {
        id: 'zhipuai/glm-5.2',
        name: 'GLM-5.2',
        family: 'glm',
        open_weights: true,
        release_date: '2026-06-13',
        reasoning: true,
        tool_call: true,
        modalities: {
          input: ['text'],
          output: ['text'],
        },
        limit: {
          context: 1000000,
          output: 131072,
        },
      },
    },
    google: {
      id: 'google',
      name: 'Google',
      models: {
        'gemini-3-flash-preview': {
          id: 'gemini-3-flash-preview',
          name: 'Gemini 3 Flash Preview',
          family: 'gemini-flash',
          open_weights: false,
          release_date: '2025-12-17',
          last_updated: '2025-12-18',
          knowledge: '2025-01',
          reasoning: true,
          tool_call: true,
          modalities: {
            input: ['text', 'image', 'video', 'audio', 'pdf'],
            output: ['text'],
          },
          limit: {
            context: 1048576,
            output: 65536,
          },
          cost: {
            input: 0.5,
            output: 3,
            cache_read: 0.05,
          },
        },
        'gemini-3.1-flash-lite-preview': {
          id: 'gemini-3.1-flash-lite-preview',
          name: 'Gemini 3.1 Flash Lite Preview',
          family: 'gemini-flash-lite',
          open_weights: false,
          release_date: '2026-03-03',
          last_updated: '2026-03-04',
          knowledge: '2025-01',
          reasoning: true,
          tool_call: true,
          modalities: {
            input: ['text', 'image', 'video', 'audio', 'pdf'],
            output: ['text'],
          },
          limit: {
            context: 1048576,
            output: 65536,
          },
          cost: {
            input: 0.25,
            output: 1.5,
            cache_read: 0.025,
          },
        },
      },
    },
    lab: {
      id: 'lab',
      name: 'Lab',
      models: {
        'gemini-3-flash-preview': {
          id: 'gemini-3-flash-preview',
          name: 'Gemini 3 Flash Preview',
          family: 'gemini-flash',
          open_weights: false,
          release_date: '2025-12-17',
          last_updated: '2025-12-18',
          knowledge: '2025-01',
          reasoning: true,
          tool_call: true,
          modalities: {
            input: ['text', 'image'],
            output: ['text'],
          },
          limit: {
            context: 1048576,
            output: 65536,
          },
          cost: {
            input: 0.9,
            output: 4,
            cache_read: 0.09,
          },
        },
      },
    },
    budgetlab: {
      id: 'budgetlab',
      name: 'Budget Lab',
      models: {
        'gemini-3-flash-preview': {
          id: 'gemini-3-flash-preview',
          name: 'Gemini 3 Flash Preview',
          family: 'gemini-flash',
          open_weights: false,
          release_date: '2025-12-17',
          last_updated: '2025-12-18',
          knowledge: '2025-01',
          reasoning: true,
          tool_call: true,
          modalities: {
            input: ['text', 'image'],
            output: ['text'],
          },
          limit: {
            context: 1048576,
            output: 65536,
          },
          cost: {
            input: 0.1,
            output: 1,
            cache_read: 0.01,
          },
        },
      },
    },
    midlab: {
      id: 'midlab',
      name: 'Mid Lab',
      models: {
        'gemini-3-flash-preview': {
          id: 'gemini-3-flash-preview',
          name: 'Gemini 3 Flash Preview',
          family: 'gemini-flash',
          open_weights: false,
          release_date: '2025-12-17',
          last_updated: '2025-12-18',
          knowledge: '2025-01',
          reasoning: true,
          tool_call: true,
          modalities: {
            input: ['text', 'image'],
            output: ['text'],
          },
          limit: {
            context: 1048576,
            output: 65536,
          },
          cost: {
            input: 0.7,
            output: 3.4,
            cache_read: 0.07,
          },
        },
      },
    },
    'nano-gpt': {
      id: 'nano-gpt',
      name: 'NanoGPT',
      models: {
        'qwen3.7-max': {
          id: 'qwen3.7-max',
          name: 'Qwen3.7 Max',
          family: 'qwen',
          open_weights: false,
          release_date: '2026-05-21',
          last_updated: '2026-05-21',
          reasoning: false,
          tool_call: false,
          modalities: {
            input: ['text'],
            output: ['text'],
          },
          limit: {
            context: 1000000,
            output: 65536,
          },
        },
        'tencent/hy3-preview': {
          id: 'tencent/hy3-preview',
          name: 'Tencent: Hy3 preview',
          family: 'hy3',
          open_weights: false,
          release_date: '2026-04-23',
          last_updated: '2026-04-23',
          reasoning: false,
          tool_call: false,
          modalities: {
            input: ['text'],
            output: ['text'],
          },
          limit: {
            context: 262144,
            output: 262144,
          },
        },
      },
    },
    alibaba: {
      id: 'alibaba',
      name: 'Alibaba',
      models: {
        'qwen3.7-max': {
          id: 'qwen3.7-max',
          name: 'Qwen3.7 Max',
          family: 'qwen',
          open_weights: false,
          release_date: '2026-05-21',
          last_updated: '2026-05-21',
          reasoning: true,
          tool_call: true,
          modalities: {
            input: ['text'],
            output: ['text'],
          },
          limit: {
            context: 1000000,
            output: 65536,
          },
        },
      },
    },
    'tencent-tokenhub': {
      id: 'tencent-tokenhub',
      name: 'Tencent TokenHub',
      models: {
        'hy3-preview': {
          id: 'hy3-preview',
          name: 'Hy3 preview',
          family: 'Hy',
          open_weights: true,
          release_date: '2026-04-20',
          last_updated: '2026-04-20',
          reasoning: true,
          tool_call: true,
          modalities: {
            input: ['text'],
            output: ['text'],
          },
          limit: {
            context: 256000,
            output: 64000,
          },
        },
      },
    },
    openai: {
      id: 'openai',
      name: 'OpenAI',
      models: {
        'gpt-4.1': {
          id: 'openai/gpt-4.1',
          name: 'GPT 4.1',
          family: 'gpt-4.1',
          open_weights: false,
          release_date: '2025-04-14',
          reasoning: true,
          tool_call: true,
          modalities: {
            input: ['text', 'image'],
            output: ['text'],
          },
          limit: {
            context: 1047576,
            output: 32768,
          },
        },
      },
    },
    anthropic: {
      id: 'anthropic',
      name: 'Anthropic',
      models: {
        'claude-sonnet-4.5': {
          id: 'anthropic/claude-sonnet-4.5',
          name: 'Claude Sonnet 4.5',
          family: 'claude-sonnet',
          open_weights: false,
          release_date: '2025-09-29',
          reasoning: true,
          tool_call: true,
          modalities: {
            input: ['text', 'image'],
            output: ['text'],
          },
          limit: {
            context: 200000,
            output: 64000,
          },
        },
      },
    },
    openrouter: {
      id: 'openrouter',
      name: 'OpenRouter',
      api: 'https://openrouter.ai/api/v1',
      models: {
        'z-ai/glm-4.6': {
          id: 'z-ai/glm-4.6',
          name: 'GLM 4.6',
          family: 'glm',
          open_weights: false,
          release_date: '2026-01-02',
          last_updated: '2026-01-03',
          knowledge: '2025-12',
          reasoning: true,
          tool_call: true,
          modalities: {
            input: ['text', 'image'],
            output: ['text'],
          },
          limit: {
            context: 202752,
            output: 131072,
          },
          cost: {
            input: 0.43,
            output: 1.74,
            cache_read: 0.08,
            context_over_200k: {
              input: 0.86,
              output: 2.2,
              cache_read: 0.16,
            },
          },
        },
        'z-ai/glm-4.5-air': {
          id: 'z-ai/glm-4.5-air',
          name: 'GLM 4.5 Air',
          family: 'glm',
          open_weights: false,
          release_date: '2025-08-01',
          reasoning: true,
          tool_call: true,
          modalities: {
            input: ['text'],
            output: ['text'],
          },
          limit: {
            context: 128000,
            output: 32768,
          },
          cost: {
            input: 0.2,
            output: 0.8,
            cache_read: 0.04,
          },
        },
      },
    },
    opencode: {
      id: 'opencode',
      name: 'OpenCode',
      models: {
        'glm-5.2': {
          id: 'glm-5.2',
          name: 'GLM-5.2',
          family: 'glm',
          open_weights: false,
          release_date: '2026-06-13',
          reasoning: true,
          tool_call: true,
          modalities: {
            input: ['text'],
            output: ['text'],
          },
          limit: {
            context: 1000000,
            output: 131072,
          },
          cost: {
            input: 1.4,
            output: 4.4,
            cache_read: 0.26,
          },
        },
      },
    },
    'umans-ai': {
      id: 'umans-ai',
      name: 'Umans AI',
      models: {
        'umans-glm-5.2': {
          id: 'umans-glm-5.2',
          name: 'GLM-5.2',
          family: 'glm',
          open_weights: false,
          release_date: '2026-06-13',
          reasoning: true,
          tool_call: true,
          modalities: {
            input: ['text', 'image'],
            output: ['text'],
          },
          limit: {
            context: 1000000,
            output: 131072,
          },
        },
      },
    },
  });

  assert.ok(catalog);
  const enriched = resolveModelsDevModelConfig(
    catalog,
    'z-ai/glm-4.6',
  );

  assert.equal(enriched?.contextSize, 202752);
  assert.equal(enriched?.maxInputTokens, undefined);
  assert.equal(enriched?.maxOutputTokens, undefined);
  assert.deepEqual(enriched?.capabilities, { tools: true, vision: true, thinking: true });
  assert.equal('thinking' in ((enriched ?? {}) as Record<string, unknown>), false);
  assert.equal(enriched?.description, 'z-ai/glm-4.6 | z-ai | glm | Closed | 2026-01-02');
  assert.deepEqual(enriched?.price, {
    inputCost: 0.43,
    cacheCost: 0.08,
    outputCost: 1.74,
    longContextInputCost: 0.86,
    longContextCacheCost: 0.16,
    longContextOutputCost: 2.2,
  });

  const taggedVariant = resolveModelsDevModelConfig(
    catalog,
    'z-ai/glm-4.5-air:free',
  );
  assert.equal(taggedVariant?.contextSize, 128000);
  assert.equal(taggedVariant?.description, 'z-ai/glm-4.5-air | z-ai | glm | Closed | 2025-08-01');
  assert.deepEqual(taggedVariant?.price, {
    inputCost: 0.2,
    cacheCost: 0.04,
    outputCost: 0.8,
  });

  const proxyGemini = resolveModelsDevModelConfig(
    catalog,
    'gemini-3-flash-preview',
  );
  assert.equal(proxyGemini?.contextSize, 1048576);
  assert.equal(proxyGemini?.maxInputTokens, undefined);
  assert.equal(proxyGemini?.maxOutputTokens, undefined);
  assert.deepEqual(proxyGemini?.capabilities, { tools: true, vision: true, thinking: true });
  assert.equal('thinking' in ((proxyGemini ?? {}) as Record<string, unknown>), false);
  assert.equal(proxyGemini?.apiStyle, 'openai-chat');
  assert.equal(
    proxyGemini?.description,
    'gemini-3-flash-preview |  | gemini-flash | Closed | 2025-12-17',
  );
  assert.deepEqual(proxyGemini?.price, {
    inputCost: 0.6,
    cacheCost: 0.06,
    outputCost: 3.2,
  });

  const labGemini = resolveModelsDevModelConfig(
    catalog,
    'gemini-3-flash-preview',
  );
  assert.deepEqual(labGemini?.price, {
    inputCost: 0.6,
    cacheCost: 0.06,
    outputCost: 3.2,
  });

  const labCatalog = normalizeModelsDevCatalog({
    models: {
      'moonshotai/kimi-k2.6': {
        id: 'moonshotai/kimi-k2.6',
        name: 'Kimi K2.6',
        family: 'kimi-k2.6',
        open_weights: true,
        release_date: '2026-04-21',
        last_updated: '2026-04-21',
        knowledge: '2025-01',
        reasoning: true,
        tool_call: true,
        modalities: {
          input: ['text', 'image'],
          output: ['text'],
        },
        limit: {
          context: 262144,
          output: 262144,
        },
      },
    },
    providers: {
      openrouter: {
        id: 'openrouter',
        name: 'OpenRouter',
        models: {
          'moonshotai/kimi-k2.6': {
            id: 'moonshotai/kimi-k2.6',
            name: 'Kimi K2.6',
            family: 'kimi-k2.6',
            cost: {
              input: 0.95,
              output: 4,
              cache_read: 0.2,
            },
          },
        },
      },
    },
  });
  const moonshotKimi = resolveModelsDevModelConfig(
    labCatalog,
    'moonshotai/kimi-k2.6',
  );
  assert.equal(
    moonshotKimi?.description,
    'moonshotai/kimi-k2.6 | moonshotai | kimi-k2.6 | Open | 2026-04-21',
  );
  assert.deepEqual(moonshotKimi?.price, {
    inputCost: 0.95,
    cacheCost: 0.2,
    outputCost: 4,
  });

  const openAiGpt = resolveModelsDevModelConfig(
    catalog,
    'gpt-4.1',
  );
  assert.equal(openAiGpt?.apiStyle, 'openai-responses');

  assert.equal(inferDefaultApiStyleForModel('grok-4.3'), 'openai-responses');
  assert.equal(inferDefaultApiStyleForModel('xai/grok-build-0.1'), 'openai-responses');
  assert.equal(inferDefaultApiStyleForModel('grok-composer-2.5-fast'), 'openai-responses');

  const anthropicClaude = resolveModelsDevModelConfig(
    catalog,
    'claude-sonnet-4.5',
  );
  assert.equal(anthropicClaude?.apiStyle, 'anthropic');

  const proxyGeminiLite = resolveModelsDevModelConfig(
    catalog,
    'gemini-3.1-flash-lite-preview',
  );
  assert.equal(proxyGeminiLite?.contextSize, 1048576);
  assert.equal(proxyGeminiLite?.maxInputTokens, undefined);
  assert.equal(proxyGeminiLite?.maxOutputTokens, undefined);
  assert.deepEqual(proxyGeminiLite?.capabilities, { tools: true, vision: true, thinking: true });
  assert.equal('thinking' in ((proxyGeminiLite ?? {}) as Record<string, unknown>), false);
  assert.equal(
    proxyGeminiLite?.description,
    'gemini-3.1-flash-lite-preview |  | gemini-flash-lite | Closed | 2026-03-03',
  );
  assert.deepEqual(proxyGeminiLite?.price, {
    inputCost: 0.25,
    cacheCost: 0.025,
    outputCost: 1.5,
  });

  const alibabaQwen = resolveModelsDevModelConfig(
    catalog,
    'qwen3.7-max',
  );
  assert.deepEqual(alibabaQwen?.capabilities, { tools: true, vision: false, thinking: true });
  assert.equal('thinking' in ((alibabaQwen ?? {}) as Record<string, unknown>), false);
  assert.equal(alibabaQwen?.description, 'qwen3.7-max |  | qwen | Closed | 2026-05-21');

  const prefixedAlibabaQwen = resolveModelsDevModelConfig(
    catalog,
    'alibaba/qwen3.7-max',
  );
  assert.deepEqual(prefixedAlibabaQwen?.capabilities, { tools: true, vision: false, thinking: true });
  assert.equal('thinking' in ((prefixedAlibabaQwen ?? {}) as Record<string, unknown>), false);

  const prefixedTencentHy3 = resolveModelsDevModelConfig(
    catalog,
    'tencent/hy3-preview',
  );
  assert.deepEqual(prefixedTencentHy3?.capabilities, { tools: true, vision: false, thinking: true });
  assert.equal('thinking' in ((prefixedTencentHy3 ?? {}) as Record<string, unknown>), false);
  assert.equal(prefixedTencentHy3?.description, 'tencent/hy3-preview | tencent | hy3 | Closed | 2026-04-23');

  const slashTencentHy3 = resolveModelsDevModelConfig(
    catalog,
    'tencent/hy3-preview/',
  );
  assert.deepEqual(slashTencentHy3?.capabilities, { tools: true, vision: false, thinking: true });
  assert.equal('thinking' in ((slashTencentHy3 ?? {}) as Record<string, unknown>), false);

  const opencodeGlm52 = resolveModelsDevModelConfig(
    catalog,
    'opencode/glm-5.2',
  );
  assert.deepEqual(opencodeGlm52?.capabilities, { tools: true, vision: false, thinking: true });
  assert.equal(opencodeGlm52?.description, 'zhipuai/glm-5.2 | zhipuai | glm | Open | 2026-06-13');

  console.log('PASS models.dev catalog 可按模型 ID/名称匹配并映射模型元数据');
}

function runGenericProviderDiscoveryMergeTests(): void {
  const { mergeConfiguredModelOverrides } = require('../providers/genericProviderDiscovery') as {
    mergeConfiguredModelOverrides: (
      currentModels: VendorModelRecord[],
      discoveredModels: VendorModelRecord[],
      defaultVisionForNewModels: boolean,
      vendorName?: string,
    ) => VendorModelRecord[];
  };

  const merged = mergeConfiguredModelOverrides(
    [
      {
        name: 'grok-4.3',
        apiStyle: 'openai-chat',
        description: 'xai/grok-4.3 | xai | grok | Closed | 2026-04-17',
        price: {
          inputCost: 1.25,
          outputCost: 2.5,
        },
      },
    ],
    [
      {
        name: 'grok-4.3',
        apiStyle: 'openai-responses',
        description: 'xai/grok-4.3 | xai | grok | Closed | 2026-04-17',
        price: {
          inputCost: 1.25,
          outputCost: 2.5,
        },
      },
    ],
    false,
    'cliproxyapi',
  );
  assert.equal(merged[0]?.apiStyle, 'openai-responses');
  assert.equal(merged[0]?.description, 'xai/grok-4.3 | xai | grok | Closed | 2026-04-17');

  const untouched = mergeConfiguredModelOverrides(
    [
      {
        name: 'gemini-3-flash-preview',
        apiStyle: 'openai-chat',
        description: 'google/gemini-3-flash-preview | google | gemini-flash | Closed | 2025-12-17',
        price: {
          inputCost: 0.5,
          outputCost: 3,
        },
      },
    ],
    [
      {
        name: 'gemini-3-flash-preview',
        apiStyle: 'openai-responses',
        description: 'google/gemini-3-flash-preview | google | gemini-flash | Closed | 2025-12-17',
        price: {
          inputCost: 0.5,
          outputCost: 3,
        },
      },
    ],
    false,
    'cliproxyapi',
  );
  assert.equal(untouched[0]?.apiStyle, 'openai-chat');

  console.log('PASS Grok 模型刷新时会从 openai-chat 自动升级为 openai-responses');
}

async function runGenericProviderModelEnabledTests(
  configStoreCtor: ConfigStoreCtor,
  genericProviderModule: GenericProviderModule,
): Promise<void> {
  const { GenericAIProvider } = genericProviderModule;
  activeState = createState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/v1',
      defaultApiStyle: 'openai-chat',
      defaultVision: false,
      models: [
        { name: 'visible-model', enabled: true },
        { name: 'hidden-model', enabled: false },
      ],
    },
  ]);

  const configStore = new configStoreCtor(createExtensionContext() as never);
  const provider = new GenericAIProvider(createExtensionContext() as never, configStore);

  try {
    await refreshWithDiscovery(provider);
    assert.deepEqual(
      provider.getAvailableModels().map((model) => model.id),
      ['Vendor/visible-model'],
      'enabled=false 的模型不应进入最终 Language Model 暴露列表',
    );
    console.log('PASS GenericAIProvider 会按模型 enabled 字段隐藏模型');
  } finally {
    provider.dispose();
    configStore.dispose();
  }
}

async function runGenericProviderDiscoveryDefaultVisionTests(
  configStoreCtor: ConfigStoreCtor,
  genericProviderModule: GenericProviderModule,
): Promise<void> {
  const { GenericAIProvider } = genericProviderModule;
  const originalFetch = globalThis.fetch;

  activeState = createState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/v1',
      defaultApiStyle: 'openai-chat',
      defaultVision: false,
      useModelsEndpoint: true,
      models: [],
    },
  ]);

  const configStore = new configStoreCtor(createExtensionContext() as never);
  const provider = new GenericAIProvider(createExtensionContext() as never, configStore) as unknown as {
    models: Array<{
      id: string;
      capabilities?: {
        imageInput?: boolean;
        toolCalling?: boolean | number;
      };
    }>;
    refreshModels(): Promise<void>;
    dispose(): void;
  };

  globalThis.fetch = (async (_url: string | URL | Request): Promise<Response> => {
    return new Response(
      JSON.stringify({
        data: [
          {
            id: 'fresh-vision-model',
            context_length: 64000,
            capabilities: {
              tool_calling: true,
              image_input: true,
            },
          },
        ],
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      },
    );
  }) as typeof globalThis.fetch;

  try {
    (configStore as unknown as { getApiKey(vendorName: string): Promise<string> }).getApiKey = async (
      vendorName: string,
    ) => (vendorName === 'Vendor' ? 'configured' : '');

    await refreshWithDiscovery(provider);

    const updatedVendor = getUpdatedVendor(activeState);
    const refreshedModel = updatedVendor.models.find((model) => model.name === 'fresh-vision-model');
    assert.equal(refreshedModel?.apiStyle, 'openai-chat');
    assert.deepEqual(refreshedModel?.capabilities, { tools: true, vision: false });
    assert.equal(provider.models[0]?.capabilities?.imageInput, false);
    console.log('PASS /models 刷新新增模型时 defaultVision=false 会覆盖发现到的 vision=true');
  } finally {
    globalThis.fetch = originalFetch;
    provider.dispose();
    configStore.dispose();
  }
}

async function runGenericProviderModelsDevEnrichmentTests(
  configStoreCtor: ConfigStoreCtor,
  genericProviderModule: GenericProviderModule,
  modelsDevCatalogModule: ModelsDevCatalogModule,
): Promise<void> {
  const { GenericAIProvider } = genericProviderModule;
  const { MODELS_DEV_API_URL } = modelsDevCatalogModule;
  const originalFetch = globalThis.fetch;

  activeState = createState([
    {
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api',
      defaultApiStyle: 'anthropic',
      defaultVision: false,
      useModelsEndpoint: true,
      models: [],
    },
  ]);

  const configStore = new configStoreCtor(createExtensionContext() as never);
  const provider = new GenericAIProvider(createExtensionContext() as never, configStore);

  globalThis.fetch = (async (url: string | URL | Request): Promise<Response> => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    if (href === MODELS_DEV_API_URL) {
      return new Response(
        JSON.stringify({
          openrouter: {
            id: 'openrouter',
            name: 'OpenRouter',
            api: 'https://openrouter.ai/api/v1',
            models: {
              'z-ai/glm-4.6': {
                id: 'z-ai/glm-4.6',
                family: 'glm',
                open_weights: false,
                release_date: '2026-01-02',
                last_updated: '2026-01-03',
                knowledge: '2025-12',
                reasoning: true,
                tool_call: true,
                modalities: {
                  input: ['text', 'image'],
                  output: ['text'],
                },
                limit: {
                  context: 202752,
                  output: 131072,
                },
                cost: {
                  input: 0.43,
                  output: 1.74,
                  cache_read: 0.08,
                },
              },
            },
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }

    return new Response(
      JSON.stringify({
        data: [
          {
            id: 'z-ai/glm-4.6',
            context_length: 64000,
            capabilities: {
              tool_calling: false,
              image_input: false,
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as typeof globalThis.fetch;

  try {
    (configStore as unknown as { getApiKey(vendorName: string): Promise<string> }).getApiKey = async (
      vendorName: string,
    ) => (vendorName === 'OpenRouter' ? 'configured' : '');

    await refreshWithDiscovery(provider);

    const updatedVendor = getUpdatedVendor(activeState);
    const enrichedModel = updatedVendor.models.find((model) => model.name === 'z-ai/glm-4.6');
    assert.equal(enrichedModel?.contextSize, 202752);
    assert.equal(enrichedModel?.maxInputTokens, undefined);
    assert.equal(enrichedModel?.maxOutputTokens, undefined);
    assert.deepEqual(enrichedModel?.capabilities, { tools: true, vision: true, thinking: true });
    assert.equal('thinking' in ((enrichedModel ?? {}) as Record<string, unknown>), false);
    assert.equal(
      enrichedModel?.description,
      'z-ai/glm-4.6 | z-ai | glm | Closed | 2026-01-02',
    );
    assert.deepEqual(enrichedModel?.price, {
      inputCost: 0.43,
      cacheCost: 0.08,
      outputCost: 1.74,
    });
    console.log('PASS /models 刷新会使用 models.dev 补全新发现模型元数据');
  } finally {
    globalThis.fetch = originalFetch;
    provider.dispose();
    configStore.dispose();
  }
}

async function runGenericProviderModelsDevProxyFallbackTests(
  configStoreCtor: ConfigStoreCtor,
  genericProviderModule: GenericProviderModule,
  modelsDevCatalogModule: ModelsDevCatalogModule,
): Promise<void> {
  const { GenericAIProvider } = genericProviderModule;
  const { MODELS_DEV_API_URL } = modelsDevCatalogModule;
  const originalFetch = globalThis.fetch;

  activeState = createState([
    {
      name: 'Proxy Vendor',
      baseUrl: 'https://proxy.example.test/v1',
      defaultApiStyle: 'openai-chat',
      defaultVision: false,
      useModelsEndpoint: true,
      models: [
        {
          name: 'gemini-3-flash-preview',
          enabled: true,
          description: 'test model: gemini-3-flash-preview',
          contextSize: 400000,
          maxInputTokens: 370000,
          maxOutputTokens: 30000,
          capabilities: {
            tools: true,
            vision: false,
          },
        },
        {
          name: 'gemini-3.1-flash-lite-preview',
          enabled: true,
          description: 'test model: gemini-3.1-flash-lite-preview',
          contextSize: 400000,
          maxInputTokens: 370000,
          maxOutputTokens: 30000,
          capabilities: {
            tools: true,
            vision: false,
          },
        },
      ],
    },
  ]);

  const configStore = new configStoreCtor(createExtensionContext() as never);
  const provider = new GenericAIProvider(createExtensionContext() as never, configStore);

  globalThis.fetch = (async (url: string | URL | Request): Promise<Response> => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    if (href === MODELS_DEV_API_URL) {
      return new Response(
        JSON.stringify({
          google: {
            id: 'google',
            name: 'Google',
            models: {
              'gemini-3-flash-preview': {
                id: 'gemini-3-flash-preview',
                name: 'Gemini 3 Flash Preview',
                family: 'gemini-flash',
                open_weights: false,
                release_date: '2025-12-17',
                last_updated: '2025-12-18',
                knowledge: '2025-01',
                reasoning: true,
                tool_call: true,
                modalities: {
                  input: ['text', 'image', 'video', 'audio', 'pdf'],
                  output: ['text'],
                },
                limit: {
                  context: 1048576,
                  output: 65536,
                },
                cost: {
                  input: 0.5,
                  output: 3,
                  cache_read: 0.05,
                },
              },
              'gemini-3.1-flash-lite-preview': {
                id: 'gemini-3.1-flash-lite-preview',
                name: 'Gemini 3.1 Flash Lite Preview',
                family: 'gemini-flash-lite',
                open_weights: false,
                release_date: '2026-03-03',
                last_updated: '2026-03-04',
                knowledge: '2025-01',
                reasoning: true,
                tool_call: true,
                modalities: {
                  input: ['text', 'image', 'video', 'audio', 'pdf'],
                  output: ['text'],
                },
                limit: {
                  context: 1048576,
                  output: 65536,
                },
                cost: {
                  input: 0.25,
                  output: 1.5,
                  cache_read: 0.025,
                },
              },
            },
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }

    return new Response(
      JSON.stringify({
        data: [
          {
            id: 'gemini-3-flash-preview',
            context_length: 400000,
            capabilities: {
              tool_calling: true,
              image_input: false,
            },
          },
          {
            id: 'gemini-3.1-flash-lite-preview',
            context_length: 400000,
            capabilities: {
              tool_calling: true,
              image_input: false,
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as typeof globalThis.fetch;

  try {
    (configStore as unknown as { getApiKey(vendorName: string): Promise<string> }).getApiKey = async (
      vendorName: string,
    ) => (vendorName === 'Proxy Vendor' ? 'configured' : '');

    await refreshWithDiscovery(provider);

    const updatedVendor = getUpdatedVendor(activeState);
    const geminiFlash = updatedVendor.models.find((model) => model.name === 'gemini-3-flash-preview');
    assert.equal(geminiFlash?.description, 'test model: gemini-3-flash-preview');
    assert.equal(geminiFlash?.contextSize, 400000);
    assert.equal(geminiFlash?.maxInputTokens, 370000);
    assert.equal(geminiFlash?.maxOutputTokens, 30000);
    assert.deepEqual(geminiFlash?.capabilities, { tools: true, vision: false });
    assert.equal('thinking' in ((geminiFlash ?? {}) as Record<string, unknown>), false);
    assert.equal(geminiFlash?.price, undefined);

    const geminiLite = updatedVendor.models.find((model) => model.name === 'gemini-3.1-flash-lite-preview');
    assert.equal(geminiLite?.description, 'test model: gemini-3.1-flash-lite-preview');
    assert.equal(geminiLite?.contextSize, 400000);
    assert.equal(geminiLite?.maxInputTokens, 370000);
    assert.equal(geminiLite?.maxOutputTokens, 30000);
    assert.deepEqual(geminiLite?.capabilities, { tools: true, vision: false });
    assert.equal('thinking' in ((geminiLite ?? {}) as Record<string, unknown>), false);
    assert.equal(geminiLite?.price, undefined);
    console.log('PASS /models 刷新按模型名匹配 models.dev 但不覆盖已有模型配置');
  } finally {
    globalThis.fetch = originalFetch;
    provider.dispose();
    configStore.dispose();
  }
}

async function runGenericProviderStaleDiscoveryWriteTests(
  configStoreCtor: ConfigStoreCtor,
  genericProviderModule: GenericProviderModule,
  modelsDevCatalogModule: ModelsDevCatalogModule,
): Promise<void> {
  const { GenericAIProvider } = genericProviderModule;
  const { MODELS_DEV_CATALOG_URL } = modelsDevCatalogModule;
  const originalFetch = globalThis.fetch;
  let modelsFetchCount = 0;
  let userDeletionApplied = false;

  activeState = createState([
    {
      name: 'cliproxyapi',
      baseUrl: 'https://proxy.example.test/v1',
      defaultApiStyle: 'openai-chat',
      defaultVision: false,
      useModelsEndpoint: true,
      models: [
        {
          name: 'gemini-3-flash-preview',
          enabled: true,
          description: 'cliproxyapi model: gemini-3-flash-preview',
          contextSize: 400000,
          maxInputTokens: 370000,
          maxOutputTokens: 30000,
          capabilities: {
            tools: true,
            vision: false,
          },
        },
      ],
    },
  ]);

  const configStore = new configStoreCtor(createExtensionContext() as never);
  const provider = new GenericAIProvider(createExtensionContext() as never, configStore);

  globalThis.fetch = (async (url: string | URL | Request): Promise<Response> => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    if (href === MODELS_DEV_CATALOG_URL) {
      return new Response(
        JSON.stringify({
          models: {
            'google/gemini-3-flash-preview': {
              id: 'google/gemini-3-flash-preview',
              name: 'Gemini 3 Flash Preview',
              family: 'gemini-flash',
              open_weights: false,
              release_date: '2025-12-17',
              last_updated: '2025-12-17',
              knowledge: '2025-01',
              reasoning: true,
              tool_call: true,
              modalities: {
                input: ['text', 'image'],
                output: ['text'],
              },
              limit: {
                context: 1048576,
                output: 65536,
              },
            },
          },
          providers: {
            google: {
              id: 'google',
              name: 'Google',
              models: {
                'gemini-3-flash-preview': {
                  id: 'gemini-3-flash-preview',
                  name: 'Gemini 3 Flash Preview',
                  family: 'gemini-flash',
                  reasoning: true,
                  tool_call: true,
                  modalities: {
                    input: ['text', 'image'],
                    output: ['text'],
                  },
                  limit: {
                    context: 1048576,
                    output: 65536,
                  },
                  cost: {
                    input: 0.5,
                    output: 3,
                    cache_read: 0.05,
                  },
                },
              },
            },
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }

    if (href === 'https://proxy.example.test/v1/models') {
      modelsFetchCount += 1;
      if (!userDeletionApplied) {
        userDeletionApplied = true;
        activeState.vendors = [
          {
            name: 'cliproxyapi',
            baseUrl: 'https://proxy.example.test/v1',
            defaultApiStyle: 'openai-chat',
            defaultVision: false,
            useModelsEndpoint: true,
            models: [],
          },
        ];
        for (const listener of [...activeState.listeners]) {
          listener({
            affectsConfiguration(changedSection: string): boolean {
              return changedSection === 'coding-plans.vendors';
            },
          });
        }
      }

      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'gemini-3-flash-preview',
              context_length: 400000,
              capabilities: {
                tool_calling: true,
                image_input: false,
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }

    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

  try {
    (configStore as unknown as { getApiKey(vendorName: string): Promise<string> }).getApiKey = async (
      vendorName: string,
    ) => (vendorName === 'cliproxyapi' ? 'configured' : '');

    await refreshWithDiscovery(provider);

    assert.ok(modelsFetchCount >= 2, '配置变更期间应排队重新发现模型');
    assert.equal(activeState.updates.length, 1, '旧快照不应先写回一次旧模型结构');

    const updatedVendor = getUpdatedVendor(activeState);
    const model = updatedVendor.models.find((entry) => entry.name === 'gemini-3-flash-preview');
    assert.ok(model, '重新发现的模型应被写回');
    assert.equal(model?.description, 'google/gemini-3-flash-preview | google | gemini-flash | Closed | 2025-12-17');
    assert.equal(model?.contextSize, 1048576);
    assert.equal(model?.maxInputTokens, undefined);
    assert.equal(model?.maxOutputTokens, undefined);
    assert.deepEqual(model?.capabilities, { tools: true, vision: true, thinking: true });
    assert.deepEqual(model?.price, {
      inputCost: 0.5,
      cacheCost: 0.05,
      outputCost: 3,
    });
    console.log('PASS /models 刷新期间配置变化时不会用旧快照写回旧模型结构');
  } finally {
    globalThis.fetch = originalFetch;
    provider.dispose();
    configStore.dispose();
  }
}

async function runGenericProviderGeneratedFallbackUpgradeTests(
  configStoreCtor: ConfigStoreCtor,
  genericProviderModule: GenericProviderModule,
  modelsDevCatalogModule: ModelsDevCatalogModule,
): Promise<void> {
  const { GenericAIProvider } = genericProviderModule;
  const { MODELS_DEV_CATALOG_URL } = modelsDevCatalogModule;
  const originalFetch = globalThis.fetch;

  activeState = createState([
    {
      name: 'cliproxyapi',
      baseUrl: 'https://proxy.example.test/v1',
      defaultApiStyle: 'openai-chat',
      defaultVision: false,
      useModelsEndpoint: true,
      models: [
        {
          name: 'gemini-3-flash-preview',
          enabled: true,
          apiStyle: 'openai-chat',
          description: 'cliproxyapi model: gemini-3-flash-preview',
          contextSize: 400000,
          capabilities: {
            tools: true,
            vision: false,
          },
        },
      ],
    },
  ]);

  const configStore = new configStoreCtor(createExtensionContext() as never);
  const provider = new GenericAIProvider(createExtensionContext() as never, configStore);

  globalThis.fetch = (async (url: string | URL | Request): Promise<Response> => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    if (href === MODELS_DEV_CATALOG_URL) {
      return new Response(
        JSON.stringify({
          models: {
            'google/gemini-3-flash-preview': {
              id: 'google/gemini-3-flash-preview',
              name: 'Gemini 3 Flash Preview',
              family: 'gemini-flash',
              open_weights: false,
              release_date: '2025-12-17',
              reasoning: true,
              tool_call: true,
              modalities: {
                input: ['text', 'image'],
                output: ['text'],
              },
              limit: {
                context: 1048576,
                output: 65536,
              },
            },
          },
          providers: {
            google: {
              id: 'google',
              name: 'Google',
              models: {
                'gemini-3-flash-preview': {
                  id: 'gemini-3-flash-preview',
                  name: 'Gemini 3 Flash Preview',
                  family: 'gemini-flash',
                  reasoning: true,
                  tool_call: true,
                  modalities: {
                    input: ['text', 'image'],
                    output: ['text'],
                  },
                  limit: {
                    context: 1048576,
                    output: 65536,
                  },
                  cost: {
                    input: 0.5,
                    output: 3,
                    cache_read: 0.05,
                  },
                },
              },
            },
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }

    return new Response(
      JSON.stringify({
        data: [
          {
            id: 'gemini-3-flash-preview',
            context_length: 400000,
            capabilities: {
              tool_calling: true,
              image_input: false,
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as typeof globalThis.fetch;

  try {
    (configStore as unknown as { getApiKey(vendorName: string): Promise<string> }).getApiKey = async (
      vendorName: string,
    ) => (vendorName === 'cliproxyapi' ? 'configured' : '');

    await refreshWithDiscovery(provider);

    assert.equal(activeState.updates.length, 1, '带 apiStyle 的自动 fallback 结构应被升级写回一次');
    const updatedVendor = getUpdatedVendor(activeState);
    const model = updatedVendor.models.find((entry) => entry.name === 'gemini-3-flash-preview');
    assert.equal(model?.description, 'google/gemini-3-flash-preview | google | gemini-flash | Closed | 2025-12-17');
    assert.equal(model?.contextSize, 1048576);
    assert.equal(model?.maxInputTokens, undefined);
    assert.equal(model?.maxOutputTokens, undefined);
    assert.deepEqual(model?.capabilities, { tools: true, vision: true, thinking: true });
    assert.deepEqual(model?.price, {
      inputCost: 0.5,
      cacheCost: 0.05,
      outputCost: 3,
    });
    console.log('PASS 自动生成的 /models fallback 配置会升级为 models.dev 新结构');
  } finally {
    globalThis.fetch = originalFetch;
    provider.dispose();
    configStore.dispose();
  }
}

async function runGenericProviderNoAutomaticDeletedModelRestoreTests(
  configStoreCtor: ConfigStoreCtor,
  genericProviderModule: GenericProviderModule,
): Promise<void> {
  const { GenericAIProvider } = genericProviderModule;
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;

  activeState = createState([
    {
      name: 'cliproxyapi',
      baseUrl: 'https://proxy.example.test/v1',
      apiKey: 'configured',
      defaultApiStyle: 'openai-chat',
      defaultVision: false,
      useModelsEndpoint: true,
      models: [
        {
          name: 'gemini-3-flash-preview',
          enabled: true,
          description: 'cliproxyapi model: gemini-3-flash-preview',
          contextSize: 400000,
          capabilities: {
            tools: true,
            vision: false,
          },
        },
      ],
    },
  ]);

  const configStore = new configStoreCtor(createExtensionContext() as never);
  const provider = new GenericAIProvider(createExtensionContext() as never, configStore);

  globalThis.fetch = (async (): Promise<Response> => {
    fetchCount += 1;
    return new Response(
      JSON.stringify({
        data: [
          {
            id: 'gemini-3-flash-preview',
            context_length: 400000,
            capabilities: {
              tool_calling: true,
              image_input: false,
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as typeof globalThis.fetch;

  try {
    await provider.refreshModels();
    activeState.updates.length = 0;

    activeState.vendors = [
      {
        name: 'cliproxyapi',
        baseUrl: 'https://proxy.example.test/v1',
        apiKey: 'configured',
        defaultApiStyle: 'openai-chat',
        defaultVision: false,
        useModelsEndpoint: true,
        models: [],
      },
    ];
    for (const listener of [...activeState.listeners]) {
      listener({
        affectsConfiguration(changedSection: string): boolean {
          return changedSection === 'coding-plans.vendors';
        },
      });
    }

    await waitForCondition(() => provider.getAvailableModels().length === 0);

    const updatedVendor = getUpdatedVendor(activeState);
    assert.deepEqual(updatedVendor.models, [], '删除模型后配置监听不应自动补回 models[]');
    assert.equal(activeState.updates.length, 0, '配置监听不应自动写回 settings models');
    assert.equal(fetchCount, 0, '配置监听和默认刷新不应自动请求 /models');
    console.log('PASS 删除模型后配置监听不会自动发现或写回 models[]');
  } finally {
    globalThis.fetch = originalFetch;
    provider.dispose();
    configStore.dispose();
  }
}

async function runGenericProviderModelChangeEventStabilityTests(
  configStoreCtor: ConfigStoreCtor,
  genericProviderModule: GenericProviderModule,
): Promise<void> {
  const { GenericAIProvider } = genericProviderModule;
  activeState = createState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/v1',
      defaultApiStyle: 'openai-chat',
      defaultVision: false,
      models: [{ name: 'stable-model' }],
    },
  ]);

  const configStore = new configStoreCtor(createExtensionContext() as never);
  const provider = new GenericAIProvider(createExtensionContext() as never, configStore);
  let eventCount = 0;
  const subscription = provider.onDidChangeModels(() => {
    eventCount += 1;
  });

  try {
    await provider.refreshModels();
    await provider.refreshModels();
    assert.equal(eventCount, 1, '相同模型信息重复刷新不应重复通知 VS Code');

    activeState.vendors = [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: 'openai-chat',
        defaultVision: false,
        models: [{ name: 'stable-model' }, { name: 'new-model' }],
      },
    ];
    await provider.refreshModels();
    assert.equal(eventCount, 2, '模型信息变化时仍应通知 VS Code');
    console.log('PASS GenericAIProvider 仅在模型信息实际变化时发送模型变更事件');
  } finally {
    subscription.dispose();
    provider.dispose();
    configStore.dispose();
  }
}

async function runGenericProviderAutoRefreshModelsSettingTests(
  configStoreCtor: ConfigStoreCtor,
  genericProviderModule: GenericProviderModule,
): Promise<void> {
  const { GenericAIProvider } = genericProviderModule;

  activeState = createState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/v1',
      defaultApiStyle: 'openai-chat',
      defaultVision: false,
      models: [{ name: 'initial-model' }],
    },
  ]);

  const enabledConfigStore = new configStoreCtor(createExtensionContext() as never);
  const enabledProvider = new GenericAIProvider(createExtensionContext() as never, enabledConfigStore);
  try {
    await enabledProvider.refreshModels();
    activeState.vendors = [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: 'openai-chat',
        defaultVision: false,
        models: [{ name: 'initial-model' }, { name: 'auto-model' }],
      },
    ];
    for (const listener of [...activeState.listeners]) {
      listener({
        affectsConfiguration(changedSection: string): boolean {
          return changedSection === 'coding-plans.vendors';
        },
      });
    }
    await waitForCondition(() => enabledProvider.getAvailableModels().some((model) => model.name === 'auto-model'));
    assert.ok(
      enabledProvider.getAvailableModels().some((model) => model.name === 'auto-model'),
      '默认应允许 settings 变更自动刷新运行时模型',
    );
  } finally {
    enabledProvider.dispose();
    enabledConfigStore.dispose();
  }

  activeState = createState(
    [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: 'openai-chat',
        defaultVision: false,
        models: [{ name: 'initial-model' }],
      },
    ],
    { autoRefreshModels: false },
  );

  const disabledConfigStore = new configStoreCtor(createExtensionContext() as never);
  const disabledProvider = new GenericAIProvider(createExtensionContext() as never, disabledConfigStore);
  try {
    await disabledProvider.refreshModels();
    activeState.vendors = [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: 'openai-chat',
        defaultVision: false,
        models: [{ name: 'initial-model' }, { name: 'blocked-auto-model' }],
      },
    ];
    for (const listener of [...activeState.listeners]) {
      listener({
        affectsConfiguration(changedSection: string): boolean {
          return changedSection === 'coding-plans.vendors';
        },
      });
    }

    assert.deepEqual(
      disabledProvider.getAvailableModels().map((model) => model.name),
      ['initial-model'],
      '关闭 autoRefreshModels 后 settings 变更不应自动刷新运行时模型',
    );

    await disabledProvider.refreshModels();
    assert.ok(
      disabledProvider.getAvailableModels().some((model) => model.name === 'blocked-auto-model'),
      '关闭 autoRefreshModels 后手动刷新仍应生效',
    );
    console.log('PASS autoRefreshModels 控制 settings 变更自动刷新且不影响手动刷新');
  } finally {
    disabledProvider.dispose();
    disabledConfigStore.dispose();
  }
}

async function runGenericProviderEmptyResponseTests(
  configStoreCtor: ConfigStoreCtor,
  genericProviderModule: GenericProviderModule,
): Promise<void> {
  const { GenericAIProvider } = genericProviderModule;
  const vscodeMock = require('vscode') as {
    testState: {
      shownWarningMessages: Array<{ message: string; items: unknown[] }>;
    };
  };
  activeState = createState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/v1',
      defaultApiStyle: 'openai-chat',
      defaultVision: false,
      models: [
        {
          name: 'empty-response-guard',
          contextSize: 64000,
          maxInputTokens: 32000,
          maxOutputTokens: 16000,
        },
      ],
    },
  ]);

  const configStore = new configStoreCtor(createExtensionContext() as never);
  const provider = new GenericAIProvider(createExtensionContext() as never, configStore) as unknown as {
    ensureNonEmptyCompletion(
      protocol: 'openai-chat' | 'openai-responses' | 'anthropic',
      trace: {
        traceId: string;
        vendorName?: string;
        modelId?: string;
        modelName?: string;
        protocol?: 'openai-chat' | 'openai-responses' | 'anthropic';
      },
      vendor: VendorRecord,
      modelName: string,
      content: string,
      toolCalls: unknown[] | undefined,
    ): void;
    dispose(): void;
  };

  const vendor = configStore.getVendors()[0] as VendorRecord;

  try {
    vscodeMock.testState.shownWarningMessages.length = 0;
    assert.throws(
      () =>
        provider.ensureNonEmptyCompletion(
          'openai-chat',
          {
            traceId: 'trace_empty',
            vendorName: 'Vendor',
            modelId: 'Vendor/empty-response-guard',
            modelName: 'empty-response-guard',
            protocol: 'openai-chat',
          },
          vendor,
          'empty-response-guard',
          '   ',
          [],
        ),
      /requestFailed|empty response|空响应/i,
    );
    await Promise.resolve();
    assert.equal(vscodeMock.testState.shownWarningMessages.length, 1);
    assert.match(
      vscodeMock.testState.shownWarningMessages[0]?.message ?? '',
      /switchToResponsesApiPrompt|Responses API/i,
    );
    console.log('PASS GenericAIProvider 会把空 completion 视为上游错误');

    assert.doesNotThrow(() =>
      provider.ensureNonEmptyCompletion(
        'openai-chat',
        { traceId: 'trace_text' },
        vendor,
        'empty-response-guard',
        'fix: keep content',
        [],
      ),
    );

    assert.doesNotThrow(() =>
      provider.ensureNonEmptyCompletion('openai-chat', { traceId: 'trace_tool' }, vendor, 'empty-response-guard', '', [
        {},
      ]),
    );
    console.log('PASS GenericAIProvider 在存在文本或工具调用时保留 completion');
  } finally {
    provider.dispose();
    configStore.dispose();
  }
}

async function runGenericProviderOutputLimitToggleTests(
  configStoreCtor: ConfigStoreCtor,
  genericProviderModule: GenericProviderModule,
  tokenUsageModule: TokenUsageModule,
): Promise<void> {
  const { GenericAIProvider } = genericProviderModule;
  const { readAttachedTokenUsage } = tokenUsageModule;
  const originalFetch = globalThis.fetch;

  async function capturePayload(
    vendors: VendorRecord[],
    modelId: string,
    options: { modelOptions?: Record<string, unknown> } = {},
  ): Promise<{ payload: Record<string, unknown>; response: unknown }> {
    activeState = createStaticVendorState(vendors);
    const configStore = new configStoreCtor(createExtensionContext() as never);
    const provider = new GenericAIProvider(createExtensionContext() as never, configStore) as unknown as {
      refreshModels(): Promise<void>;
      sendRequest(request: {
        modelId: string;
        messages: Array<{ role: string; content: Array<{ value: string }> }>;
        capabilities: { toolCalling: boolean; imageInput: boolean };
        options?: { tools?: unknown[]; modelOptions?: Record<string, unknown> };
      }): Promise<unknown>;
      dispose(): void;
    };

    let payload: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      payload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: 'chatcmpl_test',
          created: 0,
          model: 'coder',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'ok',
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    }) as typeof globalThis.fetch;

    try {
      (configStore as unknown as { getApiKey(vendorName: string): Promise<string> }).getApiKey = async (
        vendorName: string,
      ) => (vendorName === 'Vendor' ? 'configured' : '');
      await provider.refreshModels();
      const response = await provider.sendRequest({
        modelId,
        messages: [
          {
            role: 'user',
            content: [{ value: 'reply with ok' }],
          },
        ],
        capabilities: { toolCalling: false, imageInput: false },
        options: { tools: [], ...options },
      });
      assert.ok(payload);
      return {
        payload,
        response,
      };
    } finally {
      globalThis.fetch = originalFetch;
      provider.dispose();
      configStore.dispose();
    }
  }

  async function captureOpenAIResponsesPayload(
    vendors: VendorRecord[],
    modelId: string,
    messages: Array<{ role: string | number; content: Array<{ value: string }> }> = [
      {
        role: 'user',
        content: [{ value: 'reply with ok' }],
      },
    ],
    options: { modelOptions?: Record<string, unknown> } = {},
  ): Promise<Record<string, unknown>> {
    activeState = createStaticVendorState(vendors);
    const configStore = new configStoreCtor(createExtensionContext() as never);
    const provider = new GenericAIProvider(createExtensionContext() as never, configStore) as unknown as {
      refreshModels(): Promise<void>;
      sendRequest(request: {
        modelId: string;
        messages: Array<{ role: string | number; content: Array<{ value: string }> }>;
        capabilities: { toolCalling: boolean; imageInput: boolean };
        options?: { tools?: unknown[]; modelOptions?: Record<string, unknown> };
      }): Promise<unknown>;
      dispose(): void;
    };

    let payload: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      payload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: 'resp_test',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: 'ok',
                },
              ],
            },
          ],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    }) as typeof globalThis.fetch;

    try {
      (configStore as unknown as { getApiKey(vendorName: string): Promise<string> }).getApiKey = async (
        vendorName: string,
      ) => (vendorName === 'Vendor' ? 'configured' : '');
      await provider.refreshModels();
      await provider.sendRequest({
        modelId,
        messages,
        capabilities: { toolCalling: false, imageInput: false },
        options: { tools: [], ...options },
      });
      assert.ok(payload);
      return payload;
    } finally {
      globalThis.fetch = originalFetch;
      provider.dispose();
      configStore.dispose();
    }
  }

  async function capturePayloadWithRequiredMaxTokensRetry(
    vendors: VendorRecord[],
    modelId: string,
    options: { expectError?: boolean } = {},
  ): Promise<{ payloads: Record<string, unknown>[]; response?: unknown; error?: unknown }> {
    activeState = createStaticVendorState(vendors);
    const configStore = new configStoreCtor(createExtensionContext() as never);
    const provider = new GenericAIProvider(createExtensionContext() as never, configStore) as unknown as {
      refreshModels(): Promise<void>;
      sendRequest(request: {
        modelId: string;
        messages: Array<{ role: string; content: Array<{ value: string }> }>;
        capabilities: { toolCalling: boolean; imageInput: boolean };
        options?: { tools?: unknown[] };
      }): Promise<unknown>;
      dispose(): void;
    };

    const payloads: Record<string, unknown>[] = [];
    let callCount = 0;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const payload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      payloads.push(payload);
      callCount += 1;

      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            error: {
              type: 'invalid_request_error',
              message: 'missing field max_tokens at line 1 column 42',
            },
          }),
          {
            status: 400,
            headers: {
              'content-type': 'application/json',
            },
          },
        );
      }

      return new Response(
        JSON.stringify({
          id: 'chatcmpl_test',
          created: 0,
          model: 'coder',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'ok',
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    }) as typeof globalThis.fetch;

    try {
      (configStore as unknown as { getApiKey(vendorName: string): Promise<string> }).getApiKey = async (
        vendorName: string,
      ) => (vendorName === 'Vendor' ? 'configured' : '');
      await provider.refreshModels();
      let response: unknown;
      let error: unknown;
      try {
        response = await provider.sendRequest({
          modelId,
          messages: [
            {
              role: 'user',
              content: [{ value: 'reply with ok' }],
            },
          ],
          capabilities: { toolCalling: false, imageInput: false },
          options: { tools: [] },
        });
      } catch (caughtError) {
        error = caughtError;
        if (!options.expectError) {
          throw caughtError;
        }
      }
      return {
        payloads,
        response,
        error,
      };
    } finally {
      globalThis.fetch = originalFetch;
      provider.dispose();
      configStore.dispose();
    }
  }

  const zeroOutputDisabledResult = await capturePayload(
    [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: 'openai-chat',
        defaultVision: false,
        models: [
          {
            name: 'coder',
            contextSize: 64000,
            capabilities: { tools: true, vision: false },
          },
        ],
      },
    ],
    'Vendor/coder',
  );
  assert.equal('max_tokens' in zeroOutputDisabledResult.payload, false);
  assert.equal('top_p' in zeroOutputDisabledResult.payload, false);
  assert.equal(readAttachedTokenUsage(zeroOutputDisabledResult.response)?.outputBuffer, undefined);
  console.log('PASS openai-chat 在 maxOutputTokens/topP 为 0 时不会下发 max_tokens/top_p');

  const requiredMaxTokensRetryResult = await capturePayloadWithRequiredMaxTokensRetry(
    [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: 'openai-chat',
        defaultVision: false,
        models: [
          {
            name: 'coder',
            capabilities: { tools: true, vision: false },
          },
        ],
      },
    ],
    'Vendor/coder',
  );
  assert.equal(requiredMaxTokensRetryResult.payloads.length, 2);
  assert.equal('max_tokens' in requiredMaxTokensRetryResult.payloads[0], false);
  assert.equal(requiredMaxTokensRetryResult.payloads[1]?.max_tokens, 30000);
  assert.equal(requiredMaxTokensRetryResult.payloads[1]?.stream, false);
  assert.equal(
    readAttachedTokenUsage(requiredMaxTokensRetryResult.response)?.outputBuffer,
    30000,
  );
  console.log('PASS 上游要求 max_tokens 时会自动重试并补发 max_tokens');

  const noWrapRequiredMaxTokensRetryResult = await capturePayloadWithRequiredMaxTokensRetry(
    [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: 'openai-chat',
        enableExtraRequestWrapping: false,
        defaultVision: false,
        models: [
          {
            name: 'coder',
            capabilities: { tools: true, vision: false },
          },
        ],
      },
    ],
    'Vendor/coder',
    { expectError: true },
  );
  assert.equal(noWrapRequiredMaxTokensRetryResult.payloads.length, 1);
  assert.ok(noWrapRequiredMaxTokensRetryResult.error);
  console.log('PASS openai-chat 关闭额外封装后缺少 max_tokens 不会自动重试');

  const implicitReserveRetryResult = await capturePayloadWithRequiredMaxTokensRetry(
    [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: 'openai-chat',
        defaultVision: false,
        models: [
          {
            name: 'dynamic-coder',
            capabilities: { tools: true, vision: false },
          },
        ],
      },
    ],
    'Vendor/dynamic-coder',
  );
  assert.equal(implicitReserveRetryResult.payloads.length, 2);
  assert.equal('max_tokens' in implicitReserveRetryResult.payloads[0], false);
  assert.equal(implicitReserveRetryResult.payloads[1]?.max_tokens, 30000);
  assert.equal(implicitReserveRetryResult.payloads[1]?.stream, false);
  assert.equal(
    readAttachedTokenUsage(implicitReserveRetryResult.response)?.outputBuffer,
    30000,
  );
  console.log('PASS 默认输出上限会影响补发的 max_tokens 与 outputBuffer');

  const positiveOutputResult = await capturePayload(
    [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: 'openai-chat',
        defaultVision: false,
        models: [
          {
            name: 'coder',
            contextSize: 64000,
            capabilities: { tools: true, vision: false },
          },
        ],
      },
    ],
    'Vendor/coder',
    {
      modelOptions: {
        thinkingEffort: 'high',
      },
    },
  );
  assert.equal('max_tokens' in positiveOutputResult.payload, false);
  assert.equal('top_p' in positiveOutputResult.payload, false);
  assert.equal('temperature' in positiveOutputResult.payload, false);
  assert.equal(readAttachedTokenUsage(positiveOutputResult.response)?.outputBuffer, undefined);
  console.log('PASS openai-chat 在未配置 temperature/topP 时默认不发送 temperature/top_p');

  const positiveTopPResult = await capturePayload(
    [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: 'openai-chat',
        defaultVision: false,
        defaultTopP: 0.95,
        models: [
          {
            name: 'coder',
            contextSize: 64000,
            capabilities: { tools: true, vision: false },
          },
        ],
      },
    ],
    'Vendor/coder',
    {
      modelOptions: {
        thinkingEffort: 'high',
      },
    },
  );
  assert.equal(positiveTopPResult.payload.top_p, 0.95);
  console.log('PASS openai-chat 在 topP 为正数时会发送 top_p');

  const modelZeroTopPResult = await capturePayload(
    [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: 'openai-chat',
        defaultVision: false,
        defaultTopP: 0.95,
        models: [
          {
            name: 'coder',
            contextSize: 64000,
            topP: 0,
            capabilities: { tools: true, vision: false },
          },
        ],
      },
    ],
    'Vendor/coder',
  );
  assert.equal('top_p' in modelZeroTopPResult.payload, false);
  console.log('PASS openai-chat 模型显式 topP=0 时会覆盖供应商默认值并省略 top_p');

  const responsesDefaultTopPResult = await captureOpenAIResponsesPayload(
    [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: 'openai-responses',
        defaultVision: false,
        models: [
          {
            name: 'coder',
            contextSize: 64000,
            capabilities: { tools: false, vision: false },
          },
        ],
      },
    ],
    'Vendor/coder',
  );
  assert.equal('temperature' in responsesDefaultTopPResult, false);
  assert.equal('instructions' in responsesDefaultTopPResult, false);
  assert.equal('top_p' in responsesDefaultTopPResult, false);
  console.log('PASS openai-responses 默认不发送 temperature/instructions，且在未配置 topP 时不发送 top_p');

  const responsesPositiveTopPResult = await captureOpenAIResponsesPayload(
    [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: 'openai-responses',
        defaultVision: false,
        defaultTopP: 0.85,
        models: [
          {
            name: 'coder',
            contextSize: 64000,
            capabilities: { tools: false, vision: false },
          },
        ],
      },
    ],
    'Vendor/coder',
  );
  assert.equal('temperature' in responsesPositiveTopPResult, false);
  assert.equal(responsesPositiveTopPResult.top_p, 0.85);
  console.log('PASS openai-responses 在 topP 为正数时会发送 top_p');

  const responsesSystemPromptResult = await captureOpenAIResponsesPayload(
    [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: 'openai-responses',
        defaultVision: false,
        models: [
          {
            name: 'coder',
            contextSize: 64000,
            capabilities: { tools: false, vision: false },
          },
        ],
      },
    ],
    'Vendor/coder',
    [
      {
        role: 3,
        content: [{ value: 'system policy' }],
      },
      {
        role: 'user',
        content: [{ value: 'reply with ok' }],
      },
    ],
  );
  assert.equal(
    responsesSystemPromptResult.instructions,
    'system policy',
  );
  assert.deepEqual(
    (responsesSystemPromptResult.input as Array<{ role?: string }>).map((item) => item.role),
    ['user'],
  );
  console.log('PASS openai-responses 会把 system 消息发送到 instructions 字段');

  const responsesFriendlyPersonalityResult = await captureOpenAIResponsesPayload(
    [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: 'openai-responses',
        defaultVision: false,
        models: [
          {
            name: 'coder',
            contextSize: 64000,
            capabilities: { tools: false, vision: false },
          },
        ],
      },
    ],
    'Vendor/coder',
    [
      {
        role: 'user',
        content: [{ value: 'reply with ok' }],
      },
    ],
    {
      modelOptions: {
        temperature: 1,
        personality: 'friendly',
      },
    },
  );
  assert.equal('temperature' in responsesFriendlyPersonalityResult, false);
  assert.equal(
    responsesFriendlyPersonalityResult.instructions,
    'Personality: friendly. Be warm, clear, collaborative, and focused on useful next steps.',
  );
  console.log('PASS openai-responses 使用 Personality 写入 instructions，忽略 temperature 参数');

  const unwrappedOpenAIChatResult = await capturePayload(
    [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: 'openai-chat',
        enableExtraRequestWrapping: false,
        defaultVision: false,
        defaultTopP: 0.95,
        defaultTemperature: 0.4,
        models: [
          {
            name: 'coder',
            contextSize: 64000,
            capabilities: { tools: true, vision: false },
          },
        ],
      },
    ],
    'Vendor/coder',
    {
      modelOptions: {
        thinkingEffort: 'high',
      },
    },
  );
  assert.equal('temperature' in unwrappedOpenAIChatResult.payload, false);
  assert.equal('top_p' in unwrappedOpenAIChatResult.payload, false);
  assert.equal('thinking' in unwrappedOpenAIChatResult.payload, true);
  assert.equal('reasoning_effort' in unwrappedOpenAIChatResult.payload, true);
  console.log('PASS openai-chat 关闭额外封装后仍保留 thinking，但不发送其它增强字段');

  const unwrappedResponsesPayload = await captureOpenAIResponsesPayload(
    [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: 'openai-responses',
        enableExtraRequestWrapping: false,
        defaultVision: false,
        defaultTopP: 0.85,
        models: [
          {
            name: 'coder',
            contextSize: 64000,
            capabilities: { tools: false, vision: false },
          },
        ],
      },
    ],
    'Vendor/coder',
    [
      {
        role: 3,
        content: [{ value: 'system policy' }],
      },
      {
        role: 'user',
        content: [{ value: 'reply with ok' }],
      },
    ],
    {
      modelOptions: {
        thinkingEffort: 'high',
        personality: 'friendly',
      },
    },
  );
  assert.equal('instructions' in unwrappedResponsesPayload, false);
  assert.equal('top_p' in unwrappedResponsesPayload, false);
  assert.deepEqual(unwrappedResponsesPayload.reasoning, { effort: 'high' });
  assert.deepEqual(
    (unwrappedResponsesPayload.input as Array<{ role?: string }>).map((item) => item.role),
    ['system', 'user'],
  );
  console.log('PASS openai-responses 关闭额外封装后保留 system 与 reasoning，并省略其它增强字段');
}

async function runGenericProviderMultimodalPayloadTests(
  configStoreCtor: ConfigStoreCtor,
  genericProviderModule: GenericProviderModule,
): Promise<void> {
  const vscode = require('vscode') as {
    LanguageModelTextPart: new (value: string) => { value: string };
    LanguageModelDataPart: new (data: Uint8Array, mimeType: string) => { data: Uint8Array; mimeType: string };
  };
  const { GenericAIProvider } = genericProviderModule;
  const originalFetch = globalThis.fetch;

  async function capturePayload(
    apiStyle: 'openai-chat' | 'openai-responses' | 'anthropic',
  ): Promise<Record<string, unknown>> {
    activeState = createStaticVendorState([
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: apiStyle,
        defaultVision: true,
        models: [
          {
            name: 'vision-coder',
            apiStyle,
            contextSize: 64000,
            capabilities: { tools: false, vision: true },
          },
        ],
      },
    ]);
    const configStore = new configStoreCtor(createExtensionContext() as never);
    const provider = new GenericAIProvider(createExtensionContext() as never, configStore) as unknown as {
      refreshModels(): Promise<void>;
      sendRequest(request: {
        modelId: string;
        messages: Array<{ role: number; content: unknown[] }>;
        capabilities: { toolCalling: boolean; imageInput: boolean };
        options?: { tools?: unknown[] };
      }): Promise<unknown>;
      dispose(): void;
    };

    let payload: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      payload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const body =
        apiStyle === 'openai-responses'
          ? {
              id: 'resp_test',
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: 'ok' }],
                },
              ],
            }
          : apiStyle === 'anthropic'
            ? {
                id: 'msg_test',
                role: 'assistant',
                content: [{ type: 'text', text: 'ok' }],
              }
            : {
                id: 'chatcmpl_test',
                created: 0,
                model: 'vision-coder',
                choices: [
                  {
                    index: 0,
                    message: { role: 'assistant', content: 'ok' },
                    finish_reason: 'stop',
                  },
                ],
              };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      });
    }) as typeof globalThis.fetch;

    try {
      (configStore as unknown as { getApiKey(vendorName: string): Promise<string> }).getApiKey = async (
        vendorName: string,
      ) => (vendorName === 'Vendor' ? 'configured' : '');
      await provider.refreshModels();
      await provider.sendRequest({
        modelId: 'Vendor/vision-coder',
        messages: [
          {
            role: 1,
            content: [
              new vscode.LanguageModelTextPart('describe this image'),
              new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), 'image/png'),
            ],
          },
        ],
        capabilities: { toolCalling: false, imageInput: true },
        options: { tools: [] },
      });
      assert.ok(payload);
      return payload;
    } finally {
      globalThis.fetch = originalFetch;
      provider.dispose();
      configStore.dispose();
    }
  }

  const openAIChatPayload = await capturePayload('openai-chat');
  const openAIChatMessages = openAIChatPayload.messages as Array<{ content: Array<Record<string, unknown>> }>;
  assert.equal(openAIChatMessages[0]?.content[0]?.type, 'text');
  assert.equal(openAIChatMessages[0]?.content[1]?.type, 'image_url');
  assert.deepEqual(openAIChatMessages[0]?.content[1]?.image_url, { url: 'data:image/png;base64,AQID' });
  console.log('PASS openai-chat 会把 LanguageModelDataPart 图片转成 image_url');

  const openAIResponsesPayload = await capturePayload('openai-responses');
  const responsesInput = openAIResponsesPayload.input as Array<{ content: Array<Record<string, unknown>> }>;
  assert.equal(responsesInput[0]?.content[0]?.type, 'input_text');
  assert.equal(responsesInput[0]?.content[1]?.type, 'input_image');
  assert.equal(responsesInput[0]?.content[1]?.image_url, 'data:image/png;base64,AQID');
  console.log('PASS openai-responses 会把 LanguageModelDataPart 图片转成 input_image');

  const anthropicPayload = await capturePayload('anthropic');
  const anthropicMessages = anthropicPayload.messages as Array<{ content: Array<Record<string, unknown>> }>;
  assert.equal(anthropicMessages[0]?.content[0]?.type, 'text');
  assert.deepEqual(anthropicMessages[0]?.content[1], {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/png',
      data: 'AQID',
    },
  });
  console.log('PASS anthropic 会把 LanguageModelDataPart 图片转成 base64 image block');
}

async function runGenericProviderThinkingEffortTests(
  configStoreCtor: ConfigStoreCtor,
  genericProviderModule: GenericProviderModule,
): Promise<void> {
  const { GenericAIProvider } = genericProviderModule;
  const originalFetch = globalThis.fetch;

  async function capturePayload(
    vendors: VendorRecord[],
    modelId: string,
    options?: { modelOptions?: Record<string, unknown> },
  ): Promise<Record<string, unknown>> {
    activeState = createStaticVendorState(vendors);
    const configStore = new configStoreCtor(createExtensionContext() as never);
    const provider = new GenericAIProvider(createExtensionContext() as never, configStore) as unknown as {
      refreshModels(): Promise<void>;
      sendRequest(request: {
        modelId: string;
        messages: Array<{ role: string; content: Array<{ value: string }> }>;
        capabilities: { toolCalling: boolean; imageInput: boolean };
        options?: { tools?: unknown[]; modelOptions?: Record<string, unknown> };
      }): Promise<unknown>;
      dispose(): void;
    };

    let payload: Record<string, unknown> | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      payload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      const requestUrl = String(url);
      const isResponsesPayload = requestUrl.includes('/responses');
      const isAnthropicPayload = requestUrl.includes('/messages');

      if (isResponsesPayload) {
        return new Response(
          JSON.stringify({
            id: 'resp_reasoning',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [
                  {
                    type: 'output_text',
                    text: 'ok',
                  },
                ],
              },
            ],
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              total_tokens: 2,
            },
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
            },
          },
        );
      }

      if (isAnthropicPayload) {
        return new Response(
          JSON.stringify({
            id: 'msg_reasoning',
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'ok',
              },
            ],
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 1,
              output_tokens: 1,
            },
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
            },
          },
        );
      }

      return new Response(
        JSON.stringify({
          id: 'chat_reasoning',
          created: 0,
          model: 'reasoner',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'ok',
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    }) as typeof globalThis.fetch;

    try {
      (configStore as unknown as { getApiKey(vendorName: string): Promise<string> }).getApiKey = async (
        vendorName: string,
      ) => (vendorName === 'Vendor' ? 'configured' : '');
      await provider.refreshModels();
      await provider.sendRequest({
        modelId,
        messages: [
          {
            role: 'user',
            content: [{ value: 'reply with ok' }],
          },
        ],
        capabilities: { toolCalling: false, imageInput: false },
        options: { tools: [], ...options },
      });
      assert.ok(payload);
      return payload;
    } finally {
      globalThis.fetch = originalFetch;
      provider.dispose();
      configStore.dispose();
    }
  }

  async function captureOpenAIResponsesReasoningFallbackPayloads(): Promise<Record<string, unknown>[]> {
    activeState = createStaticVendorState([
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: 'openai-responses',
        defaultVision: false,
        models: [
          {
            name: 'reasoner',
            contextSize: 64000,
            maxInputTokens: 32000,
            maxOutputTokens: 16000,
            capabilities: { tools: false, vision: false },
          },
        ],
      },
    ]);
    const configStore = new configStoreCtor(createExtensionContext() as never);
    const provider = new GenericAIProvider(createExtensionContext() as never, configStore) as unknown as {
      refreshModels(): Promise<void>;
      sendRequest(request: {
        modelId: string;
        messages: Array<{ role: string; content: Array<{ value: string }> }>;
        capabilities: { toolCalling: boolean; imageInput: boolean };
        options?: { tools?: unknown[]; modelOptions?: Record<string, unknown> };
      }): Promise<unknown>;
      dispose(): void;
    };

    const payloads: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const payload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      payloads.push(payload);
      if (payloads.length === 1) {
        return new Response(
          JSON.stringify({
            detail: 'Unsupported parameter: reasoning',
          }),
          {
            status: 400,
            headers: {
              'content-type': 'application/json',
            },
          },
        );
      }

      return new Response(
        JSON.stringify({
          id: 'resp_reasoning',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: 'ok',
                },
              ],
            },
          ],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    }) as typeof globalThis.fetch;

    try {
      (configStore as unknown as { getApiKey(vendorName: string): Promise<string> }).getApiKey = async (
        vendorName: string,
      ) => (vendorName === 'Vendor' ? 'configured' : '');
      await provider.refreshModels();
      const request = {
        modelId: 'Vendor/reasoner',
        messages: [
          {
            role: 'user',
            content: [{ value: 'reply with ok' }],
          },
        ],
        capabilities: { toolCalling: false, imageInput: false },
        options: {
          tools: [],
          modelOptions: {
            thinkingEffort: 'high',
          },
        },
      };
      await provider.sendRequest(request);
      await provider.sendRequest(request);
      return payloads;
    } finally {
      globalThis.fetch = originalFetch;
      provider.dispose();
      configStore.dispose();
    }
  }

  const openAIChatPayload = await capturePayload(
    [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: 'openai-chat',
        defaultVision: false,
        models: [
          {
            name: 'reasoner',
            contextSize: 64000,
            maxInputTokens: 32000,
            maxOutputTokens: 16000,
            capabilities: { tools: false, vision: false },
          },
        ],
      },
    ],
    'Vendor/reasoner',
    {
      modelOptions: {
        thinkingEffort: 'none',
      },
    },
  );
  assert.deepEqual(openAIChatPayload.thinking, { type: 'disabled' });
  assert.equal('reasoning_effort' in openAIChatPayload, false);
  console.log('PASS openai-chat 在请求级 none 模式下会发送 thinking.disabled 且省略 reasoning_effort');

  const defaultThinkingOpenAIChatPayload = await capturePayload(
    [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: 'openai-chat',
        defaultVision: false,
        models: [
          {
            name: 'reasoner',
            contextSize: 64000,
            maxInputTokens: 32000,
            maxOutputTokens: 16000,
            capabilities: { tools: false, vision: false },
          },
        ],
      },
    ],
    'Vendor/reasoner',
    {
      modelOptions: {
        thinkingType: 'default',
        thinkingEffort: 'high',
      },
    },
  );
  assert.equal('thinking' in defaultThinkingOpenAIChatPayload, false);
  assert.equal(defaultThinkingOpenAIChatPayload.reasoning_effort, 'high');
  console.log('PASS openai-chat 在请求级 thinkingType=default 时不发送 thinking 参数');

  for (const thinkingEffort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
    const overriddenOpenAIChatPayload = await capturePayload(
      [
        {
          name: 'Vendor',
          baseUrl: 'https://example.test/v1',
          defaultApiStyle: 'openai-chat',
          defaultVision: false,
          models: [
            {
              name: 'reasoner',
              contextSize: 64000,
              maxInputTokens: 32000,
              maxOutputTokens: 16000,
              capabilities: { tools: false, vision: false },
            },
          ],
        },
      ],
      'Vendor/reasoner',
      {
        modelOptions: {
          thinkingEffort,
        },
      },
    );
    assert.deepEqual(overriddenOpenAIChatPayload.thinking, { type: 'enabled' });
    assert.equal(overriddenOpenAIChatPayload.reasoning_effort, thinkingEffort);
  }
  console.log('PASS 请求级 thinkingEffort 可驱动 openai-chat 的 thinking 与 reasoning_effort');

  const overriddenTemperaturePayload = await capturePayload(
    [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: 'openai-chat',
        defaultVision: false,
        defaultTemperature: 0.4,
        models: [
          {
            name: 'reasoner',
            temperature: 0.7,
            contextSize: 64000,
            maxInputTokens: 32000,
            maxOutputTokens: 16000,
            capabilities: { tools: false, vision: false },
          },
        ],
      },
    ],
    'Vendor/reasoner',
    {
      modelOptions: {
        temperature: '1',
      },
    },
  );
  assert.equal(overriddenTemperaturePayload.temperature, 1);
  console.log('PASS 请求级 temperature 可覆盖模型级与供应商级默认值');

  const requestInheritedTemperaturePayload = await capturePayload(
    [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: 'openai-chat',
        defaultVision: false,
        defaultTemperature: 0.4,
        models: [
          {
            name: 'reasoner',
            temperature: 0.7,
            contextSize: 64000,
            maxInputTokens: 32000,
            maxOutputTokens: 16000,
            capabilities: { tools: false, vision: false },
          },
        ],
      },
    ],
    'Vendor/reasoner',
    {
      modelOptions: {
        temperature: 'inherit',
      },
    },
  );
  assert.equal(requestInheritedTemperaturePayload.temperature, 0.7);
  console.log('PASS 请求级 temperature=inherit 会继承模型级与供应商级默认值');

  const inheritedModelTemperaturePayload = await capturePayload(
    [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: 'openai-chat',
        defaultVision: false,
        defaultTemperature: 0.4,
        models: [
          {
            name: 'reasoner',
            temperature: 'inherit' as unknown as number,
            contextSize: 64000,
            maxInputTokens: 32000,
            maxOutputTokens: 16000,
            capabilities: { tools: false, vision: false },
          },
        ],
      },
    ],
    'Vendor/reasoner',
  );
  assert.equal(inheritedModelTemperaturePayload.temperature, 0.4);
  console.log('PASS 模型级 temperature=inherit 会使用供应商 defaultTemperature');

  const omittedTemperaturePayload = await capturePayload(
    [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: 'openai-chat',
        defaultVision: false,
        defaultTemperature: 0.4,
        models: [
          {
            name: 'reasoner',
            temperature: 0.7,
            contextSize: 64000,
            maxInputTokens: 32000,
            maxOutputTokens: 16000,
            capabilities: { tools: false, vision: false },
          },
        ],
      },
    ],
    'Vendor/reasoner',
    {
      modelOptions: {
        temperature: 'none',
      },
    },
  );
  assert.equal('temperature' in omittedTemperaturePayload, false);
  console.log('PASS 请求级 temperature=none 会省略 temperature 参数');

  const openAIResponsesPayload = await capturePayload(
    [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: 'openai-responses',
        defaultVision: false,
        models: [
          {
            name: 'reasoner',
            contextSize: 64000,
            maxInputTokens: 32000,
            maxOutputTokens: 16000,
            capabilities: { tools: false, vision: false },
          },
        ],
      },
    ],
    'Vendor/reasoner',
    {
      modelOptions: {
        thinkingEffort: 'high',
      },
    },
  );
  assert.deepEqual(openAIResponsesPayload.reasoning, { effort: 'high' });
  assert.equal('thinking' in openAIResponsesPayload, false);
  assert.equal('reasoning_effort' in openAIResponsesPayload, false);
  assert.equal('temperature' in openAIResponsesPayload, false);
  assert.equal('instructions' in openAIResponsesPayload, false);
  console.log('PASS openai-responses 会按请求级 thinkingEffort 发送 reasoning.effort，默认不注入 Personality');

  const unsupportedOpenAIResponsesEffortPayload = await capturePayload(
    [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: 'openai-responses',
        defaultVision: false,
        models: [
          {
            name: 'reasoner',
            apiType: 'responses',
            maxInputTokens: 32000,
            maxOutputTokens: 16000,
            supportsReasoningEffort: ['xhigh'],
            capabilities: { tools: false, vision: false },
          },
        ],
      },
    ],
    'Vendor/reasoner',
    {
      modelOptions: {
        thinkingEffort: 'high',
      },
    },
  );
  assert.equal('reasoning' in unsupportedOpenAIResponsesEffortPayload, false);
  console.log('PASS supportsReasoningEffort 会阻止未声明支持的 openai-responses effort 下发');

  const nonStreamingOpenAIResponsesPayload = await capturePayload(
    [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: 'openai-responses',
        defaultVision: false,
        models: [
          {
            name: 'reasoner',
            maxInputTokens: 32000,
            maxOutputTokens: 16000,
            streaming: false,
            capabilities: { tools: false, vision: false },
          },
        ],
      },
    ],
    'Vendor/reasoner',
    {
      modelOptions: {
        thinkingEffort: 'xhigh',
      },
    },
  );
  assert.equal(nonStreamingOpenAIResponsesPayload.stream, false);
  console.log('PASS streaming=false 会让 openai-responses 走非流式请求');

  const responsesReasoningFallbackPayloads = await captureOpenAIResponsesReasoningFallbackPayloads();
  assert.equal(responsesReasoningFallbackPayloads.length, 3);
  assert.deepEqual(responsesReasoningFallbackPayloads[0].reasoning, { effort: 'high' });
  assert.equal('reasoning' in responsesReasoningFallbackPayloads[1], false);
  assert.equal('reasoning' in responsesReasoningFallbackPayloads[2], false);
  console.log('PASS openai-responses 遇到 reasoning 参数不兼容时会去掉 reasoning 重试并记住会话降级');

  const openAIResponsesXhighPayload = await capturePayload(
    [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: 'openai-responses',
        defaultVision: false,
        models: [
          {
            name: 'reasoner',
            contextSize: 64000,
            maxInputTokens: 32000,
            maxOutputTokens: 16000,
            capabilities: { tools: false, vision: false },
          },
        ],
      },
    ],
    'Vendor/reasoner',
    {
      modelOptions: {
        thinkingEffort: 'xhigh',
      },
    },
  );
  assert.deepEqual(openAIResponsesXhighPayload.reasoning, { effort: 'xhigh' });
  assert.equal('thinking' in openAIResponsesXhighPayload, false);
  assert.equal('reasoning_effort' in openAIResponsesXhighPayload, false);
  console.log('PASS openai-responses 会按请求级 thinkingEffort=xhigh 发送 reasoning.effort=xhigh');

  const openAIResponsesMaxPayload = await capturePayload(
    [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: 'openai-responses',
        defaultVision: false,
        models: [
          {
            name: 'reasoner',
            contextSize: 64000,
            maxInputTokens: 32000,
            maxOutputTokens: 16000,
            capabilities: { tools: false, vision: false },
          },
        ],
      },
    ],
    'Vendor/reasoner',
    {
      modelOptions: {
        thinkingEffort: 'max',
      },
    },
  );
  assert.deepEqual(openAIResponsesMaxPayload.reasoning, { effort: 'max' });
  console.log('PASS openai-responses 会按请求级 thinkingEffort=max 发送 reasoning.effort=max');

  const unwrappedOpenAIResponsesPayload = await capturePayload(
    [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/v1',
        defaultApiStyle: 'openai-responses',
        enableExtraRequestWrapping: false,
        defaultVision: false,
        defaultTopP: 0.8,
        models: [
          {
            name: 'reasoner',
            contextSize: 64000,
            maxInputTokens: 32000,
            maxOutputTokens: 16000,
            capabilities: { tools: false, vision: false },
          },
        ],
      },
    ],
    'Vendor/reasoner',
    {
      modelOptions: {
        thinkingEffort: 'xhigh',
        personality: 'friendly',
      },
    },
  );
  assert.deepEqual(unwrappedOpenAIResponsesPayload.reasoning, { effort: 'xhigh' });
  assert.equal('top_p' in unwrappedOpenAIResponsesPayload, false);
  assert.equal('instructions' in unwrappedOpenAIResponsesPayload, false);
  console.log('PASS openai-responses 关闭额外封装后仍保留 reasoning，但不发送 top_p/instructions');

  const anthropicPayload = await capturePayload(
    [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/anthropic/v1',
        defaultApiStyle: 'anthropic',
        defaultVision: false,
        models: [
          {
            name: 'reasoner',
            contextSize: 64000,
            maxInputTokens: 32000,
            maxOutputTokens: 16000,
            capabilities: { tools: false, vision: false },
          },
        ],
      },
    ],
    'Vendor/reasoner',
    {
      modelOptions: {
        effort: 'xhigh',
        thinkingType: true,
      },
    },
  );
  assert.deepEqual(anthropicPayload.thinking, { type: 'adaptive' });
  assert.deepEqual(anthropicPayload.output_config, { effort: 'xhigh' });
  console.log('PASS anthropic 会分别按请求级 thinking 开关与 effort 发送 thinking 和 output_config.effort');

  const anthropicThinkingDisabledPayload = await capturePayload(
    [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/anthropic/v1',
        defaultApiStyle: 'anthropic',
        defaultVision: false,
        models: [
          {
            name: 'reasoner',
            contextSize: 64000,
            maxInputTokens: 32000,
            maxOutputTokens: 16000,
            capabilities: { tools: false, vision: false },
          },
        ],
      },
    ],
    'Vendor/reasoner',
    {
      modelOptions: {
        effort: 'low',
        thinkingType: false,
      },
    },
  );
  assert.deepEqual(anthropicThinkingDisabledPayload.thinking, { type: 'disabled' });
  assert.deepEqual(anthropicThinkingDisabledPayload.output_config, { effort: 'low' });
  console.log('PASS anthropic thinking=false 会发送 disabled thinking 且保留独立 effort');

  const unwrappedAnthropicPayload = await capturePayload(
    [
      {
        name: 'Vendor',
        baseUrl: 'https://example.test/anthropic/v1',
        defaultApiStyle: 'anthropic',
        enableExtraRequestWrapping: false,
        defaultTemperature: 0.3,
        defaultVision: false,
        models: [
          {
            name: 'reasoner',
            contextSize: 64000,
            maxInputTokens: 32000,
            maxOutputTokens: 16000,
            capabilities: { tools: false, vision: false },
          },
        ],
      },
    ],
    'Vendor/reasoner',
    {
      modelOptions: {
        effort: 'low',
        thinkingType: false,
      },
    },
  );
  assert.equal(unwrappedAnthropicPayload.max_tokens, 12800);
  assert.equal('temperature' in unwrappedAnthropicPayload, false);
  assert.deepEqual(unwrappedAnthropicPayload.thinking, { type: 'disabled' });
  assert.deepEqual(unwrappedAnthropicPayload.output_config, { effort: 'low' });
  console.log('PASS anthropic 关闭额外封装后仍保留 thinking/effort，但省略其它增强字段');
}

async function runGenericProviderAnthropicSamplingCompatibilityTests(
  configStoreCtor: ConfigStoreCtor,
  genericProviderModule: GenericProviderModule,
): Promise<void> {
  const { GenericAIProvider } = genericProviderModule;
  const originalFetch = globalThis.fetch;

  activeState = createStaticVendorState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/anthropic/v1',
      defaultApiStyle: 'anthropic',
      defaultTemperature: 0.4,
      defaultTopP: 0.9,
      defaultVision: false,
      models: [
        {
          name: 'coder',
          temperature: 0.25,
          topP: 0.8,
          capabilities: { tools: false, vision: false },
        },
      ],
    },
  ]);

  const configStore = new configStoreCtor(createExtensionContext() as never);
  const provider = new GenericAIProvider(createExtensionContext() as never, configStore) as unknown as {
    refreshModels(): Promise<void>;
    sendRequest(request: {
      modelId: string;
      messages: Array<{ role: string; content: Array<{ value: string }> }>;
      capabilities: { toolCalling: boolean; imageInput: boolean };
      options?: { tools?: unknown[] };
    }): Promise<unknown>;
    dispose(): void;
  };

  let payload: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    payload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        id: 'msg_test',
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'ok',
          },
        ],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 4,
          output_tokens: 2,
        },
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      },
    );
  }) as typeof globalThis.fetch;

  try {
    (configStore as unknown as { getApiKey(vendorName: string): Promise<string> }).getApiKey = async (
      vendorName: string,
    ) => (vendorName === 'Vendor' ? 'configured' : '');
    await provider.refreshModels();
    await provider.sendRequest({
      modelId: 'Vendor/coder',
      messages: [
        {
          role: 'user',
          content: [{ value: 'reply with ok' }],
        },
      ],
      capabilities: { toolCalling: false, imageInput: false },
      options: { tools: [] },
    });

    assert.ok(payload);
  assert.equal(payload.temperature, 0.25);
  assert.equal(payload.max_tokens, 30000);
  assert.equal('top_p' in payload, false);
  console.log('PASS anthropic 请求会保留 temperature 但不发送 top_p');
  } finally {
    globalThis.fetch = originalFetch;
    provider.dispose();
    configStore.dispose();
  }

  activeState = createStaticVendorState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/anthropic/v1',
      defaultApiStyle: 'anthropic',
      enableExtraRequestWrapping: false,
      defaultTemperature: 0.4,
      defaultTopP: 0.9,
      defaultVision: false,
      models: [
        {
          name: 'coder',
          temperature: 0.25,
          topP: 0.8,
          capabilities: { tools: false, vision: false },
        },
      ],
    },
  ]);

  const unwrappedConfigStore = new configStoreCtor(createExtensionContext() as never);
  const unwrappedProvider = new GenericAIProvider(createExtensionContext() as never, unwrappedConfigStore) as unknown as {
    refreshModels(): Promise<void>;
    sendRequest(request: {
      modelId: string;
      messages: Array<{ role: string; content: Array<{ value: string }> }>;
      capabilities: { toolCalling: boolean; imageInput: boolean };
      options?: { tools?: unknown[] };
    }): Promise<unknown>;
    dispose(): void;
  };

  let unwrappedPayload: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    unwrappedPayload = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        id: 'msg_test',
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'ok',
          },
        ],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 4,
          output_tokens: 2,
        },
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      },
    );
  }) as typeof globalThis.fetch;

  try {
    (unwrappedConfigStore as unknown as { getApiKey(vendorName: string): Promise<string> }).getApiKey = async (
      vendorName: string,
    ) => (vendorName === 'Vendor' ? 'configured' : '');
    await unwrappedProvider.refreshModels();
    await unwrappedProvider.sendRequest({
      modelId: 'Vendor/coder',
      messages: [
        {
          role: 'user',
          content: [{ value: 'reply with ok' }],
        },
      ],
      capabilities: { toolCalling: false, imageInput: false },
      options: { tools: [] },
    });

    assert.ok(unwrappedPayload);
    assert.equal(unwrappedPayload.max_tokens, 30000);
    assert.equal('temperature' in unwrappedPayload, false);
    assert.equal('top_p' in unwrappedPayload, false);
    console.log('PASS anthropic 关闭额外封装后仍发送必需 max_tokens 但省略增强采样字段');
  } finally {
    globalThis.fetch = originalFetch;
    unwrappedProvider.dispose();
    unwrappedConfigStore.dispose();
  }
}

async function runGenericProviderAnthropicStreamFallbackTests(
  configStoreCtor: ConfigStoreCtor,
  genericProviderModule: GenericProviderModule,
): Promise<void> {
  const { GenericAIProvider } = genericProviderModule;
  const originalFetch = globalThis.fetch;

  activeState = createStaticVendorState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/anthropic/v1',
      defaultApiStyle: 'anthropic',
      defaultVision: false,
      models: [
        {
          name: 'coder',
          contextSize: 64000,
          maxInputTokens: 32000,
          maxOutputTokens: 16000,
          capabilities: { tools: true, vision: false },
        },
      ],
    },
  ]);

  const configStore = new configStoreCtor(createExtensionContext() as never);
  const provider = new GenericAIProvider(createExtensionContext() as never, configStore) as unknown as {
    refreshModels(): Promise<void>;
    sendRequest(request: {
      modelId: string;
      messages: Array<{ role: string; content: Array<{ value: string }> }>;
      capabilities: { toolCalling: boolean; imageInput: boolean };
      options?: { tools?: unknown[] };
    }): Promise<{ text: AsyncIterable<string> }>;
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
              output_tokens: 2,
            },
          },
        })}`,
        '',
        'event: content_block_start',
        `data: ${JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'toolu_stream',
            name: 'read_file',
          },
        })}`,
        '',
        'event: content_block_delta',
        `data: ${JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: '{1}',
          },
        })}`,
        '',
        'event: message_delta',
        `data: ${JSON.stringify({
          type: 'message_delta',
          delta: {
            stop_reason: 'tool_use',
          },
          usage: {
            input_tokens: 11,
            output_tokens: 2,
          },
        })}`,
        '',
        'data: [DONE]',
        '',
      ].join('\n');

      return new Response(sseBody, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
        },
      });
    }

    return new Response(
      JSON.stringify({
        id: 'msg_fallback',
        type: 'message',
        role: 'assistant',
        model: 'coder',
        content: [
          {
            type: 'text',
            text: 'fallback answer',
          },
        ],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 13,
          output_tokens: 4,
        },
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      },
    );
  }) as typeof globalThis.fetch;

  try {
    (configStore as unknown as { getApiKey(vendorName: string): Promise<string> }).getApiKey = async (
      vendorName: string,
    ) => (vendorName === 'Vendor' ? 'configured' : '');
    await provider.refreshModels();
    const firstResponse = await provider.sendRequest({
      modelId: 'Vendor/coder',
      messages: [
        {
          role: 'user',
          content: [{ value: 'read the file' }],
        },
      ],
      capabilities: { toolCalling: true, imageInput: false },
      options: { tools: [] },
    });
    const textChunks: string[] = [];
    for await (const chunk of firstResponse.text) {
      textChunks.push(chunk);
    }

    const secondResponse = await provider.sendRequest({
      modelId: 'Vendor/coder',
      messages: [
        {
          role: 'user',
          content: [{ value: 'read the file again' }],
        },
      ],
      capabilities: { toolCalling: true, imageInput: false },
      options: { tools: [] },
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
  genericProviderModule: GenericProviderModule,
): Promise<void> {
  const { GenericAIProvider } = genericProviderModule;
  const originalFetch = globalThis.fetch;

  activeState = createStaticVendorState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/anthropic/v1',
      defaultApiStyle: 'anthropic',
      defaultVision: false,
      models: [
        {
          name: 'coder',
          contextSize: 64000,
          maxInputTokens: 32000,
          maxOutputTokens: 16000,
          capabilities: { tools: true, vision: false },
        },
      ],
    },
  ]);

  const configStore = new configStoreCtor(createExtensionContext() as never);
  const provider = new GenericAIProvider(createExtensionContext() as never, configStore) as unknown as {
    refreshModels(): Promise<void>;
    sendRequest(request: {
      modelId: string;
      messages: Array<{ role: string; content: Array<{ value: string }> }>;
      capabilities: { toolCalling: boolean; imageInput: boolean };
      options?: { tools?: unknown[] };
    }): Promise<{ text: AsyncIterable<string> }>;
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
          message: 'model overloaded',
        },
        request_id: 'req_stream_error',
      })}`,
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    return new Response(sseBody, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
      },
    });
  }) as typeof globalThis.fetch;

  try {
    (configStore as unknown as { getApiKey(vendorName: string): Promise<string> }).getApiKey = async (
      vendorName: string,
    ) => (vendorName === 'Vendor' ? 'configured' : '');
    await provider.refreshModels();
    const response = await provider.sendRequest({
      modelId: 'Vendor/coder',
      messages: [
        {
          role: 'user',
          content: [{ value: 'hello' }],
        },
      ],
      capabilities: { toolCalling: true, imageInput: false },
      options: { tools: [] },
    });

    await assert.rejects(
      async () => {
        for await (const chunk of response.text) {
          void chunk;
          // consume stream
        }
      },
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /requestFailed/);
        assert.doesNotMatch(message, /emptyModelResponse/);
        return true;
      },
    );

    const secondResponse = await provider.sendRequest({
      modelId: 'Vendor/coder',
      messages: [
        {
          role: 'user',
          content: [{ value: 'hello again' }],
        },
      ],
      capabilities: { toolCalling: true, imageInput: false },
      options: { tools: [] },
    });
    await assert.rejects(
      async () => {
        for await (const chunk of secondResponse.text) {
          void chunk;
        }
      },
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /requestFailed/);
        return true;
      },
    );
    assert.equal(payloads[0]?.stream, true);
    assert.equal(payloads[1]?.stream, false);
    console.log('PASS anthropic 流式 error 事件后当前会话会持续使用非流式');
  } finally {
    globalThis.fetch = originalFetch;
    provider.dispose();
    configStore.dispose();
  }
}

async function runGenericProviderOpenAIReasoningContinuationTests(
  configStoreCtor: ConfigStoreCtor,
  baseProviderModule: BaseProviderModule,
  genericProviderModule: GenericProviderModule,
): Promise<void> {
  const { GenericAIProvider } = genericProviderModule;
  const reasoningContentMimeType = (baseProviderModule as Record<string, unknown>)[
    'INTERNAL_REASONING_CONTENT_MIME_TYPE'
  ];
  if (typeof reasoningContentMimeType !== 'string') {
    throw new Error('INTERNAL_REASONING_CONTENT_MIME_TYPE is unavailable in baseProviderModule');
  }
  const vscode = require('vscode') as typeof import('vscode');
  const originalFetch = globalThis.fetch;

  activeState = createStaticVendorState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/openai/v1',
      defaultApiStyle: 'openai-chat',
      defaultVision: false,
      models: [
        {
          name: 'deepseek-v4-flash',
          contextSize: 64000,
          maxInputTokens: 32000,
          maxOutputTokens: 16000,
          capabilities: { tools: true, vision: false },
        },
      ],
    },
  ]);

  const configStore = new configStoreCtor(createExtensionContext() as never);
  const provider = new GenericAIProvider(createExtensionContext() as never, configStore) as unknown as {
    refreshModels(): Promise<void>;
    sendRequest(request: {
      modelId: string;
      messages: Array<{ role: string; content: unknown[] }>;
      capabilities: { toolCalling: boolean; imageInput: boolean };
      options?: { tools?: unknown[] };
    }): Promise<{ stream: AsyncIterable<unknown>; text: AsyncIterable<string> }>;
    dispose(): void;
  };
  const payloads: Record<string, unknown>[] = [];

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    payloads.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    if (payloads.length === 1) {
      const sseBody = [
        `data: ${JSON.stringify({
          id: 'chat_reasoning_1',
          choices: [
            {
              index: 0,
              delta: {
                reasoning_content: [{ type: 'reasoning', text: 'Need the get_date tool first.' }],
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_reasoning_1',
                    type: 'function',
                    function: {
                      name: 'get_date',
                      arguments: '{}',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        })}`,
        '',
        'data: [DONE]',
        '',
      ].join('\n');
      return new Response(sseBody, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
        },
      });
    }

    return new Response(
      JSON.stringify({
        id: 'chat_reasoning_2',
        created: 1,
        model: 'deepseek-v4-flash',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'done',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 2,
          total_tokens: 22,
        },
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      },
    );
  }) as typeof globalThis.fetch;

  try {
    (configStore as unknown as { getApiKey(vendorName: string): Promise<string> }).getApiKey = async (
      vendorName: string,
    ) => (vendorName === 'Vendor' ? 'configured' : '');
    await provider.refreshModels();

    const firstResponse = await provider.sendRequest({
      modelId: 'Vendor/deepseek-v4-flash',
      messages: [
        {
          role: 'user',
          content: [{ value: 'Please call get_date first.' }],
        },
      ],
      capabilities: { toolCalling: true, imageInput: false },
      options: { tools: [] },
    });

    const firstResponseParts: unknown[] = [];
    for await (const part of firstResponse.stream) {
      firstResponseParts.push(part);
    }
    const firstResponseText: string[] = [];
    for await (const chunk of firstResponse.text) {
      firstResponseText.push(chunk);
    }

    assert.deepEqual(firstResponseText, []);
    assert.equal(firstResponseParts.length, 2);

    const reasoningPart = firstResponseParts.find(
      (part) =>
        part instanceof vscode.LanguageModelDataPart ||
        ((part as { constructor?: { name?: string } } | undefined)?.constructor?.name ?? '').includes('ThinkingPart'),
    );
    assert.ok(reasoningPart);
    if (reasoningPart instanceof vscode.LanguageModelDataPart) {
      const typedReasoningPart = reasoningPart as import('vscode').LanguageModelDataPart;
      assert.equal(typedReasoningPart.mimeType, reasoningContentMimeType);
      assert.deepEqual(JSON.parse(new TextDecoder().decode(typedReasoningPart.data)), {
        reasoning_content: 'Need the get_date tool first.',
      });
    } else {
      assert.equal((reasoningPart as { value?: unknown }).value, 'Need the get_date tool first.');
    }

    const toolCallPart = firstResponseParts.find((part) => part instanceof vscode.LanguageModelToolCallPart);
    assert.ok(toolCallPart instanceof vscode.LanguageModelToolCallPart);
    const typedToolCallPart = toolCallPart as import('vscode').LanguageModelToolCallPart;
    assert.equal(typedToolCallPart.callId, 'call_reasoning_1');
    assert.equal(typedToolCallPart.name, 'get_date');
    assert.deepEqual(typedToolCallPart.input, {});

    const roundTrippedAssistantParts = firstResponseParts.filter(
      (part) => part instanceof vscode.LanguageModelToolCallPart,
    );
    assert.equal(roundTrippedAssistantParts.length, 1);

    const secondResponse = await provider.sendRequest({
      modelId: 'Vendor/deepseek-v4-flash',
      messages: [
        {
          role: 'user',
          content: [{ value: 'Please call get_date first.' }],
        },
        {
          role: 'assistant',
          content: roundTrippedAssistantParts,
        },
        {
          role: 'user',
          content: [
            new vscode.LanguageModelToolResultPart('call_reasoning_1', [
              new vscode.LanguageModelTextPart('2026-04-27'),
            ]),
          ],
        },
      ],
      capabilities: { toolCalling: true, imageInput: false },
      options: { tools: [] },
    });

    const secondResponseText: string[] = [];
    for await (const chunk of secondResponse.text) {
      secondResponseText.push(chunk);
    }

  assert.deepEqual(secondResponseText, ['done']);
  assert.equal(payloads.length, 2);
  assert.deepEqual(payloads[1]?.messages, [
      {
        role: 'user',
        content: 'Please call get_date first.',
      },
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'Need the get_date tool first.',
        tool_calls: [
          {
            id: 'call_reasoning_1',
            type: 'function',
            function: {
              name: 'get_date',
              arguments: '{}',
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_reasoning_1',
        content: '2026-04-27',
      },
  ]);
  console.log('PASS openai-chat 会在 tool continuation 中保留并回传 reasoning_content');
  } finally {
    globalThis.fetch = originalFetch;
    provider.dispose();
    configStore.dispose();
  }

  activeState = createStaticVendorState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/openai/v1',
      defaultApiStyle: 'openai-chat',
      enableExtraRequestWrapping: false,
      defaultVision: false,
      models: [
        {
          name: 'deepseek-v4-flash',
          contextSize: 64000,
          maxInputTokens: 32000,
          maxOutputTokens: 16000,
          capabilities: { tools: true, vision: false },
        },
      ],
    },
  ]);

  const unwrappedConfigStore = new configStoreCtor(createExtensionContext() as never);
  const unwrappedProvider = new GenericAIProvider(createExtensionContext() as never, unwrappedConfigStore) as unknown as {
    refreshModels(): Promise<void>;
    sendRequest(request: {
      modelId: string;
      messages: Array<{ role: string; content: unknown[] }>;
      capabilities: { toolCalling: boolean; imageInput: boolean };
      options?: { tools?: unknown[] };
    }): Promise<{ stream: AsyncIterable<unknown>; text: AsyncIterable<string> }>;
    dispose(): void;
  };
  const unwrappedPayloads: Record<string, unknown>[] = [];

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    unwrappedPayloads.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    if (unwrappedPayloads.length === 1) {
      const sseBody = [
        `data: ${JSON.stringify({
          id: 'chat_reasoning_1',
          choices: [
            {
              index: 0,
              delta: {
                reasoning_content: [{ type: 'reasoning', text: 'Need the get_date tool first.' }],
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_reasoning_1',
                    type: 'function',
                    function: {
                      name: 'get_date',
                      arguments: '{}',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        })}`,
        '',
        'data: [DONE]',
        '',
      ].join('\n');
      return new Response(sseBody, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
        },
      });
    }

    return new Response(
      JSON.stringify({
        id: 'chat_reasoning_2',
        created: 1,
        model: 'deepseek-v4-flash',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'done',
            },
            finish_reason: 'stop',
          },
        ],
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      },
    );
  }) as typeof globalThis.fetch;

  try {
    (unwrappedConfigStore as unknown as { getApiKey(vendorName: string): Promise<string> }).getApiKey = async (
      vendorName: string,
    ) => (vendorName === 'Vendor' ? 'configured' : '');
    await unwrappedProvider.refreshModels();

    const firstResponse = await unwrappedProvider.sendRequest({
      modelId: 'Vendor/deepseek-v4-flash',
      messages: [
        {
          role: 'user',
          content: [{ value: 'Please call get_date first.' }],
        },
      ],
      capabilities: { toolCalling: true, imageInput: false },
      options: { tools: [] },
    });

    const firstResponseParts: unknown[] = [];
    for await (const part of firstResponse.stream) {
      firstResponseParts.push(part);
    }

    const roundTrippedAssistantParts = firstResponseParts.filter(
      (part) => part instanceof vscode.LanguageModelToolCallPart,
    );

    await unwrappedProvider.sendRequest({
      modelId: 'Vendor/deepseek-v4-flash',
      messages: [
        {
          role: 'user',
          content: [{ value: 'Please call get_date first.' }],
        },
        {
          role: 'assistant',
          content: roundTrippedAssistantParts,
        },
        {
          role: 'user',
          content: [
            new vscode.LanguageModelToolResultPart('call_reasoning_1', [
              new vscode.LanguageModelTextPart('2026-04-27'),
            ]),
          ],
        },
      ],
      capabilities: { toolCalling: true, imageInput: false },
      options: { tools: [] },
    });

    assert.equal('reasoning_content' in ((unwrappedPayloads[1]?.messages as Array<Record<string, unknown>>)[1] ?? {}), false);
    console.log('PASS openai-chat 关闭额外封装后 tool continuation 不回传 reasoning_content');
  } finally {
    globalThis.fetch = originalFetch;
    unwrappedProvider.dispose();
    unwrappedConfigStore.dispose();
  }
}

function runProtocolStreamTests(protocolsModule: ProtocolsModule): void {
  const {
    readOpenAIChatMessageText,
    createOpenAIChatStreamState,
    applyOpenAIChatStreamChunk,
    finalizeOpenAIChatStreamState,
    createOpenAIResponsesStreamState,
    applyOpenAIResponsesStreamEvent,
    finalizeOpenAIResponsesStreamState,
    createAnthropicStreamState,
    applyAnthropicStreamEvent,
    finalizeAnthropicStreamState,
    toAnthropicMessages,
  } = protocolsModule;

  const openAIChatState = createOpenAIChatStreamState();
  const chatDelta = applyOpenAIChatStreamChunk(
    openAIChatState,
    {
      id: 'chat_1',
      choices: [
        {
          index: 0,
          delta: {
            content: 'hello ',
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                function: {
                  name: 'search',
                  arguments: '{',
                },
              },
            ],
          },
        },
      ],
    },
    () => 'generated_call',
  );
  applyOpenAIChatStreamChunk(
    openAIChatState,
    {
      choices: [
        {
          index: 0,
          delta: {
            content: 'world',
            tool_calls: [
              {
                index: 0,
                function: {
                  arguments: '"q":"repo"}',
                },
              },
            ],
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
      },
    },
    () => 'generated_call',
  );
  const finalizedChat = finalizeOpenAIChatStreamState(openAIChatState, () => 'generated_call');
  assert.equal(chatDelta.textDelta, 'hello ');
  assert.equal(finalizedChat.content, 'hello world');
  assert.deepEqual(finalizedChat.toolCalls, [
    {
      id: 'call_1',
      type: 'function',
      function: {
        name: 'search',
        arguments: '{"q":"repo"}',
      },
    },
  ]);
  assert.deepEqual(finalizedChat.usage, {
    prompt_tokens: 10,
    completion_tokens: 4,
    total_tokens: 14,
  });
  console.log('PASS openai-chat 流式文本与工具调用可正确累积');

  const reasoningOnlyChatState = createOpenAIChatStreamState();
  const reasoningOnlyChatDelta = applyOpenAIChatStreamChunk(
    reasoningOnlyChatState,
    {
      choices: [
        {
          index: 0,
          delta: {
            reasoning_content: [{ type: 'reasoning', text: 'fallback ' }],
          },
        },
      ],
    },
    () => 'generated_call',
  );
  applyOpenAIChatStreamChunk(
    reasoningOnlyChatState,
    {
      choices: [
        {
          index: 0,
          message: {
            reasoning: [{ type: 'reasoning', text: 'text' }],
          },
        },
      ],
    },
    () => 'generated_call',
  );
  const finalizedReasoningOnlyChat = finalizeOpenAIChatStreamState(reasoningOnlyChatState, () => 'generated_call');
  assert.equal(reasoningOnlyChatDelta.textDelta, '');
  assert.equal(finalizedReasoningOnlyChat.content, 'fallback text');
  assert.equal(finalizedReasoningOnlyChat.reasoningContent, 'fallback text');

  const reasoningToolCallState = createOpenAIChatStreamState();
  applyOpenAIChatStreamChunk(
    reasoningToolCallState,
    {
      choices: [
        {
          index: 0,
          delta: {
            reasoning_content: [{ type: 'reasoning', text: 'Need the tool first.' }],
            tool_calls: [
              {
                index: 0,
                id: 'call_reasoning_1',
                function: {
                  name: 'lookup',
                  arguments: '{}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
    () => 'generated_call',
  );
  const finalizedReasoningToolCall = finalizeOpenAIChatStreamState(reasoningToolCallState, () => 'generated_call');
  assert.equal(finalizedReasoningToolCall.content, '');
  assert.equal(finalizedReasoningToolCall.reasoningContent, 'Need the tool first.');
  assert.deepEqual(finalizedReasoningToolCall.toolCalls, [
    {
      id: 'call_reasoning_1',
      type: 'function',
      function: {
        name: 'lookup',
        arguments: '{}',
      },
    },
  ]);

  const mixedProxyChatState = createOpenAIChatStreamState();
  applyOpenAIChatStreamChunk(
    mixedProxyChatState,
    {
      choices: [
        {
          index: 0,
          delta: {
            reasoning_content: [{ type: 'reasoning', text: 'proxy ' }],
          },
        },
      ],
    },
    () => 'generated_call',
  );
  const mixedProxyChatDelta = applyOpenAIChatStreamChunk(
    mixedProxyChatState,
    {
      choices: [
        {
          index: 0,
          message: {
            content: [{ type: 'text', text: 'reply' }],
          },
        },
      ],
    },
    () => 'generated_call',
  );
  const finalizedMixedProxyChat = finalizeOpenAIChatStreamState(mixedProxyChatState, () => 'generated_call');
  assert.equal(mixedProxyChatDelta.textDelta, 'reply');
  assert.equal(finalizedMixedProxyChat.content, 'reply');
  console.log('PASS openai-chat 可兼容代理常见的非标准 chunk 字段');

  const cacheControlChatState = createOpenAIChatStreamState();
  const cacheControlChatDelta = applyOpenAIChatStreamChunk(
    cacheControlChatState,
    {
      choices: [
        {
          index: 0,
          delta: {
            content: [
              { type: 'text', text: 'hello ' },
              { type: 'cache_control', value: '[cache_control 9 bytes]' },
            ],
          },
        },
      ],
    },
    () => 'generated_call',
  );
  const finalizedCacheControlChat = finalizeOpenAIChatStreamState(cacheControlChatState, () => 'generated_call');
  assert.equal(cacheControlChatDelta.textDelta, 'hello ');
  assert.equal(finalizedCacheControlChat.content, 'hello ');
  assert.equal(
    readOpenAIChatMessageText({
      content: [
        { type: 'text', text: 'hello ' },
        { type: 'cache_control', value: '[cache_control 9 bytes]' },
      ],
    }),
    'hello ',
  );
  console.log('PASS openai-chat 响应中的 cache_control 非文本块不会泄漏到最终文本');

  const responsesState = createOpenAIResponsesStreamState();
  let generatedResponsesToolCallIds = 0;
  const generateResponsesToolCallId = () => {
    generatedResponsesToolCallIds += 1;
    return `generated_response_call_${generatedResponsesToolCallIds}`;
  };
  const responsesDelta = applyOpenAIResponsesStreamEvent(
    responsesState,
    'response.output_text.delta',
    {
      delta: 'partial ',
    },
    generateResponsesToolCallId,
  );
  applyOpenAIResponsesStreamEvent(
    responsesState,
    'response.output_item.added',
    {
      output_index: 0,
      item: {
        id: 'item_1',
        type: 'function_call',
        call_id: 'resp_call',
        name: 'lookup',
        arguments: '',
      },
    },
    generateResponsesToolCallId,
  );
  applyOpenAIResponsesStreamEvent(
    responsesState,
    'response.function_call_arguments.delta',
    {
      item_id: 'item_1',
      output_index: 0,
      delta: '{"id":',
    },
    generateResponsesToolCallId,
  );
  applyOpenAIResponsesStreamEvent(
    responsesState,
    'response.function_call_arguments.delta',
    {
      item_id: 'item_1',
      output_index: 0,
      delta: '42}',
    },
    generateResponsesToolCallId,
  );
  applyOpenAIResponsesStreamEvent(
    responsesState,
    'response.function_call_arguments.done',
    {
      item_id: 'item_1',
      output_index: 0,
      arguments: '{"id":42}',
    },
    generateResponsesToolCallId,
  );
  applyOpenAIResponsesStreamEvent(
    responsesState,
    'response.output_item.done',
    {
      item: {
        id: 'item_1',
        type: 'function_call',
        call_id: 'resp_call',
        name: 'lookup',
        arguments: '{"id":42}',
      },
    },
    generateResponsesToolCallId,
  );
  applyOpenAIResponsesStreamEvent(
    responsesState,
    'response.completed',
    {
      response: {
        id: 'resp_1',
        output_text: 'partial done',
        output: [
          {
            id: 'item_1',
            type: 'function_call',
            call_id: 'resp_call',
            name: 'lookup',
            arguments: '{"id":42}',
          },
        ],
        usage: {
          input_tokens: 12,
          output_tokens: 5,
          total_tokens: 17,
        },
      },
    },
    generateResponsesToolCallId,
  );
  const finalizedResponses = finalizeOpenAIResponsesStreamState(responsesState, generateResponsesToolCallId);
  assert.equal(responsesDelta.textDelta, 'partial ');
  assert.equal(finalizedResponses.content, 'partial ');
  assert.equal(generatedResponsesToolCallIds, 0);
  assert.deepEqual(finalizedResponses.toolCalls, [
    {
      id: 'resp_call',
      type: 'function',
      function: {
        name: 'lookup',
        arguments: '{"id":42}',
      },
    },
  ]);
  assert.deepEqual(finalizedResponses.usage, {
    input_tokens: 12,
    output_tokens: 5,
    total_tokens: 17,
  });
  console.log('PASS openai-responses 标准 item_id 参数增量会合并为单个具名工具调用');

  const interleavedResponsesState = createOpenAIResponsesStreamState();
  let generatedInterleavedToolCallIds = 0;
  const generateInterleavedToolCallId = () => {
    generatedInterleavedToolCallIds += 1;
    return `generated_interleaved_call_${generatedInterleavedToolCallIds}`;
  };
  for (const event of [
    {
      eventType: 'response.output_item.added',
      payload: {
        output_index: 0,
        item: {
          id: 'item_a',
          type: 'function_call',
          call_id: 'call_a',
          name: 'read_file',
          arguments: '',
        },
      },
    },
    {
      eventType: 'response.output_item.added',
      payload: {
        output_index: 1,
        item: {
          id: 'item_b',
          type: 'function_call',
          call_id: 'call_b',
          name: 'search',
          arguments: '',
        },
      },
    },
    {
      eventType: 'response.function_call_arguments.delta',
      payload: { item_id: 'item_a', output_index: 0, delta: '{"path":"' },
    },
    {
      eventType: 'response.function_call_arguments.delta',
      payload: { item_id: 'item_b', output_index: 1, delta: '{"query":"' },
    },
    {
      eventType: 'response.function_call_arguments.delta',
      payload: { item_id: 'item_a', output_index: 0, delta: 'README.md"}' },
    },
    {
      eventType: 'response.function_call_arguments.delta',
      payload: { item_id: 'item_b', output_index: 1, delta: 'unknown_tool"}' },
    },
  ] as const) {
    applyOpenAIResponsesStreamEvent(
      interleavedResponsesState,
      event.eventType,
      event.payload,
      generateInterleavedToolCallId,
    );
  }
  const finalizedInterleavedResponses = finalizeOpenAIResponsesStreamState(
    interleavedResponsesState,
    generateInterleavedToolCallId,
  );
  assert.equal(generatedInterleavedToolCallIds, 0);
  assert.deepEqual(finalizedInterleavedResponses.toolCalls, [
    {
      id: 'call_a',
      type: 'function',
      function: {
        name: 'read_file',
        arguments: '{"path":"README.md"}',
      },
    },
    {
      id: 'call_b',
      type: 'function',
      function: {
        name: 'search',
        arguments: '{"query":"unknown_tool"}',
      },
    },
  ]);
  console.log('PASS openai-responses 交错到达的多工具参数增量不会串流或拆分');

  const lateMetadataResponsesState = createOpenAIResponsesStreamState();
  let generatedLateMetadataToolCallIds = 0;
  const generateLateMetadataToolCallId = () => {
    generatedLateMetadataToolCallIds += 1;
    return `generated_late_metadata_call_${generatedLateMetadataToolCallIds}`;
  };
  applyOpenAIResponsesStreamEvent(
    lateMetadataResponsesState,
    'response.function_call_arguments.delta',
    {
      item_id: 'item_late',
      output_index: 2,
      delta: '{"path":',
    },
    generateLateMetadataToolCallId,
  );
  applyOpenAIResponsesStreamEvent(
    lateMetadataResponsesState,
    'response.output_item.added',
    {
      output_index: 2,
      item: {
        id: 'item_late',
        type: 'function_call',
        call_id: 'call_late',
        name: 'open_file',
        arguments: '',
      },
    },
    generateLateMetadataToolCallId,
  );
  applyOpenAIResponsesStreamEvent(
    lateMetadataResponsesState,
    'response.function_call_arguments.delta',
    {
      item_id: 'item_late',
      output_index: 2,
      delta: '"DEV.md"}',
    },
    generateLateMetadataToolCallId,
  );
  applyOpenAIResponsesStreamEvent(
    lateMetadataResponsesState,
    'response.output_item.done',
    {
      output_index: 2,
      item: {
        id: 'item_late',
        type: 'function_call',
        call_id: 'call_late',
        name: 'open_file',
        arguments: '',
      },
    },
    generateLateMetadataToolCallId,
  );
  const finalizedLateMetadataResponses = finalizeOpenAIResponsesStreamState(
    lateMetadataResponsesState,
    generateLateMetadataToolCallId,
  );
  assert.equal(generatedLateMetadataToolCallIds, 0);
  assert.equal(lateMetadataResponsesState.toolCalls.size, 1);
  assert.deepEqual(finalizedLateMetadataResponses.toolCalls, [
    {
      id: 'call_late',
      type: 'function',
      function: {
        name: 'open_file',
        arguments: '{"path":"DEV.md"}',
      },
    },
  ]);
  console.log('PASS openai-responses 工具元数据晚于参数增量到达时仍会合并并采用 call_id');
  console.log('PASS openai-responses 流式事件可正确累积文本与工具调用');

  const anthropicNormalized = toAnthropicMessages(
    [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: '{"path":"/tmp/a"}',
            },
          },
          {
            id: 'call_2',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: '{"path":"/tmp/b"}',
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'A',
      },
      {
        role: 'tool',
        tool_call_id: 'call_2',
        content: 'B',
      },
    ],
    () => 'generated_call',
  );
  assert.equal(anthropicNormalized.messages.length, 2);
  const mergedToolResults = anthropicNormalized.messages[1]?.content;
  assert.ok(Array.isArray(mergedToolResults));
  assert.equal(mergedToolResults.length, 2);
  assert.deepEqual(mergedToolResults[0], {
    type: 'tool_result',
    tool_use_id: 'call_1',
    content: 'A',
  });
  assert.deepEqual(mergedToolResults[1], {
    type: 'tool_result',
    tool_use_id: 'call_2',
    content: 'B',
  });
  console.log('PASS anthropic 会将同一轮连续 tool_result 合并到一个 user 消息');
  const anthropicMergedTurn = toAnthropicMessages(
    [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_3',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: '{"path":"/tmp/c"}',
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_3',
        content: 'C',
      },
      {
        role: 'user',
        content: '继续总结 C',
      },
    ],
    () => 'generated_call',
  );
  assert.equal(anthropicMergedTurn.messages.length, 2);
  const mergedTurnContent = anthropicMergedTurn.messages[1]?.content;
  assert.ok(Array.isArray(mergedTurnContent));
  assert.deepEqual(mergedTurnContent, [
    {
      type: 'tool_result',
      tool_use_id: 'call_3',
      content: 'C',
    },
    {
      type: 'text',
      text: '继续总结 C',
    },
  ]);
  console.log('PASS anthropic 会将同一轮的 tool_result 与后续用户文本合并为单个 user turn');

  const anthropicState = createAnthropicStreamState();
  const anthropicDelta = applyAnthropicStreamEvent(anthropicState, 'content_block_start', {
    index: 0,
    content_block: {
      type: 'text',
      text: 'Hi ',
    },
  });
  applyAnthropicStreamEvent(anthropicState, 'content_block_delta', {
    index: 0,
    delta: {
      type: 'text_delta',
      text: 'there',
    },
  });
  applyAnthropicStreamEvent(anthropicState, 'content_block_start', {
    index: 1,
    content_block: {
      type: 'tool_use',
      id: 'toolu_1',
      name: 'run',
    },
  });
  applyAnthropicStreamEvent(anthropicState, 'content_block_delta', {
    index: 1,
    delta: {
      type: 'input_json_delta',
      partial_json: '{"cmd":"npm test"}',
    },
  });
  applyAnthropicStreamEvent(anthropicState, 'message_delta', {
    usage: {
      input_tokens: 9,
      output_tokens: 3,
    },
    delta: {
      type: 'message_delta',
      stop_reason: 'end_turn',
    },
  });
  const finalizedAnthropic = finalizeAnthropicStreamState(anthropicState, () => 'tool_generated');
  assert.equal(anthropicDelta.textDelta, 'Hi ');
  assert.equal(finalizedAnthropic.content, 'Hi there');
  assert.deepEqual(finalizedAnthropic.toolCalls, [
    {
      id: 'toolu_1',
      type: 'function',
      function: {
        name: 'run',
        arguments: '{"cmd":"npm test"}',
      },
    },
  ]);
  assert.deepEqual(finalizedAnthropic.usage, {
    input_tokens: 9,
    output_tokens: 3,
  });
  console.log('PASS anthropic 流式事件可正确累积文本与工具调用');

  const anthropicUsageState = createAnthropicStreamState();
  applyAnthropicStreamEvent(anthropicUsageState, 'message_start', {
    message: {
      id: 'msg_usage_1',
      role: 'assistant',
      usage: {
        input_tokens: 350,
        cache_creation_input_tokens: 24,
        cache_read_input_tokens: 23296,
      },
    },
  });
  applyAnthropicStreamEvent(anthropicUsageState, 'message_delta', {
    usage: {
      output_tokens: 75,
    },
    delta: {
      type: 'message_delta',
      stop_reason: 'end_turn',
    },
  });
  const finalizedAnthropicUsage = finalizeAnthropicStreamState(anthropicUsageState, () => 'tool_generated');
  assert.deepEqual(finalizedAnthropicUsage.usage, {
    input_tokens: 350,
    cache_creation_input_tokens: 24,
    cache_read_input_tokens: 23296,
    output_tokens: 75,
  });
  console.log('PASS anthropic 流式 usage 会合并输入、缓存输入与输出统计');

  const anthropicServerToolState = createAnthropicStreamState();
  applyAnthropicStreamEvent(anthropicServerToolState, 'content_block_start', {
    index: 0,
    content_block: {
      type: 'server_tool_use',
      id: 'srvtool_1',
      name: 'str_replace_editor',
    },
  });
  applyAnthropicStreamEvent(anthropicServerToolState, 'content_block_delta', {
    index: 0,
    delta: {
      type: 'input_json_delta',
      partial_json: '{"command":"view","path":"README.md"}',
    },
  });
  const finalizedAnthropicServerTool = finalizeAnthropicStreamState(anthropicServerToolState, () => 'tool_generated');
  assert.equal(finalizedAnthropicServerTool.content, '');
  assert.deepEqual(finalizedAnthropicServerTool.toolCalls, [
    {
      id: 'srvtool_1',
      type: 'function',
      function: {
        name: 'str_replace_editor',
        arguments: '{"command":"view","path":"README.md"}',
      },
    },
  ]);
  console.log('PASS anthropic 流式事件可兼容 server_tool_use 工具块');

  const anthropicCompatState = createAnthropicStreamState();
  applyAnthropicStreamEvent(anthropicCompatState, 'content_block_start', {
    index: 0,
    content_block: {
      type: 'text',
      text: '',
    },
  });
  const compatDeltaWithoutType = applyAnthropicStreamEvent(anthropicCompatState, 'content_block_delta', {
    index: 0,
    delta: {
      text: 'compat ',
    },
  });
  applyAnthropicStreamEvent(anthropicCompatState, 'content_block_delta', {
    index: 0,
    delta: {
      type: 'unsupported_delta_type',
      text: 'text',
    },
  });
  const finalizedAnthropicCompat = finalizeAnthropicStreamState(anthropicCompatState, () => 'tool_generated');
  assert.equal(compatDeltaWithoutType.textDelta, 'compat ');
  assert.equal(finalizedAnthropicCompat.content, 'compat text');
  assert.deepEqual(finalizedAnthropicCompat.toolCalls, []);
  console.log('PASS anthropic 流式文本兼容无 type/非标准 delta.type 事件');

  const parsedAnthropicServerTool = protocolsModule.parseAnthropicResponse(
    {
      id: 'msg_server_tool',
      role: 'assistant',
      content: [
        {
          type: 'server_tool_use',
          id: 'srvtool_2',
          name: 'web_fetch',
          input: {
            url: 'https://example.test',
          },
        },
      ],
    },
    () => 'tool_generated',
  );
  assert.deepEqual(parsedAnthropicServerTool, {
    content: '',
    toolCalls: [
      {
        id: 'srvtool_2',
        type: 'function',
        function: {
          name: 'web_fetch',
          arguments: '{"url":"https://example.test"}',
        },
      },
    ],
  });
  console.log('PASS anthropic 非流式响应可兼容 server_tool_use 工具块');
}

function runTokenUsageNormalizationTests(tokenUsageModule: TokenUsageModule): void {
  const { normalizeTokenUsage, readAttachedTokenUsage, attachTokenUsage } = tokenUsageModule;

  const openAIChatUsage = normalizeTokenUsage(
    'openai-chat',
    {
      prompt_tokens: 1014,
      completion_tokens: 140,
      total_tokens: 1154,
    },
    200000,
  );
  assert.deepEqual(openAIChatUsage, {
    promptTokens: 1014,
    completionTokens: 140,
    totalTokens: 1154,
    outputBuffer: 200000,
  });
  console.log('PASS openai-chat usage 正常映射');

  const openAIResponsesUsage = normalizeTokenUsage(
    'openai-responses',
    {
      input_tokens: 1147,
      output_tokens: 104,
      total_tokens: 1251,
    },
    65500,
  );
  assert.deepEqual(openAIResponsesUsage, {
    promptTokens: 1147,
    completionTokens: 104,
    totalTokens: 1251,
    outputBuffer: 65500,
  });
  console.log('PASS openai-responses usage 正常映射');

  const anthropicUsage = normalizeTokenUsage(
    'anthropic',
    {
      input_tokens: 321,
      output_tokens: 79,
    },
    8192,
  );
  assert.deepEqual(anthropicUsage, {
    promptTokens: 321,
    completionTokens: 79,
    totalTokens: 400,
    outputBuffer: 8192,
  });
  console.log('PASS anthropic usage 正常映射');

  const anthropicCompatUsage = normalizeTokenUsage(
    'anthropic',
    {
      input_tokens: 350,
      cache_read_input_tokens: 23296,
      completion_tokens: 525,
      prompt_tokens: 331,
      total_tokens: 856,
    },
    30000,
  );
  assert.deepEqual(anthropicCompatUsage, {
    promptTokens: 331,
    completionTokens: 525,
    totalTokens: 856,
    outputBuffer: 30000,
  });
  console.log('PASS anthropic 兼容接口会优先使用 prompt/completion/total 统计');

  const anthropicCachedUsage = normalizeTokenUsage('anthropic', {
    input_tokens: 350,
    cache_creation_input_tokens: 24,
    cache_read_input_tokens: 23296,
    output_tokens: 75,
  });
  assert.deepEqual(anthropicCachedUsage, {
    promptTokens: 23670,
    completionTokens: 75,
    totalTokens: 23745,
    outputBuffer: undefined,
  });
  console.log('PASS anthropic 缺失 prompt_tokens 时会把 cache 输入计入上下文占用');

  const correctedUsage = normalizeTokenUsage('openai-chat', {
    prompt_tokens: 1000,
    completion_tokens: 100,
    total_tokens: 1300,
  });
  assert.deepEqual(correctedUsage, {
    promptTokens: 1000,
    completionTokens: 300,
    totalTokens: 1300,
    outputBuffer: undefined,
  });
  console.log('PASS totalTokens 与 prompt+completion 不一致时按 totalTokens 纠偏');

  const fallbackUsage = normalizeTokenUsage('openai-responses', {
    input_tokens: 900,
    output_tokens: 120,
  });
  assert.deepEqual(fallbackUsage, {
    promptTokens: 900,
    completionTokens: 120,
    totalTokens: 1020,
    outputBuffer: undefined,
  });
  console.log('PASS 缺失 totalTokens 时回退到 prompt+completion');

  const attachedRecord: Record<string, unknown> = {};
  attachTokenUsage(attachedRecord, correctedUsage);
  assert.deepEqual(readAttachedTokenUsage(attachedRecord), correctedUsage);
  console.log('PASS 响应对象可读回归一化 usage');
}

function runContextUsageStateTests(contextUsageStateModule: ContextUsageStateModule): void {
  const { ContextUsageState, buildContextStatusText, buildContextStatusTooltip } = contextUsageStateModule;

  const state = new ContextUsageState();
  assert.equal(buildContextStatusText(undefined), 'CodingPlans\u00A0Context\u00A0--');
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
    outputBuffer: 1,
  });

  const snapshot = state.getSnapshot();
  assert.ok(snapshot);
  assert.equal(buildContextStatusText(snapshot), 'CodingPlans\u00A0Context\u00A017%');
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
    outputBuffer: 60000,
  };
  assert.equal(buildContextStatusText(reservedSnapshot), 'CodingPlans\u00A0Context\u00A048%');
  const reservedTooltip = buildContextStatusTooltip(reservedSnapshot);
  assert.match(reservedTooltip, /47\.5% of 128K/);
  assert.match(reservedTooltip, /- Occupied Context: 60\.9K/);
  assert.match(tooltip, /- Model: model/);
  assert.match(tooltip, /- Updated: 2026-03-20T08:52:11\.000Z/);
  state.dispose();
  console.log('PASS ContextUsageState 与状态栏文案正常生成');
}

function runPlanUsageStatusTests(
  planUsageStatusModule: PlanUsageStatusModule,
  contextUsageStateModule: ContextUsageStateModule,
): void {
  const {
    CodingPlanStatusBarController,
    PlanUsageState,
    buildCodingPlanDetailsHtml,
    buildCodingPlanStatusText,
    buildCodingPlanStatusTooltip,
    buildPlanUsageStatusText,
    buildPlanUsageStatusTooltip,
    parseVendorPlanUsageSnapshot,
  } = planUsageStatusModule;
  const { ContextUsageState } = contextUsageStateModule;
  const vscodeMock = require('vscode') as { testState: { createdStatusBarItems: Array<Record<string, unknown>> } };

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
            nextResetTime: Date.UTC(2026, 2, 30, 10, 0, 0),
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
              { modelCode: 'web-reader', usage: 395 },
            ],
          },
        ],
      },
    },
    Date.UTC(2026, 2, 30, 8, 0, 0),
  );

  assert.ok(snapshot, '智谱 usage 响应应可被解析');
  assert.equal(snapshot?.vendor, 'zhipu');
  assert.equal(snapshot?.productName, 'GLM Coding Max');
  assert.deepEqual(
    snapshot?.limits.map((limit) => ({
      label: limit.label,
      percentage: limit.percentage,
      used: limit.used,
      limit: limit.limit,
    })),
    [
      {
        label: '5h',
        percentage: 15,
        used: 127694464,
        limit: 800000000,
      },
      {
        label: 'MCP',
        percentage: 45,
        used: 1828,
        limit: 4000,
      },
    ],
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
    outputBuffer: 1,
  };
  assert.equal(buildCodingPlanStatusText(contextSnapshot, snapshot), 'CodingPlans 5h 15% | MCP 45% | Ctx 17%');
  const mergedTooltip = buildCodingPlanStatusTooltip(contextSnapshot, snapshot);
  assert.match(mergedTooltip, /\*\*Plan Usage\*\*/);
  assert.match(mergedTooltip, /\*\*Context\*\*/);
  assert.match(mergedTooltip, /- 5h: 15% \(127\.7M \/ 800M\)/);
  assert.match(mergedTooltip, /- MCP: 45% \(1828 \/ 4000\)/);
  assert.match(mergedTooltip, /- Context: 16\.6% of 131\.1K/);
  assert.match(mergedTooltip, /- Prompt: 21\.8K/);
  assert.match(mergedTooltip, /- Model: glm-4\.7/);
  assert.doesNotMatch(mergedTooltip, /Click the status bar item to keep these details open/);
  assert.doesNotMatch(mergedTooltip, /Source:/);
  assert.doesNotMatch(mergedTooltip, /open\.bigmodel\.cn\/api\/monitor\/usage\/quota\/limit/);

  const detailsHtml = buildCodingPlanDetailsHtml(contextSnapshot, snapshot);
  assert.match(detailsHtml, /Usage details snapshot/);
  assert.match(detailsHtml, /<h2>Plan Usage<\/h2>/);
  assert.match(detailsHtml, /<h2>Context<\/h2>/);
  assert.match(detailsHtml, /GLM Coding Max/);
  assert.match(detailsHtml, /glm-4\.7/);
  assert.match(
    detailsHtml,
    /background-color: var\(--vscode-editorHoverWidget-background, var\(--vscode-editor-background\)\);/,
  );
  assert.doesNotMatch(detailsHtml, /color-mix\(/);
  assert.doesNotMatch(detailsHtml, /Source:/);
  assert.doesNotMatch(detailsHtml, /open\.bigmodel\.cn\/api\/monitor\/usage\/quota\/limit/);
  console.log('PASS 智谱 usage 响应与状态栏文案可正确解析');

  const controllerContextUsageState = new ContextUsageState();
  const controllerPlanUsageState = new PlanUsageState();
  vscodeMock.testState.createdStatusBarItems.length = 0;
  const controller = new CodingPlanStatusBarController(controllerContextUsageState, controllerPlanUsageState);
  const statusBarItem = vscodeMock.testState.createdStatusBarItems.at(-1);
  assert.ok(statusBarItem, '应创建 CodingPlans 状态栏项');
  assert.equal(statusBarItem?.name, 'CodingPlans');
  assert.equal(statusBarItem?.command, undefined);
  assert.doesNotMatch(readMarkdownStringValue(statusBarItem?.tooltip), /Click the status bar item/);
  controller.dispose();
  controllerPlanUsageState.dispose();
  controllerContextUsageState.dispose();
  console.log('PASS CodingPlans 状态栏仅保留 hover，不再绑定点击命令');
}

async function runCommitMessageGeneratorTests(
  commitMessageGeneratorModule: CommitMessageGeneratorModule,
): Promise<void> {
  const { commitMessageTestUtils, registerCommitMessageModelSource, selectCommitMessageModel } =
    commitMessageGeneratorModule;
  const vscodeMock = require('vscode') as {
    testState: {
      shownInformationMessages: Array<{ message: string; items: unknown[] }>;
      shownQuickPicks: Array<{ items: unknown[]; options: unknown }>;
      enqueueQuickPickSelection(selection: unknown): void;
    };
  };

  registerCommitMessageModelSource(undefined);

  const normalizedMessage = commitMessageTestUtils.sanitizeGeneratedCommitMessage(
    [
      '```',
      'fix(bridge):移除手动认证配置需求并完善本地桥接架构',
      '- 删除旧版认证配置说明',
      '- 新增 bridge 命令行工具',
      '```',
    ].join('\n'),
  );
  assert.equal(
    normalizedMessage,
    [
      'fix(bridge): 移除手动认证配置需求并完善本地桥接架构',
      '',
      '- 删除旧版认证配置说明',
      '- 新增 bridge 命令行工具',
    ].join('\n'),
  );
  console.log('PASS commit message 题头会自动补齐 Conventional Commits 冒号后的空格');

  const prompt = commitMessageTestUtils.buildDiffGenerationPrompt(
    'diff --git a/src/bridge.ts b/src/bridge.ts',
    'zh-cn',
    {
      pipelineMode: 'single',
      maxDiffLines: 3000,
      summaryTriggerLines: 1200,
      summaryChunkLines: 800,
      summaryMaxChunks: 12,
      maxBodyBulletCount: 7,
      subjectMaxLength: 72,
      requireConventionalType: true,
      warnOnValidationFailure: true,
      llmMaxPromptLength: 20000,
    },
    false,
  );
  assert.match(
    prompt,
    /Prefer no body or 1 bullet for narrow changes such as deleting, renaming, or moving a single file\./,
  );
  assert.match(
    prompt,
    /Prefer 2 or 3 bullet points only when the diff clearly contains multiple meaningful change groups\./,
  );
  assert.match(
    prompt,
    /Each bullet should group related edits by intent or outcome, not narrate the diff file-by-file\./,
  );
  assert.match(
    prompt,
    /Avoid repetitive file-by-file bullets\. Verb-led bullets are acceptable when they stay concise and strictly reflect the diff\./,
  );
  assert.match(
    prompt,
    /For narrow changes such as deleting or renaming a single file, the body may be omitted entirely\./,
  );
  assert.match(
    prompt,
    /Never invent motivations, architecture changes, or side effects that are not directly supported by the diff\./,
  );
  console.log('PASS commit message prompt 会明确要求聚合式高信号摘要');

  const recentStyleBlock = commitMessageTestUtils.buildStyleReferenceBlock([
    [
      'build(vsix): 优化 .vscodeignore 策略为白名单模式',
      '',
      '- 将 .vscodeignore 改为默认忽略所有文件并仅包含特定白名单文件。',
      '- 更新打包测试逻辑，通过显式列表验证 VSIX 内容并增加金丝雀测试。',
    ].join('\n'),
    ['chore: update provider pricing'].join('\n'),
  ]);
  assert.ok(recentStyleBlock);
  assert.match(recentStyleBlock, /The first line should look like it belongs next to these samples\./);
  assert.match(recentStyleBlock, /If the samples use Conventional Commits, keep the same type\/scope style\./);
  assert.match(recentStyleBlock, /Use these samples for style only, not as evidence of what changed now\./);
  assert.match(
    recentStyleBlock,
    /Do not copy exact change details, identifiers, tickets, scopes, topics, files, dependencies, providers, metrics, or workflows/,
  );

  const stylePrompt = commitMessageTestUtils.buildDiffGenerationPrompt(
    'diff --git a/src/bridge.ts b/src/bridge.ts',
    'zh-cn',
    {
      pipelineMode: 'single',
      maxDiffLines: 3000,
      summaryTriggerLines: 1200,
      summaryChunkLines: 800,
      summaryMaxChunks: 12,
      maxBodyBulletCount: 7,
      subjectMaxLength: 72,
      requireConventionalType: true,
      warnOnValidationFailure: true,
      llmMaxPromptLength: 20000,
    },
    false,
    recentStyleBlock,
  );
  const styleIndex = stylePrompt.indexOf('STYLE REQUIREMENT');
  const fallbackFormatIndex = stylePrompt.indexOf('FALLBACK FORMAT REQUIREMENT');
  assert.ok(styleIndex >= 0);
  assert.ok(fallbackFormatIndex > styleIndex);
  assert.match(stylePrompt, /Use the fallback format rules only for details that the recent samples do not decide\./);
  assert.match(
    stylePrompt,
    /If STYLE conflicts with body length, bullet, or subject format details below, follow STYLE\./,
  );
  assert.match(stylePrompt, /CURRENT DIFF \(ONLY CHANGE EVIDENCE\):/);
  assert.match(
    stylePrompt,
    /Generate the commit message from this diff only\. Use recent commit messages only for writing style\./,
  );
  assert.match(stylePrompt, /Any topic, file, or action absent from this diff must be excluded from the output\./);
  assert.match(
    stylePrompt,
    /Recent commit messages are style references only; they are not evidence for the current change\./,
  );
  console.log('PASS commit message recent style 提示词会优先约束格式与正文风格');

  const noBodyIssues = commitMessageTestUtils.validateCommitMessage(
    'chore: 删除已完成说明文件',
    'zh-cn',
    {
      pipelineMode: 'single',
      maxDiffLines: 3000,
      summaryTriggerLines: 1200,
      summaryChunkLines: 800,
      summaryMaxChunks: 12,
      maxBodyBulletCount: 7,
      subjectMaxLength: 72,
      requireConventionalType: true,
      warnOnValidationFailure: true,
      llmMaxPromptLength: 20000,
    },
    false,
  );
  assert.deepEqual(noBodyIssues, []);
  console.log('PASS commit message 校验允许窄变更仅输出题头');

  vscodeMock.testState.shownInformationMessages.length = 0;
  vscodeMock.testState.shownQuickPicks.length = 0;
  const previousUpdateCount = activeState.updates.length;
  vscodeMock.testState.enqueueQuickPickSelection('cliproxyapi');
  vscodeMock.testState.enqueueQuickPickSelection('gpt-5.4');
  registerCommitMessageModelSource({
    getAvailableModels() {
      return [
        {
          vendor: 'coding-plans',
          family: 'cliproxyapi',
          name: 'gpt-5.4',
          id: 'cliproxyapi/gpt-5.4',
          version: 'cliproxyapi',
          maxInputTokens: 200000,
          maxOutputTokens: 30000,
          async sendRequest(): Promise<never> {
            throw new Error('not used in test');
          },
          async countTokens(): Promise<number> {
            return 0;
          },
        },
        {
          vendor: 'coding-plans',
          family: 'deepseek',
          name: 'deepseek-v4-pro',
          id: 'deepseek/deepseek-v4-pro',
          version: 'deepseek',
          maxInputTokens: 1000000,
          maxOutputTokens: 30000,
          async sendRequest(): Promise<never> {
            throw new Error('not used in test');
          },
          async countTokens(): Promise<number> {
            return 0;
          },
        },
      ];
    },
  });
  await selectCommitMessageModel();
  assert.deepEqual(
    activeState.updates.slice(previousUpdateCount).map((update) => ({ key: update.key, value: update.value })),
    [
      { key: 'commitMessage.modelVendor', value: 'cliproxyapi' },
      { key: 'commitMessage.modelId', value: 'gpt-5.4' },
    ],
  );
  console.log('PASS commit message 模型选择可直接使用扩展内部模型源，不依赖 unscoped provider 枚举');
  registerCommitMessageModelSource(undefined);
}

async function runLMChatProviderAdapterProvideTokenCountTests(
  contextUsageStateModule: ContextUsageStateModule,
  lmChatProviderAdapterModule: LMChatProviderAdapterModule,
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
    getModel(): { countTokens(text: string | { content: unknown[] }): Promise<number> } {
      return {
        async countTokens(text: string | { content: unknown[] }): Promise<number> {
          const raw =
            typeof text === 'string'
              ? text
              : Array.isArray(text.content)
                ? text.content
                    .map((part) =>
                      part && typeof part === 'object' && 'value' in (part as Record<string, unknown>)
                        ? String((part as { value?: unknown }).value ?? '')
                        : '',
                    )
                    .join('')
                : '';
          return Math.max(1, Math.ceil(raw.length / 4));
        },
      };
    },
    onDidChangeModels(): { dispose(): void } {
      return new vscode.Disposable();
    },
  };

  const usageState = new ContextUsageState();
  const adapter = new LMChatProviderAdapter(fakeProvider as never, undefined, usageState);
  const model = {
    id: 'vendor/model',
    name: 'model',
  } as never;
  const otherModel = {
    id: 'vendor/other',
    name: 'other',
  } as never;

  assert.equal(await adapter.provideTokenCount(model, 'hello', {} as never), 2);
  assert.equal(await adapter.provideTokenCount(otherModel, 'hello', {} as never), 2);

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
    outputBuffer: 10,
  });

  assert.equal(await adapter.provideTokenCount(model, 'hello', {} as never), 2);
  assert.equal(await adapter.provideTokenCount(model, 'hello', {} as never), 2);
  assert.equal(await adapter.provideTokenCount(otherModel, 'hello', {} as never), 2);

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
    outputBuffer: 12,
  });

  assert.equal(await adapter.provideTokenCount(model, 'hello', {} as never), 2);
  assert.equal(await adapter.provideTokenCount(model, 'hello', {} as never), 2);
  assert.equal(await adapter.provideTokenCount(otherModel, 'hello', {} as never), 2);
  adapter.dispose();
  usageState.dispose();
  console.log('PASS LMChatProviderAdapter 会做本地近似 token 估算，不复用上一轮上下文占用');
}

async function runLMChatProviderAdapterEmptyResponseRetryTests(
  lmChatProviderAdapterModule: LMChatProviderAdapterModule,
): Promise<void> {
  const vscode = require('vscode') as {
    Disposable: new (callback?: () => void) => { dispose(): void };
    LanguageModelError: new (message: string) => Error & { code?: string };
    LanguageModelTextPart: new (value: string) => { value: string };
  };
  const { LMChatProviderAdapter } = lmChatProviderAdapterModule;

  let sendCount = 0;
  const targetModel = {
    id: 'vendor/model',
    name: 'model',
    maxTokens: 32000,
    sendRequest: async () => {
      sendCount += 1;
      if (sendCount === 1) {
        return {
          stream: (async function* () {
            const error = new vscode.LanguageModelError('Request failed: Upstream model returned an empty response.');
            error.code = 'coding-plans.empty-model-response';
            throw error;
          })(),
          text: (async function* () {})(),
        };
      }

      return {
        stream: (async function* () {
          yield new vscode.LanguageModelTextPart('retry succeeded');
        })(),
        text: (async function* () {
          yield 'retry succeeded';
        })(),
      };
    },
  };

  const fakeProvider = {
    getVendor(): string {
      return 'coding-plans';
    },
    getModel(modelId: string): typeof targetModel | undefined {
      return modelId === targetModel.id ? targetModel : undefined;
    },
    onDidChangeModels(): { dispose(): void } {
      return new vscode.Disposable();
    },
  };

  const adapter = new LMChatProviderAdapter(fakeProvider as never);
  const reportedParts: Array<{ value?: string }> = [];
  const progress = {
    report(part: { value?: string }): void {
      reportedParts.push(part);
    },
  };
  const model = {
    id: targetModel.id,
    name: targetModel.name,
  } as never;
  const messages = [
    {
      role: 1,
      content: [new vscode.LanguageModelTextPart('hello')],
    },
  ] as never;
  const token = {
    isCancellationRequested: false,
    onCancellationRequested(): { dispose(): void } {
      return new vscode.Disposable();
    },
  } as never;

  await adapter.provideLanguageModelChatResponse(model, messages, {} as never, progress as never, token);

  assert.equal(sendCount, 2);
  assert.deepEqual(
    reportedParts.map((part) => part.value),
    ['retry succeeded'],
  );
  adapter.dispose();
  console.log('PASS LMChatProviderAdapter 会在空响应且尚未输出内容时自动重试');
}

async function runManageVendorConfigurationTests(
  configStoreCtor: ConfigStoreCtor,
  extensionModule: ExtensionModule,
): Promise<void> {
  const vscodeMock = require('vscode') as {
    testState: {
      shownInformationMessages: Array<{ message: string; items: unknown[] }>;
      shownQuickPicks: Array<{ items: unknown[]; options: unknown }>;
      executedCommands: Array<{ command: string; args: unknown[] }>;
      enqueueQuickPickSelection(selection: unknown): void;
      enqueueInputBoxValue(value: string | undefined): void;
      clearQueuedInputs(): void;
    };
  };

  activeState = createState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/v1',
      defaultApiStyle: 'openai-chat',
      useModelsEndpoint: false,
      models: [],
    },
  ]);
  const secretContext = createExtensionContextWithSecrets();
  const configStore = new configStoreCtor(secretContext.context as never);
  let refreshCount = 0;
  let notifyCount = 0;
  const fakeProvider = {
    async refreshModels(options?: { forceDiscoveryRetry?: boolean; discoverFromEndpoint?: boolean }): Promise<void> {
      assert.equal(options?.forceDiscoveryRetry, true);
      assert.equal(options?.discoverFromEndpoint, true);
      refreshCount += 1;
    },
    getAvailableModels(): unknown[] {
      return [];
    },
  };
  const fakeAdapter = {
    notifyLanguageModelInformationChanged(): void {
      notifyCount += 1;
    },
  };

  vscodeMock.testState.shownInformationMessages.length = 0;
  vscodeMock.testState.shownQuickPicks.length = 0;
  vscodeMock.testState.executedCommands.length = 0;
  vscodeMock.testState.clearQueuedInputs();
  vscodeMock.testState.enqueueQuickPickSelection('Vendor');
  vscodeMock.testState.enqueueQuickPickSelection({ label: '设置 API Key', action: 'apiKey' });
  vscodeMock.testState.enqueueInputBoxValue('secret-key');

  try {
    await extensionModule.manageVendorConfiguration(configStore, fakeProvider as never, fakeAdapter as never);
    assert.equal(secretContext.secrets.get('coding-plans.vendor.apiKey.Vendor'), 'secret-key');
    assert.equal(refreshCount, 1);
    assert.equal(notifyCount, 1);
    assert.equal(vscodeMock.testState.shownQuickPicks.length, 2);
    assert.equal(vscodeMock.testState.shownInformationMessages[0]?.message, 'apiKeySaved');
    console.log('PASS 管理向导会从 vendors 动态选择供应商并保存对应 API Key 后刷新模型');
  } finally {
    configStore.dispose();
  }
}

async function runLMChatProviderAdapterModelFilteringTests(
  configStoreCtor: ConfigStoreCtor,
  lmChatProviderAdapterModule: LMChatProviderAdapterModule,
): Promise<void> {
  const vscode = require('vscode') as {
    Disposable: new (callback?: () => void) => { dispose(): void };
  };
  const { LMChatProviderAdapter } = lmChatProviderAdapterModule;
  activeState = createState([
    {
      name: 'Vendor',
      baseUrl: 'https://example.test/v1',
      defaultApiStyle: 'openai-chat',
      models: [],
    },
    {
      name: 'Other',
      baseUrl: 'https://other.example.test/v1',
      defaultApiStyle: 'openai-chat',
      models: [],
    },
    {
      name: 'Anthropic',
      baseUrl: 'https://anthropic.example.test/v1',
      defaultApiStyle: 'anthropic',
      models: [],
    },
  ]);
  const secretContext = createExtensionContextWithSecrets();
  secretContext.secrets.set('coding-plans.vendor.apiKey.Vendor', 'configured');
  secretContext.secrets.set('coding-plans.vendor.apiKey.Anthropic', 'configured');
  const configStore = new configStoreCtor(secretContext.context as never);
  const models = [
    {
      id: 'Vendor/coder',
      name: 'coder',
      family: 'Vendor',
      apiStyle: 'openai-chat',
      description: 'Vendor coder',
      version: 'Vendor',
      maxInputTokens: 32000,
      maxOutputTokens: 16000,
      capabilities: { toolCalling: true, imageInput: false },
      inputCost: 4,
      cacheCost: 1,
      outputCost: 12,
      longContextInputCost: 6,
      longContextCacheCost: 2,
      longContextOutputCost: 18,
    },
    {
      id: 'Other/coder',
      name: 'coder',
      family: 'Other',
      apiStyle: 'openai-responses',
      description: 'Other coder',
      version: 'Other',
      maxInputTokens: 32000,
      maxOutputTokens: 16000,
      capabilities: { toolCalling: true, imageInput: false },
    },
    {
      id: 'Anthropic/coder',
      name: 'coder',
      family: 'Anthropic',
      apiStyle: 'anthropic',
      description: 'Anthropic coder',
      version: 'Anthropic',
      maxInputTokens: 32000,
      maxOutputTokens: 16000,
      capabilities: { toolCalling: true, imageInput: false },
    },
  ];
  let availableModels = models;
  let refreshCount = 0;
  const fakeProvider = {
    getVendor(): string {
      return 'coding-plans';
    },
    getApiKey(): string {
      return '';
    },
    getAvailableModels(): typeof models {
      return availableModels;
    },
    async refreshModels(): Promise<void> {
      refreshCount += 1;
    },
    isModelDiscoveryUnsupported(): boolean {
      return false;
    },
    onDidChangeModels(): { dispose(): void } {
      return new vscode.Disposable();
    },
  };

  const adapter = new LMChatProviderAdapter(fakeProvider as never, configStore);
  try {
    const unscopedModels = await adapter.provideLanguageModelChatInformation({ silent: false } as never, {} as never);
    assert.deepEqual(unscopedModels, []);

    const defaultRootModels = await adapter.provideLanguageModelChatInformation(
      {
        silent: true,
        group: 'Coding Plans',
      } as never,
      {} as never,
    );
    assert.deepEqual(defaultRootModels, []);

    const unresolvedGroupModels = await adapter.provideLanguageModelChatInformation(
      {
        silent: true,
        group: 'Group',
      } as never,
      {} as never,
    );
    assert.deepEqual(unresolvedGroupModels, []);

    const vendorGroupModels = await adapter.provideLanguageModelChatInformation(
      {
        silent: true,
        group: 'Vendor',
      } as never,
      {} as never,
    );
    assert.deepEqual(
      vendorGroupModels.map((model) => model.id),
      ['Vendor/coder'],
    );
    assert.equal((vendorGroupModels[0]?.capabilities as unknown as { agentMode?: boolean })?.agentMode, undefined);
    assert.equal('thinking' in ((vendorGroupModels[0] ?? {}) as unknown as Record<string, unknown>), false);
    assert.equal(
      (
        vendorGroupModels[0] as unknown as {
          configurationSchema?: {
            properties?: Record<
              string,
              {
                type?: string;
                default?: unknown;
                group?: string;
                enum?: unknown[];
              }
            >;
          };
        }
      ).configurationSchema
        ? Object.prototype.hasOwnProperty.call(
            (vendorGroupModels[0] as unknown as { configurationSchema?: Record<string, unknown> }).configurationSchema,
            'type',
          )
        : false,
      false,
    );
    assert.equal(
      (
        vendorGroupModels[0] as unknown as {
          configurationSchema?: {
            properties?: Record<
              string,
              {
                type?: string;
                default?: unknown;
                group?: string;
                enum?: unknown[];
              }
            >;
          };
        }
      ).configurationSchema?.properties?.thinkingEffort?.type,
      'string',
    );
    assert.deepEqual(
      (
        vendorGroupModels[0] as unknown as {
          configurationSchema?: {
            properties?: Record<
              string,
              {
                enum?: unknown[];
              }
            >;
          };
        }
      ).configurationSchema?.properties?.thinkingEffort?.enum,
      ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    );
    assert.equal(
      (
        vendorGroupModels[0] as unknown as {
          configurationSchema?: {
            properties?: Record<
              string,
              {
                default?: unknown;
                group?: string;
              }
            >;
          };
        }
      ).configurationSchema?.properties?.thinkingEffort?.default,
      'high',
    );
    assert.equal(
      (
        vendorGroupModels[0] as unknown as {
          configurationSchema?: {
            properties?: Record<
              string,
              {
                group?: string;
              }
            >;
          };
        }
      ).configurationSchema?.properties?.thinkingEffort?.group,
      'navigation',
    );
    assert.deepEqual(
      Object.keys(
        (
          vendorGroupModels[0] as unknown as {
            configurationSchema?: {
              properties?: Record<string, unknown>;
            };
          }
        ).configurationSchema?.properties ?? {},
      ),
      ['thinkingEffort', 'thinkingType', 'temperature'],
    );
    assert.deepEqual(
      (
        vendorGroupModels[0] as unknown as {
          configurationSchema?: {
            properties?: Record<
              string,
              {
                enum?: unknown[];
              }
            >;
          };
        }
      ).configurationSchema?.properties?.thinkingType?.enum,
      ['enabled', 'disabled', 'default'],
    );
    assert.equal(
      (
        vendorGroupModels[0] as unknown as {
          configurationSchema?: {
            properties?: Record<
              string,
              {
                title?: unknown;
              }
            >;
          };
        }
      ).configurationSchema?.properties?.thinkingType?.title,
      'Thinking Type',
    );
    assert.equal(
      (
        vendorGroupModels[0] as unknown as {
          configurationSchema?: {
            properties?: Record<
              string,
              {
                default?: unknown;
              }
            >;
          };
        }
      ).configurationSchema?.properties?.thinkingType?.default,
      'default',
    );
    assert.equal(
      (
        vendorGroupModels[0] as unknown as {
          configurationSchema?: {
            properties?: Record<string, unknown>;
          };
        }
      ).configurationSchema?.properties?.thinking,
      undefined,
    );
    assert.equal(
      (
        vendorGroupModels[0] as unknown as {
          configurationSchema?: {
            properties?: Record<
              string,
              {
                type?: string;
                default?: unknown;
              }
            >;
          };
        }
      ).configurationSchema?.properties?.temperature?.type,
      'string',
    );
    assert.deepEqual(
      (
        vendorGroupModels[0] as unknown as {
          configurationSchema?: {
            properties?: Record<
              string,
              {
                enum?: unknown[];
              }
            >;
          };
        }
      ).configurationSchema?.properties?.temperature?.enum,
      ['inherit', 'none', '0.1', '0.4', '0.7', '1'],
    );
    assert.equal(
      (
        vendorGroupModels[0] as unknown as {
          configurationSchema?: {
            properties?: Record<
              string,
              {
                default?: unknown;
              }
            >;
          };
        }
      ).configurationSchema?.properties?.temperature?.default,
      'none',
    );
    assert.equal((vendorGroupModels[0] as unknown as { inputCost?: number }).inputCost, 4);
    assert.equal((vendorGroupModels[0] as unknown as { cacheCost?: number }).cacheCost, 1);
    assert.equal((vendorGroupModels[0] as unknown as { outputCost?: number }).outputCost, 12);
    assert.equal((vendorGroupModels[0] as unknown as { longContextInputCost?: number }).longContextInputCost, 6);
    assert.equal((vendorGroupModels[0] as unknown as { longContextCacheCost?: number }).longContextCacheCost, 2);
    assert.equal((vendorGroupModels[0] as unknown as { longContextOutputCost?: number }).longContextOutputCost, 18);

    availableModels = [
      {
        ...models[0],
        id: 'Vendor/limited',
        name: 'limited',
        apiType: 'responses',
        editTools: ['apply-patch'],
        supportsReasoningEffort: ['high', 'xhigh'],
        reasoningEffortFormat: 'responses',
        zeroDataRetentionEnabled: false,
      } as never,
    ];
    const limitedVendorModels = await adapter.provideLanguageModelChatInformation(
      {
        silent: true,
        group: 'Vendor',
      } as never,
      {} as never,
    );
    assert.deepEqual(
      (
        limitedVendorModels[0] as unknown as {
          configurationSchema?: {
            properties?: Record<
              string,
              {
                enum?: unknown[];
                default?: unknown;
              }
            >;
          };
        }
      ).configurationSchema?.properties?.thinkingEffort?.enum,
      ['high', 'xhigh'],
    );
    assert.equal(
      (
        limitedVendorModels[0] as unknown as {
          configurationSchema?: {
            properties?: Record<
              string,
              {
                default?: unknown;
              }
            >;
          };
        }
      ).configurationSchema?.properties?.thinkingEffort?.default,
      'high',
    );
    assert.equal((limitedVendorModels[0] as unknown as { editTools?: readonly string[] }).editTools, undefined);
    assert.equal(
      (
        limitedVendorModels[0]?.capabilities as {
          editTools?: readonly string[];
          editToolsHint?: readonly string[];
        }
      ).editTools,
      undefined,
    );
    assert.deepEqual(
      (
        limitedVendorModels[0]?.capabilities as {
          editToolsHint?: readonly string[];
        }
      ).editToolsHint,
      ['apply-patch'],
    );
    assert.equal(
      (limitedVendorModels[0] as unknown as { zeroDataRetentionEnabled?: boolean }).zeroDataRetentionEnabled,
      false,
    );

    availableModels = [
      {
        ...models[0],
        id: 'Vendor/non-thinking',
        name: 'non-thinking',
        capabilities: {
          ...models[0].capabilities,
          thinking: false,
        },
      } as never,
    ];
    const nonThinkingVendorModels = await adapter.provideLanguageModelChatInformation(
      {
        silent: true,
        group: 'Vendor',
      } as never,
      {} as never,
    );
    assert.equal(
      (
        nonThinkingVendorModels[0] as unknown as {
          configurationSchema?: {
            properties?: Record<string, unknown>;
          };
        }
      ).configurationSchema?.properties?.thinkingEffort,
      undefined,
    );
    availableModels = models;

    const otherGroupModels = await adapter.provideLanguageModelChatInformation(
      {
        silent: true,
        group: 'Other',
      } as never,
      {} as never,
    );
    assert.deepEqual(
      otherGroupModels.map((model) => model.id),
      ['Other/coder'],
    );
    assert.equal(
      (
        otherGroupModels[0] as unknown as {
          configurationSchema?: {
            properties?: Record<string, unknown>;
          };
        }
      ).configurationSchema?.properties?.temperature,
      undefined,
    );
    assert.deepEqual(
      (
        otherGroupModels[0] as unknown as {
          configurationSchema?: {
            properties?: Record<
              string,
              {
                enum?: unknown[];
              }
            >;
          };
        }
      ).configurationSchema?.properties?.thinkingEffort?.enum,
      ['low', 'medium', 'high', 'xhigh', 'max'],
    );
    assert.equal(
      (
        otherGroupModels[0] as unknown as {
          configurationSchema?: {
            properties?: Record<
              string,
              {
                default?: unknown;
              }
            >;
          };
        }
      ).configurationSchema?.properties?.thinkingEffort?.default,
      'max',
    );
    assert.equal(
      (
        otherGroupModels[0] as unknown as {
          configurationSchema?: {
            properties?: Record<
              string,
              {
                type?: string;
                default?: unknown;
              }
            >;
          };
        }
      ).configurationSchema?.properties?.personality?.type,
      'string',
    );
    assert.deepEqual(
      (
        otherGroupModels[0] as unknown as {
          configurationSchema?: {
            properties?: Record<
              string,
              {
                enum?: unknown[];
              }
            >;
          };
        }
      ).configurationSchema?.properties?.personality?.enum,
      ['none', 'pragmatic', 'friendly'],
    );
    assert.equal(
      (
        otherGroupModels[0] as unknown as {
          configurationSchema?: {
            properties?: Record<
              string,
              {
                default?: unknown;
              }
            >;
          };
        }
      ).configurationSchema?.properties?.personality?.default,
      'none',
    );

    const anthropicGroupModels = await adapter.provideLanguageModelChatInformation(
      {
        silent: true,
        group: 'Anthropic',
      } as never,
      {} as never,
    );
    assert.deepEqual(
      anthropicGroupModels.map((model) => model.id),
      ['Anthropic/coder'],
    );
    assert.equal(
      (
        anthropicGroupModels[0] as unknown as {
          configurationSchema?: {
            properties?: Record<
              string,
              {
                type?: string;
                default?: unknown;
                group?: string;
                enum?: unknown[];
              }
            >;
          };
        }
      ).configurationSchema?.properties?.thinkingType?.type,
      'string',
    );
    assert.equal(
      (
        anthropicGroupModels[0] as unknown as {
          configurationSchema?: {
            properties?: Record<
              string,
              {
                title?: unknown;
              }
            >;
          };
        }
      ).configurationSchema?.properties?.thinkingType?.title,
      'Thinking Type',
    );
    assert.deepEqual(
      (
        anthropicGroupModels[0] as unknown as {
          configurationSchema?: {
            properties?: Record<
              string,
              {
                enum?: unknown[];
              }
            >;
          };
        }
      ).configurationSchema?.properties?.thinkingType?.enum,
      ['think', 'non-think'],
    );
    assert.equal(
      (
        anthropicGroupModels[0] as unknown as {
          configurationSchema?: {
            properties?: Record<
              string,
              {
                default?: unknown;
              }
            >;
          };
        }
      ).configurationSchema?.properties?.thinkingType?.default,
      'think',
    );
    assert.equal(
      (
        anthropicGroupModels[0] as unknown as {
          configurationSchema?: {
            properties?: Record<string, unknown>;
          };
        }
      ).configurationSchema?.properties?.thinking,
      undefined,
    );
    assert.deepEqual(
      (
        anthropicGroupModels[0] as unknown as {
          configurationSchema?: {
            properties?: Record<
              string,
              {
                enum?: unknown[];
              }
            >;
          };
        }
      ).configurationSchema?.properties?.effort?.enum,
      ['low', 'medium', 'high', 'xhigh', 'max'],
    );
    assert.equal(
      (
        anthropicGroupModels[0] as unknown as {
          configurationSchema?: {
            properties?: Record<
              string,
              {
                default?: unknown;
              }
            >;
          };
        }
      ).configurationSchema?.properties?.effort?.default,
      'max',
    );
    assert.equal(
      (
        anthropicGroupModels[0] as unknown as {
          configurationSchema?: {
            properties?: Record<string, unknown>;
          };
        }
      ).configurationSchema?.properties?.thinkingEffort,
      undefined,
    );

    availableModels = [
      {
        ...models[0],
        id: 'Vendor/plain',
        name: 'plain',
        enableExtraRequestWrapping: false,
      } as never,
    ];
    const unwrappedVendorModels = await adapter.provideLanguageModelChatInformation(
      {
        silent: true,
        group: 'Vendor',
      } as never,
      {} as never,
    );
    assert.deepEqual(
      Object.keys(
        (
          unwrappedVendorModels[0] as unknown as {
            configurationSchema?: {
              properties?: Record<string, unknown>;
            };
          }
        ).configurationSchema?.properties ?? {},
      ),
      ['thinkingEffort', 'thinkingType'],
    );
    availableModels = models;

    const vendorModels = await adapter.provideLanguageModelChatInformation(
      {
        silent: true,
        group: 'Group',
        configuration: { vendorName: 'Vendor' },
      } as never,
      {} as never,
    );
    assert.deepEqual(
      vendorModels.map((model) => model.id),
      ['Vendor/coder'],
    );

    availableModels = [];
    secretContext.secrets.clear();
    refreshCount = 0;
    const silentEmptyModels = await adapter.provideLanguageModelChatInformation(
      {
        silent: true,
        group: 'Vendor',
      } as never,
      {} as never,
    );
    assert.equal(refreshCount, 1);
    assert.deepEqual(silentEmptyModels, []);
    console.log(
      'PASS LMChatProviderAdapter 仅在真实供应商 group 或 configuration 场景暴露模型，并按协议暴露 More Actions schema',
    );
  } finally {
    adapter.dispose();
    configStore.dispose();
  }
}

async function runLMChatProviderAdapterCliproxyapiPickerTests(
  configStoreCtor: ConfigStoreCtor,
  lmChatProviderAdapterModule: LMChatProviderAdapterModule,
): Promise<void> {
  const vscode = require('vscode') as {
    Disposable: new (callback?: () => void) => { dispose(): void };
  };
  const { LMChatProviderAdapter } = lmChatProviderAdapterModule;

  activeState = createState([
    {
      name: 'cliproxyapi',
      baseUrl: 'https://cliproxyapi.jqknono.com/v1',
      defaultApiStyle: 'openai-chat',
      useModelsEndpoint: true,
      models: [],
    },
  ]);
  const secretContext = createExtensionContextWithSecrets();
  secretContext.secrets.set('coding-plans.vendor.apiKey.cliproxyapi', 'configured');
  const configStore = new configStoreCtor(secretContext.context as never);
  const models = [
    {
      id: 'cliproxyapi/o4-mini',
      name: 'o4-mini',
      family: 'cliproxyapi',
      apiStyle: 'openai-chat',
      description: 'cliproxyapi model',
      version: 'cliproxyapi',
      maxInputTokens: 32000,
      maxOutputTokens: 16000,
      capabilities: { toolCalling: true, imageInput: false },
    },
  ];
  let refreshCount = 0;
  const fakeProvider = {
    getVendor(): string {
      return 'coding-plans';
    },
    getApiKey(): string {
      return '';
    },
    getAvailableModels(): typeof models {
      return models;
    },
    async refreshModels(): Promise<void> {
      refreshCount += 1;
      return undefined;
    },
    isModelDiscoveryUnsupported(): boolean {
      return false;
    },
    onDidChangeModels(): { dispose(): void } {
      return new vscode.Disposable();
    },
  };

  const adapter = new LMChatProviderAdapter(fakeProvider as never, configStore);
  try {
    const pickedModels = await adapter.provideLanguageModelChatInformation(
      {
        silent: true,
        group: 'cliproxyapi',
        configuration: { vendorName: 'cliproxyapi' },
      } as never,
      {} as never,
    );
    assert.deepEqual(
      pickedModels.map((model) => model.id),
      ['cliproxyapi/o4-mini'],
    );

    const nonSilentModels = await adapter.provideLanguageModelChatInformation(
      {
        silent: false,
        group: 'cliproxyapi',
        configuration: { vendorName: 'cliproxyapi' },
      } as never,
      {} as never,
    );
    assert.deepEqual(
      nonSilentModels.map((model) => model.id),
      ['cliproxyapi/o4-mini'],
    );
    assert.equal(secretContext.secrets.get('coding-plans.vendor.apiKey.cliproxyapi'), 'configured');
    assert.equal(refreshCount, 0);

    activeState = createState([
      {
        name: 'cliproxyapi',
        baseUrl: 'https://cliproxyapi.jqknono.com/v1',
        defaultApiStyle: 'openai-chat',
        useModelsEndpoint: false,
        models: [],
      },
    ]);

    refreshCount = 0;
    const modelsAfterSettingsChange = await adapter.provideLanguageModelChatInformation(
      {
        silent: true,
        group: 'cliproxyapi',
        configuration: { vendorName: 'cliproxyapi' },
      } as never,
      {} as never,
    );
    assert.deepEqual(
      modelsAfterSettingsChange.map((model) => model.id),
      ['cliproxyapi/o4-mini'],
    );
    assert.equal(secretContext.secrets.get('coding-plans.vendor.apiKey.cliproxyapi'), 'configured');
    assert.equal(refreshCount, 0);

    console.log('PASS LMChatProviderAdapter 会在显式 provider group 路径暴露 cliproxyapi 真实模型');
  } finally {
    adapter.dispose();
    configStore.dispose();
  }
}

async function runLMChatProviderAdapterModelOptionsForwardingTests(
  lmChatProviderAdapterModule: LMChatProviderAdapterModule,
): Promise<void> {
  const vscode = require('vscode') as {
    Disposable: new (callback?: () => void) => { dispose(): void };
    LanguageModelTextPart: new (value: string) => { value: string };
  };
  const { LMChatProviderAdapter } = lmChatProviderAdapterModule;
  const requestSourceModelOptionKey = '__codingPlansRequestSource';

  let capturedOptions: Record<string, unknown> | undefined;
  const targetModel = {
    id: 'Vendor/reasoner',
    name: 'reasoner',
    maxTokens: 32000,
    async sendRequest(
      _messages: unknown[],
      options?: Record<string, unknown>,
    ): Promise<{
      stream: AsyncIterable<{ value: string }>;
      text: AsyncIterable<string>;
    }> {
      capturedOptions = options;
      return {
        stream: (async function* () {
          yield new vscode.LanguageModelTextPart('ok');
        })(),
        text: (async function* () {
          yield 'ok';
        })(),
      };
    },
  };

  const fakeProvider = {
    getVendor(): string {
      return 'coding-plans';
    },
    getModel(modelId: string): typeof targetModel | undefined {
      return modelId === targetModel.id ? targetModel : undefined;
    },
    onDidChangeModels(): { dispose(): void } {
      return new vscode.Disposable();
    },
  };

  const adapter = new LMChatProviderAdapter(fakeProvider as never);
  const reportedParts: Array<{ value?: string }> = [];
  try {
    await adapter.provideLanguageModelChatResponse(
      {
        id: targetModel.id,
        name: targetModel.name,
      } as never,
      [
        {
          role: 1,
          content: [new vscode.LanguageModelTextPart('hello')],
        },
      ] as never,
      {
        modelOptions: {
          thinkingEffort: 'high',
          [requestSourceModelOptionKey]: 'commit-message',
        },
      } as never,
      {
        report(part: { value?: string }): void {
          reportedParts.push(part);
        },
      } as never,
      {
        isCancellationRequested: false,
        onCancellationRequested(): { dispose(): void } {
          return new vscode.Disposable();
        },
      } as never,
    );

    assert.deepEqual(capturedOptions?.modelOptions, { thinkingEffort: 'high' });
    assert.deepEqual(
      reportedParts.map((part) => part.value),
      ['ok'],
    );
    console.log('PASS LMChatProviderAdapter 会保留 thinkingEffort 并剥离内部 source 标记');
  } finally {
    adapter.dispose();
  }
}

async function runLMChatProviderAdapterModelConfigurationForwardingTest(
  lmChatProviderAdapterModule: LMChatProviderAdapterModule,
): Promise<void> {
  const vscode = require('vscode') as {
    Disposable: new (callback?: () => void) => { dispose(): void };
    LanguageModelTextPart: new (value: string) => { value: string };
  };
  const { LMChatProviderAdapter } = lmChatProviderAdapterModule;
  const targetModel = {
    id: 'Vendor/coder',
    name: 'coder',
    maxTokens: 64000,
    async sendRequest(_messages: unknown[], options?: { modelOptions?: Record<string, unknown> }): Promise<unknown> {
      capturedOptions = options;
      return {
        stream: (async function* stream(): AsyncIterable<{ value: string }> {
          yield { value: 'ok' };
        })(),
      };
    },
  };
  let capturedOptions: { modelOptions?: Record<string, unknown> } | undefined;

  const fakeProvider = {
    getVendor(): string {
      return 'coding-plans';
    },
    getModel(modelId: string): typeof targetModel | undefined {
      return modelId === targetModel.id ? targetModel : undefined;
    },
    onDidChangeModels(): { dispose(): void } {
      return new vscode.Disposable();
    },
  };

  const adapter = new LMChatProviderAdapter(fakeProvider as never);
  const reportedParts: Array<{ value?: string }> = [];
  try {
    await adapter.provideLanguageModelChatResponse(
      {
        id: targetModel.id,
        name: targetModel.name,
      } as never,
      [
        {
          role: 1,
          content: [new vscode.LanguageModelTextPart('hello')],
        },
      ] as never,
      {
        modelConfiguration: {
          thinkingEffort: 'xhigh',
          personality: 'friendly',
        },
        modelOptions: {
          thinkingEffort: 'high',
        },
      } as never,
      {
        report(part: { value?: string }): void {
          reportedParts.push(part);
        },
      } as never,
      {
        isCancellationRequested: false,
        onCancellationRequested(): { dispose(): void } {
          return new vscode.Disposable();
        },
      } as never,
    );

    assert.deepEqual(capturedOptions?.modelOptions, {
      thinkingEffort: 'high',
      personality: 'friendly',
    });
    assert.deepEqual(
      reportedParts.map((part) => part.value),
      ['ok'],
    );
    console.log('PASS LMChatProviderAdapter 会转发 VS Code More Actions 保存的 modelConfiguration');
  } finally {
    adapter.dispose();
  }
}

async function main(): Promise<void> {
  const restore = installVscodeMock();
  try {
    const { ConfigStore } = require('../config/configStore') as ConfigStoreModule;
    const baseProviderModule = require('../providers/baseProvider') as BaseProviderModule;
    const genericProviderModule = require('../providers/genericProvider') as GenericProviderModule;
    const modelsDevCatalogModule = require('../providers/modelsDevCatalog') as ModelsDevCatalogModule;
    const tokenUsageModule = require('../providers/tokenUsage') as TokenUsageModule;
    const protocolsModule = require('../providers/genericProviderProtocols') as ProtocolsModule;
    const contextUsageStateModule = require('../contextUsageState') as ContextUsageStateModule;
    const lmChatProviderAdapterModule = require('../providers/lmChatProviderAdapter') as LMChatProviderAdapterModule;
    const planUsageStatusModule = require('../planUsageStatus') as PlanUsageStatusModule;
    const commitMessageGeneratorModule = require('../commitMessageGenerator') as CommitMessageGeneratorModule;
    const extensionModule = require('../extension') as ExtensionModule;
    const i18nModule = require('../i18n/i18n') as I18nModule;
    await runNativeLogLevelConfigurationTests();
    for (const testCase of testCases) {
      await runTestCase(ConfigStore, testCase);
    }
    await runConfigNormalizationTests(ConfigStore);
    await runConfigStoreVendorApiKeySecretStorageTests(ConfigStore);
    runTokenWindowResolutionTests(baseProviderModule);
    await runGenericProviderContextSizeTests(ConfigStore, genericProviderModule);
    runGenericProviderRequestContentLoggingTests(genericProviderModule);
    await runModelsDevCatalogTests(modelsDevCatalogModule);
    runGenericProviderDiscoveryMergeTests();
    await runGenericProviderModelEnabledTests(ConfigStore, genericProviderModule);
    await runGenericProviderDiscoveryDefaultVisionTests(ConfigStore, genericProviderModule);
    await runGenericProviderModelsDevEnrichmentTests(ConfigStore, genericProviderModule, modelsDevCatalogModule);
    await runGenericProviderModelsDevProxyFallbackTests(ConfigStore, genericProviderModule, modelsDevCatalogModule);
    await runGenericProviderStaleDiscoveryWriteTests(ConfigStore, genericProviderModule, modelsDevCatalogModule);
    await runGenericProviderGeneratedFallbackUpgradeTests(ConfigStore, genericProviderModule, modelsDevCatalogModule);
    await runGenericProviderNoAutomaticDeletedModelRestoreTests(ConfigStore, genericProviderModule);
    await runGenericProviderModelChangeEventStabilityTests(ConfigStore, genericProviderModule);
    await runGenericProviderAutoRefreshModelsSettingTests(ConfigStore, genericProviderModule);
    await runGenericProviderEmptyResponseTests(ConfigStore, genericProviderModule);
    await runGenericProviderOutputLimitToggleTests(ConfigStore, genericProviderModule, tokenUsageModule);
    await runGenericProviderMultimodalPayloadTests(ConfigStore, genericProviderModule);
    await runGenericProviderThinkingEffortTests(ConfigStore, genericProviderModule);
    await runGenericProviderAnthropicSamplingCompatibilityTests(ConfigStore, genericProviderModule);
    await runGenericProviderAnthropicStreamFallbackTests(ConfigStore, genericProviderModule);
    await runGenericProviderAnthropicStreamErrorEventTests(ConfigStore, genericProviderModule);
    await runGenericProviderOpenAIReasoningContinuationTests(ConfigStore, baseProviderModule, genericProviderModule);
    runProtocolStreamTests(protocolsModule);
    runTokenUsageNormalizationTests(tokenUsageModule);
    runContextUsageStateTests(contextUsageStateModule);
    runPlanUsageStatusTests(planUsageStatusModule, contextUsageStateModule);
    await runCommitMessageGeneratorTests(commitMessageGeneratorModule);
    await runManageVendorConfigurationTests(ConfigStore, extensionModule);
    await i18nModule.initI18n();
    await runLMChatProviderAdapterModelFilteringTests(ConfigStore, lmChatProviderAdapterModule);
    await runLMChatProviderAdapterCliproxyapiPickerTests(ConfigStore, lmChatProviderAdapterModule);
    await runLMChatProviderAdapterModelOptionsForwardingTests(lmChatProviderAdapterModule);
    await runLMChatProviderAdapterModelConfigurationForwardingTest(lmChatProviderAdapterModule);
    await runLMChatProviderAdapterProvideTokenCountTests(contextUsageStateModule, lmChatProviderAdapterModule);
    await runLMChatProviderAdapterEmptyResponseRetryTests(lmChatProviderAdapterModule);
  } finally {
    restore();
  }

  console.log('All tests passed.');
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
