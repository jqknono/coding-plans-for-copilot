import assert from 'node:assert/strict';
import * as vscode from 'vscode';

const EXTENSION_ID = 'techfetch-dev.coding-plans-for-copilot';
const EXPECTED_COMMANDS = [
  'coding-plans.manage',
  'coding-plans.refreshModels',
  'coding-plans.generateCommitMessage',
  'coding-plans.selectCommitMessageModel'
];

interface TestVendorConfig {
  name: string;
  baseUrl: string;
  defaultApiStyle: 'openai-chat';
  useModelsEndpoint: boolean;
  models: Array<{
    name: string;
    contextSize: number;
    capabilities: {
      tools: boolean;
      vision: boolean;
    };
  }>;
}

async function waitForModel(modelId: string, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const models = await vscode.lm.selectChatModels({ vendor: 'coding-plans' });
    if (models.some(model => model.id === modelId)) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  assert.fail(`超时仍未在 VS Code 模型选择器中看到 ${modelId}`);
}

async function activateExtension(): Promise<vscode.Extension<unknown>> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);

  assert.ok(extension, `未找到扩展 ${EXTENSION_ID}`);

  await extension.activate();
  assert.equal(extension.isActive, true, '扩展应能在 Desktop 测试实例中激活');

  return extension;
}

suite('VS Code Desktop Smoke Tests', () => {
  test('extension initialization exposes configured models without manual refresh', async () => {
    assert.equal(
      typeof vscode.lm?.selectChatModels,
      'function',
      'VS Code 1.120 应提供 vscode.lm.selectChatModels'
    );

    const config = vscode.workspace.getConfiguration('coding-plans');
    const previousGlobalVendors = config.inspect<TestVendorConfig[]>('vendors')?.globalValue;
    const testVendor: TestVendorConfig = {
      name: 'DesktopInit',
      baseUrl: 'https://example.test/v1',
      defaultApiStyle: 'openai-chat',
      useModelsEndpoint: false,
      models: [
        {
          name: 'desktop-init-model',
          contextSize: 32000,
          capabilities: {
            tools: true,
            vision: false
          }
        }
      ]
    };

    try {
      await config.update('vendors', [testVendor], vscode.ConfigurationTarget.Global);
      await activateExtension();
      await waitForModel('DesktopInit/desktop-init-model');
    } finally {
      await config.update('vendors', previousGlobalVendors, vscode.ConfigurationTarget.Global);
    }
  });

  test('extension activates and registers expected commands', async () => {
    await activateExtension();

    const registeredCommands = await vscode.commands.getCommands(true);
    for (const command of EXPECTED_COMMANDS) {
      assert.ok(
        registeredCommands.includes(command),
        `激活后应注册命令 ${command}`
      );
    }
  });

  test('extension models are visible through VS Code language model selector', async () => {
    await activateExtension();

    assert.equal(
      typeof vscode.lm?.selectChatModels,
      'function',
      'VS Code 1.120 应提供 vscode.lm.selectChatModels'
    );

    const config = vscode.workspace.getConfiguration('coding-plans');
    const previousGlobalVendors = config.inspect<TestVendorConfig[]>('vendors')?.globalValue;
    const testVendor: TestVendorConfig = {
      name: 'DesktopTest',
      baseUrl: 'https://example.test/v1',
      defaultApiStyle: 'openai-chat',
      useModelsEndpoint: false,
      models: [
        {
          name: 'desktop-smoke-model',
          contextSize: 32000,
          capabilities: {
            tools: true,
            vision: false
          }
        }
      ]
    };

    try {
      await config.update('vendors', [testVendor], vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('coding-plans.refreshModels');

      const models = await vscode.lm.selectChatModels({ vendor: 'coding-plans' });
      assert.ok(
        models.some(model => model.id === 'DesktopTest/desktop-smoke-model'),
        'VS Code model selector should include the model contributed by Coding Plans'
      );
    } finally {
      await config.update('vendors', previousGlobalVendors, vscode.ConfigurationTarget.Global);
    }
  });
});
