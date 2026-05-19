import * as vscode from 'vscode';
import { ContextUsageState } from './contextUsageState';
import { GenericAIProvider } from './providers/genericProvider';
import { LMChatProviderAdapter } from './providers/lmChatProviderAdapter';
import { ConfigStore } from './config/configStore';
import { CodingPlanStatusBarController, PlanUsagePollingController, PlanUsageState } from './planUsageStatus';
import { initI18n, getMessage } from './i18n/i18n';
import { getCompactErrorMessage } from './providers/baseProvider';
import {
  generateCommitMessage,
  invalidateCommitMessageModelSelectionCache,
  registerCommitMessageModelSource,
  selectCommitMessageModel
} from './commitMessageGenerator';
import {
  CODING_PLANS_VENDOR,
  LANGUAGE_MODELS_REFRESH_LOG_PREFIX,
  PREFERRED_LANGUAGE_MODELS_REFRESH_COMMANDS,
  REFRESH_MODELS_COMMAND
} from './constants';
import { logger } from './logging/outputChannelLogger';

let providers: Map<string, GenericAIProvider> = new Map();
let refreshModelsCommandInProgress = false;
let languageModelProviderRegistration: vscode.Disposable | undefined;
let reRegisterLanguageModelProviderInProgress = false;
let languageModelsUiSyncInFlight: Promise<void> | undefined;
let languageModelsUiSyncPending = false;
const pendingLanguageModelsUiSyncReasons = new Set<string>();
let suppressProviderModelChangeUiSyncDepth = 0;

type ManageVendorAction = 'apiKey' | 'refreshModels' | 'openSettings';

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

function summarizeConfiguredVendorsForLog(configStore: ConfigStore): Array<Record<string, unknown>> {
  return configStore.getVendors().map(vendor => ({
    name: vendor.name,
    baseUrl: vendor.baseUrl,
    defaultApiStyle: vendor.defaultApiStyle,
    useModelsEndpoint: vendor.useModelsEndpoint,
    defaultVision: vendor.defaultVision,
    modelCount: vendor.models.length,
    modelNamesPreview: vendor.models.slice(0, 20).map(model => model.name)
  }));
}

function summarizeInternalLanguageModelsForLog(
  models: ReturnType<GenericAIProvider['getAvailableModels']>
): Array<Record<string, unknown>> {
  return models.slice(0, 20).map(model => ({
    id: model.id,
    vendor: model.vendor,
    family: model.family,
    name: model.name,
    version: model.version,
    apiStyle: model.apiStyle,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    capabilities: model.capabilities
  }));
}

function summarizeVSCodeLanguageModelsForLog(
  models: readonly vscode.LanguageModelChat[]
): Array<Record<string, unknown>> {
  return models.slice(0, 20).map(model => {
    const modelWithOutputLimit = model as vscode.LanguageModelChat & { maxOutputTokens?: number };
    return ({
      id: model.id,
      vendor: model.vendor,
      family: model.family,
      name: model.name,
      version: model.version,
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: modelWithOutputLimit.maxOutputTokens
    });
  });
}

async function logLanguageModelInventorySnapshot(
  reason: string,
  genericProvider: GenericAIProvider,
  configStore: ConfigStore
): Promise<void> {
  const internalModels = genericProvider.getAvailableModels();
  const configuredVendors = summarizeConfiguredVendorsForLog(configStore);
  logger.debug(`${LANGUAGE_MODELS_REFRESH_LOG_PREFIX} inventory snapshot start`, {
    reason,
    configuredVendors,
    internalModelCount: internalModels.length,
    internalModels: summarizeInternalLanguageModelsForLog(internalModels)
  });

  if (!vscode.lm || typeof vscode.lm.selectChatModels !== 'function') {
    logger.warn(`${LANGUAGE_MODELS_REFRESH_LOG_PREFIX} inventory snapshot skipped because selectChatModels API is unavailable`, {
      reason
    });
    return;
  }

  try {
    const models = await vscode.lm.selectChatModels({ vendor: CODING_PLANS_VENDOR });
    logger.info(`${LANGUAGE_MODELS_REFRESH_LOG_PREFIX} inventory snapshot resolved`, {
      reason,
      configuredVendorCount: configuredVendors.length,
      internalModelCount: internalModels.length,
      internalModelIds: internalModels.map(model => model.id),
      selectChatModelsCount: models.length,
      selectChatModelsModels: summarizeVSCodeLanguageModelsForLog(models)
    });
  } catch (error) {
    logger.warn(`${LANGUAGE_MODELS_REFRESH_LOG_PREFIX} inventory snapshot failed`, {
      reason,
      configuredVendors,
      internalModelCount: internalModels.length,
      internalModelIds: internalModels.map(model => model.id),
      error: getCompactErrorMessage(error)
    });
  }
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

async function synchronizeLanguageModelsUiOnce(
  reason: string,
  configStore: ConfigStore,
  genericProvider: GenericAIProvider,
  adapter: LMChatProviderAdapter
): Promise<void> {
  adapter.notifyLanguageModelInformationChanged();
  logger.info(`${LANGUAGE_MODELS_REFRESH_LOG_PREFIX} provider change event emitted`, { reason });

  const executedCommand = await refreshLanguageModelsWorkbenchView();
  const reRegistered = executedCommand ? false : await reRegisterLanguageModelProvider(adapter);
  const snapshotReason = executedCommand
    ? `after-workbench-refresh:${reason}:${executedCommand}`
    : reRegistered
      ? `after-provider-reregister:${reason}`
      : `after-provider-notified:${reason}`;

  await logLanguageModelInventorySnapshot(snapshotReason, genericProvider, configStore);
  logger.info(`${LANGUAGE_MODELS_REFRESH_LOG_PREFIX} UI synchronization completed`, {
    reason,
    executedCommand,
    reRegistered
  });
}

async function synchronizeLanguageModelsUi(
  reason: string,
  configStore: ConfigStore,
  genericProvider: GenericAIProvider,
  adapter: LMChatProviderAdapter
): Promise<void> {
  pendingLanguageModelsUiSyncReasons.add(reason);

  if (languageModelsUiSyncInFlight) {
    languageModelsUiSyncPending = true;
    logger.debug(`${LANGUAGE_MODELS_REFRESH_LOG_PREFIX} queued UI synchronization`, {
      reason,
      pendingReasons: Array.from(pendingLanguageModelsUiSyncReasons)
    });
    return languageModelsUiSyncInFlight;
  }

  const running = (async () => {
    do {
      languageModelsUiSyncPending = false;
      const reasons = Array.from(pendingLanguageModelsUiSyncReasons);
      pendingLanguageModelsUiSyncReasons.clear();
      const mergedReason = reasons.join(',');
      logger.info(`${LANGUAGE_MODELS_REFRESH_LOG_PREFIX} UI synchronization start`, {
        reason: mergedReason,
        internalModelCount: genericProvider.getAvailableModels().length,
        internalModelIds: genericProvider.getAvailableModels().map(model => model.id)
      });
      await synchronizeLanguageModelsUiOnce(mergedReason, configStore, genericProvider, adapter);
    } while (languageModelsUiSyncPending || pendingLanguageModelsUiSyncReasons.size > 0);
  })();

  languageModelsUiSyncInFlight = running;
  try {
    await running;
  } finally {
    if (languageModelsUiSyncInFlight === running) {
      languageModelsUiSyncInFlight = undefined;
    }
  }
}

async function withSuppressedProviderModelChangeUiSync<T>(
  callback: () => Promise<T>
): Promise<T> {
  suppressProviderModelChangeUiSyncDepth += 1;
  try {
    return await callback();
  } finally {
    suppressProviderModelChangeUiSyncDepth = Math.max(0, suppressProviderModelChangeUiSyncDepth - 1);
  }
}

async function refreshCodingPlansModels(
  configStore: ConfigStore,
  genericProvider: GenericAIProvider,
  adapter: LMChatProviderAdapter
): Promise<void> {
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

  await withSuppressedProviderModelChangeUiSync(
    () => genericProvider.refreshModels({ forceDiscoveryRetry: true })
  );
  const afterModels = genericProvider.getAvailableModels().map(model => model.id);
  logger.info(`${LANGUAGE_MODELS_REFRESH_LOG_PREFIX} provider refreshed`, {
    afterCount: afterModels.length,
    afterPreview: afterModels.slice(0, 20)
  });
  await logLanguageModelInventorySnapshot('after-provider-refresh', genericProvider, configStore);
  await synchronizeLanguageModelsUi('refresh-command', configStore, genericProvider, adapter);
  logger.info(`${LANGUAGE_MODELS_REFRESH_LOG_PREFIX} command completed`);
}

export async function manageVendorConfiguration(
  configStore: ConfigStore,
  genericProvider: GenericAIProvider,
  adapter: LMChatProviderAdapter
): Promise<void> {
  const vendors = configStore.getVendors();
  if (vendors.length === 0) {
    const action = getMessage('manageActionOpenSettings');
    const picked = await vscode.window.showWarningMessage(getMessage('vendorNotConfigured'), action);
    if (picked === action) {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'coding-plans.vendors');
    }
    return;
  }

  const pickedVendor = await vscode.window.showQuickPick(
    vendors.map(vendor => ({
      label: vendor.name,
      description: vendor.defaultApiStyle,
      detail: vendor.baseUrl,
      vendor
    })),
    {
      placeHolder: getMessage('manageActionSelectVendor'),
      ignoreFocusOut: true
    }
  );
  if (!pickedVendor) {
    return;
  }

  const pickedAction = await vscode.window.showQuickPick(
    [
      {
        label: getMessage('manageActionApiKey'),
        action: 'apiKey' as ManageVendorAction
      },
      {
        label: getMessage('manageActionRefreshModels'),
        action: 'refreshModels' as ManageVendorAction
      },
      {
        label: getMessage('manageActionOpenSettings'),
        action: 'openSettings' as ManageVendorAction
      }
    ],
    {
      placeHolder: getMessage('manageActionPlaceholder', pickedVendor.vendor.name),
      ignoreFocusOut: true
    }
  );
  if (!pickedAction) {
    return;
  }

  if (pickedAction.action === 'openSettings') {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'coding-plans.vendors');
    return;
  }

  if (pickedAction.action === 'refreshModels') {
    await refreshCodingPlansModels(configStore, genericProvider, adapter);
    vscode.window.showInformationMessage(getMessage('modelsRefreshed', 'Coding Plan'));
    return;
  }

  const apiKey = await vscode.window.showInputBox({
    prompt: getMessage('inputApiKey', pickedVendor.vendor.name),
    placeHolder: getMessage('inputPlaceholder'),
    password: true,
    ignoreFocusOut: true
  });
  if (apiKey === undefined) {
    return;
  }

  await configStore.setApiKey(pickedVendor.vendor.name, apiKey);
  vscode.window.showInformationMessage(getMessage('apiKeySaved', pickedVendor.vendor.name));
  await refreshCodingPlansModels(configStore, genericProvider, adapter);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await initI18n();
  context.subscriptions.push(logger);
  logger.info(getMessage('extensionActivated'));
  logger.info(`${LANGUAGE_MODELS_REFRESH_LOG_PREFIX} activation environment`, {
    vscodeVersion: vscode.version,
    hasLanguageModelsNamespace: !!vscode.lm,
    hasRegisterLanguageModelChatProvider: typeof vscode.lm?.registerLanguageModelChatProvider === 'function',
    hasSelectChatModels: typeof vscode.lm?.selectChatModels === 'function',
    hasOnDidChangeChatModels: typeof vscode.lm?.onDidChangeChatModels === 'function'
  });

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
        logger.info(`${LANGUAGE_MODELS_REFRESH_LOG_PREFIX} vscode.lm.onDidChangeChatModels fired`);
        void logLanguageModelInventorySnapshot(
          'vscode.lm.onDidChangeChatModels',
          genericProvider,
          configStore
        ).catch(error => {
          logger.warn(`${LANGUAGE_MODELS_REFRESH_LOG_PREFIX} failed to log inventory after onDidChangeChatModels`, {
            error: getCompactErrorMessage(error)
          });
        });
      })
    );
  }

  const configStore = new ConfigStore(context);
  context.subscriptions.push(configStore);
  const contextUsageState = new ContextUsageState();
  context.subscriptions.push(contextUsageState);
  const planUsageState = new PlanUsageState();
  context.subscriptions.push(planUsageState);
  const codingPlanStatusBarController = new CodingPlanStatusBarController(
    contextUsageState,
    planUsageState
  );
  context.subscriptions.push(codingPlanStatusBarController);
  const planUsagePollingController = new PlanUsagePollingController(configStore, planUsageState, contextUsageState);
  context.subscriptions.push(planUsagePollingController);

  const genericProvider = new GenericAIProvider(context, configStore);
  providers.set('coding-plans', genericProvider);
  registerCommitMessageModelSource({
    getAvailableModels: () => genericProvider.getAvailableModels(),
    refreshModels: () => genericProvider.refreshModels()
  });

  const adapter = new LMChatProviderAdapter(genericProvider, configStore, contextUsageState);
  context.subscriptions.push(adapter);
  context.subscriptions.push(
    genericProvider.onDidChangeModels(() => {
      if (suppressProviderModelChangeUiSyncDepth > 0) {
        logger.debug(`${LANGUAGE_MODELS_REFRESH_LOG_PREFIX} skipped automatic UI synchronization for managed provider refresh`, {
          suppressionDepth: suppressProviderModelChangeUiSyncDepth
        });
        return;
      }
      void synchronizeLanguageModelsUi(
        'provider-models-changed',
        configStore,
        genericProvider,
        adapter
      ).catch(error => {
        logger.warn(`${LANGUAGE_MODELS_REFRESH_LOG_PREFIX} failed to synchronize UI after provider model change`, {
          error: getCompactErrorMessage(error)
        });
      });
    })
  );
  context.subscriptions.push(new vscode.Disposable(() => {
    languageModelProviderRegistration?.dispose();
    languageModelProviderRegistration = undefined;
  }));
  void withSuppressedProviderModelChangeUiSync(
    () => genericProvider.initialize()
  ).then(async () => {
    logger.info(`${LANGUAGE_MODELS_REFRESH_LOG_PREFIX} generic provider initialization completed`, {
      internalModelCount: genericProvider.getAvailableModels().length,
      internalModelIds: genericProvider.getAvailableModels().map(model => model.id)
    });
    registerLanguageModelProvider(adapter);
    void logLanguageModelInventorySnapshot('after-register-language-model-provider', genericProvider, configStore).catch(error => {
      logger.warn(`${LANGUAGE_MODELS_REFRESH_LOG_PREFIX} failed to log inventory after provider registration`, {
        error: getCompactErrorMessage(error)
      });
    });
    if (genericProvider.getAvailableModels().length > 0) {
      await synchronizeLanguageModelsUi(
        'after-generic-provider-initialize',
        configStore,
        genericProvider,
        adapter
      );
    } else {
      await logLanguageModelInventorySnapshot('after-generic-provider-initialize', genericProvider, configStore);
    }
  }).catch(error => {
    logger.error('Failed to initialize generic provider models.', error);
    registerLanguageModelProvider(adapter);
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('coding-plans.manage', async () => {
      await manageVendorConfiguration(configStore, genericProvider, adapter);
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
        await refreshCodingPlansModels(configStore, genericProvider, adapter);
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
  registerCommitMessageModelSource(undefined);
  providers.forEach(provider => provider.dispose());
  providers.clear();
}




