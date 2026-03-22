import * as vscode from 'vscode';
import { ContextStatusBarController, ContextUsageState } from './contextUsageState';
import { GenericAIProvider } from './providers/genericProvider';
import { LMChatProviderAdapter } from './providers/lmChatProviderAdapter';
import { ConfigStore } from './config/configStore';
import { initI18n, getMessage } from './i18n/i18n';
import { getCompactErrorMessage } from './providers/baseProvider';
import {
  generateCommitMessage,
  invalidateCommitMessageModelSelectionCache,
  selectCommitMessageModel
} from './commitMessageGenerator';
import {
  COMMIT_MESSAGE_SHOW_GENERATE_CONTEXT_KEY,
  COMMIT_MESSAGE_SHOW_GENERATE_SETTING_KEY,
  LANGUAGE_MODELS_REFRESH_LOG_PREFIX,
  PREFERRED_LANGUAGE_MODELS_REFRESH_COMMANDS,
  REFRESH_MODELS_COMMAND
} from './constants';
import { logger } from './logging/outputChannelLogger';

let providers: Map<string, GenericAIProvider> = new Map();
let refreshModelsCommandInProgress = false;
let languageModelProviderRegistration: vscode.Disposable | undefined;
let reRegisterLanguageModelProviderInProgress = false;

function shouldShowGenerateCommitMessageCommand(): boolean {
  return vscode.workspace
    .getConfiguration('coding-plans')
    .get<boolean>(COMMIT_MESSAGE_SHOW_GENERATE_SETTING_KEY, true);
}

async function syncGenerateCommitMessageCommandVisibility(): Promise<void> {
  await vscode.commands.executeCommand(
    'setContext',
    COMMIT_MESSAGE_SHOW_GENERATE_CONTEXT_KEY,
    shouldShowGenerateCommitMessageCommand()
  );
}

function isLikelyLanguageModelsRefreshCommand(command: string): boolean {
  const lower = command.toLowerCase();
  return lower.includes('refresh')
    && (
      lower.includes('languagemodel')
      || lower.includes('language-model')
      || lower.includes('languagemodels')
    );
}

function isPotentialLanguageModelsRefreshCommand(command: string): boolean {
  const lower = command.toLowerCase();
  return lower.includes('refresh')
    && (
      lower.includes('language')
      || lower.includes('model')
      || lower.includes('chat')
      || lower.includes('lm')
    );
}

function isSafeWorkbenchRefreshCommand(command: string): boolean {
  if (command === REFRESH_MODELS_COMMAND) {
    return false;
  }

  // Avoid invoking other extension commands to prevent re-entrancy loops.
  return command.startsWith('workbench.action.');
}

function uniqueCommands(commands: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const command of commands) {
    if (seen.has(command)) {
      continue;
    }
    seen.add(command);
    deduped.push(command);
  }
  return deduped;
}

async function refreshLanguageModelsWorkbenchView(): Promise<string | undefined> {
  try {
    const allCommands = await vscode.commands.getCommands(true);
    const commandSet = new Set(allCommands);
    const preferredAvailable = PREFERRED_LANGUAGE_MODELS_REFRESH_COMMANDS
      .filter(command => commandSet.has(command))
      .filter(command => isSafeWorkbenchRefreshCommand(command));
    const discoveredStrict = allCommands
      .filter(command => isLikelyLanguageModelsRefreshCommand(command))
      .filter(command => isSafeWorkbenchRefreshCommand(command))
      .filter(command => !PREFERRED_LANGUAGE_MODELS_REFRESH_COMMANDS.includes(command))
      .sort();
    const discoveredLoose = allCommands
      .filter(command => isPotentialLanguageModelsRefreshCommand(command))
      .filter(command => isSafeWorkbenchRefreshCommand(command))
      .filter(command => !PREFERRED_LANGUAGE_MODELS_REFRESH_COMMANDS.includes(command))
      .sort();

    const refreshCommands = uniqueCommands([
      ...PREFERRED_LANGUAGE_MODELS_REFRESH_COMMANDS,
      ...discoveredStrict,
      ...discoveredLoose
    ]);

    logger.info(`${LANGUAGE_MODELS_REFRESH_LOG_PREFIX} candidates`, {
      preferredAvailable,
      discoveredStrictCount: discoveredStrict.length,
      discoveredStrictPreview: discoveredStrict.slice(0, 20),
      discoveredLooseCount: discoveredLoose.length,
      discoveredLoosePreview: discoveredLoose.slice(0, 20)
    });

    const attempted: string[] = [];
    for (const command of refreshCommands) {
      if (!commandSet.has(command)) {
        continue;
      }
      attempted.push(command);
      try {
        await vscode.commands.executeCommand(command);
        logger.info(`${LANGUAGE_MODELS_REFRESH_LOG_PREFIX} executed refresh command`, { command, attempted });
        return command;
      } catch (error) {
        logger.debug(`${LANGUAGE_MODELS_REFRESH_LOG_PREFIX} failed refresh command`, { command, error });
      }
    }
    logger.warn(`${LANGUAGE_MODELS_REFRESH_LOG_PREFIX} no refresh command executed`, { attempted });
  } catch (error) {
    logger.debug(`${LANGUAGE_MODELS_REFRESH_LOG_PREFIX} failed to resolve refresh commands`, { error });
  }

  return undefined;
}

function registerLanguageModelProvider(adapter: LMChatProviderAdapter): boolean {
  if (typeof vscode.lm.registerLanguageModelChatProvider !== 'function') {
    logger.warn('LanguageModelChatProvider API is unavailable; chat provider registration is skipped.');
    return false;
  }

  try {
    languageModelProviderRegistration?.dispose();
    languageModelProviderRegistration = vscode.lm.registerLanguageModelChatProvider('coding-plans', adapter);
    logger.info(`${LANGUAGE_MODELS_REFRESH_LOG_PREFIX} language model provider registered`);
    return true;
  } catch (error) {
    logger.error('Failed to register language model chat provider.', error);
    return false;
  }
}

async function reRegisterLanguageModelProvider(adapter: LMChatProviderAdapter): Promise<boolean> {
  if (reRegisterLanguageModelProviderInProgress) {
    logger.warn(`${LANGUAGE_MODELS_REFRESH_LOG_PREFIX} skipped re-register while previous re-register is in progress`);
    return false;
  }

  reRegisterLanguageModelProviderInProgress = true;
  try {
    logger.info(`${LANGUAGE_MODELS_REFRESH_LOG_PREFIX} re-registering language model provider`);
    return registerLanguageModelProvider(adapter);
  } finally {
    reRegisterLanguageModelProviderInProgress = false;
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await initI18n();
  context.subscriptions.push(logger);
  logger.info(getMessage('extensionActivated'));

  await syncGenerateCommitMessageCommandVisibility();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration(`coding-plans.${COMMIT_MESSAGE_SHOW_GENERATE_SETTING_KEY}`)) {
        void syncGenerateCommitMessageCommandVisibility();
      }
    })
  );

  // Register commit-message commands first so they remain available
  // even if provider initialization fails.
  context.subscriptions.push(
    vscode.commands.registerCommand('coding-plans.generateCommitMessage', generateCommitMessage)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('coding-plans.selectCommitMessageModel', selectCommitMessageModel)
  );
  if (typeof vscode.lm?.onDidChangeChatModels === 'function') {
    context.subscriptions.push(
      vscode.lm.onDidChangeChatModels(() => {
        invalidateCommitMessageModelSelectionCache('vscode.lm.onDidChangeChatModels');
      })
    );
  }

  const configStore = new ConfigStore(context);
  context.subscriptions.push(configStore);
  const contextUsageState = new ContextUsageState();
  context.subscriptions.push(contextUsageState);
  const contextStatusBarController = new ContextStatusBarController(contextUsageState);
  context.subscriptions.push(contextStatusBarController);

  const genericProvider = new GenericAIProvider(context, configStore);
  void genericProvider.initialize().catch(error => {
    logger.error('Failed to initialize generic provider models.', error);
  });
  providers.set('coding-plans', genericProvider);

  const adapter = new LMChatProviderAdapter(genericProvider, configStore, contextUsageState);
  context.subscriptions.push(adapter);
  registerLanguageModelProvider(adapter);
  context.subscriptions.push(new vscode.Disposable(() => {
    languageModelProviderRegistration?.dispose();
    languageModelProviderRegistration = undefined;
  }));

  context.subscriptions.push(
    vscode.commands.registerCommand('coding-plans.manage', async () => {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'coding-plans.vendors');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(REFRESH_MODELS_COMMAND, async () => {
      if (refreshModelsCommandInProgress) {
        logger.warn(`${LANGUAGE_MODELS_REFRESH_LOG_PREFIX} skipped re-entrant refresh command`);
        return;
      }

      refreshModelsCommandInProgress = true;
      try {
        const vendorSummary = configStore.getVendors().map(vendor => ({
          name: vendor.name,
          useModelsEndpoint: vendor.useModelsEndpoint,
          modelCount: vendor.models.length
        }));
        logger.info(`${LANGUAGE_MODELS_REFRESH_LOG_PREFIX} effective vendors`, vendorSummary);

        const beforeModels = genericProvider.getAvailableModels().map(model => model.id);
        logger.info(`${LANGUAGE_MODELS_REFRESH_LOG_PREFIX} command start`, {
          beforeCount: beforeModels.length,
          beforePreview: beforeModels.slice(0, 20)
        });

        await genericProvider.refreshModels({ forceDiscoveryRetry: true });
        const afterModels = genericProvider.getAvailableModels().map(model => model.id);
        logger.info(`${LANGUAGE_MODELS_REFRESH_LOG_PREFIX} provider refreshed`, {
          afterCount: afterModels.length,
          afterPreview: afterModels.slice(0, 20)
        });

        adapter.notifyLanguageModelInformationChanged();
        logger.info(`${LANGUAGE_MODELS_REFRESH_LOG_PREFIX} provider change event emitted`);

        const executedCommand = await refreshLanguageModelsWorkbenchView();
        if (!executedCommand) {
          await reRegisterLanguageModelProvider(adapter);
        }
        logger.info(`${LANGUAGE_MODELS_REFRESH_LOG_PREFIX} command completed`, { executedCommand });
        vscode.window.showInformationMessage(getMessage('modelsRefreshed', 'Coding Plan'));
      } catch (error) {
        vscode.window.showErrorMessage(
          getMessage('refreshModelsFailed', getCompactErrorMessage(error))
        );
      } finally {
        refreshModelsCommandInProgress = false;
      }
    })
  );

}

export function deactivate(): void {
  logger.info(getMessage('extensionDeactivated'));
  providers.forEach(provider => provider.dispose());
  providers.clear();
}




