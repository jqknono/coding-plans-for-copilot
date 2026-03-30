import * as vscode from 'vscode';
import { ConfigStore, VendorConfig } from './config/configStore';
import { ContextUsageState, LastContextUsageSnapshot } from './contextUsageState';
import { normalizeHttpBaseUrl, getCompactErrorMessage } from './providers/baseProvider';
import { logger } from './logging/outputChannelLogger';

const DEFAULT_USAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const STATUS_LIMIT_COUNT = 2;

export interface PlanUsageLimitSnapshot {
  label: string;
  percentage: number;
  used?: number;
  limit?: number;
  remaining?: number;
  resetAt?: number;
  details: string[];
  sortOrder: number;
}

export interface VendorPlanUsageSnapshot {
  vendor: string;
  usageUrl: string;
  productName?: string;
  recordedAt: number;
  limits: PlanUsageLimitSnapshot[];
}

export class PlanUsageState implements vscode.Disposable {
  private snapshot: VendorPlanUsageSnapshot | undefined;
  private readonly onDidChangeEmitter = new vscode.EventEmitter<VendorPlanUsageSnapshot | undefined>();
  public readonly onDidChange = this.onDidChangeEmitter.event;

  getSnapshot(): VendorPlanUsageSnapshot | undefined {
    return this.snapshot;
  }

  update(snapshot: VendorPlanUsageSnapshot): void {
    this.snapshot = snapshot;
    this.onDidChangeEmitter.fire(this.snapshot);
  }

  clear(): void {
    this.snapshot = undefined;
    this.onDidChangeEmitter.fire(undefined);
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}

export class CodingPlanStatusBarController implements vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly contextUsageState: ContextUsageState,
    private readonly usageState: PlanUsageState,
    detailsCommand?: string
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.statusBarItem.name = 'CodingPlans';
    this.statusBarItem.command = detailsCommand;
    this.statusBarItem.show();
    this.disposables.push(this.statusBarItem);
    this.disposables.push(this.contextUsageState.onDidChange(() => {
      this.render();
    }));
    this.disposables.push(this.usageState.onDidChange(snapshot => {
      this.render(snapshot);
    }));
    this.render(this.usageState.getSnapshot());
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }

  private render(snapshot?: VendorPlanUsageSnapshot): void {
    const currentSnapshot = snapshot ?? this.usageState.getSnapshot();
    const contextSnapshot = this.contextUsageState.getSnapshot();
    this.statusBarItem.text = buildCodingPlanStatusText(contextSnapshot, currentSnapshot);
    this.statusBarItem.tooltip = new vscode.MarkdownString(buildCodingPlanStatusTooltip(contextSnapshot, currentSnapshot));
    updateOpenCodingPlanDetailsPanel(contextSnapshot, currentSnapshot);
  }
}

export class PlanUsagePollingController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshInFlight: Promise<void> | undefined;
  private preferredVendorName: string | undefined;
  private disposed = false;

  constructor(
    private readonly configStore: ConfigStore,
    private readonly usageState: PlanUsageState,
    contextUsageState?: ContextUsageState
  ) {
    this.disposables.push(this.configStore.onDidChange(() => {
      this.scheduleRefresh(0);
    }));

    if (contextUsageState) {
      this.disposables.push(contextUsageState.onDidChange(snapshot => {
        this.onContextUsageChanged(snapshot);
      }));
    }

    this.scheduleRefresh(1000);
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }

  private onContextUsageChanged(snapshot: LastContextUsageSnapshot | undefined): void {
    const vendorName = readVendorNameFromModelId(snapshot?.modelId);
    if (!vendorName || vendorName === this.preferredVendorName) {
      return;
    }

    this.preferredVendorName = vendorName;
    this.scheduleRefresh(0);
  }

  private scheduleRefresh(delayMs: number): void {
    if (this.disposed) {
      return;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refreshNow();
    }, Math.max(0, delayMs));
  }

  private async refreshNow(): Promise<void> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    const running = (async () => {
      const target = await this.resolveTargetVendor();
      if (!target) {
        this.usageState.clear();
        return;
      }

      try {
        const snapshot = await this.fetchVendorUsage(target.vendor, target.apiKey);
        if (!snapshot) {
          logger.warn('Plan usage response was ignored because no recognizable limits were found', {
            vendor: target.vendor.name,
            usageUrl: target.vendor.usageUrl
          });
          return;
        }

        this.usageState.update(snapshot);
        logger.info('Plan usage refreshed', {
          vendor: snapshot.vendor,
          usageUrl: snapshot.usageUrl,
          limits: snapshot.limits.map(limit => ({
            label: limit.label,
            percentage: limit.percentage,
            used: limit.used,
            limit: limit.limit
          }))
        });
      } catch (error) {
        logger.warn('Failed to refresh plan usage', {
          vendor: target.vendor.name,
          usageUrl: target.vendor.usageUrl,
          error: getCompactErrorMessage(error)
        });
      } finally {
        if (!this.disposed) {
          this.scheduleRefresh(DEFAULT_USAGE_REFRESH_INTERVAL_MS);
        }
      }
    })();

    this.refreshInFlight = running;
    try {
      await running;
    } finally {
      if (this.refreshInFlight === running) {
        this.refreshInFlight = undefined;
      }
    }
  }

  private async resolveTargetVendor(): Promise<{ vendor: VendorConfig; apiKey: string } | undefined> {
    const vendors = this.configStore.getVendors();
    const candidates = vendors.filter(vendor => normalizeHttpBaseUrl(vendor.usageUrl) !== undefined);
    if (candidates.length === 0) {
      return undefined;
    }

    const preferred = this.preferredVendorName
      ? candidates.find(vendor => vendor.name.toLowerCase() === this.preferredVendorName?.toLowerCase())
      : undefined;
    if (preferred) {
      const apiKey = (await this.configStore.getApiKey(preferred.name)).trim();
      if (apiKey.length > 0) {
        return { vendor: preferred, apiKey };
      }
    }

    for (const vendor of candidates) {
      const apiKey = (await this.configStore.getApiKey(vendor.name)).trim();
      if (apiKey.length > 0) {
        return { vendor, apiKey };
      }
    }

    return undefined;
  }

  private async fetchVendorUsage(vendor: VendorConfig, apiKey: string): Promise<VendorPlanUsageSnapshot | undefined> {
    const usageUrl = normalizeHttpBaseUrl(vendor.usageUrl);
    if (!usageUrl) {
      return undefined;
    }

    const response = await fetch(usageUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }
    });
    const payload = await readResponseData(response);
    if (!response.ok) {
      const error: Error & { response?: { status: number; data: unknown } } = new Error(`Request failed with status ${response.status}`);
      error.response = {
        status: response.status,
        data: payload
      };
      throw error;
    }

    return parseVendorPlanUsageSnapshot(vendor.name, usageUrl, payload, Date.now());
  }
}

export function buildPlanUsageStatusText(snapshot: VendorPlanUsageSnapshot | undefined): string {
  const limits = snapshot?.limits.slice(0, STATUS_LIMIT_COUNT) ?? [];
  if (limits.length === 0) {
    return 'CodingPlans Usage --';
  }

  return `CodingPlans Usage ${limits.map(limit => `${limit.label} ${limit.percentage}%`).join(' | ')}`;
}

export function buildPlanUsageStatusTooltip(snapshot: VendorPlanUsageSnapshot | undefined): string {
  if (!snapshot || snapshot.limits.length === 0) {
    return [
      '**CodingPlans Usage**',
      '',
      'No coding plan usage is available yet.'
    ].join('\n');
  }

  const lines = [
    '**CodingPlans Usage**',
    '',
    `- Vendor: ${snapshot.vendor}`,
    ...(snapshot.productName ? [`- Plan: ${snapshot.productName}`] : []),
    ...snapshot.limits.map(limit => {
      const summary = `- ${limit.label}: ${limit.percentage}%${formatLimitPair(limit)}`;
      const resetLine = limit.resetAt ? `- ${limit.label} Reset: ${new Date(limit.resetAt).toISOString()}` : undefined;
      const detailLines = limit.details.map(detail => `- ${limit.label} Detail: ${detail}`);
      return [summary, resetLine, ...detailLines].filter((line): line is string => !!line);
    }).flat(),
    `- Updated: ${new Date(snapshot.recordedAt).toISOString()}`
  ];

  return lines.join('\n');
}

export function buildCodingPlanStatusText(
  contextSnapshot: LastContextUsageSnapshot | undefined,
  planUsageSnapshot: VendorPlanUsageSnapshot | undefined
): string {
  const parts: string[] = [];
  const planLimits = planUsageSnapshot?.limits.slice(0, STATUS_LIMIT_COUNT) ?? [];
  for (const limit of planLimits) {
    parts.push(`${limit.label} ${limit.percentage}%`);
  }

  const contextPercentage = readContextPercentage(contextSnapshot);
  if (contextPercentage !== undefined) {
    parts.push(`Ctx ${contextPercentage}%`);
  }

  return parts.length > 0
    ? `CodingPlans ${parts.join(' | ')}`
    : 'CodingPlans --';
}

export function buildCodingPlanStatusTooltip(
  contextSnapshot: LastContextUsageSnapshot | undefined,
  planUsageSnapshot: VendorPlanUsageSnapshot | undefined
): string {
  const sections: string[] = ['**CodingPlans**'];

  if (planUsageSnapshot?.limits.length) {
    sections.push(
      '',
      '**Plan Usage**',
      '',
      `- Vendor: ${planUsageSnapshot.vendor}`,
      ...(planUsageSnapshot.productName ? [`- Plan: ${planUsageSnapshot.productName}`] : []),
      ...planUsageSnapshot.limits.map(limit => {
        const summary = `- ${limit.label}: ${limit.percentage}%${formatLimitPair(limit)}`;
        const resetLine = limit.resetAt ? `- ${limit.label} Reset: ${new Date(limit.resetAt).toISOString()}` : undefined;
        const detailLines = limit.details.map(detail => `- ${limit.label} Detail: ${detail}`);
        return [summary, resetLine, ...detailLines].filter((line): line is string => !!line);
      }).flat(),
      `- Updated: ${new Date(planUsageSnapshot.recordedAt).toISOString()}`
    );
  }

  if (contextSnapshot && contextSnapshot.totalContextWindow > 0) {
    const occupiedContextTokens = readOccupiedContextTokens(contextSnapshot);
    const ratio = Number(((occupiedContextTokens / contextSnapshot.totalContextWindow) * 100).toFixed(1));
    sections.push(
      '',
      '**Context**',
      '',
      `- Context: ${ratio}% of ${formatCompactTokens(contextSnapshot.totalContextWindow)}`,
      `- Prompt: ${formatCompactTokens(contextSnapshot.promptTokens)}`,
      `- Completion: ${formatCompactTokens(contextSnapshot.completionTokens)}`,
      `- Total: ${formatCompactTokens(contextSnapshot.totalTokens)}`,
      `- Reserved Output: ${contextSnapshot.outputBuffer === undefined ? '--' : formatCompactTokens(contextSnapshot.outputBuffer)}`,
      `- Occupied Context: ${formatCompactTokens(occupiedContextTokens)}`,
      `- Model: ${contextSnapshot.modelName}`,
      `- Updated: ${new Date(contextSnapshot.recordedAt).toISOString()}`
    );
  }

  if (sections.length === 1) {
    sections.push('', 'No coding plan usage or context data is available yet.');
  }

  sections.push('', '_Click the status bar item to keep these details open._');
  return sections.join('\n');
}

export function showCodingPlanDetails(
  contextSnapshot: LastContextUsageSnapshot | undefined,
  planUsageSnapshot: VendorPlanUsageSnapshot | undefined
): void {
  if (!statusDetailsPanel) {
    statusDetailsPanel = vscode.window.createWebviewPanel(
      'codingPlansStatusDetails',
      'CodingPlans',
      vscode.ViewColumn.Beside,
      {
        enableFindWidget: true
      }
    );
    statusDetailsPanel.onDidDispose(() => {
      statusDetailsPanel = undefined;
    });
  }

  updateOpenCodingPlanDetailsPanel(contextSnapshot, planUsageSnapshot);
  statusDetailsPanel.reveal(vscode.ViewColumn.Beside);
}

export function buildCodingPlanDetailsHtml(
  contextSnapshot: LastContextUsageSnapshot | undefined,
  planUsageSnapshot: VendorPlanUsageSnapshot | undefined
): string {
  const sections: string[] = [];

  if (planUsageSnapshot?.limits.length) {
    sections.push(
      renderDetailsSection(
        'Plan Usage',
        [
          renderDetailsItem('Vendor', planUsageSnapshot.vendor),
          ...(planUsageSnapshot.productName ? [renderDetailsItem('Plan', planUsageSnapshot.productName)] : []),
          ...planUsageSnapshot.limits.map(limit => {
            const summary = [
              `${limit.label}: ${limit.percentage}%${formatLimitPair(limit)}`
            ];
            if (limit.resetAt) {
              summary.push(`Reset: ${new Date(limit.resetAt).toISOString()}`);
            }
            summary.push(...limit.details.map(detail => `Detail: ${detail}`));
            return renderDetailsItem(limit.label, summary.join(' | '));
          }),
          renderDetailsItem('Updated', new Date(planUsageSnapshot.recordedAt).toISOString())
        ]
      )
    );
  }

  if (contextSnapshot && contextSnapshot.totalContextWindow > 0) {
    const occupiedContextTokens = readOccupiedContextTokens(contextSnapshot);
    const ratio = Number(((occupiedContextTokens / contextSnapshot.totalContextWindow) * 100).toFixed(1));
    sections.push(
      renderDetailsSection(
        'Context',
        [
          renderDetailsItem('Context', `${ratio}% of ${formatCompactTokens(contextSnapshot.totalContextWindow)}`),
          renderDetailsItem('Prompt', formatCompactTokens(contextSnapshot.promptTokens)),
          renderDetailsItem('Completion', formatCompactTokens(contextSnapshot.completionTokens)),
          renderDetailsItem('Total', formatCompactTokens(contextSnapshot.totalTokens)),
          renderDetailsItem('Reserved Output', contextSnapshot.outputBuffer === undefined ? '--' : formatCompactTokens(contextSnapshot.outputBuffer)),
          renderDetailsItem('Occupied Context', formatCompactTokens(occupiedContextTokens)),
          renderDetailsItem('Model', contextSnapshot.modelName),
          renderDetailsItem('Updated', new Date(contextSnapshot.recordedAt).toISOString())
        ]
      )
    );
  }

  const body = sections.length > 0
    ? sections.join('\n')
    : '<p class="empty">No coding plan usage or context data is available yet.</p>';

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="UTF-8" />',
    "  <meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline';\" />",
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    '  <title>CodingPlans</title>',
    '  <style>',
    '    :root { color-scheme: light dark; }',
    '    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; }',
    '    main { max-width: 920px; margin: 0 auto; padding: 24px; }',
    '    h1 { margin: 0 0 8px; font-size: 24px; }',
    '    h2 { margin: 24px 0 12px; font-size: 16px; }',
    '    p { margin: 0 0 12px; line-height: 1.6; }',
    '    section { border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 16px; background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-editorHoverWidget-background) 8%); }',
    '    ul { margin: 0; padding-left: 20px; }',
    '    li { margin: 0 0 10px; line-height: 1.6; }',
    '    .label { font-weight: 600; }',
    '    .hint { color: var(--vscode-descriptionForeground); }',
    '    .empty { color: var(--vscode-descriptionForeground); }',
    '    a { color: var(--vscode-textLink-foreground); }',
    '  </style>',
    '</head>',
    '<body>',
    '  <main>',
    '    <h1>CodingPlans</h1>',
    '    <p class="hint">Pinned details for the status bar item. This view stays open while you inspect it.</p>',
    body,
    '  </main>',
    '</body>',
    '</html>'
  ].join('\n');
}

export function parseVendorPlanUsageSnapshot(
  vendorName: string,
  usageUrl: string,
  payload: unknown,
  recordedAt: number
): VendorPlanUsageSnapshot | undefined {
  const source = asRecord(payload);
  if (!source) {
    return undefined;
  }

  const data = asRecord(source.data) ?? source;
  const productName = firstNonEmptyString(data.productName, source.productName);
  const rawLimits = readRawLimitEntries(data, source);
  const limits = rawLimits
    .map(entry => normalizePlanUsageLimit(entry))
    .filter((limit): limit is PlanUsageLimitSnapshot => limit !== undefined)
    .sort((left, right) => {
      if (left.sortOrder !== right.sortOrder) {
        return left.sortOrder - right.sortOrder;
      }
      if (left.label !== right.label) {
        return left.label.localeCompare(right.label);
      }
      return left.percentage - right.percentage;
    });

  if (limits.length === 0) {
    return undefined;
  }

  return {
    vendor: vendorName,
    usageUrl,
    productName,
    recordedAt,
    limits
  };
}

function readVendorNameFromModelId(modelId: string | undefined): string | undefined {
  if (typeof modelId !== 'string') {
    return undefined;
  }
  const separatorIndex = modelId.indexOf('/');
  if (separatorIndex <= 0) {
    return undefined;
  }
  const vendorName = modelId.slice(0, separatorIndex).trim();
  return vendorName.length > 0 ? vendorName : undefined;
}

function readRawLimitEntries(...sources: Record<string, unknown>[]): Record<string, unknown>[] {
  const candidateKeys = ['limits', 'quotas', 'items', 'usage', 'data'];
  for (const source of sources) {
    for (const key of candidateKeys) {
      const raw = source[key];
      if (!Array.isArray(raw)) {
        continue;
      }

      const entries = raw
        .map(item => asRecord(item))
        .filter((item): item is Record<string, unknown> => item !== undefined);
      if (entries.some(isLikelyUsageLimitRecord)) {
        return entries;
      }
    }
  }

  return [];
}

function isLikelyUsageLimitRecord(value: Record<string, unknown>): boolean {
  return readPercentageValue(value) !== undefined
    || (readMetric(value, ['currentValue', 'used', 'usedValue', 'consumed']) !== undefined
      && readMetric(value, ['usage', 'limit', 'limitValue', 'quota', 'total']) !== undefined);
}

function normalizePlanUsageLimit(source: Record<string, unknown>): PlanUsageLimitSnapshot | undefined {
  const used = readMetric(source, ['currentValue', 'used', 'usedValue', 'consumed']);
  const limit = readMetric(source, ['usage', 'limit', 'limitValue', 'quota', 'total']);
  const remaining = readMetric(source, ['remaining', 'available', 'left']);
  const percentage = readPercentageValue(source) ?? derivePercentage(used, limit);

  if (percentage === undefined) {
    return undefined;
  }

  const label = resolvePlanUsageLabel(source);
  return {
    label: label.label,
    percentage,
    used,
    limit,
    remaining,
    resetAt: readTimestamp(source, ['nextResetTime', 'nextRenewTime', 'resetAt', 'renewAt']),
    details: readUsageDetails(source),
    sortOrder: label.sortOrder
  };
}

function resolvePlanUsageLabel(source: Record<string, unknown>): { label: string; sortOrder: number } {
  const rawLabel = [
    firstNonEmptyString(source.label, source.title, source.name, source.type),
    ...readUsageDetails(source)
  ].join(' ').toLowerCase();
  const number = readPositiveInteger(source.number);
  const unit = readPositiveInteger(source.unit);
  const usageDetails = readUsageDetails(source);

  if (usageDetails.length > 0 || /(?:mcp|search|reader|time_limit|call|invoke|次数|调用)/i.test(rawLabel)) {
    return { label: 'MCP', sortOrder: 30 };
  }

  if (unit === 3 && number !== undefined) {
    return { label: `${number}h`, sortOrder: 10 };
  }

  if (unit === 6 && number !== undefined) {
    return { label: `${number}d`, sortOrder: 20 };
  }

  const hoursMatch = rawLabel.match(/(\d+)\s*(?:h|hr|hour|hours|小时)/i);
  if (hoursMatch) {
    return { label: `${hoursMatch[1]}h`, sortOrder: 10 };
  }

  if (/(?:week|weekly|周)/i.test(rawLabel)) {
    return { label: 'Week', sortOrder: 20 };
  }

  if (/(?:day|daily|日)/i.test(rawLabel)) {
    return { label: 'Day', sortOrder: 20 };
  }

  if (/(?:month|monthly|月)/i.test(rawLabel)) {
    return { label: 'Month', sortOrder: 40 };
  }

  if (/(?:count|quota|limit|usage)/i.test(rawLabel)) {
    return { label: 'Usage', sortOrder: 50 };
  }

  return { label: 'Quota', sortOrder: 60 };
}

function readUsageDetails(source: Record<string, unknown>): string[] {
  const raw = source.usageDetails;
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map(item => {
      const detail = asRecord(item);
      if (!detail) {
        return undefined;
      }
      const name = firstNonEmptyString(detail.modelCode, detail.name, detail.label, detail.title);
      const value = readMetric(detail, ['usage', 'currentValue', 'used', 'count']);
      if (!name || value === undefined || value <= 0) {
        return undefined;
      }
      return `${name}: ${formatUsageMetric(value)}`;
    })
    .filter((value): value is string => value !== undefined);
}

function readPercentageValue(source: Record<string, unknown>): number | undefined {
  for (const key of ['percentage', 'percent', 'usagePercentage', 'ratio']) {
    const value = source[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      continue;
    }

    if (value >= 0 && value <= 1) {
      return clampPercentage(Math.round(value * 100));
    }
    return clampPercentage(Math.round(value));
  }

  return undefined;
}

function derivePercentage(used: number | undefined, limit: number | undefined): number | undefined {
  if (used === undefined || limit === undefined || limit <= 0) {
    return undefined;
  }
  return clampPercentage(Math.round((used / limit) * 100));
}

function clampPercentage(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function readMetric(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.round(value);
    }
  }
  return undefined;
}

function readTimestamp(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.round(value);
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function formatLimitPair(limit: PlanUsageLimitSnapshot): string {
  if (limit.used === undefined || limit.limit === undefined) {
    return '';
  }
  return ` (${formatUsageMetric(limit.used)} / ${formatUsageMetric(limit.limit)})`;
}

function formatUsageMetric(value: number): string {
  if (value >= 1_000_000) {
    return `${Number((value / 1_000_000).toFixed(1))}M`;
  }
  if (value >= 10_000) {
    return `${Number((value / 1_000).toFixed(1))}K`;
  }
  return String(value);
}

function readContextPercentage(snapshot: LastContextUsageSnapshot | undefined): number | undefined {
  if (!snapshot || snapshot.totalContextWindow <= 0) {
    return undefined;
  }
  return Math.min(100, Math.max(0, Math.round((readOccupiedContextTokens(snapshot) / snapshot.totalContextWindow) * 100)));
}

function readOccupiedContextTokens(snapshot: LastContextUsageSnapshot): number {
  return Math.min(
    snapshot.totalContextWindow,
    snapshot.totalTokens + Math.max(snapshot.outputBuffer ?? 0, 0)
  );
}

function formatCompactTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${Number((value / 1_000_000).toFixed(1))}M`;
  }
  if (value >= 1_000) {
    return `${Number((value / 1_000).toFixed(1))}K`;
  }
  return String(value);
}

let statusDetailsPanel: vscode.WebviewPanel | undefined;

function updateOpenCodingPlanDetailsPanel(
  contextSnapshot: LastContextUsageSnapshot | undefined,
  planUsageSnapshot: VendorPlanUsageSnapshot | undefined
): void {
  if (!statusDetailsPanel) {
    return;
  }

  statusDetailsPanel.webview.html = buildCodingPlanDetailsHtml(contextSnapshot, planUsageSnapshot);
}

function renderDetailsSection(title: string, items: string[]): string {
  return [
    '<section>',
    `  <h2>${escapeHtml(title)}</h2>`,
    '  <ul>',
    ...items.map(item => `    ${item}`),
    '  </ul>',
    '</section>'
  ].join('\n');
}

function renderDetailsItem(label: string, value: string): string {
  return `<li><span class="label">${escapeHtml(label)}:</span> ${escapeHtml(value)}</li>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function readResponseData(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
