import * as vscode from 'vscode';
import { NormalizedTokenUsage } from './providers/tokenUsage';

export interface LastContextUsageSnapshot extends NormalizedTokenUsage {
  provider: string;
  modelId: string;
  modelName: string;
  totalContextWindow: number;
  traceId: string;
  recordedAt: number;
}

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

  private render(snapshot: LastContextUsageSnapshot | undefined): void {
    this.statusBarItem.text = buildContextStatusText(snapshot);
    this.statusBarItem.tooltip = new vscode.MarkdownString(buildContextStatusTooltip(snapshot));
  }
}

export function buildContextStatusText(snapshot: LastContextUsageSnapshot | undefined): string {
  if (!snapshot || snapshot.totalContextWindow <= 0) {
    return 'CodingPlans Context --';
  }

  const percentage = Math.min(100, Math.max(0, Math.round((snapshot.totalTokens / snapshot.totalContextWindow) * 100)));
  return `CodingPlans Context ${percentage}%`;
}

export function buildContextStatusTooltip(snapshot: LastContextUsageSnapshot | undefined): string {
  if (!snapshot || snapshot.totalContextWindow <= 0) {
    return [
      '**CodingPlans Context**',
      '',
      'No completed request usage is available yet.'
    ].join('\n');
  }

  const ratio = Number(((snapshot.totalTokens / snapshot.totalContextWindow) * 100).toFixed(1));
  const recordedAt = new Date(snapshot.recordedAt).toISOString();

  return [
    '**CodingPlans Context**',
    '',
    `${ratio}% of ${formatCompactTokens(snapshot.totalContextWindow)}`,
    '',
    `- Prompt: ${formatCompactTokens(snapshot.promptTokens)}`,
    `- Completion: ${formatCompactTokens(snapshot.completionTokens)}`,
    `- Total: ${formatCompactTokens(snapshot.totalTokens)}`,
    `- Reserved Output: ${snapshot.outputBuffer === undefined ? '--' : formatCompactTokens(snapshot.outputBuffer)}`,
    `- Model: ${snapshot.modelName}`,
    `- Updated: ${recordedAt}`
  ].join('\n');
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
