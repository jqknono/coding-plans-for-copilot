import * as vscode from 'vscode';

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
type ConfiguredLogLevel = LogLevel | 'off';

const LOG_LEVEL_SETTING = 'coding-plans.logLevel';
const SET_DEFAULT_LOG_LEVEL_COMMAND = 'workbench.action.setDefaultLogLevel';

const LOG_LEVEL_VALUES: Record<LogLevel, vscode.LogLevel> = {
  trace: vscode.LogLevel.Trace,
  debug: vscode.LogLevel.Debug,
  info: vscode.LogLevel.Info,
  warn: vscode.LogLevel.Warning,
  error: vscode.LogLevel.Error,
};

class LogOutputChannelLogger implements vscode.Disposable {
  private channel: vscode.LogOutputChannel | undefined;
  private configurationListener: vscode.Disposable | undefined;
  private extensionId: string | undefined;

  constructor(private readonly channelName: string) {}

  async configureNativeLogLevel(extensionId: string): Promise<void> {
    this.extensionId = extensionId;
    this.getChannel();
    if (!this.configurationListener) {
      this.configurationListener = vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(LOG_LEVEL_SETTING)) {
          void this.applyConfiguredNativeLogLevel();
        }
      });
    }
    await this.applyConfiguredNativeLogLevel();
  }

  trace(message: string, data?: unknown): void {
    this.write('trace', message, data);
  }

  info(message: string, data?: unknown): void {
    this.write('info', message, data);
  }

  warn(message: string, data?: unknown): void {
    this.write('warn', message, data);
  }

  error(message: string, data?: unknown): void {
    this.write('error', message, data);
  }

  debug(message: string, data?: unknown): void {
    this.write('debug', message, data);
  }

  isTraceEnabled(): boolean {
    return this.isLevelEnabled('trace');
  }

  dispose(): void {
    this.configurationListener?.dispose();
    this.configurationListener = undefined;
    this.extensionId = undefined;
    this.channel?.dispose();
    this.channel = undefined;
  }

  private getChannel(): vscode.LogOutputChannel {
    if (!this.channel) {
      this.channel = vscode.window.createOutputChannel(this.channelName, { log: true });
    }
    return this.channel;
  }

  private write(level: LogLevel, message: string, data?: unknown): void {
    if (!this.isLevelEnabled(level)) {
      return;
    }

    const suffix = data === undefined ? '' : ` ${this.stringify(data)}`;
    this.getChannel()[level](`${message}${suffix}`);
  }

  private isLevelEnabled(level: LogLevel): boolean {
    const channelLogLevel = this.getChannel().logLevel;
    return channelLogLevel !== vscode.LogLevel.Off && channelLogLevel <= LOG_LEVEL_VALUES[level];
  }

  private async applyConfiguredNativeLogLevel(): Promise<void> {
    if (!this.extensionId) {
      return;
    }

    const configured = vscode.workspace
      .getConfiguration('coding-plans')
      .get<ConfiguredLogLevel>('logLevel', 'info');
    const logLevel = this.toNativeLogLevel(configured);
    try {
      await vscode.commands.executeCommand(SET_DEFAULT_LOG_LEVEL_COMMAND, logLevel, this.extensionId);
    } catch (error) {
      this.getChannel().warn(`Failed to apply configured native log level: ${this.stringify(error)}`);
    }
  }

  private toNativeLogLevel(level: ConfiguredLogLevel): vscode.LogLevel {
    if (level === 'off') {
      return vscode.LogLevel.Off;
    }
    return LOG_LEVEL_VALUES[level] ?? vscode.LogLevel.Info;
  }

  private stringify(data: unknown): string {
    if (typeof data === 'string') {
      return data;
    }

    try {
      return JSON.stringify(data, (_key, value) => {
        if (value instanceof Error) {
          return {
            name: value.name,
            message: value.message,
            stack: value.stack,
          };
        }
        return value;
      });
    } catch {
      return String(data);
    }
  }
}

export const logger = new LogOutputChannelLogger('Coding Plans');
