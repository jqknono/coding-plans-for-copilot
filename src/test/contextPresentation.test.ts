import assert from 'node:assert/strict';
import {
  buildContextStatusText,
  buildContextStatusTooltip,
  ContextStatusBarController,
  ContextUsageState,
  LastContextUsageSnapshot,
  readOccupiedContextTokens,
} from '../contextUsageState';
import {
  buildCodingPlanDetailsHtml,
  buildCodingPlanStatusText,
  buildCodingPlanStatusTooltip,
  CodingPlanStatusBarController,
  PlanUsageState,
  VendorPlanUsageSnapshot,
} from '../planUsageStatus';

const snapshot: LastContextUsageSnapshot = {
  provider: 'coding-plans',
  modelId: 'vendor/model',
  modelName: '展示模型',
  totalContextWindow: 80000,
  inputBudget: 64000,
  outputBudget: 16000,
  modelContextWindow: 200000,
  promptTokens: 48000,
  completionTokens: 4000,
  totalTokens: 52000,
  outputBuffer: 48000,
  traceId: 'context-presentation',
  recordedAt: Date.UTC(2026, 9, 17, 8),
};

const planSnapshot: VendorPlanUsageSnapshot = {
  vendor: 'vendor',
  usageUrl: 'https://example.test/usage',
  recordedAt: snapshot.recordedAt,
  limits: [{ label: '5h', percentage: 15, details: [], sortOrder: 10 }],
};

function verifyDetails(current: LastContextUsageSnapshot, entries: Array<[string, string]>): void {
  const tooltips = [
    buildContextStatusTooltip(current),
    buildCodingPlanStatusTooltip(current, planSnapshot),
  ];
  const html = buildCodingPlanDetailsHtml(current, planSnapshot);
  for (const [label, value] of entries) {
    for (const tooltip of tooltips) {
      assert.ok(tooltip.split('\n').includes(`- ${label}: ${value}`), `${label} 展示 ${value}`);
    }
    assert.ok(html.includes(`<span class="label">${label}:</span> ${value}</li>`), `${label} 详情展示 ${value}`);
  }
}

/** 接入现有 vscode mock 后调用，覆盖实际控制器与共享展示契约。 */
export function runContextPresentationTests(): void {
  assert.equal(readOccupiedContextTokens(snapshot), 64000, '输出预算 R 优先于 outputBuffer');
  assert.equal(readOccupiedContextTokens({ ...snapshot, outputBudget: undefined }), 96000, '旧快照沿用 outputBuffer');
  assert.equal(readOccupiedContextTokens({ ...snapshot, outputBudget: undefined, outputBuffer: undefined }), 52000);
  assert.equal(readOccupiedContextTokens({ ...snapshot, outputBudget: 0 }), 52000, '显式零预算保留其语义');
  assert.equal(buildCodingPlanStatusText(snapshot, planSnapshot), 'CodingPlans 5h 15% | Ctx 80%');
  assert.equal(buildContextStatusText(snapshot), 'CodingPlans\u00A0Context\u00A080%');
  verifyDetails(snapshot, [
    ['Context', '80% of 80K'],
    ['Prompt', '48K / 64K'],
    ['Completion', '4K / 16K'],
    ['有效窗口 (P + R)', '80K'],
    ['模型窗口 C', '200K'],
    ['Occupied Context', '64K'],
  ]);

  const overflow = { ...snapshot, promptTokens: 72000, completionTokens: 24000, totalTokens: 96000 };
  assert.equal(readOccupiedContextTokens(overflow), 96000, '实际 completion 超过 R 时采用实际值');
  assert.equal(buildCodingPlanStatusText(overflow, undefined), 'CodingPlans Ctx 120%');
  assert.equal(buildContextStatusText(overflow), 'CodingPlans\u00A0Context\u00A0120%');
  verifyDetails(overflow, [
    ['Context', '120% of 80K'],
    ['Prompt', '72K / 64K'],
    ['Completion', '24K / 16K'],
    ['Occupied Context', '96K'],
  ]);

  const unknown = { ...snapshot, usageAvailable: false, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  assert.equal(buildCodingPlanStatusText(unknown, undefined), 'CodingPlans Ctx --');
  assert.equal(buildContextStatusText(unknown), 'CodingPlans\u00A0Context\u00A0--');
  verifyDetails(unknown, [
    ['最近完成请求', '缺少用量，实际占用未知'],
    ['Context', '--'],
    ['Prompt', '-- / 64K'],
    ['Completion', '-- / 16K'],
    ['Total', '--'],
    ['Occupied Context', '--'],
    ['有效窗口 (P + R)', '80K'],
    ['模型窗口 C', '200K'],
    ['Model', '展示模型'],
    ['Updated', '2026-10-17T08:00:00.000Z'],
  ]);
  const zeroUsage = { ...unknown, usageAvailable: true };
  assert.equal(buildCodingPlanStatusText(zeroUsage, undefined), 'CodingPlans Ctx 20%');
  verifyDetails(zeroUsage, [['Prompt', '0 / 64K'], ['Completion', '0 / 16K'], ['Total', '0']]);

  const vscodeMock = require('vscode') as {
    testState: { createdStatusBarItems: Array<{ text: string; tooltip: { value: string } }> };
  };
  const contextState = new ContextUsageState();
  const planState = new PlanUsageState();
  const controller = new CodingPlanStatusBarController(contextState, planState);
  const planItem = vscodeMock.testState.createdStatusBarItems.at(-1);
  const contextController = new ContextStatusBarController(contextState);
  const contextItem = vscodeMock.testState.createdStatusBarItems.at(-1);
  assert.ok(planItem);
  assert.ok(contextItem);
  try {
    planState.update(planSnapshot);
    contextState.update(snapshot);
    assert.equal(planItem.text, 'CodingPlans 5h 15% | Ctx 80%');
    assert.equal(contextItem.text, 'CodingPlans\u00A0Context\u00A080%');
    contextState.update(overflow);
    assert.equal(planItem.text, 'CodingPlans 5h 15% | Ctx 120%');
    assert.equal(contextItem.text, 'CodingPlans\u00A0Context\u00A0120%');
    contextState.update(unknown);
    assert.equal(planItem.text, 'CodingPlans 5h 15% | Ctx --');
    assert.equal(contextItem.text, 'CodingPlans\u00A0Context\u00A0--');
    for (const item of [planItem, contextItem]) {
      assert.ok(item.tooltip.value.includes('最近完成请求'));
      assert.ok(item.tooltip.value.includes('Prompt: -- / 64K'));
      assert.ok(item.tooltip.value.includes('Completion: -- / 16K'));
      assert.ok(item.tooltip.value.includes('Model: 展示模型'));
      assert.ok(item.tooltip.value.includes('Updated: 2026-10-17T08:00:00.000Z'));
    }
    contextState.update(snapshot);
    assert.equal(planItem.text, 'CodingPlans 5h 15% | Ctx 80%');
  } finally {
    contextController.dispose();
    controller.dispose();
    planState.dispose();
    contextState.dispose();
  }
}
