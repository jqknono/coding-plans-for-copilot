import * as vscode from 'vscode';
import { DEFAULT_TERMINAL_INTENT_MAX_ENTRIES } from '../constants';
import { extractTerminalIntent } from './extract';
import { isTerminalIntentCaptureEnabled, readTerminalIntentMaxEntries } from './settings';
import { TerminalIntentRecord, TerminalIntentToolCallLike } from './types';

export class TerminalIntentStore implements vscode.Disposable {
  private readonly entries: TerminalIntentRecord[] = [];
  private readonly knownCallIds = new Set<string>();
  private readonly onDidChangeEmitter = new vscode.EventEmitter<readonly TerminalIntentRecord[]>();
  public readonly onDidChange = this.onDidChangeEmitter.event;
  private maxEntries: number;

  constructor(maxEntries: number = DEFAULT_TERMINAL_INTENT_MAX_ENTRIES) {
    this.maxEntries = Math.max(1, Math.floor(maxEntries));
  }

  getEntries(): readonly TerminalIntentRecord[] {
    return this.entries;
  }

  setMaxEntries(maxEntries: number): void {
    const next = Math.max(1, Math.floor(maxEntries));
    if (next === this.maxEntries) {
      return;
    }
    this.maxEntries = next;
    if (this.trimToMaxEntries()) {
      this.onDidChangeEmitter.fire(this.entries);
    }
  }

  captureFromToolCall(part: TerminalIntentToolCallLike, timestamp: number = Date.now()): TerminalIntentRecord | undefined {
    if (!isTerminalIntentCaptureEnabled()) {
      return undefined;
    }

    this.setMaxEntries(readTerminalIntentMaxEntries());
    const record = extractTerminalIntent(part, timestamp);
    if (!record) {
      return undefined;
    }
    return this.add(record);
  }

  add(record: TerminalIntentRecord): TerminalIntentRecord | undefined {
    if (this.knownCallIds.has(record.callId)) {
      return undefined;
    }

    this.knownCallIds.add(record.callId);
    this.entries.unshift(record);
    this.trimToMaxEntries();
    this.onDidChangeEmitter.fire(this.entries);
    return record;
  }

  clear(): void {
    if (this.entries.length === 0 && this.knownCallIds.size === 0) {
      return;
    }
    this.entries.length = 0;
    this.knownCallIds.clear();
    this.onDidChangeEmitter.fire(this.entries);
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
    this.entries.length = 0;
    this.knownCallIds.clear();
  }

  private trimToMaxEntries(): boolean {
    if (this.entries.length <= this.maxEntries) {
      return false;
    }

    const removed = this.entries.splice(this.maxEntries);
    for (const record of removed) {
      this.knownCallIds.delete(record.callId);
    }
    return removed.length > 0;
  }
}
