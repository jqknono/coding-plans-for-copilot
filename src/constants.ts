export const COMMIT_MESSAGE_SHOW_GENERATE_SETTING_KEY = 'commitMessage.showGenerateCommand';
export const COMMIT_MESSAGE_SHOW_GENERATE_CONTEXT_KEY = 'codingPlans.showGenerateCommitMessage';
export const LANGUAGE_MODELS_REFRESH_LOG_PREFIX = '[coding-plans][language-models-refresh]';
export const REFRESH_MODELS_COMMAND = 'coding-plans.refreshModels';
export const PREFERRED_LANGUAGE_MODELS_REFRESH_COMMANDS = [
  'workbench.action.chat.refreshLanguageModels',
  'workbench.action.languageModels.refresh',
  'workbench.action.chat.languageModels.refresh'
];

export const COMMIT_MESSAGE_MODEL_VENDOR_SETTING_KEY = 'commitMessage.modelVendor';
export const COMMIT_MESSAGE_MODEL_ID_SETTING_KEY = 'commitMessage.modelId';
export const COMMIT_MESSAGE_USE_RECENT_STYLE_SETTING_KEY = 'commitMessage.useRecentCommitStyle';
export const COMMIT_MESSAGE_OPTIONS_SETTING_KEY = 'commitMessage.options';
export const COMMIT_MESSAGE_OPTIONS_PROMPT_KEY = 'prompt';
export const COMMIT_MESSAGE_OPTIONS_MAX_DIFF_LINES_KEY = 'maxDiffLines';
export const COMMIT_MESSAGE_OPTIONS_PIPELINE_MODE_KEY = 'pipelineMode';
export const COMMIT_MESSAGE_OPTIONS_SUMMARY_TRIGGER_LINES_KEY = 'summaryTriggerLines';
export const COMMIT_MESSAGE_OPTIONS_SUMMARY_CHUNK_LINES_KEY = 'summaryChunkLines';
export const COMMIT_MESSAGE_OPTIONS_SUMMARY_MAX_CHUNKS_KEY = 'summaryMaxChunks';
export const COMMIT_MESSAGE_OPTIONS_MAX_BODY_BULLET_COUNT_KEY = 'maxBodyBulletCount';
export const COMMIT_MESSAGE_OPTIONS_SUBJECT_MAX_LENGTH_KEY = 'subjectMaxLength';
export const COMMIT_MESSAGE_OPTIONS_REQUIRE_CONVENTIONAL_TYPE_KEY = 'requireConventionalType';
export const COMMIT_MESSAGE_OPTIONS_WARN_ON_VALIDATION_FAILURE_KEY = 'warnOnValidationFailure';
export const COMMIT_MESSAGE_OPTIONS_LLM_MAX_PROMPT_LENGTH_KEY = 'llmMaxPromptLength';
export const COMMIT_MESSAGE_OPTIONS_LEGACY_RECENT_STYLE_MAX_TOTAL_LENGTH_KEY = 'recentStyleMaxTotalLength';
export const LEGACY_COMMIT_MESSAGE_PROMPT_SETTING_KEY = 'commitMessage.prompt';
export const LEGACY_COMMIT_MESSAGE_MAX_DIFF_LINES_SETTING_KEY = 'commitMessage.maxDiffLines';
export const LEGACY_COMMIT_MESSAGE_PIPELINE_MODE_SETTING_KEY = 'commitMessage.pipelineMode';
export const LEGACY_COMMIT_MESSAGE_SUMMARY_TRIGGER_LINES_SETTING_KEY = 'commitMessage.summaryTriggerLines';
export const LEGACY_COMMIT_MESSAGE_SUMMARY_CHUNK_LINES_SETTING_KEY = 'commitMessage.summaryChunkLines';
export const LEGACY_COMMIT_MESSAGE_SUMMARY_MAX_CHUNKS_SETTING_KEY = 'commitMessage.summaryMaxChunks';
export const LEGACY_COMMIT_MESSAGE_SUBJECT_MAX_LENGTH_SETTING_KEY = 'commitMessage.subjectMaxLength';
export const LEGACY_COMMIT_MESSAGE_REQUIRE_CONVENTIONAL_TYPE_SETTING_KEY = 'commitMessage.requireConventionalType';
export const LEGACY_COMMIT_MESSAGE_WARN_ON_VALIDATION_FAILURE_SETTING_KEY = 'commitMessage.warnOnValidationFailure';
export const DEFAULT_COMMIT_MESSAGE_MAX_DIFF_LINES = 3000;
export const DEFAULT_PIPELINE_MODE = 'single';
export const DEFAULT_SUMMARY_TRIGGER_LINES = 1200;
export const DEFAULT_SUMMARY_CHUNK_LINES = 800;
export const DEFAULT_SUMMARY_MAX_CHUNKS = 12;
export const DEFAULT_MAX_BODY_BULLET_COUNT = 7;
export const DEFAULT_SUBJECT_MAX_LENGTH = 72;
export const DEFAULT_REQUIRE_CONVENTIONAL_TYPE = true;
export const DEFAULT_WARN_ON_VALIDATION_FAILURE = true;
export const DEFAULT_RECENT_COMMIT_STYLE_SAMPLE_SIZE = 7;
export const RECENT_COMMIT_STYLE_MAX_ENTRY_LENGTH = 500;
export const DEFAULT_LLM_MAX_PROMPT_LENGTH = 5000;
export const COMMIT_LOG_ENTRY_SEPARATOR = '\u001e';
export const SELECT_CHAT_MODELS_TIMEOUT_MS = 10000;
export const SELECT_CHAT_MODELS_CACHE_TTL_MS = 30000;
export const REQUEST_CANCELLED_ERROR_CODE = 'coding-plans.requestCancelled';
export const COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX = '[coding-plans][commit-message-model-selection]';
export const CODING_PLANS_VENDOR = 'coding-plans';
export const COMMIT_MESSAGE_TASK_BLOCK = [
  'TASK: Generate a complete multi-line git commit message from change information.',
  'You are a Git commit message generator.'
].join('\n');
export const DEFAULT_COMMIT_FORMAT_PROMPT = [
  'FORMAT REQUIREMENT:',
  'Follow the Conventional Commits format: <type>(<scope>): <description>.',
  'Common types: feat, fix, docs, style, refactor, perf, test, build, ci, chore.',
  'Output ONLY the commit message, no explanation, no markdown fences.'
].join('\n');
export const SUMMARY_JSON_SCHEMA = [
  '{',
  '  "filesChanged": ["relative/path.ts"],',
  '  "majorChanges": ["what changed and why"],',
  '  "riskNotes": ["potential risk or migration note"],',
  '  "breakingChange": false',
  '}'
].join('\n');
export const PLACEHOLDER_MODEL_ID_SUFFIXES = ['__setup_api_key__', '__no_models__', '__unsupported__', '__vendor_not_configured__'] as const;
export const CONVENTIONAL_COMMIT_SUBJECT_RE = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9_.\-\/]+\))?!?: .+/i;

export const ADVANCED_OPTIONS_SETTING_KEY = 'advanced';
export const DEFAULT_ADVANCED_RESERVED_OUTPUT = 30000;
export const VENDOR_API_KEY_PREFIX = 'coding-plans.vendor.apiKey.';
export const DEFAULT_TOKEN_SIDE_LIMIT = 200000;
export const DEFAULT_CONTEXT_WINDOW_SIZE = DEFAULT_TOKEN_SIDE_LIMIT;
export const DEFAULT_REQUEST_MAX_TOKENS = DEFAULT_TOKEN_SIDE_LIMIT;
export const DEFAULT_RESERVED_OUTPUT_TOKENS = 30000;
export const DEFAULT_MODEL_CAPABILITIES_TOOLS = true;
export const DEFAULT_MODEL_CAPABILITIES_VISION = false;

export const LOG_LEVEL_PRIORITY = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40
} as const;

export const MODEL_VERSION_LABEL = 'Coding Plans for Copilot';
export const DEFAULT_CONFIGURED_MODELS: readonly string[] = [];
export const DEFAULT_MODEL_TOOLS = true;
export const NON_RETRYABLE_DISCOVERY_STATUS_CODES = new Set([400, 401, 403, 404]);
export const DEFAULT_TEMPERATURE = 0.2;
export const DEFAULT_TOP_P = 1.0;
export const RESPONSE_TRACE_ID_FIELD = '__codingPlansTraceId';
export const REQUEST_SOURCE_MODEL_OPTION_KEY = '__codingPlansRequestSource';
export const REQUEST_SOURCE_COMMIT_MESSAGE = 'commit-message';

export const ENABLE_CONTEXT_WINDOW_USAGE_REPORTING = true;
export const RESPONSE_USAGE_FIELD = '__codingPlansUsage';
