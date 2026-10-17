import * as vscode from 'vscode';
import { NormalizedTokenUsage } from './providers/tokenUsage';

export interface LastContextUsageSnapshot extends NormalizedTokenUsage {
  /** false 表示最近完成请求缺少用量；省略时沿用已有用量。 */
  usageAvailable?: boolean;
  provider: string;
  modelId: string;
  modelName: string;
  totalContextWindow: number;
  inputBudget?: number;
  outputBudget?: number;
  modelContextWindow?: number;
  traceId: string;
  recordedAt: number;
}

const STATUS_BAR_NO_BREAK_SPACE = '\u00A0';
const CONTEXT_STATUS_LABEL = `CodingPlans${STATUS_BAR_NO_BREAK_SPACE}Context`;

export class ContextUsageState implements vscode.Disposable {
  private snapshot: LastContextUsageSnapshot | undefined;
  private readonly onDidChangeEmitter = new vscode.EventEmitter<LastContextUsageSnapshot | undefined>();
  public readonly onDidChange = this.onDidChangeEmitter.event;

  getSnapshot(): LastContextUsageSnapshot | undefined {
    return this.snapshot;
  }

  update(snapshot: LastContextUsageSnapshot): void {
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

export class ContextStatusBarController implements vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly usageState: ContextUsageState) {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.name = 'CodingPlans Context';
    this.statusBarItem.show();
    this.disposables.push(this.statusBarItem);
    this.disposables.push(
      this.usageState.onDidChange((snapshot) => {
        this.render(snapshot);
      }),
    );
    this.render(this.usageState.getSnapshot());
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }

  private render(snapshot: LastContextUsageSnapshot | undefined): void {
    this.statusBarItem.text = buildContextStatusText(snapshot);
    this.statusBarItem.tooltip = new vscode.MarkdownString(buildContextStatusTooltip(snapshot));
  }
}

export function buildContextStatusText(snapshot: LastContextUsageSnapshot | undefined): string {
  if (!snapshot || snapshot.usageAvailable === false || snapshot.totalContextWindow <= 0) {
    return `${CONTEXT_STATUS_LABEL}${STATUS_BAR_NO_BREAK_SPACE}--`;
  }

  const percentage = Math.max(0, Math.round((readOccupiedContextTokens(snapshot) / snapshot.totalContextWindow) * 100));
  return `${CONTEXT_STATUS_LABEL}${STATUS_BAR_NO_BREAK_SPACE}${percentage}%`;
}

export function buildContextStatusTooltip(snapshot: LastContextUsageSnapshot | undefined): string {
  if (!snapshot) {
    return ['**CodingPlans Context**', '', '等待最近完成请求的用量。'].join('\n');
  }

  return [
    '**CodingPlans Context · 最近完成请求**',
    '',
    ...buildContextUsageDetails(snapshot).map(([label, value]) => `- ${label}: ${value}`),
  ].join('\n');
}

export function readOccupiedContextTokens(snapshot: LastContextUsageSnapshot): number {
  return snapshot.promptTokens + Math.max(snapshot.completionTokens, snapshot.outputBudget ?? snapshot.outputBuffer ?? 0);
}

/** 状态栏 tooltip 与详情页共用最近完成请求的展示契约。 */
export function buildContextUsageDetails(snapshot: LastContextUsageSnapshot): Array<[string, string]> {
  const usageAvailable = snapshot.usageAvailable !== false;
  const outputBudget = snapshot.outputBudget ?? snapshot.outputBuffer;
  const occupiedContextTokens = readOccupiedContextTokens(snapshot);
  const ratio = usageAvailable && snapshot.totalContextWindow > 0
    ? `${Number(((occupiedContextTokens / snapshot.totalContextWindow) * 100).toFixed(1))}% of ${formatCompactTokens(snapshot.totalContextWindow)}`
    : '--';
  const formatBudget = (value: number | undefined): string => value === undefined ? '--' : formatCompactTokens(value);
  const formatUsage = (value: number): string => usageAvailable ? formatCompactTokens(value) : '--';

  return [
    ...(usageAvailable ? [] : [['最近完成请求', '缺少用量，实际占用未知'] as [string, string]]),
    ['Context', ratio],
    ['Prompt', `${formatUsage(snapshot.promptTokens)} / ${formatBudget(snapshot.inputBudget)}`],
    ['Completion', `${formatUsage(snapshot.completionTokens)} / ${formatBudget(outputBudget)}`],
    ['有效窗口 (P + R)', snapshot.totalContextWindow > 0 ? formatCompactTokens(snapshot.totalContextWindow) : '--'],
    ['模型窗口 C', formatBudget(snapshot.modelContextWindow)],
    ['Total', formatUsage(snapshot.totalTokens)],
    ['Reserved Output', formatBudget(snapshot.outputBuffer)],
    ['Occupied Context', formatUsage(occupiedContextTokens)],
    ['Model', snapshot.modelName],
    ['Updated', new Date(snapshot.recordedAt).toISOString()],
  ];
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
