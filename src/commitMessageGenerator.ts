import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { getMessage } from './i18n/i18n';
import {
  CODING_PLANS_VENDOR,
  COMMIT_LOG_ENTRY_SEPARATOR,
  COMMIT_MESSAGE_MODEL_ID_SETTING_KEY,
  COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX,
  COMMIT_MESSAGE_MODEL_VENDOR_SETTING_KEY,
  COMMIT_MESSAGE_OPTIONS_LEGACY_RECENT_STYLE_MAX_TOTAL_LENGTH_KEY,
  COMMIT_MESSAGE_OPTIONS_LLM_MAX_PROMPT_LENGTH_KEY,
  COMMIT_MESSAGE_OPTIONS_MAX_BODY_BULLET_COUNT_KEY,
  COMMIT_MESSAGE_OPTIONS_MAX_DIFF_LINES_KEY,
  COMMIT_MESSAGE_OPTIONS_PIPELINE_MODE_KEY,
  COMMIT_MESSAGE_OPTIONS_PROMPT_KEY,
  COMMIT_MESSAGE_OPTIONS_REQUIRE_CONVENTIONAL_TYPE_KEY,
  COMMIT_MESSAGE_OPTIONS_SETTING_KEY,
  COMMIT_MESSAGE_OPTIONS_SUBJECT_MAX_LENGTH_KEY,
  COMMIT_MESSAGE_OPTIONS_SUMMARY_CHUNK_LINES_KEY,
  COMMIT_MESSAGE_OPTIONS_SUMMARY_MAX_CHUNKS_KEY,
  COMMIT_MESSAGE_OPTIONS_SUMMARY_TRIGGER_LINES_KEY,
  COMMIT_MESSAGE_OPTIONS_WARN_ON_VALIDATION_FAILURE_KEY,
  COMMIT_MESSAGE_TASK_BLOCK,
  COMMIT_MESSAGE_USE_RECENT_STYLE_SETTING_KEY,
  CONVENTIONAL_COMMIT_SUBJECT_RE,
  DEFAULT_COMMIT_FORMAT_PROMPT,
  DEFAULT_COMMIT_MESSAGE_MAX_DIFF_LINES,
  DEFAULT_LLM_MAX_PROMPT_LENGTH,
  DEFAULT_MAX_BODY_BULLET_COUNT,
  DEFAULT_PIPELINE_MODE,
  DEFAULT_RECENT_COMMIT_STYLE_SAMPLE_SIZE,
  DEFAULT_REQUIRE_CONVENTIONAL_TYPE,
  DEFAULT_SUBJECT_MAX_LENGTH,
  DEFAULT_SUMMARY_CHUNK_LINES,
  DEFAULT_SUMMARY_MAX_CHUNKS,
  DEFAULT_SUMMARY_TRIGGER_LINES,
  DEFAULT_WARN_ON_VALIDATION_FAILURE,
  LEGACY_COMMIT_MESSAGE_MAX_DIFF_LINES_SETTING_KEY,
  LEGACY_COMMIT_MESSAGE_PIPELINE_MODE_SETTING_KEY,
  LEGACY_COMMIT_MESSAGE_PROMPT_SETTING_KEY,
  LEGACY_COMMIT_MESSAGE_REQUIRE_CONVENTIONAL_TYPE_SETTING_KEY,
  LEGACY_COMMIT_MESSAGE_SUBJECT_MAX_LENGTH_SETTING_KEY,
  LEGACY_COMMIT_MESSAGE_SUMMARY_CHUNK_LINES_SETTING_KEY,
  LEGACY_COMMIT_MESSAGE_SUMMARY_MAX_CHUNKS_SETTING_KEY,
  LEGACY_COMMIT_MESSAGE_SUMMARY_TRIGGER_LINES_SETTING_KEY,
  LEGACY_COMMIT_MESSAGE_WARN_ON_VALIDATION_FAILURE_SETTING_KEY,
  PLACEHOLDER_MODEL_ID_SUFFIXES,
  REQUEST_SOURCE_COMMIT_MESSAGE,
  REQUEST_SOURCE_MODEL_OPTION_KEY,
  RECENT_COMMIT_STYLE_MAX_ENTRY_LENGTH,
  REQUEST_CANCELLED_ERROR_CODE,
  SELECT_CHAT_MODELS_CACHE_TTL_MS,
  SELECT_CHAT_MODELS_TIMEOUT_MS,
  SUMMARY_JSON_SCHEMA
} from './constants';
import { getCompactErrorMessage } from './providers/baseProvider';
import { logger } from './logging/outputChannelLogger';

interface GitExtension {
  getAPI(version: number): GitAPI;
}

interface GitAPI {
  repositories: GitRepository[];
  getRepository?(uri: vscode.Uri): GitRepository | null;
}

interface GitRepository {
  rootUri?: vscode.Uri;
  inputBox: { value: string };
  diff(cached?: boolean): Promise<string>;
  state: { indexChanges: unknown[]; workingTreeChanges: unknown[] };
}

type CommitMessageLanguage = 'en' | 'zh-cn';
type CommitMessagePipelineMode = 'single' | 'two-stage' | 'auto';
type LanguageEnforcementRule = {
  outputRequirement: string;
};

type CommitMessageSettings = {
  pipelineMode: CommitMessagePipelineMode;
  maxDiffLines: number;
  summaryTriggerLines: number;
  summaryChunkLines: number;
  summaryMaxChunks: number;
  maxBodyBulletCount: number;
  subjectMaxLength: number;
  requireConventionalType: boolean;
  warnOnValidationFailure: boolean;
  llmMaxPromptLength: number;
};

type CommitMessageOptions = {
  prompt?: string;
  maxDiffLines?: number;
  pipelineMode?: CommitMessagePipelineMode;
  summaryTriggerLines?: number;
  summaryChunkLines?: number;
  summaryMaxChunks?: number;
  maxBodyBulletCount?: number;
  subjectMaxLength?: number;
  requireConventionalType?: boolean;
  warnOnValidationFailure?: boolean;
  llmMaxPromptLength?: number;
  // Backward compatibility: old key name.
  recentStyleMaxTotalLength?: number;
};

type DiffSummary = {
  filesChanged: string[];
  majorChanges: string[];
  riskNotes: string[];
  breakingChange: boolean;
};

type PreparedGenerationInput =
  | { kind: 'diff'; diff: string; breakingChangeExpected: boolean }
  | {
    kind: 'summary';
    summary: DiffSummary;
    breakingChangeExpected: boolean;
    /**
     * Full diff can be very large; this is a truncated diff included ONLY as a reference
     * so the model can follow repository style while still having direct change context.
     */
    diffForReference: string;
    diffOriginalLines: number;
    diffTruncated: boolean;
  };

type ModelSelectionResult =
  | { kind: 'selected'; model: vscode.LanguageModelChat }
  | { kind: 'cancelled' }
  | { kind: 'noModels' };

type ChatModelsSelectionCacheState = {
  models: vscode.LanguageModelChat[];
  fetchedAt: number;
  selectorKey: string;
  inFlight?: Promise<vscode.LanguageModelChat[]>;
};

let chatModelsSelectionCache: ChatModelsSelectionCacheState | undefined;

const LANGUAGE_ENFORCEMENT_RULES: Record<CommitMessageLanguage, LanguageEnforcementRule> = {
  'zh-cn': {
    outputRequirement: 'Output MUST be Simplified Chinese (zh-CN).'
  },
  en: {
    outputRequirement: 'Output MUST be English.'
  }
};

function getCommitLanguage(): CommitMessageLanguage {
  const configured = vscode.workspace
    .getConfiguration('coding-plans')
    .get<string>('commitMessage.language', 'en');

  if (configured === 'zh-cn') {
    return 'zh-cn';
  }
  return 'en';
}

function shouldUseRecentCommitStyle(): boolean {
  return vscode.workspace
    .getConfiguration('coding-plans')
    .get<boolean>(COMMIT_MESSAGE_USE_RECENT_STYLE_SETTING_KEY, false);
}

function normalizePipelineMode(value: string | undefined): CommitMessagePipelineMode {
  if (value === 'single' || value === 'two-stage' || value === 'auto') {
    return value;
  }
  return DEFAULT_PIPELINE_MODE;
}

function getCommitMessageOptions(config: vscode.WorkspaceConfiguration): CommitMessageOptions {
  const configured = config.get<CommitMessageOptions | undefined>(COMMIT_MESSAGE_OPTIONS_SETTING_KEY, undefined);
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) {
    return {};
  }
  return configured;
}

function readPositiveIntegerValue(value: unknown, fallback: number): number {
  const configured = value;
  if (typeof configured !== 'number' || !Number.isFinite(configured) || configured <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(configured));
}

function getCommitMessageSettings(): CommitMessageSettings {
  const config = vscode.workspace.getConfiguration('coding-plans');
  const options = getCommitMessageOptions(config);
  const pipelineMode = normalizePipelineMode(
    typeof options[COMMIT_MESSAGE_OPTIONS_PIPELINE_MODE_KEY] === 'string'
      ? options[COMMIT_MESSAGE_OPTIONS_PIPELINE_MODE_KEY]
      : config.get<string>(LEGACY_COMMIT_MESSAGE_PIPELINE_MODE_SETTING_KEY, DEFAULT_PIPELINE_MODE)
  );

  return {
    pipelineMode,
    maxDiffLines: readPositiveIntegerValue(
      options[COMMIT_MESSAGE_OPTIONS_MAX_DIFF_LINES_KEY]
      ?? config.get<number>(LEGACY_COMMIT_MESSAGE_MAX_DIFF_LINES_SETTING_KEY, DEFAULT_COMMIT_MESSAGE_MAX_DIFF_LINES),
      DEFAULT_COMMIT_MESSAGE_MAX_DIFF_LINES
    ),
    summaryTriggerLines: readPositiveIntegerValue(
      options[COMMIT_MESSAGE_OPTIONS_SUMMARY_TRIGGER_LINES_KEY]
      ?? config.get<number>(LEGACY_COMMIT_MESSAGE_SUMMARY_TRIGGER_LINES_SETTING_KEY, DEFAULT_SUMMARY_TRIGGER_LINES),
      DEFAULT_SUMMARY_TRIGGER_LINES
    ),
    summaryChunkLines: readPositiveIntegerValue(
      options[COMMIT_MESSAGE_OPTIONS_SUMMARY_CHUNK_LINES_KEY]
      ?? config.get<number>(LEGACY_COMMIT_MESSAGE_SUMMARY_CHUNK_LINES_SETTING_KEY, DEFAULT_SUMMARY_CHUNK_LINES),
      DEFAULT_SUMMARY_CHUNK_LINES
    ),
    summaryMaxChunks: readPositiveIntegerValue(
      options[COMMIT_MESSAGE_OPTIONS_SUMMARY_MAX_CHUNKS_KEY]
      ?? config.get<number>(LEGACY_COMMIT_MESSAGE_SUMMARY_MAX_CHUNKS_SETTING_KEY, DEFAULT_SUMMARY_MAX_CHUNKS),
      DEFAULT_SUMMARY_MAX_CHUNKS
    ),
    maxBodyBulletCount: Math.max(
      2,
      readPositiveIntegerValue(
        options[COMMIT_MESSAGE_OPTIONS_MAX_BODY_BULLET_COUNT_KEY]
        ?? DEFAULT_MAX_BODY_BULLET_COUNT,
        DEFAULT_MAX_BODY_BULLET_COUNT
      )
    ),
    subjectMaxLength: readPositiveIntegerValue(
      options[COMMIT_MESSAGE_OPTIONS_SUBJECT_MAX_LENGTH_KEY]
      ?? config.get<number>(LEGACY_COMMIT_MESSAGE_SUBJECT_MAX_LENGTH_SETTING_KEY, DEFAULT_SUBJECT_MAX_LENGTH),
      DEFAULT_SUBJECT_MAX_LENGTH
    ),
    requireConventionalType:
      typeof options[COMMIT_MESSAGE_OPTIONS_REQUIRE_CONVENTIONAL_TYPE_KEY] === 'boolean'
        ? options[COMMIT_MESSAGE_OPTIONS_REQUIRE_CONVENTIONAL_TYPE_KEY]
        : config.get<boolean>(
          LEGACY_COMMIT_MESSAGE_REQUIRE_CONVENTIONAL_TYPE_SETTING_KEY,
          DEFAULT_REQUIRE_CONVENTIONAL_TYPE
        ),
    warnOnValidationFailure:
      typeof options[COMMIT_MESSAGE_OPTIONS_WARN_ON_VALIDATION_FAILURE_KEY] === 'boolean'
        ? options[COMMIT_MESSAGE_OPTIONS_WARN_ON_VALIDATION_FAILURE_KEY]
        : config.get<boolean>(
          LEGACY_COMMIT_MESSAGE_WARN_ON_VALIDATION_FAILURE_SETTING_KEY,
          DEFAULT_WARN_ON_VALIDATION_FAILURE
        ),
    llmMaxPromptLength: Math.max(
      500,
      readPositiveIntegerValue(
        options[COMMIT_MESSAGE_OPTIONS_LLM_MAX_PROMPT_LENGTH_KEY]
        ?? options[COMMIT_MESSAGE_OPTIONS_LEGACY_RECENT_STYLE_MAX_TOTAL_LENGTH_KEY]
        ?? DEFAULT_LLM_MAX_PROMPT_LENGTH,
        DEFAULT_LLM_MAX_PROMPT_LENGTH
      )
    )
  };
}

function getCommitLanguageEnforcementBlock(language: CommitMessageLanguage): string {
  const rule = LANGUAGE_ENFORCEMENT_RULES[language];
  const forbiddenLanguageRule =
    language === 'zh-cn'
      ? 'Do not output English sentences.'
      : 'Do not output Chinese sentences.';
  const lines = [
    `LANGUAGE REQUIREMENT (HIGHEST PRIORITY): ${rule.outputRequirement}`,
    'If any other instruction conflicts with this language rule, ignore the conflicting instruction.',
    forbiddenLanguageRule
  ];

  return lines.join('\n');
}

function getCommitFormatPrompt(): string {
  const config = vscode.workspace.getConfiguration('coding-plans');
  const options = getCommitMessageOptions(config);
  const configured =
    typeof options[COMMIT_MESSAGE_OPTIONS_PROMPT_KEY] === 'string'
      ? options[COMMIT_MESSAGE_OPTIONS_PROMPT_KEY]
      : config.get<string>(LEGACY_COMMIT_MESSAGE_PROMPT_SETTING_KEY, DEFAULT_COMMIT_FORMAT_PROMPT);
  const trimmed = configured.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_COMMIT_FORMAT_PROMPT;
}

function getGenerationStructureBlock(
  settings: CommitMessageSettings,
  breakingChangeExpected: boolean,
  hasStyleReference = false
): string {
  const lines = [
    'OUTPUT STRUCTURE (strict):',
    ...(hasStyleReference
      ? ['If STYLE conflicts with body length, bullet, or subject format details below, follow STYLE.']
      : []),
    '1) First line MUST be the commit subject.',
    settings.requireConventionalType
      ? '2) Subject MUST follow Conventional Commits.'
      : '2) Subject SHOULD be concise and descriptive.',
    `3) Subject length SHOULD be <= ${settings.subjectMaxLength} characters.`,
    '4) The body is optional. If you include it, add one blank line after the subject.',
    `5) If a body is needed, provide 1 to ${settings.maxBodyBulletCount} short bullet points, each prefixed with "- ".`,
    '6) Prefer no body or 1 bullet for narrow changes such as deleting, renaming, or moving a single file.',
    '7) Prefer 2 or 3 bullet points only when the diff clearly contains multiple meaningful change groups.',
    '8) Each bullet should group related edits by intent or outcome, not narrate the diff file-by-file.',
    '9) Keep each bullet focused on concrete code changes and resulting behavior.',
    '10) Avoid repetitive file-by-file bullets. Verb-led bullets are acceptable when they stay concise and strictly reflect the diff.',
    '11) Mention low-level implementation details only when they are necessary to understand the change.',
    '12) For narrow changes such as deleting or renaming a single file, the body may be omitted entirely.',
    '13) Never invent motivations, architecture changes, or side effects that are not directly supported by the diff.'
  ];

  if (breakingChangeExpected) {
    lines.push('14) Add a footer line: "BREAKING CHANGE: <impact summary>".');
  }

  lines.push('Do not include markdown code fences.');
  return lines.join('\n');
}

function getFallbackFormatPrompt(formatPrompt: string, hasStyleReference: boolean): string {
  if (!hasStyleReference) {
    return formatPrompt;
  }

  return [
    'FALLBACK FORMAT REQUIREMENT (lower priority than STYLE):',
    'Use the fallback format rules only for details that the recent samples do not decide.',
    formatPrompt
  ].join('\n');
}

function getEvidenceBoundaryBlock(): string {
  return [
    'EVIDENCE BOUNDARY (strict):',
    'Only describe facts that are directly supported by the diff or structured summary.',
    'Recent commit messages are style references only; they are not evidence for the current change.',
    'Never mention a topic, file, dependency, provider, metric, workflow, or feature that appears only in recent commit samples.',
    'If the evidence is weak, keep the message minimal and generic.',
    'Do not infer motivations, architecture changes, business impact, or completed workflows unless they are explicitly shown in the changes.'
  ].join('\n');
}

function buildDiffGenerationPrompt(
  diff: string,
  language: CommitMessageLanguage,
  settings: CommitMessageSettings,
  breakingChangeExpected: boolean,
  styleReferenceBlock?: string
): string {
  const hasStyleReference = Boolean(styleReferenceBlock);
  const languageEnforcementBlock = getCommitLanguageEnforcementBlock(language);
  const formatPrompt = getFallbackFormatPrompt(getCommitFormatPrompt(), hasStyleReference);
  const structureBlock = getGenerationStructureBlock(settings, breakingChangeExpected, hasStyleReference);
  const evidenceBoundaryBlock = getEvidenceBoundaryBlock();

  const promptSections = [
    COMMIT_MESSAGE_TASK_BLOCK,
    '',
    languageEnforcementBlock
  ];

  if (styleReferenceBlock) {
    promptSections.push('', styleReferenceBlock);
  }

  promptSections.push(
    '',
    formatPrompt,
    '',
    structureBlock,
    '',
    evidenceBoundaryBlock
  );

  promptSections.push(
    '',
    'CURRENT DIFF (ONLY CHANGE EVIDENCE):',
    'Generate the commit message from this diff only. Use recent commit messages only for writing style.',
    'Any topic, file, or action absent from this diff must be excluded from the output.',
    '--- BEGIN DIFF ---',
    diff,
    '--- END DIFF ---'
  );
  return promptSections.join('\n');
}

function buildSummaryGenerationPrompt(
  summary: DiffSummary,
  language: CommitMessageLanguage,
  settings: CommitMessageSettings,
  styleReferenceBlock?: string,
  diffForReference?: {
    diff: string;
    originalLines: number;
    truncated: boolean;
  }
): string {
  const hasStyleReference = Boolean(styleReferenceBlock);
  const languageEnforcementBlock = getCommitLanguageEnforcementBlock(language);
  const formatPrompt = getFallbackFormatPrompt(getCommitFormatPrompt(), hasStyleReference);
  const structureBlock = getGenerationStructureBlock(settings, summary.breakingChange, hasStyleReference);
  const evidenceBoundaryBlock = getEvidenceBoundaryBlock();

  const promptSections = [
    COMMIT_MESSAGE_TASK_BLOCK,
    '',
    languageEnforcementBlock
  ];

  if (styleReferenceBlock) {
    promptSections.push('', styleReferenceBlock);
  }

  promptSections.push(
    '',
    formatPrompt,
    '',
    structureBlock,
    '',
    evidenceBoundaryBlock
  );

  if (diffForReference) {
    promptSections.push(
      '',
      'DIFF CONTEXT (reference):',
      `The full diff had ${diffForReference.originalLines} lines; truncated=${diffForReference.truncated}.`,
      'Use this diff as additional context for current-change evidence. Recent commit samples are style only.',
      'If any instruction conflicts, follow LANGUAGE and STYLE requirements without inventing unsupported change content.',
      '--- BEGIN DIFF (TRUNCATED REFERENCE) ---',
      diffForReference.diff,
      '--- END DIFF (TRUNCATED REFERENCE) ---'
    );
  }

  promptSections.push(
    '',
    'Use the following structured summary as the primary source of truth for change intent.',
    'Recent commit messages are style references only; do not reuse their topics unless this summary supports them.',
    '--- BEGIN CHANGE SUMMARY JSON ---',
    JSON.stringify(summary, null, 2),
    '--- END CHANGE SUMMARY JSON ---'
  );
  return promptSections.join('\n');
}

function buildChunkSummaryPrompt(chunk: string, chunkIndex: number, totalChunks: number): string {
  return [
    'You are summarizing git diff chunks for commit-message generation.',
    'Return ONLY JSON. No markdown fences, no explanation.',
    'JSON schema:',
    SUMMARY_JSON_SCHEMA,
    '',
    `Chunk ${chunkIndex + 1} of ${totalChunks}.`,
    'Focus on concrete code changes, behavior changes, and risks.',
    'Only include facts directly evidenced by the diff chunk.',
    'If the chunk only shows low-information changes, keep arrays short or empty.',
    '',
    '--- BEGIN DIFF CHUNK ---',
    chunk,
    '--- END DIFF CHUNK ---'
  ].join('\n');
}

function buildAggregateSummaryPrompt(chunkSummaries: DiffSummary[]): string {
  return [
    'You are aggregating chunk-level diff summaries.',
    'Return ONLY one JSON object with this schema:',
    SUMMARY_JSON_SCHEMA,
    '',
    'Rules:',
    '- Deduplicate files and repeated changes.',
    '- Keep majorChanges concise and actionable.',
    '- Keep the result conservative: only retain items supported by the chunk summaries.',
    '- If the combined evidence is weak, prefer fewer summary items.',
    '- Set breakingChange=true only when the combined changes clearly indicate a breaking change.',
    '',
    '--- BEGIN CHUNK SUMMARIES JSON ---',
    JSON.stringify(chunkSummaries, null, 2),
    '--- END CHUNK SUMMARIES JSON ---'
  ].join('\n');
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function getRepositoryRootPath(repo: GitRepository): string | undefined {
  const rootPath = repo.rootUri?.fsPath?.trim();
  if (!rootPath) {
    return undefined;
  }
  return rootPath;
}

function trimCommitStyleSample(message: string, maxLength = RECENT_COMMIT_STYLE_MAX_ENTRY_LENGTH): string {
  const normalized = normalizeNewlines(message).trim();
  if (!normalized) {
    return '';
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

async function getRecentCommitMessages(
  repo: GitRepository,
  count: number,
  maxPromptLength = DEFAULT_LLM_MAX_PROMPT_LENGTH
): Promise<string[]> {
  const rootPath = getRepositoryRootPath(repo);
  if (!rootPath) {
    return [];
  }

  const safeCount = Math.max(1, Math.floor(count));
  const safeMaxPromptLength = Math.max(500, Math.floor(maxPromptLength));
  // Try to keep enough samples: avoid one long body consuming the whole style budget.
  const perEntryMaxLength = Math.max(
    80,
    Math.min(
      RECENT_COMMIT_STYLE_MAX_ENTRY_LENGTH,
      Math.floor(safeMaxPromptLength / safeCount)
    )
  );
  const stdout = await new Promise<string>((resolve) => {
    execFile(
      'git',
      ['-C', rootPath, 'log', '--no-merges', `-${safeCount}`, `--pretty=format:%B${COMMIT_LOG_ENTRY_SEPARATOR}`],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
      (error, out) => {
        if (error) {
          resolve('');
          return;
        }
        resolve(out);
      }
    );
  });

  if (!stdout.trim()) {
    return [];
  }

  // We already cap each entry, so we can keep the full requested sample size.
  return normalizeNewlines(stdout)
    .split(COMMIT_LOG_ENTRY_SEPARATOR)
    .map(message => trimCommitStyleSample(message, perEntryMaxLength))
    .filter(message => message.length > 0)
    .slice(0, safeCount);
}

function buildStyleReferenceBlock(recentMessages: string[]): string | undefined {
  if (recentMessages.length === 0) {
    return undefined;
  }

  const examples = recentMessages
    .map((message, index) => `[${index + 1}]\n${message}`)
    .join('\n\n');

  return [
    'STYLE REQUIREMENT (HIGHEST PRIORITY AFTER LANGUAGE):',
    'Infer the dominant commit-message format from the samples below and follow it.',
    'The first line should look like it belongs next to these samples.',
    'Apply the same style dimensions: prefix/type/scope pattern, description language, punctuation, casing, line breaks, body length, bullet prefix, and detail level.',
    'If the samples use Conventional Commits, keep the same type/scope style.',
    'If the samples omit a body for narrow changes, prefer a subject-only message for similarly narrow current changes.',
    'If the samples use a blank line plus "- " bullets for multi-part changes, use that body style only when the current diff has comparable complexity.',
    'If any lower-priority formatting instruction conflicts with this style requirement, follow the style requirement.',
    'Use these samples for style only, not as evidence of what changed now.',
    'Do not copy exact change details, identifiers, tickets, scopes, topics, files, dependencies, providers, metrics, or workflows unless they are clearly required by the current diff.',
    '--- BEGIN RECENT COMMIT MESSAGES ---',
    examples,
    '--- END RECENT COMMIT MESSAGES ---'
  ].join('\n');
}

function stripMarkdownFences(text: string): string {
  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/);
  if (fencedMatch) {
    return fencedMatch[1].trim();
  }
  return trimmed;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized = value
    .map(item => (typeof item === 'string' ? item.trim() : ''))
    .filter(item => item.length > 0);
  return Array.from(new Set(normalized));
}

function normalizeBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === 'yes' || normalized === '1';
  }
  return false;
}

function toDiffSummary(value: unknown): DiffSummary {
  const objectValue = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return {
    filesChanged: normalizeStringArray(objectValue.filesChanged),
    majorChanges: normalizeStringArray(objectValue.majorChanges),
    riskNotes: normalizeStringArray(objectValue.riskNotes),
    breakingChange: normalizeBoolean(objectValue.breakingChange)
  };
}

function extractFirstJsonObject(text: string): string | undefined {
  const normalized = stripMarkdownFences(text);
  const start = normalized.indexOf('{');
  if (start < 0) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < normalized.length; i++) {
    const ch = normalized[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return normalized.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

function parseDiffSummary(raw: string): DiffSummary {
  const normalizedRaw = stripMarkdownFences(raw);
  try {
    return toDiffSummary(JSON.parse(normalizedRaw));
  } catch {
    const extracted = extractFirstJsonObject(normalizedRaw);
    if (!extracted) {
      throw new Error('Failed to parse summary JSON');
    }
    return toDiffSummary(JSON.parse(extracted));
  }
}

function splitDiffIntoChunks(diff: string, chunkLines: number, maxChunks: number): string[] {
  const normalizedDiff = normalizeNewlines(diff);
  const lines = normalizedDiff.split('\n');
  if (lines.length === 0) {
    return [];
  }

  const safeChunkLines = Math.max(1, chunkLines);
  const safeMaxChunks = Math.max(1, maxChunks);
  const chunks: string[] = [];
  let cursor = 0;

  for (let i = 0; i < safeMaxChunks && cursor < lines.length; i++) {
    if (i === safeMaxChunks - 1) {
      const remaining = lines.slice(cursor);
      if (cursor + safeChunkLines < lines.length) {
        remaining.unshift(
          '[NOTE] Remaining diff lines were merged into this final chunk because summaryMaxChunks was reached.',
          ''
        );
      }
      chunks.push(remaining.join('\n'));
      cursor = lines.length;
    } else {
      chunks.push(lines.slice(cursor, cursor + safeChunkLines).join('\n'));
      cursor += safeChunkLines;
    }
  }

  return chunks;
}

function shouldUseTwoStagePipeline(settings: CommitMessageSettings, diffLineCount: number): boolean {
  if (settings.pipelineMode === 'two-stage') {
    return true;
  }
  if (settings.pipelineMode === 'single') {
    return false;
  }
  return diffLineCount > settings.summaryTriggerLines;
}

function truncateDiffForSingleStage(diff: string, maxLines: number): { diff: string; originalLines: number; truncated: boolean } {
  const normalizedDiff = normalizeNewlines(diff);
  const lines = normalizedDiff.split('\n');
  if (lines.length <= maxLines) {
    return { diff: normalizedDiff, originalLines: lines.length, truncated: false };
  }
  return {
    diff: lines.slice(0, maxLines).join('\n'),
    originalLines: lines.length,
    truncated: true
  };
}

function sanitizeGeneratedCommitMessage(raw: string): string {
  const cleaned = stripMarkdownFences(normalizeNewlines(raw));
  const lines = cleaned.split('\n');
  const startIndex = lines.findIndex(line => line.trim().length > 0);
  if (startIndex < 0) {
    return '';
  }

  const subject = normalizeConventionalCommitSubject(lines[startIndex].trim());
  const rest = lines.slice(startIndex + 1).map(line => line.trimEnd());
  while (rest.length > 0 && rest[rest.length - 1].trim().length === 0) {
    rest.pop();
  }

  if (rest.length === 0) {
    return subject;
  }
  if (rest[0].trim().length > 0) {
    rest.unshift('');
  }
  return [subject, ...rest].join('\n').trim();
}

function normalizeConventionalCommitSubject(subject: string): string {
  return subject.replace(
    /^((?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([^)]+\))?!?):(?=\S)/i,
    '$1: '
  );
}

function getBulletCount(message: string): number {
  return normalizeNewlines(message)
    .split('\n')
    .filter(line => line.trim().startsWith('- '))
    .length;
}

function getSubjectLine(message: string): string {
  return normalizeNewlines(message).split('\n').find(line => line.trim().length > 0)?.trim() ?? '';
}

function validateCommitMessage(
  message: string,
  language: CommitMessageLanguage,
  settings: CommitMessageSettings,
  breakingChangeExpected: boolean
): string[] {
  const issues: string[] = [];
  const normalized = normalizeNewlines(message);
  const subject = getSubjectLine(normalized);

  if (!subject) {
    issues.push('subject line is empty');
    return issues;
  }

  if (settings.requireConventionalType && !CONVENTIONAL_COMMIT_SUBJECT_RE.test(subject)) {
    issues.push('subject does not follow Conventional Commits');
  }

  if (subject.length > settings.subjectMaxLength) {
    issues.push(`subject exceeds ${settings.subjectMaxLength} characters`);
  }

  if (language === 'en') {
    if (/[\u3400-\u9fff]/.test(normalized)) {
      issues.push('output contains Chinese characters but language is English');
    }
  } else {
    if (!/[\u3400-\u9fff]/.test(normalized)) {
      issues.push('output does not contain Simplified Chinese text');
    }
  }

  const bulletCount = getBulletCount(normalized);
  if (bulletCount > settings.maxBodyBulletCount) {
    issues.push(`body should contain at most ${settings.maxBodyBulletCount} bullet lines`);
  }

  if (breakingChangeExpected && !/^BREAKING CHANGE:/m.test(normalized)) {
    issues.push('missing BREAKING CHANGE footer for breaking changes');
  }

  return issues;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isGitRepository(value: unknown): value is GitRepository {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.diff === 'function'
    && isRecord(value.inputBox)
    && typeof value.inputBox.value === 'string';
}

function normalizeFsPath(fsPath: string): string {
  const normalized = path.normalize(fsPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function areFsPathsEqual(left: string, right: string): boolean {
  return normalizeFsPath(left) === normalizeFsPath(right);
}

function isPathEqualOrWithin(pathToCheck: string, rootPath: string): boolean {
  const normalizedPathToCheck = normalizeFsPath(pathToCheck);
  const normalizedRootPath = normalizeFsPath(rootPath);
  const relative = path.relative(normalizedRootPath, normalizedPathToCheck);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function findRepositoryByRootPath(repositories: GitRepository[], rootPath: string): GitRepository | undefined {
  return repositories.find(repo => {
    const candidateRootPath = repo.rootUri?.fsPath;
    return typeof candidateRootPath === 'string' && areFsPathsEqual(candidateRootPath, rootPath);
  });
}

function getUriFromCommandContext(
  value: unknown,
  depth = 0,
  visited: WeakSet<object> = new WeakSet<object>()
): vscode.Uri | undefined {
  if (value instanceof vscode.Uri) {
    return value;
  }
  if (!isRecord(value) || depth > 3) {
    return undefined;
  }

  const objectValue = value as object;
  if (visited.has(objectValue)) {
    return undefined;
  }
  visited.add(objectValue);

  const directKeys = ['rootUri', 'uri', 'resourceUri', 'originalUri'] as const;
  for (const key of directKeys) {
    const candidate = value[key];
    if (candidate instanceof vscode.Uri) {
      return candidate;
    }
  }

  const nestedKeys = ['sourceControl', 'resourceGroup', 'resourceState', 'repository', 'input'] as const;
  for (const key of nestedKeys) {
    const nestedUri = getUriFromCommandContext(value[key], depth + 1, visited);
    if (nestedUri) {
      return nestedUri;
    }
  }

  return undefined;
}

function findRepositoryByUri(gitApi: GitAPI, uri: vscode.Uri): GitRepository | undefined {
  const repositoryFromApi = gitApi.getRepository?.(uri);
  if (repositoryFromApi) {
    return repositoryFromApi;
  }
  if (uri.scheme !== 'file') {
    return undefined;
  }

  return gitApi.repositories.find(repo => {
    const repoRootPath = repo.rootUri?.fsPath;
    return typeof repoRootPath === 'string' && isPathEqualOrWithin(uri.fsPath, repoRootPath);
  });
}

function resolveRepositoryFromCommandContext(gitApi: GitAPI, commandContext: unknown): GitRepository | undefined {
  if (isGitRepository(commandContext)) {
    if (gitApi.repositories.includes(commandContext)) {
      return commandContext;
    }

    const rootPath = commandContext.rootUri?.fsPath;
    if (typeof rootPath === 'string') {
      const matched = findRepositoryByRootPath(gitApi.repositories, rootPath);
      if (matched) {
        return matched;
      }
    }
  }

  const contextUri = getUriFromCommandContext(commandContext);
  if (contextUri) {
    const matched = findRepositoryByUri(gitApi, contextUri);
    if (matched) {
      return matched;
    }
  }

  return undefined;
}

async function getGitRepository(commandContext?: unknown): Promise<GitRepository | undefined> {
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext) {
    return undefined;
  }

  const gitApi = ext.isActive ? ext.exports.getAPI(1) : (await ext.activate()).getAPI(1);
  const repositoryFromCommand = resolveRepositoryFromCommandContext(gitApi, commandContext);
  if (repositoryFromCommand) {
    return repositoryFromCommand;
  }

  const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
  if (activeEditorUri) {
    const repositoryFromEditor = findRepositoryByUri(gitApi, activeEditorUri);
    if (repositoryFromEditor) {
      return repositoryFromEditor;
    }
  }

  if (gitApi.repositories.length === 1) {
    return gitApi.repositories[0];
  }

  return gitApi.repositories[0];
}

async function getDiff(repo: GitRepository): Promise<string> {
  const staged = await repo.diff(true);
  if (staged.trim().length > 0) {
    return staged;
  }
  return repo.diff(false);
}

function isPlaceholderModelId(modelId: string): boolean {
  return PLACEHOLDER_MODEL_ID_SUFFIXES.some(suffix => modelId.endsWith(suffix));
}

function isCopilotVendor(vendor: string): boolean {
  return normalizeValue(vendor) === 'copilot';
}

function modelSortKey(model: vscode.LanguageModelChat): [number, string, string, string, string] {
  // Prefer this extension's vendors first, then other vendors.
  const tier = model.vendor === CODING_PLANS_VENDOR ? 0 : 1;
  return [tier, model.vendor, model.family, model.name, model.id];
}

function getVendorDisplayName(vendor: string): string {
  switch (vendor) {
    case 'coding-plans':
      return 'Coding Plans';
    default:
      return vendor;
  }
}

function normalizeValue(value: string | undefined): string {
  return (value || '').trim().toLowerCase();
}

function normalizeSelectorValue(value: string | undefined): string | undefined {
  const trimmed = (value || '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeChatModelsSelector(
  selector?: vscode.LanguageModelChatSelector
): vscode.LanguageModelChatSelector | undefined {
  if (!selector) {
    return undefined;
  }
  const normalized: vscode.LanguageModelChatSelector = {};
  const vendor = normalizeSelectorValue(selector.vendor);
  const family = normalizeSelectorValue(selector.family);
  const version = normalizeSelectorValue(selector.version);
  const id = normalizeSelectorValue(selector.id);
  if (vendor) {
    normalized.vendor = vendor;
  }
  if (family) {
    normalized.family = family;
  }
  if (version) {
    normalized.version = version;
  }
  if (id) {
    normalized.id = id;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function toSelectorCacheKey(selector?: vscode.LanguageModelChatSelector): string {
  if (!selector) {
    return '__all__';
  }
  return JSON.stringify({
    vendor: selector.vendor || '',
    family: selector.family || '',
    version: selector.version || '',
    id: selector.id || ''
  });
}

function toSelectorLogPayload(selector?: vscode.LanguageModelChatSelector): {
  vendor?: string;
  family?: string;
  version?: string;
  id?: string;
} {
  if (!selector) {
    return {};
  }
  return {
    vendor: selector.vendor,
    family: selector.family,
    version: selector.version,
    id: selector.id
  };
}

export function invalidateCommitMessageModelSelectionCache(reason: string): void {
  const previous = chatModelsSelectionCache;
  chatModelsSelectionCache = undefined;
  logger.info(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} cache-invalidated`, {
    reason,
    hadCache: !!previous,
    selectorKey: previous?.selectorKey,
    modelCount: previous?.models.length,
    ageMs: previous ? Date.now() - previous.fetchedAt : undefined
  });
}

function getCodingPlansVendorName(model: vscode.LanguageModelChat): string | undefined {
  if (model.vendor !== CODING_PLANS_VENDOR) {
    return undefined;
  }
  const slashIndex = model.id.indexOf('/');
  if (slashIndex <= 0) {
    return undefined;
  }
  return model.id.substring(0, slashIndex);
}

function matchesCodingPlansVendor(model: vscode.LanguageModelChat, vendor: string): boolean {
  const normalizedVendor = normalizeValue(vendor);
  if (!normalizedVendor || model.vendor !== CODING_PLANS_VENDOR) {
    return false;
  }

  const familyMatch = normalizeValue(model.family) === normalizedVendor;
  if (familyMatch) {
    return true;
  }

  const vendorFromId = getCodingPlansVendorName(model);
  return normalizeValue(vendorFromId) === normalizedVendor;
}

function matchesCodingPlansSelection(model: vscode.LanguageModelChat, vendor: string, id?: string): boolean {
  if (!matchesCodingPlansVendor(model, vendor)) {
    return false;
  }
  if (!id) {
    return true;
  }

  const normalizedId = normalizeValue(id);
  if (normalizeValue(model.name) === normalizedId) {
    return true;
  }

  const slashIndex = model.id.indexOf('/');
  const idFromComposite = slashIndex >= 0 ? model.id.substring(slashIndex + 1) : model.id;
  return normalizeValue(idFromComposite) === normalizedId;
}

function isDistinctDisplayValue(value: string | undefined, ...others: Array<string | undefined>): boolean {
  const target = normalizeValue(value);
  if (!target) {
    return false;
  }
  return others.every(other => normalizeValue(other) !== target);
}

function toVendorScopedModelQuickPickItem(model: vscode.LanguageModelChat): {
  label: string;
  description?: string;
  detail?: string;
  model: vscode.LanguageModelChat;
} {
  const description = isDistinctDisplayValue(model.family, model.name) ? model.family : undefined;
  const detail = isDistinctDisplayValue(model.id, model.name, model.family) ? model.id : undefined;
  return {
    label: model.name,
    description,
    detail,
    model
  };
}

function getModelVendorLabel(model: vscode.LanguageModelChat): string {
  if (model.vendor === CODING_PLANS_VENDOR) {
    return model.family || 'Coding Plans';
  }
  return getVendorDisplayName(model.vendor);
}

function getModelGroupKey(model: vscode.LanguageModelChat): string {
  if (model.vendor === CODING_PLANS_VENDOR) {
    return model.family || model.vendor;
  }
  return model.vendor;
}

function toModelLogPayload(model: vscode.LanguageModelChat): {
  vendor: string;
  family: string;
  name: string;
  id: string;
} {
  return {
    vendor: model.vendor,
    family: model.family,
    name: model.name,
    id: model.id
  };
}

function summarizeModelGroupsForLog(models: readonly vscode.LanguageModelChat[]): Array<{ group: string; count: number }> {
  const grouped = new Map<string, number>();
  for (const model of models) {
    const key = getModelGroupKey(model);
    grouped.set(key, (grouped.get(key) || 0) + 1);
  }
  return Array.from(grouped.entries())
    .map(([group, count]) => ({ group, count }))
    .sort((a, b) => {
      if (a.count !== b.count) {
        return b.count - a.count;
      }
      return a.group.localeCompare(b.group);
    });
}

function toGlobalModelQuickPickItem(model: vscode.LanguageModelChat): {
  label: string;
  description?: string;
  detail?: string;
  model: vscode.LanguageModelChat;
} {
  const descriptionParts = [getModelVendorLabel(model)];
  if (isDistinctDisplayValue(model.family, model.name) && model.family !== descriptionParts[0]) {
    descriptionParts.push(model.family);
  }
  const detail = isDistinctDisplayValue(model.id, model.name, model.family) ? model.id : undefined;
  return {
    label: model.name,
    description: descriptionParts.join(' · '),
    detail,
    model
  };
}

async function pickVendor(models: vscode.LanguageModelChat[]): Promise<string | undefined> {
  type VendorEntry = { key: string; displayName: string; count: number };
  const vendorMap = new Map<string, VendorEntry>();

  for (const model of models) {
    const key = getModelGroupKey(model);
    const existing = vendorMap.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      vendorMap.set(key, { key, displayName: getModelVendorLabel(model), count: 1 });
    }
  }

  const vendors = Array.from(vendorMap.values());
  logger.info(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} opening vendor picker`, {
    vendorCount: vendors.length,
    vendors: vendors.map(item => ({ key: item.key, displayName: item.displayName, count: item.count }))
  });
  const picked = await vscode.window.showQuickPick(
    vendors.map(item => ({
      label: item.displayName,
      description: item.key !== item.displayName ? item.key : undefined,
      detail: `${item.count} model${item.count > 1 ? 's' : ''}`,
      vendor: item.key
    })),
    {
      ignoreFocusOut: true,
      placeHolder: getMessage('commitMessageSelectVendor')
    }
  );
  logger.info(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} vendor picker resolved`, {
    cancelled: !picked,
    pickedVendor: picked?.vendor
  });
  return picked?.vendor;
}

function getCommitMessageConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('coding-plans');
}

function readConfiguredModelSelector(): { vendor?: string; id?: string } {
  const config = getCommitMessageConfig();
  const vendor = (config.get<string>(COMMIT_MESSAGE_MODEL_VENDOR_SETTING_KEY, '') || '').trim();
  const id = (config.get<string>(COMMIT_MESSAGE_MODEL_ID_SETTING_KEY, '') || '').trim();
  return {
    vendor: vendor.length > 0 ? vendor : undefined,
    id: id.length > 0 ? id : undefined
  };
}

async function saveModelSelection(model: vscode.LanguageModelChat): Promise<void> {
  const config = getCommitMessageConfig();
  let vendorToSave = model.vendor;
  let idToSave = model.id;

  if (model.vendor === CODING_PLANS_VENDOR && model.id.includes('/')) {
    const slashIndex = model.id.indexOf('/');
    vendorToSave = model.id.substring(0, slashIndex);
    idToSave = model.id.substring(slashIndex + 1);
  }

  const startedAt = Date.now();
  logger.info(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} saving model selection`, {
    selectedModel: toModelLogPayload(model),
    settingVendor: vendorToSave,
    settingId: idToSave
  });
  await Promise.all([
    config.update(COMMIT_MESSAGE_MODEL_VENDOR_SETTING_KEY, vendorToSave, vscode.ConfigurationTarget.Global),
    config.update(COMMIT_MESSAGE_MODEL_ID_SETTING_KEY, idToSave, vscode.ConfigurationTarget.Global)
  ]);
  logger.info(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} model selection saved`, {
    elapsedMs: Date.now() - startedAt
  });
}

async function selectModel(
  allowPrompt: boolean,
  forcePrompt = false,
  token?: vscode.CancellationToken
): Promise<ModelSelectionResult> {
  const startedAt = Date.now();
  logger.info(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} selectModel start`, {
    allowPrompt,
    forcePrompt,
    hasCancellationToken: !!token
  });
  const finishSelection = (result: ModelSelectionResult, reason: string): ModelSelectionResult => {
    logger.info(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} selectModel resolved`, {
      reason,
      kind: result.kind,
      elapsedMs: Date.now() - startedAt,
      model: result.kind === 'selected' ? toModelLogPayload(result.model) : undefined
    });
    return result;
  };

  throwIfCancelled(token);
  const allModels = await selectChatModelsWithTimeout(token, { vendor: CODING_PLANS_VENDOR });
  throwIfCancelled(token);
  let filteredPlaceholderCount = 0;
  let filteredCopilotCount = 0;
  const models = allModels
    .filter(model => {
      const placeholder = isPlaceholderModelId(model.id);
      if (placeholder) {
        filteredPlaceholderCount += 1;
        return false;
      }
      const copilot = isCopilotVendor(model.vendor);
      if (copilot) {
        filteredCopilotCount += 1;
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      const ka = modelSortKey(a);
      const kb = modelSortKey(b);
      for (let i = 0; i < ka.length; i++) {
        if (ka[i] < kb[i]) { return -1; }
        if (ka[i] > kb[i]) { return 1; }
      }
      return 0;
    });
  logger.info(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} models prepared`, {
    allModelCount: allModels.length,
    keptModelCount: models.length,
    filteredPlaceholderCount,
    filteredCopilotCount,
    modelGroups: summarizeModelGroupsForLog(models)
  });

  if (models.length === 0) {
    return finishSelection({ kind: 'noModels' }, 'no-usable-models');
  }

  const selector = readConfiguredModelSelector();
  logger.info(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} configured selector loaded`, {
    configuredVendor: selector.vendor,
    configuredId: selector.id
  });

  if (!forcePrompt) {
    if (selector.vendor && selector.id) {
      const vendor = selector.vendor;
      const id = selector.id;
      const compositeId = `${vendor}/${id}`;
      const match = models.find(m =>
        (m.vendor === CODING_PLANS_VENDOR && (m.id === compositeId || matchesCodingPlansSelection(m, vendor, id)))
        || (m.vendor === vendor && m.id === id)
      );
      if (match) {
        return finishSelection({ kind: 'selected', model: match }, 'configured-vendor-id-match');
      }
      logger.warn(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} configured model not found`, {
        configuredVendor: vendor,
        configuredId: id
      });
      if (allowPrompt) {
        void vscode.window.showWarningMessage(getMessage('commitMessageConfiguredModelNotFound'));
      }
    } else if (selector.vendor) {
      const vendor = selector.vendor;
      const match = models.find(m =>
        (m.vendor === CODING_PLANS_VENDOR && matchesCodingPlansSelection(m, vendor))
        || (m.vendor === vendor)
      );
      if (match) {
        return finishSelection({ kind: 'selected', model: match }, 'configured-vendor-match');
      }
      logger.warn(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} configured vendor not found`, {
        configuredVendor: selector.vendor
      });
      if (allowPrompt) {
        void vscode.window.showWarningMessage(getMessage('commitMessageConfiguredVendorNotFound', selector.vendor));
      }
    }
  }

  if (!allowPrompt) {
    return finishSelection({ kind: 'selected', model: models[0] }, 'prompt-disabled-default-first-model');
  }

  if (!selector.vendor) {
    const pickedVendor = await pickVendor(models);
    if (!pickedVendor) {
      return finishSelection({ kind: 'cancelled' }, 'vendor-picker-cancelled');
    }

    const vendorModels = models.filter(model => getModelGroupKey(model) === pickedVendor);
    logger.info(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} opening model picker for vendor`, {
      vendor: pickedVendor,
      modelCount: vendorModels.length
    });
    const pickedModel = await vscode.window.showQuickPick(
      vendorModels.map(model => toVendorScopedModelQuickPickItem(model)),
      {
        ignoreFocusOut: true,
        placeHolder: getMessage('commitMessageSelectModelForVendor', pickedVendor)
      }
    );

    if (!pickedModel) {
      return finishSelection({ kind: 'cancelled' }, 'vendor-model-picker-cancelled');
    }

    await saveModelSelection(pickedModel.model);
    return finishSelection({ kind: 'selected', model: pickedModel.model }, 'vendor-model-picked');
  }

  if (models.length === 1) {
    await saveModelSelection(models[0]);
    return finishSelection({ kind: 'selected', model: models[0] }, 'single-model-auto-selected');
  }

  logger.info(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} opening global model picker`, {
    modelCount: models.length
  });
  const picked = await vscode.window.showQuickPick(
    models.map(model => toGlobalModelQuickPickItem(model)),
    {
      ignoreFocusOut: true,
      placeHolder: getMessage('commitMessageSelectModel')
    }
  );

  if (!picked) {
    return finishSelection({ kind: 'cancelled' }, 'global-model-picker-cancelled');
  }

  await saveModelSelection(picked.model);
  return finishSelection({ kind: 'selected', model: picked.model }, 'global-model-picked');
}

async function selectChatModelsWithTimeout(
  token?: vscode.CancellationToken,
  selector?: vscode.LanguageModelChatSelector
): Promise<vscode.LanguageModelChat[]> {
  if (!vscode.lm || typeof vscode.lm.selectChatModels !== 'function') {
    throw new Error(getMessage('commitMessageModelSelectionUnavailable'));
  }

  const normalizedSelector = normalizeChatModelsSelector(selector);
  const selectorKey = toSelectorCacheKey(normalizedSelector);
  const selectorLog = toSelectorLogPayload(normalizedSelector);
  const now = Date.now();
  const cache = chatModelsSelectionCache;
  const hasMatchingCache = !!cache && cache.selectorKey === selectorKey;

  let staleModels: vscode.LanguageModelChat[] | undefined;
  let staleAgeMs: number | undefined;
  if (hasMatchingCache && cache) {
    const ageMs = now - cache.fetchedAt;
    if (ageMs <= SELECT_CHAT_MODELS_CACHE_TTL_MS) {
      logger.info(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} cache-hit`, {
        selector: selectorLog,
        modelCount: cache.models.length,
        ageMs,
        ttlMs: SELECT_CHAT_MODELS_CACHE_TTL_MS,
        elapsedMs: Date.now() - now
      });
      return cache.models;
    }
    if (cache.fetchedAt > 0) {
      staleModels = cache.models;
      staleAgeMs = ageMs;
      logger.info(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} cache-stale`, {
        selector: selectorLog,
        modelCount: cache.models.length,
        ageMs,
        ttlMs: SELECT_CHAT_MODELS_CACHE_TTL_MS
      });
    }
    if (cache.inFlight) {
      try {
        return await cache.inFlight;
      } catch (error: unknown) {
        if (staleModels) {
          logger.warn(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} stale-cache-served`, {
            selector: selectorLog,
            modelCount: staleModels.length,
            staleAgeMs,
            reason: 'inflight-refresh-failed',
            error: formatErrorDetail(error)
          });
          return staleModels;
        }
        throw error;
      }
    }
  } else {
    logger.info(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} cache-miss`, {
      selector: selectorLog,
      hasExistingCache: !!cache,
      existingSelectorKey: cache?.selectorKey,
      existingModelCount: cache?.models.length
    });
  }

  const refreshStartedAt = Date.now();
  logger.info(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} cache-refresh-start`, {
    selector: selectorLog,
    hasStaleCache: !!staleModels,
    staleAgeMs
  });
  const refreshPromise = selectChatModelsOnceWithTimeout(token, normalizedSelector);
  chatModelsSelectionCache = {
    models: staleModels || [],
    fetchedAt: staleModels ? now - (staleAgeMs || 0) : 0,
    selectorKey,
    inFlight: refreshPromise
  };

  try {
    const refreshedModels = await refreshPromise;
    chatModelsSelectionCache = {
      models: refreshedModels,
      fetchedAt: Date.now(),
      selectorKey
    };
    logger.info(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} cache-refresh-resolved`, {
      selector: selectorLog,
      modelCount: refreshedModels.length,
      elapsedMs: Date.now() - refreshStartedAt
    });
    return refreshedModels;
  } catch (error: unknown) {
    logger.warn(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} cache-refresh-failed`, {
      selector: selectorLog,
      elapsedMs: Date.now() - refreshStartedAt,
      cancelled: isRequestCancelledError(error),
      error: formatErrorDetail(error)
    });
    if (staleModels) {
      chatModelsSelectionCache = {
        models: staleModels,
        fetchedAt: now - (staleAgeMs || 0),
        selectorKey
      };
      logger.warn(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} stale-cache-served`, {
        selector: selectorLog,
        modelCount: staleModels.length,
        staleAgeMs,
        reason: 'refresh-failed',
        error: formatErrorDetail(error)
      });
      return staleModels;
    }
    if (chatModelsSelectionCache?.inFlight === refreshPromise && chatModelsSelectionCache.selectorKey === selectorKey) {
      chatModelsSelectionCache = undefined;
    }
    throw error;
  } finally {
    if (chatModelsSelectionCache?.inFlight === refreshPromise && chatModelsSelectionCache.selectorKey === selectorKey) {
      chatModelsSelectionCache = {
        models: chatModelsSelectionCache.models,
        fetchedAt: chatModelsSelectionCache.fetchedAt,
        selectorKey
      };
    }
  }
}

async function selectChatModelsOnceWithTimeout(
  token?: vscode.CancellationToken,
  selector?: vscode.LanguageModelChatSelector
): Promise<vscode.LanguageModelChat[]> {
  if (!vscode.lm || typeof vscode.lm.selectChatModels !== 'function') {
    throw new Error(getMessage('commitMessageModelSelectionUnavailable'));
  }

  const startedAt = Date.now();
  const selectorLog = toSelectorLogPayload(selector);
  logger.info(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} selectChatModels start`, {
    timeoutMs: SELECT_CHAT_MODELS_TIMEOUT_MS,
    hasCancellationToken: !!token,
    selector: selectorLog
  });
  let timeoutHandle: NodeJS.Timeout | undefined;
  let cancellationDisposable: vscode.Disposable | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      logger.warn(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} selectChatModels timeout`, {
        timeoutMs: SELECT_CHAT_MODELS_TIMEOUT_MS,
        elapsedMs: Date.now() - startedAt,
        selector: selectorLog
      });
      reject(new Error(getMessage('commitMessageModelSelectionTimeout')));
    }, SELECT_CHAT_MODELS_TIMEOUT_MS);
  });
  const cancellationPromise = token ? new Promise<never>((_, reject) => {
    if (token.isCancellationRequested) {
      logger.info(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} selectChatModels cancelled before request`, {
        elapsedMs: Date.now() - startedAt,
        selector: selectorLog
      });
      reject(createRequestCancelledError());
      return;
    }
    cancellationDisposable = token.onCancellationRequested(() => {
      logger.info(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} selectChatModels cancelled during request`, {
        elapsedMs: Date.now() - startedAt,
        selector: selectorLog
      });
      reject(createRequestCancelledError());
    });
  }) : undefined;
  const selectModelsPromise = vscode.lm.selectChatModels(selector).then(models => {
    logger.info(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} selectChatModels resolved`, {
      elapsedMs: Date.now() - startedAt,
      modelCount: models.length,
      selector: selectorLog,
      modelGroups: summarizeModelGroupsForLog(models)
    });
    return models;
  });

  try {
    const pending = cancellationPromise
      ? [selectModelsPromise, timeoutPromise, cancellationPromise]
      : [selectModelsPromise, timeoutPromise];
    return await Promise.race(pending);
  } catch (error: unknown) {
    logger.warn(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} selectChatModels failed`, {
      elapsedMs: Date.now() - startedAt,
      cancelled: isRequestCancelledError(error),
      selector: selectorLog,
      error: formatErrorDetail(error)
    });
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    cancellationDisposable?.dispose();
  }
}

function createRequestCancelledError(): Error {
  const error = new Error(getMessage('requestCancelled'));
  (error as { code?: string }).code = REQUEST_CANCELLED_ERROR_CODE;
  return error;
}

function throwIfCancelled(token?: vscode.CancellationToken): void {
  if (token?.isCancellationRequested) {
    throw createRequestCancelledError();
  }
}

function isRequestCancelledError(error: unknown): boolean {
  const maybeError = error as { code?: unknown; name?: unknown; message?: unknown } | undefined;
  if (typeof maybeError?.code === 'string' && maybeError.code === REQUEST_CANCELLED_ERROR_CODE) {
    return true;
  }

  const message = error instanceof Error
    ? error.message
    : typeof maybeError?.message === 'string'
      ? maybeError.message
      : String(error ?? '');
  const normalizedMessage = normalizeValue(message);
  if (
    normalizedMessage === normalizeValue(getMessage('requestCancelled'))
    || normalizedMessage === 'canceled'
    || normalizedMessage === 'cancelled'
  ) {
    return true;
  }

  const name = typeof maybeError?.name === 'string' ? normalizeValue(maybeError.name) : '';
  return name === 'cancellationerror' || name === 'canceled' || name === 'cancelled';
}

function formatErrorDetail(error: unknown): string {
  const details: string[] = [];
  const baseMessage = getCompactErrorMessage(error);
  if (baseMessage.length > 0) {
    details.push(baseMessage);
  }

  const maybeError = error as {
    name?: unknown;
    code?: unknown;
    cause?: unknown;
    response?: { status?: unknown };
    status?: unknown;
  } | undefined;

  if (error instanceof vscode.LanguageModelError && typeof error.code === 'string' && error.code.length > 0) {
    details.push(`lmCode=${error.code}`);
  }

  const code = maybeError?.code;
  if (typeof code === 'string' && code.length > 0) {
    details.push(`code=${code}`);
  } else if (typeof code === 'number' && Number.isFinite(code)) {
    details.push(`code=${code}`);
  }

  const status = typeof maybeError?.response?.status === 'number'
    ? maybeError.response.status
    : typeof maybeError?.status === 'number'
      ? maybeError.status
      : undefined;
  if (typeof status === 'number' && Number.isFinite(status)) {
    details.push(`status=${status}`);
  }

  const name = maybeError?.name;
  if (typeof name === 'string' && name.length > 0) {
    details.push(`name=${name}`);
  }

  const causeMessage = maybeError?.cause ? getCompactErrorMessage(maybeError.cause) : '';
  if (causeMessage.length > 0) {
    details.push(`cause=${causeMessage}`);
  }

  const unique = Array.from(new Set(details.filter(item => item.trim().length > 0)));
  return unique.join(' | ') || 'Unknown error';
}

function isLanguageModelBlockedError(error: unknown): boolean {
  if (error instanceof vscode.LanguageModelError) {
    return error.code === vscode.LanguageModelError.Blocked.name;
  }
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && code === vscode.LanguageModelError.Blocked.name;
}

async function sendPrompt(
  model: vscode.LanguageModelChat,
  prompt: string,
  token: vscode.CancellationToken,
  justification: string,
  maxPromptLength: number
): Promise<string> {
  const safeMaxPromptLength = Math.max(500, Math.floor(maxPromptLength));
  const originalPrompt = normalizeNewlines(prompt);
  let promptForModel = originalPrompt;
  if (originalPrompt.length > safeMaxPromptLength) {
    void vscode.window.showWarningMessage(
      getMessage('commitMessagePromptTooLarge', originalPrompt.length, safeMaxPromptLength)
    );
    const truncationMarker = '\n\n[TRUNCATED] Prompt was shortened due to llmMaxPromptLength.\n\n';
    const budgetWithoutMarker = Math.max(0, safeMaxPromptLength - truncationMarker.length);
    const headLength = Math.min(
      budgetWithoutMarker,
      Math.max(120, Math.floor(budgetWithoutMarker * 0.35))
    );
    const tailLength = Math.max(0, budgetWithoutMarker - headLength);
    const head = originalPrompt.slice(0, headLength);
    const tail = tailLength > 0 ? originalPrompt.slice(originalPrompt.length - tailLength) : '';
    promptForModel = `${head}${truncationMarker}${tail}`;
  }

  const messages = [vscode.LanguageModelChatMessage.User(promptForModel)];
  let response: vscode.LanguageModelChatResponse;
  try {
    const requestOptions: vscode.LanguageModelChatRequestOptions = { justification };
    if (model.vendor === CODING_PLANS_VENDOR) {
      requestOptions.modelOptions = {
        [REQUEST_SOURCE_MODEL_OPTION_KEY]: REQUEST_SOURCE_COMMIT_MESSAGE
      };
    }
    response = await model.sendRequest(messages, requestOptions, token);
  } catch (error: unknown) {
    if (isLanguageModelBlockedError(error) && isCopilotVendor(model.vendor)) {
      throw new Error(getMessage('commitMessageCopilotQuotaExceeded'));
    }
    throw error;
  }

  let result = '';
  for await (const chunk of response.text) {
    result += chunk;
  }
  return result.trim();
}

async function runTwoStageSummary(
  model: vscode.LanguageModelChat,
  diff: string,
  settings: CommitMessageSettings,
  token: vscode.CancellationToken
): Promise<DiffSummary> {
  const chunks = splitDiffIntoChunks(diff, settings.summaryChunkLines, settings.summaryMaxChunks);
  if (chunks.length === 0) {
    return {
      filesChanged: [],
      majorChanges: [],
      riskNotes: [],
      breakingChange: false
    };
  }

  const chunkSummaries: DiffSummary[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const rawChunkSummary = await sendPrompt(
      model,
      buildChunkSummaryPrompt(chunks[i], i, chunks.length),
      token,
      'Summarize a diff chunk for commit message generation.',
      settings.llmMaxPromptLength
    );
    chunkSummaries.push(parseDiffSummary(rawChunkSummary));
  }

  const rawAggregateSummary = await sendPrompt(
    model,
    buildAggregateSummaryPrompt(chunkSummaries),
    token,
    'Aggregate chunk summaries into one structured summary.',
    settings.llmMaxPromptLength
  );
  return parseDiffSummary(rawAggregateSummary);
}

async function prepareGenerationInput(
  model: vscode.LanguageModelChat,
  diff: string,
  settings: CommitMessageSettings,
  token: vscode.CancellationToken
): Promise<PreparedGenerationInput> {
  const diffLineCount = normalizeNewlines(diff).split('\n').length;
  const useTwoStage = shouldUseTwoStagePipeline(settings, diffLineCount);

  const truncatedForReference = truncateDiffForSingleStage(diff, settings.maxDiffLines);

  if (useTwoStage) {
    try {
      const summary = await runTwoStageSummary(model, diff, settings, token);
      return {
        kind: 'summary',
        summary,
        breakingChangeExpected: summary.breakingChange,
        diffForReference: truncatedForReference.diff,
        diffOriginalLines: truncatedForReference.originalLines,
        diffTruncated: truncatedForReference.truncated
      };
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      void vscode.window.showWarningMessage(getMessage('commitMessageSummaryFallback', detail));
      const truncated = truncateDiffForSingleStage(diff, settings.maxDiffLines);
      if (truncated.truncated) {
        void vscode.window.showWarningMessage(
          getMessage('commitMessageDiffTooLarge', truncated.originalLines, settings.maxDiffLines)
        );
      }
      return {
        kind: 'diff',
        diff: truncated.diff,
        breakingChangeExpected: false
      };
    }
  }

  const truncated = truncateDiffForSingleStage(diff, settings.maxDiffLines);
  if (truncated.truncated) {
    void vscode.window.showWarningMessage(
      getMessage('commitMessageDiffTooLarge', truncated.originalLines, settings.maxDiffLines)
    );
  }
  return {
    kind: 'diff',
    diff: truncated.diff,
    breakingChangeExpected: false
  };
}

function maybeWarnOnValidationFailure(
  generatedMessage: string,
  language: CommitMessageLanguage,
  settings: CommitMessageSettings,
  breakingChangeExpected: boolean
): void {
  if (!settings.warnOnValidationFailure) {
    return;
  }
  const issues = validateCommitMessage(generatedMessage, language, settings, breakingChangeExpected);
  if (issues.length === 0) {
    return;
  }
  void vscode.window.showWarningMessage(
    getMessage('commitMessageValidationWarning', issues.join('; '))
  );
}

function getCommitMessagePreview(message: string): string {
  return getSubjectLine(message);
}

export const commitMessageTestUtils = {
  buildDiffGenerationPrompt,
  buildStyleReferenceBlock,
  sanitizeGeneratedCommitMessage,
  validateCommitMessage
};

export async function selectCommitMessageModel(): Promise<void> {
  const startedAt = Date.now();
  logger.info(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} command start`);
  try {
    const selection = await selectModel(true, true);
    if (selection.kind === 'cancelled') {
      logger.info(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} command cancelled`, {
        elapsedMs: Date.now() - startedAt
      });
      vscode.window.showInformationMessage(getMessage('requestCancelled'));
      return;
    }
    if (selection.kind === 'noModels') {
      logger.warn(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} command found no models`, {
        elapsedMs: Date.now() - startedAt
      });
      vscode.window.showWarningMessage(getMessage('commitMessageNoModel'));
      return;
    }
    logger.info(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} command selected model`, {
      elapsedMs: Date.now() - startedAt,
      model: toModelLogPayload(selection.model)
    });
    vscode.window.showInformationMessage(
      getMessage('commitMessageModelSaved', `${selection.model.vendor} · ${selection.model.name}`)
    );
  } catch (error: unknown) {
    if (isRequestCancelledError(error)) {
      logger.info(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} command cancelled by exception`, {
        elapsedMs: Date.now() - startedAt
      });
      vscode.window.showInformationMessage(getMessage('requestCancelled'));
      return;
    }
    logger.error(`${COMMIT_MESSAGE_MODEL_SELECTION_LOG_PREFIX} command failed`, {
      elapsedMs: Date.now() - startedAt,
      error: formatErrorDetail(error)
    });
    logger.error('Failed to select commit message model.', error);
    const detail = formatErrorDetail(error);
    vscode.window.showErrorMessage(getMessage('commitMessageModelSelectionFailed', detail));
  }
}

export async function generateCommitMessage(commandContext?: unknown): Promise<void> {
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: getMessage('commitMessageGenerating'),
        cancellable: true
      },
      async (progress, token) => {
        const reportProgress = (message: string, increment: number): void => {
          progress.report({ message, increment });
        };

        // Yield once so progress UI can render immediately after button click.
        reportProgress(getMessage('commitMessageProgressCheckingRepo'), 1);
        await Promise.resolve();
        throwIfCancelled(token);

        const repo = await getGitRepository(commandContext);
        throwIfCancelled(token);
        if (!repo) {
          vscode.window.showWarningMessage(getMessage('commitMessageNoGitRepo'));
          return;
        }

        reportProgress(getMessage('commitMessageProgressReadingDiff'), 9);
        const diff = await getDiff(repo);
        throwIfCancelled(token);
        if (diff.trim().length === 0) {
          vscode.window.showInformationMessage(getMessage('commitMessageNoChanges'));
          return;
        }

        reportProgress(getMessage('commitMessageProgressSelectingModel'), 10);
        const selection = await selectModel(true, false, token);
        throwIfCancelled(token);
        if (selection.kind === 'cancelled') {
          vscode.window.showInformationMessage(getMessage('requestCancelled'));
          return;
        }
        if (selection.kind === 'noModels') {
          vscode.window.showWarningMessage(getMessage('commitMessageNoModel'));
          return;
        }

        const model = selection.model;
        const settings = getCommitMessageSettings();
        const language = getCommitLanguage();
        const styleReferenceBlockPromise = shouldUseRecentCommitStyle()
          ? getRecentCommitMessages(
            repo,
            DEFAULT_RECENT_COMMIT_STYLE_SAMPLE_SIZE,
            settings.llmMaxPromptLength
          ).then(buildStyleReferenceBlock)
          : Promise.resolve<string | undefined>(undefined);

        reportProgress(getMessage('commitMessageProgressPreparing'), 20);
        const preparedInput = await prepareGenerationInput(model, diff, settings, token);
        throwIfCancelled(token);
        const styleReferenceBlock = await styleReferenceBlockPromise;
        throwIfCancelled(token);
        const generationStageMessage =
          preparedInput.kind === 'summary'
            ? getMessage('commitMessageProgressGeneratingFromSummary')
            : getMessage('commitMessageProgressGeneratingFromDiff');
        reportProgress(generationStageMessage, 20);
        const prompt =
          preparedInput.kind === 'summary'
            ? buildSummaryGenerationPrompt(
              preparedInput.summary,
              language,
              settings,
              styleReferenceBlock,
              {
                diff: preparedInput.diffForReference,
                originalLines: preparedInput.diffOriginalLines,
                truncated: preparedInput.diffTruncated
              }
            )
            : buildDiffGenerationPrompt(
              preparedInput.diff,
              language,
              settings,
              preparedInput.breakingChangeExpected,
              styleReferenceBlock
            );

        const rawResult = await sendPrompt(
          model,
          prompt,
          token,
          'Generate a git commit message from code changes.',
          settings.llmMaxPromptLength
        );
        throwIfCancelled(token);

        const normalizedMessage = sanitizeGeneratedCommitMessage(rawResult);
        if (!normalizedMessage) {
          throw new Error('Empty commit message generated');
        }

        maybeWarnOnValidationFailure(
          normalizedMessage,
          language,
          settings,
          preparedInput.breakingChangeExpected
        );

        repo.inputBox.value = normalizedMessage;
        progress.report({ increment: 40 });
        vscode.window.showInformationMessage(
          getMessage('commitMessageGenerated', getCommitMessagePreview(normalizedMessage))
        );
      }
    );
  } catch (error: unknown) {
    if (isRequestCancelledError(error)) {
      vscode.window.showInformationMessage(getMessage('requestCancelled'));
      return;
    }
    logger.error('Failed to generate commit message.', error);
    const detail = formatErrorDetail(error);
    vscode.window.showErrorMessage(getMessage('commitMessageFailed', detail));
  }
}
