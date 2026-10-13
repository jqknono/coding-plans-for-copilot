import * as vscode from 'vscode';
import {
  TERMINAL_INTENT_CLEAR_COMMAND,
  TERMINAL_INTENT_FOCUS_COMMAND,
  TERMINAL_INTENT_VIEW_ID,
} from '../constants';
import { getMessage } from '../i18n/i18n';
import { TerminalIntentStore } from './store';
import { TerminalIntentRecord } from './types';

export class TerminalIntentViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = TERMINAL_INTENT_VIEW_ID;

  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly store: TerminalIntentStore) {
    this.disposables.push(
      this.store.onDidChange(() => {
        this.render();
      }),
    );
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: false,
    };
    webviewView.description = getMessage('terminalIntentViewDescription');
    this.render();
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.view = undefined;
  }

  private render(): void {
    if (!this.view) {
      return;
    }
    this.view.webview.html = renderTerminalIntentHtml(this.store.getEntries());
  }
}

export function renderTerminalIntentHtml(entries: readonly TerminalIntentRecord[]): string {
  if (entries.length === 0) {
    return wrapHtml(`<p class="empty">${escapeHtml(getMessage('terminalIntentEmpty'))}</p>`);
  }

  const cards = entries
    .map((entry) => {
      const time = escapeHtml(formatIntentTimestamp(entry.timestamp));
      const goal = escapeHtml(entry.goal || getMessage('terminalIntentMissingGoal'));
      const explanation = escapeHtml(entry.explanation || getMessage('terminalIntentMissingExplanation'));
      const command = entry.command ? renderCommandRow(entry.command) : '';
      return `
        <article class="card">
          <div class="meta">${time}</div>
          <div class="row"><span class="label">goal</span><div class="value">${goal}</div></div>
          <div class="row"><span class="label">explanation</span><div class="value">${explanation}</div></div>
          ${command}
        </article>
      `;
    })
    .join('\n');

  return wrapHtml(`<section class="list">${cards}</section>`);
}

export function clampCommandDisplayText(command: string, maxLines: number = 3): string {
  const normalized = command.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length <= maxLines) {
    return normalized;
  }
  return `${lines.slice(0, maxLines).join('\n')}\n…`;
}

function renderCommandRow(command: string): string {
  const displayText = clampCommandDisplayText(command, 3);
  const title = escapeHtml(command).replace(/\r?\n/g, '&#10;');
  return `<div class="row"><span class="label">command</span><code class="command" title="${title}">${escapeHtml(displayText)}</code></div>`;
}

function wrapHtml(body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      color-scheme: light dark;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
    }
    body {
      margin: 0;
      padding: 12px;
      background: transparent;
    }
    .empty {
      margin: 0;
      opacity: 0.75;
      line-height: 1.4;
    }
    .list {
      display: grid;
      gap: 10px;
    }
    .card {
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
      border-radius: 6px;
      padding: 10px;
      background: var(--vscode-editor-background);
    }
    .meta {
      margin-bottom: 8px;
      opacity: 0.7;
      font-size: 11px;
    }
    .row {
      display: grid;
      grid-template-columns: 88px 1fr;
      gap: 8px;
      margin-top: 6px;
      align-items: start;
    }
    .label {
      opacity: 0.7;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.02em;
    }
    .value, code.command {
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.4;
    }
    code.command {
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 3;
      overflow: hidden;
      max-height: calc(1.4em * 3);
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
    }
  </style>
</head>
<body>
  ${body}
</body>
</html>`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatIntentTimestamp(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return String(timestamp);
  }
}

export function registerTerminalIntentView(
  context: vscode.ExtensionContext,
  store: TerminalIntentStore,
): TerminalIntentViewProvider {
  const provider = new TerminalIntentViewProvider(store);
  context.subscriptions.push(provider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(TerminalIntentViewProvider.viewType, provider),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(TERMINAL_INTENT_CLEAR_COMMAND, () => {
      store.clear();
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(TERMINAL_INTENT_FOCUS_COMMAND, async () => {
      await vscode.commands.executeCommand(`${TERMINAL_INTENT_VIEW_ID}.focus`);
    }),
  );
  return provider;
}
