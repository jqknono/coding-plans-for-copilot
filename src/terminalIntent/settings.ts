import * as vscode from 'vscode';
import {
  DEFAULT_TERMINAL_INTENT_ENABLED,
  DEFAULT_TERMINAL_INTENT_MAX_ENTRIES,
  TERMINAL_INTENT_ENABLED_SETTING_KEY,
  TERMINAL_INTENT_MAX_ENTRIES_SETTING_KEY,
} from '../constants';

export function isTerminalIntentCaptureEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('coding-plans')
    .get<boolean>(TERMINAL_INTENT_ENABLED_SETTING_KEY, DEFAULT_TERMINAL_INTENT_ENABLED);
}

export function readTerminalIntentMaxEntries(): number {
  const configured = vscode.workspace
    .getConfiguration('coding-plans')
    .get<number>(TERMINAL_INTENT_MAX_ENTRIES_SETTING_KEY, DEFAULT_TERMINAL_INTENT_MAX_ENTRIES);
  if (!Number.isFinite(configured) || configured < 1) {
    return DEFAULT_TERMINAL_INTENT_MAX_ENTRIES;
  }
  return Math.floor(configured);
}
