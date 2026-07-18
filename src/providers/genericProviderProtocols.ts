import * as vscode from 'vscode';
import {
  ChatContentPart,
  ChatImageContentPart,
  ChatMessage,
  ChatMessageContent,
  ChatToolCall,
  ChatToolDefinition,
} from './baseProvider';
import { AnthropicEffort, ChatThinkingEffort, ResponsesThinkingEffort } from '../constants';

type ThinkingToggle = {
  type: 'enabled' | 'disabled';
};

type AnthropicThinkingToggle = {
  type: 'adaptive' | 'disabled';
};

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  tools?: ChatToolDefinition[];
  tool_choice?: 'auto' | 'required';
  temperature?: number;
  top_p?: number;
  thinking?: ThinkingToggle;
  reasoning_effort?: Exclude<ChatThinkingEffort, 'none'>;
  max_tokens?: number;
  stream?: boolean;
}

interface OpenAIChatTextContentPart {
  type: 'text';
  text: string;
}

interface OpenAIChatImageContentPart {
  type: 'image_url';
  image_url: {
    url: string;
  };
}

type OpenAIChatContentPart = OpenAIChatTextContentPart | OpenAIChatImageContentPart;

export interface OpenAIChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | OpenAIChatContentPart[];
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface OpenAIChatResponse {
  id: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content?: unknown;
      reasoning_content?: unknown;
      reasoning?: unknown;
      tool_calls?: ChatToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAIResponsesToolDefinition {
  type: 'function';
  name: string;
  description?: string;
  parameters?: object;
}

interface OpenAIResponsesInputTextContent {
  type: 'input_text';
  text: string;
}

interface OpenAIResponsesInputImageContent {
  type: 'input_image';
  image_url: string;
}

interface OpenAIResponsesInputToolCallContent {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

interface OpenAIResponsesInputToolResultContent {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

type OpenAIResponsesInputContent = OpenAIResponsesInputTextContent | OpenAIResponsesInputImageContent;

interface OpenAIResponsesInputMessage {
  type?: 'message';
  role: 'system' | 'user' | 'assistant';
  content: string | OpenAIResponsesInputContent[];
}

export type OpenAIResponsesInputItem =
  | OpenAIResponsesInputMessage
  | OpenAIResponsesInputToolCallContent
  | OpenAIResponsesInputToolResultContent;

export interface OpenAIResponsesRequest {
  model: string;
  instructions?: string;
  input: OpenAIResponsesInputItem[];
  tools?: OpenAIResponsesToolDefinition[];
  tool_choice?: 'auto' | 'required';
  top_p?: number;
  reasoning?: {
    effort: ResponsesThinkingEffort;
  };
  max_output_tokens?: number;
  stream?: boolean;
}

interface OpenAIResponsesFunctionCallItem {
  id?: string;
  type: 'function_call';
  call_id?: string;
  name?: string;
  arguments?: string;
}

interface OpenAIResponsesMessageItem {
  type: 'message';
  role?: string;
  content?: Array<{
    type?: string;
    text?: string;
  }>;
}

interface OpenAIResponsesReasoningItem {
  type: 'reasoning';
  summary?: Array<{
    type?: string;
    text?: string;
  }>;
}

type OpenAIResponsesOutputItem = OpenAIResponsesFunctionCallItem | OpenAIResponsesMessageItem | OpenAIResponsesReasoningItem;

export interface OpenAIResponsesResponse {
  id: string;
  output?: OpenAIResponsesOutputItem[];
  output_text?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

export interface AnthropicToolDefinition {
  name: string;
  description?: string;
  input_schema?: object;
}

interface AnthropicTextContentBlock {
  type: 'text';
  text: string;
}

interface AnthropicImageContentBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

interface AnthropicToolUseContentBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input?: unknown;
}

interface AnthropicToolResultContentBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

type AnthropicRequestContentBlock =
  | AnthropicTextContentBlock
  | AnthropicImageContentBlock
  | AnthropicToolUseContentBlock
  | AnthropicToolResultContentBlock;

export interface AnthropicChatMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicRequestContentBlock[];
}

export interface AnthropicChatRequest {
  model: string;
  max_tokens?: number;
  system?: string;
  messages: AnthropicChatMessage[];
  tools?: AnthropicToolDefinition[];
  tool_choice?: AnthropicToolChoice;
  thinking?: AnthropicThinkingToggle;
  output_config?: {
    effort: AnthropicEffort;
  };
  temperature?: number;
  top_p?: number;
  stream?: boolean;
}

export interface AnthropicToolChoice {
  type: 'auto' | 'any' | 'tool' | 'none';
  name?: string;
}

interface AnthropicResponseTextContentBlock {
  type: string;
  text?: string;
}

interface AnthropicResponseThinkingContentBlock {
  type: 'thinking';
  thinking: string;
}

interface AnthropicResponseToolUseContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
}

type AnthropicResponseContentBlock =
  | AnthropicResponseTextContentBlock
  | AnthropicResponseThinkingContentBlock
  | AnthropicResponseToolUseContentBlock;

export interface AnthropicChatResponse {
  id: string;
  role: 'assistant';
  content?: AnthropicResponseContentBlock[];
  stop_reason?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export interface OpenAIChatStreamChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: unknown;
      reasoning_content?: unknown;
      reasoning?: unknown;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: 'function';
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    message?: {
      role?: string;
      content?: unknown;
      reasoning_content?: unknown;
      reasoning?: unknown;
      tool_calls?: ChatToolCall[];
    };
    text?: unknown;
    output_text?: unknown;
    finish_reason?: string | null;
  }>;
  usage?: OpenAIChatResponse['usage'];
}

export interface OpenAIResponsesStreamEvent {
  type?: string;
  response?: OpenAIResponsesResponse;
  item_id?: string;
  output_index?: number;
  call_id?: string;
  name?: string;
  arguments?: string;
  item?: {
    id?: string;
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  };
  delta?: string;
  text?: string;
  output_text?: string;
  usage?: OpenAIResponsesResponse['usage'];
}

export interface AnthropicStreamEvent {
  type?: string;
  index?: number;
  usage?: AnthropicChatResponse['usage'];
  message?: AnthropicChatResponse;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  content_block?: {
    type?: string;
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    input?: unknown;
  };
}

export interface OpenAIChatStreamState {
  content: string;
  fallbackContent: string;
  responseId?: string;
  usage?: OpenAIChatResponse['usage'];
  finishReason?: string;
  toolCalls: Map<
    number,
    {
      id?: string;
      name?: string;
      arguments: string;
    }
  >;
}

interface OpenAIResponsesStreamToolCall {
  id: string;
  callId?: string;
  itemId?: string;
  name?: string;
  arguments: string;
  argumentsComplete: boolean;
  order: number;
}

export interface OpenAIResponsesStreamState {
  content: string;
  reasoningContent: string;
  responseId?: string;
  usage?: OpenAIResponsesResponse['usage'];
  finalResponse?: OpenAIResponsesResponse;
  toolCalls: Map<string, OpenAIResponsesStreamToolCall>;
  toolCallAliases: Map<string, string>;
  nextToolCallOrder: number;
  lastToolCallKey?: string;
}

export interface AnthropicStreamState {
  content: string;
  reasoningContent: string;
  responseId?: string;
  usage?: AnthropicChatResponse['usage'];
  stopReason?: string;
  finalMessage?: AnthropicChatResponse;
  blocks: Map<
    number,
    {
      type: 'text' | 'thinking' | 'tool_use';
      text: string;
      id?: string;
      name?: string;
      inputJson: string;
    }
  >;
}

type GenerateToolCallId = () => string;

export function createOpenAIChatStreamState(): OpenAIChatStreamState {
  return {
    content: '',
    fallbackContent: '',
    toolCalls: new Map(),
  };
}

function readOpenAICompatibleText(value: unknown): string {
  if (typeof value === 'string') {
    return stripOpenAICompatibleNonTextPlaceholders(value);
  }

  if (Array.isArray(value)) {
    return value.map((part) => readOpenAICompatibleText(part)).join('');
  }

  if (!value || typeof value !== 'object') {
    return '';
  }

  const record = value as Record<string, unknown>;
  const partType = typeof record.type === 'string' ? record.type.trim().toLowerCase() : '';
  if (partType.length > 0 && partType !== 'text' && partType !== 'output_text' && partType !== 'reasoning') {
    return '';
  }
  if (typeof record.text === 'string') {
    return stripOpenAICompatibleNonTextPlaceholders(record.text);
  }
  if (typeof record.value === 'string') {
    return stripOpenAICompatibleNonTextPlaceholders(record.value);
  }
  if (typeof record.content === 'string') {
    return stripOpenAICompatibleNonTextPlaceholders(record.content);
  }
  if (Array.isArray(record.content)) {
    return record.content.map((part) => readOpenAICompatibleText(part)).join('');
  }

  return '';
}

function stripOpenAICompatibleNonTextPlaceholders(text: string): string {
  return text.replace(/\[[a-z0-9_./+-]+\s+\d+\s+bytes\]/gi, '');
}

export function readOpenAIChatMessageText(
  message:
    | {
        content?: unknown;
        reasoning_content?: unknown;
        reasoning?: unknown;
      }
    | undefined,
): string {
  if (!message) {
    return '';
  }

  return readOpenAIChatMessageContentText(message) || readOpenAIChatMessageReasoningText(message);
}

export function readOpenAIChatMessageContentText(
  message:
    | {
        content?: unknown;
      }
    | undefined,
): string {
  if (!message) {
    return '';
  }

  return readOpenAICompatibleText(message.content);
}

export function readOpenAIChatMessageReasoningText(
  message:
    | {
        reasoning_content?: unknown;
        reasoning?: unknown;
      }
    | undefined,
): string {
  if (!message) {
    return '';
  }

  return readOpenAICompatibleText(message.reasoning_content) || readOpenAICompatibleText(message.reasoning);
}

export function applyOpenAIChatStreamChunk(
  state: OpenAIChatStreamState,
  chunk: OpenAIChatStreamChunk,
  generateToolCallId: GenerateToolCallId,
): { textDelta: string } {
  let textDelta = '';
  if (typeof chunk.id === 'string' && chunk.id.trim().length > 0) {
    state.responseId = chunk.id;
  }
  if (chunk.usage) {
    state.usage = chunk.usage;
  }

  for (const choice of chunk.choices ?? []) {
    const nextText =
      readOpenAICompatibleText(choice.delta?.content) ||
      readOpenAICompatibleText(choice.message?.content) ||
      readOpenAICompatibleText(choice.text) ||
      readOpenAICompatibleText(choice.output_text);
    if (nextText.length > 0) {
      state.content += nextText;
      textDelta += nextText;
    }

    const fallbackText =
      readOpenAICompatibleText(choice.delta?.reasoning_content) ||
      readOpenAICompatibleText(choice.message?.reasoning_content) ||
      readOpenAICompatibleText(choice.delta?.reasoning) ||
      readOpenAICompatibleText(choice.message?.reasoning);
    if (fallbackText.length > 0) {
      state.fallbackContent += fallbackText;
    }

    const toolCalls =
      choice.delta?.tool_calls ??
      choice.message?.tool_calls?.map((toolCall, index) => ({
        index,
        id: toolCall.id,
        type: toolCall.type,
        function: toolCall.function,
      }));
    for (const toolCall of toolCalls ?? []) {
      const toolIndex = typeof toolCall.index === 'number' ? toolCall.index : state.toolCalls.size;
      const existing = state.toolCalls.get(toolIndex) ?? { arguments: '' };
      if (typeof toolCall.id === 'string' && toolCall.id.trim().length > 0) {
        existing.id = toolCall.id;
      }
      const functionName = toolCall.function?.name;
      if (typeof functionName === 'string' && functionName.trim().length > 0) {
        existing.name = functionName;
      }
      const functionArguments = toolCall.function?.arguments;
      if (typeof functionArguments === 'string' && functionArguments.length > 0) {
        existing.arguments += functionArguments;
      }
      state.toolCalls.set(toolIndex, existing);
    }

    if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
      state.finishReason = choice.finish_reason;
    }
  }

  if (state.toolCalls.size === 0 && chunk.choices?.some((choice) => Array.isArray(choice.message?.tool_calls))) {
    for (const choice of chunk.choices) {
      for (const [index, toolCall] of (choice.message?.tool_calls ?? []).entries()) {
        state.toolCalls.set(index, {
          id: toolCall.id || generateToolCallId(),
          name: toolCall.function?.name,
          arguments: toolCall.function?.arguments ?? '{}',
        });
      }
    }
  }

  return { textDelta };
}

export function finalizeOpenAIChatStreamState(
  state: OpenAIChatStreamState,
  generateToolCallId: GenerateToolCallId,
): { content: string; reasoningContent?: string; toolCalls: ChatToolCall[]; usage?: OpenAIChatResponse['usage'] } {
  const reasoningContent = state.fallbackContent || undefined;
  const hasToolCalls = state.toolCalls.size > 0;
  return {
    content: state.content || (hasToolCalls ? '' : (reasoningContent ?? '')),
    ...(reasoningContent ? { reasoningContent } : {}),
    toolCalls: [...state.toolCalls.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([, toolCall]) => ({
        id: toolCall.id || generateToolCallId(),
        type: 'function',
        function: {
          name: toolCall.name || 'unknown_tool',
          arguments: toolCall.arguments || '{}',
        },
      })),
    usage: state.usage,
  };
}

export function createOpenAIResponsesStreamState(): OpenAIResponsesStreamState {
  return {
    content: '',
    reasoningContent: '',
    toolCalls: new Map(),
    toolCallAliases: new Map(),
    nextToolCallOrder: 0,
  };
}

function readNonEmptyStreamIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function buildOpenAIResponsesToolCallAliases(
  callId: string | undefined,
  itemId: string | undefined,
  outputIndex: number | undefined,
): string[] {
  return [
    callId ? `call:${callId}` : undefined,
    itemId ? `item:${itemId}` : undefined,
    outputIndex !== undefined ? `output:${outputIndex}` : undefined,
  ].filter((alias): alias is string => alias !== undefined);
}

function mergeOpenAIResponsesToolCalls(
  state: OpenAIResponsesStreamState,
  primaryKey: string,
  secondaryKey: string,
): void {
  if (primaryKey === secondaryKey) {
    return;
  }

  const primary = state.toolCalls.get(primaryKey);
  const secondary = state.toolCalls.get(secondaryKey);
  if (!primary || !secondary) {
    return;
  }

  primary.callId ??= secondary.callId;
  primary.itemId ??= secondary.itemId;
  primary.name ??= secondary.name;
  if (secondary.argumentsComplete && (!primary.argumentsComplete || secondary.arguments.length >= primary.arguments.length)) {
    primary.arguments = secondary.arguments;
    primary.argumentsComplete = true;
  } else if (!primary.argumentsComplete && !secondary.argumentsComplete && secondary.arguments.length > 0) {
    primary.arguments += secondary.arguments;
  }
  primary.order = Math.min(primary.order, secondary.order);

  state.toolCalls.delete(secondaryKey);
  for (const [alias, key] of state.toolCallAliases) {
    if (key === secondaryKey) {
      state.toolCallAliases.set(alias, primaryKey);
    }
  }
  if (state.lastToolCallKey === secondaryKey) {
    state.lastToolCallKey = primaryKey;
  }
}

function resolveOpenAIResponsesToolCall(
  state: OpenAIResponsesStreamState,
  payload: OpenAIResponsesStreamEvent,
  generateToolCallId: GenerateToolCallId,
  fallbackOutputIndex?: number,
): OpenAIResponsesStreamToolCall {
  const callId = readNonEmptyStreamIdentifier(payload.call_id) ?? readNonEmptyStreamIdentifier(payload.item?.call_id);
  const itemId = readNonEmptyStreamIdentifier(payload.item_id) ?? readNonEmptyStreamIdentifier(payload.item?.id);
  const outputIndex =
    typeof payload.output_index === 'number' && Number.isInteger(payload.output_index)
      ? payload.output_index
      : fallbackOutputIndex;
  const aliases = buildOpenAIResponsesToolCallAliases(callId, itemId, outputIndex);
  const matchingKeys = [...new Set(aliases.map((alias) => state.toolCallAliases.get(alias)).filter(Boolean))] as string[];
  matchingKeys.sort(
    (left, right) =>
      (state.toolCalls.get(left)?.order ?? Number.MAX_SAFE_INTEGER) -
      (state.toolCalls.get(right)?.order ?? Number.MAX_SAFE_INTEGER),
  );

  let toolCallKey = matchingKeys[0];
  if (!toolCallKey && aliases.length === 0 && state.lastToolCallKey && state.toolCalls.has(state.lastToolCallKey)) {
    toolCallKey = state.lastToolCallKey;
  }

  if (!toolCallKey) {
    const toolCallId = callId ?? itemId ?? generateToolCallId();
    toolCallKey = aliases[0] ?? `generated:${toolCallId}`;
    state.toolCalls.set(toolCallKey, {
      id: toolCallId,
      callId,
      itemId,
      arguments: '',
      argumentsComplete: false,
      order: state.nextToolCallOrder,
    });
    state.nextToolCallOrder += 1;
  }

  for (const secondaryKey of matchingKeys.slice(1)) {
    mergeOpenAIResponsesToolCalls(state, toolCallKey, secondaryKey);
  }

  const toolCall = state.toolCalls.get(toolCallKey);
  if (!toolCall) {
    throw new Error('Failed to resolve OpenAI Responses tool call stream state.');
  }

  toolCall.callId = callId ?? toolCall.callId;
  toolCall.itemId = itemId ?? toolCall.itemId;
  for (const alias of aliases) {
    state.toolCallAliases.set(alias, toolCallKey);
  }
  state.lastToolCallKey = toolCallKey;
  return toolCall;
}

function applyCompletedOpenAIResponsesToolCall(
  toolCall: OpenAIResponsesStreamToolCall,
  name: unknown,
  rawArguments: unknown,
): void {
  const resolvedName = readNonEmptyStreamIdentifier(name);
  if (resolvedName) {
    toolCall.name = resolvedName;
  }
  if (typeof rawArguments === 'string') {
    if (rawArguments.length > 0 || toolCall.arguments.length === 0) {
      toolCall.arguments = rawArguments;
    }
    toolCall.argumentsComplete = true;
  }
}

export function applyOpenAIResponsesStreamEvent(
  state: OpenAIResponsesStreamState,
  eventType: string | undefined,
  payload: OpenAIResponsesStreamEvent,
  generateToolCallId: GenerateToolCallId,
): { textDelta: string } {
  const resolvedEventType = eventType || payload.type;
  let textDelta = '';

  if (payload.response) {
    state.finalResponse = payload.response;
    if (typeof payload.response.id === 'string' && payload.response.id.trim().length > 0) {
      state.responseId = payload.response.id;
    }
    if (payload.response.usage) {
      state.usage = payload.response.usage;
    }
    for (const [outputIndex, item] of (payload.response.output ?? []).entries()) {
      if (item.type !== 'function_call') {
        continue;
      }
      const toolCall = resolveOpenAIResponsesToolCall(
        state,
        {
          item_id: item.id,
          call_id: item.call_id,
          output_index: outputIndex,
        },
        generateToolCallId,
      );
      const name = readNonEmptyStreamIdentifier(item.name);
      if (name) {
        toolCall.name = name;
      }
      if (resolvedEventType === 'response.completed') {
        applyCompletedOpenAIResponsesToolCall(toolCall, item.name, item.arguments);
      } else if (typeof item.arguments === 'string' && item.arguments.length > 0 && toolCall.arguments.length === 0) {
        toolCall.arguments = item.arguments;
      }
    }
  }
  if (payload.usage) {
    state.usage = payload.usage;
  }

  if (resolvedEventType === 'response.output_text.delta') {
    const deltaText =
      typeof payload.delta === 'string'
        ? payload.delta
        : typeof payload.output_text === 'string'
          ? payload.output_text
          : '';
    if (deltaText.length > 0) {
      state.content += deltaText;
      textDelta = deltaText;
    }
    return { textDelta };
  }

  if (resolvedEventType === 'response.reasoning_text.delta') {
    const reasoningDelta =
      typeof payload.delta === 'string'
        ? payload.delta
        : '';
    if (reasoningDelta.length > 0) {
      state.reasoningContent += reasoningDelta;
    }
    return { textDelta };
  }

  if (resolvedEventType === 'response.function_call_arguments.delta') {
    const toolCall = resolveOpenAIResponsesToolCall(state, payload, generateToolCallId);
    const name = readNonEmptyStreamIdentifier(payload.name) ?? readNonEmptyStreamIdentifier(payload.item?.name);
    if (name) {
      toolCall.name = name;
    }
    if (typeof payload.delta === 'string' && payload.delta.length > 0) {
      toolCall.arguments += payload.delta;
    }
    return { textDelta };
  }

  if (resolvedEventType === 'response.function_call_arguments.done') {
    const toolCall = resolveOpenAIResponsesToolCall(state, payload, generateToolCallId);
    applyCompletedOpenAIResponsesToolCall(
      toolCall,
      payload.name ?? payload.item?.name,
      payload.arguments ?? payload.item?.arguments,
    );
    return { textDelta };
  }

  if (resolvedEventType === 'response.output_item.done' || resolvedEventType === 'response.output_item.added') {
    if (payload.item?.type === 'function_call') {
      const toolCall = resolveOpenAIResponsesToolCall(state, payload, generateToolCallId);
      const name = readNonEmptyStreamIdentifier(payload.item.name);
      if (name) {
        toolCall.name = name;
      }
      if (resolvedEventType === 'response.output_item.done') {
        applyCompletedOpenAIResponsesToolCall(toolCall, payload.item.name, payload.item.arguments);
      } else if (typeof payload.item.arguments === 'string' && payload.item.arguments.length > 0) {
        toolCall.arguments = payload.item.arguments;
      }
      return { textDelta };
    }

    if (payload.item?.type === 'message' && state.content.length === 0) {
      const fallbackText = (payload.item.content ?? [])
        .map((content) => (typeof content.text === 'string' ? content.text : ''))
        .join('');
      if (fallbackText.length > 0) {
        state.content = fallbackText;
        textDelta = fallbackText;
      }
    }
    return { textDelta };
  }

  if (resolvedEventType === 'response.completed' && payload.response) {
    if (state.content.length === 0) {
      const parsed = parseOpenAIResponsesResponse(payload.response, generateToolCallId);
      state.content = parsed.content;
      textDelta = parsed.content;
    }
    return { textDelta };
  }

  return { textDelta };
}

export function finalizeOpenAIResponsesStreamState(
  state: OpenAIResponsesStreamState,
  generateToolCallId: GenerateToolCallId,
): { content: string; reasoningContent?: string; toolCalls: ChatToolCall[]; usage?: OpenAIResponsesResponse['usage'] } {
  const mergedToolCalls = new Map<string, ChatToolCall>();
  for (const toolCall of [...state.toolCalls.values()].sort((left, right) => left.order - right.order)) {
    const toolCallId = toolCall.callId ?? toolCall.itemId ?? toolCall.id;
    mergedToolCalls.set(toolCallId, {
      id: toolCallId,
      type: 'function',
      function: {
        name: toolCall.name || 'unknown_tool',
        arguments: toolCall.arguments || '{}',
      },
    });
  }

  if (state.finalResponse) {
    const parsed = parseOpenAIResponsesResponse(state.finalResponse, generateToolCallId);
    if (state.content.length === 0 && parsed.content.length > 0) {
      state.content = parsed.content;
    }
    for (const toolCall of parsed.toolCalls) {
      if (!mergedToolCalls.has(toolCall.id)) {
        mergedToolCalls.set(toolCall.id, toolCall);
      }
    }
    if (!state.reasoningContent && parsed.reasoningContent) {
      state.reasoningContent = parsed.reasoningContent;
    }
  }

  const reasoningContent = state.reasoningContent || undefined;

  return {
    content: state.content,
    ...(reasoningContent ? { reasoningContent } : {}),
    toolCalls: [...mergedToolCalls.values()],
    usage: state.usage,
  };
}

export function createAnthropicStreamState(): AnthropicStreamState {
  return {
    content: '',
    reasoningContent: '',
    blocks: new Map(),
  };
}

export function applyAnthropicStreamEvent(
  state: AnthropicStreamState,
  eventType: string | undefined,
  payload: AnthropicStreamEvent,
): { textDelta: string } {
  const resolvedEventType = eventType || payload.type;
  let textDelta = '';

  if (resolvedEventType === 'message_start' && payload.message) {
    state.finalMessage = payload.message;
    if (typeof payload.message.id === 'string' && payload.message.id.trim().length > 0) {
      state.responseId = payload.message.id;
    }
    if (payload.message.usage) {
      state.usage = mergeAnthropicUsage(state.usage, payload.message.usage);
    }
    return { textDelta };
  }

  if (resolvedEventType === 'content_block_start' && typeof payload.index === 'number' && payload.content_block) {
    if (isAnthropicToolUseBlock(payload.content_block)) {
      state.blocks.set(payload.index, {
        type: 'tool_use',
        text: '',
        id: payload.content_block.id,
        name: payload.content_block.name,
        inputJson: payload.content_block.input !== undefined ? JSON.stringify(payload.content_block.input) : '',
      });
      return { textDelta };
    }

    const isThinkingBlock = payload.content_block.type === 'thinking';
    const initialText =
      typeof payload.content_block.thinking === 'string'
        ? payload.content_block.thinking
        : typeof (payload.content_block as { text?: unknown }).text === 'string'
          ? (payload.content_block as { text: string }).text
          : '';

    state.blocks.set(payload.index, {
      type: isThinkingBlock ? 'thinking' : 'text',
      text: initialText,
      inputJson: '',
    });

    if (initialText.length > 0) {
      if (isThinkingBlock) {
        state.reasoningContent += initialText;
      } else {
        state.content += initialText;
        textDelta = initialText;
      }
    }
    return { textDelta };
  }

  if (resolvedEventType === 'content_block_delta' && typeof payload.index === 'number') {
    const block = state.blocks.get(payload.index);
    if (!block) {
      return { textDelta };
    }

    const deltaText = typeof payload.delta?.text === 'string' ? payload.delta.text : '';
    if (block.type === 'text' && deltaText.length > 0) {
      block.text += deltaText;
      state.content += deltaText;
      textDelta = deltaText;
      return { textDelta };
    }

    const deltaThinking =
      typeof payload.delta?.thinking === 'string'
        ? payload.delta.thinking
        : payload.delta?.type === 'thinking_delta' && typeof payload.delta?.text === 'string'
          ? payload.delta.text
          : '';
    if (block.type === 'thinking' && deltaThinking.length > 0) {
      block.text += deltaThinking;
      state.reasoningContent += deltaThinking;
      return { textDelta };
    }

    if (payload.delta?.type === 'input_json_delta' && typeof payload.delta.partial_json === 'string') {
      block.inputJson += payload.delta.partial_json;
    }
    return { textDelta };
  }

  if (resolvedEventType === 'message_delta') {
    if (payload.usage) {
      state.usage = mergeAnthropicUsage(state.usage, payload.usage);
    }
    if (typeof payload.delta?.stop_reason === 'string' && payload.delta.stop_reason.length > 0) {
      state.stopReason = payload.delta.stop_reason;
    }
  }

  return { textDelta };
}

function mergeAnthropicUsage(
  current: AnthropicChatResponse['usage'],
  next: AnthropicChatResponse['usage'],
): AnthropicChatResponse['usage'] {
  if (!current) {
    return next ? { ...next } : undefined;
  }
  if (!next) {
    return { ...current };
  }

  return {
    ...current,
    ...next,
  };
}

export function finalizeAnthropicStreamState(
  state: AnthropicStreamState,
  generateToolCallId: GenerateToolCallId,
): { content: string; reasoningContent?: string; toolCalls: ChatToolCall[]; usage?: AnthropicChatResponse['usage'] } {
  const toolCalls: ChatToolCall[] = [];
  for (const [, block] of [...state.blocks.entries()].sort((left, right) => left[0] - right[0])) {
    if (block.type === 'thinking') {
      continue;
    }
    if (block.type !== 'tool_use' || !block.name) {
      continue;
    }
    const parsedArguments = parseToolArgumentsSafe(block.inputJson || '{}');
    toolCalls.push({
      id: block.id || generateToolCallId(),
      type: 'function',
      function: {
        name: block.name,
        arguments: JSON.stringify(parsedArguments),
      },
    });
  }

  if (state.finalMessage) {
    const parsed = parseAnthropicResponse(state.finalMessage, generateToolCallId);
    if (state.content.length === 0 && parsed.content.length > 0) {
      state.content = parsed.content;
    }
    if (toolCalls.length === 0 && parsed.toolCalls.length > 0) {
      toolCalls.push(...parsed.toolCalls);
    }
    if (!state.reasoningContent && parsed.reasoningContent) {
      state.reasoningContent = parsed.reasoningContent;
    }
  }

  const reasoningContent = state.reasoningContent || undefined;

  return {
    content: state.content,
    ...(reasoningContent ? { reasoningContent } : {}),
    toolCalls,
    usage: state.usage,
  };
}

export function buildAnthropicToolDefinitions(tools?: ChatToolDefinition[]): AnthropicToolDefinition[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }));
}

export function buildAnthropicToolChoice(
  options?: vscode.LanguageModelChatRequestOptions,
): AnthropicToolChoice | undefined {
  if (!options?.tools || options.tools.length === 0) {
    return undefined;
  }

  if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
    return { type: 'any' };
  }

  return { type: 'auto' };
}

export function buildOpenAIResponsesToolDefinitions(
  tools?: ChatToolDefinition[],
): OpenAIResponsesToolDefinition[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));
}

export function toOpenAIChatMessages(messages: ChatMessage[]): OpenAIChatMessage[] {
  return messages.map((message) => ({
    ...message,
    content: toOpenAIChatContent(message.content),
  }));
}

function toOpenAIChatContent(content: ChatMessageContent): OpenAIChatMessage['content'] {
  if (typeof content === 'string') {
    return content;
  }

  return content.map((part) => {
    if (part.type === 'image') {
      return {
        type: 'image_url',
        image_url: {
          url: toDataUrl(part),
        },
      };
    }

    return {
      type: 'text',
      text: part.text,
    };
  });
}

export function toOpenAIResponsesInput(
  messages: ChatMessage[],
  generateToolCallId: GenerateToolCallId,
): OpenAIResponsesInputItem[] {
  return toOpenAIResponsesPayloadParts(messages, generateToolCallId).input;
}

export function toOpenAIResponsesInputWithoutInstructions(
  messages: ChatMessage[],
  generateToolCallId: GenerateToolCallId,
): OpenAIResponsesInputItem[] {
  const input: OpenAIResponsesInputItem[] = [];

  for (const message of messages) {
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id || generateToolCallId(),
        output: getTextContent(message.content),
      });
      continue;
    }

    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      const textContent = getTextContent(message.content);
      if (textContent.trim().length > 0) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: textContent,
        });
      }

      for (const toolCall of message.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: toolCall.id || generateToolCallId(),
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        });
      }
      continue;
    }

    input.push({
      type: 'message',
      role: message.role,
      content: toOpenAIResponsesContent(message.content),
    });
  }

  return input;
}

export function toOpenAIResponsesPayloadParts(
  messages: ChatMessage[],
  generateToolCallId: GenerateToolCallId,
): { instructions?: string; input: OpenAIResponsesInputItem[] } {
  const instructionParts: string[] = [];
  const input: OpenAIResponsesInputItem[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      const textContent = getTextContent(message.content);
      if (textContent.trim().length > 0) {
        instructionParts.push(textContent);
      }
      continue;
    }

    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id || generateToolCallId(),
        output: getTextContent(message.content),
      });
      continue;
    }

    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      const textContent = getTextContent(message.content);
      if (textContent.trim().length > 0) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: textContent,
        });
      }

      for (const toolCall of message.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: toolCall.id || generateToolCallId(),
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        });
      }
      continue;
    }

    input.push({
      type: 'message',
      role: message.role,
      content: toOpenAIResponsesContent(message.content),
    });
  }

  const instructions = instructionParts.join('\n\n');
  return {
    ...(instructions.length > 0 ? { instructions } : {}),
    input,
  };
}

function toOpenAIResponsesContent(content: ChatMessageContent): string | OpenAIResponsesInputContent[] {
  if (typeof content === 'string') {
    return content;
  }

  return content.map((part) => {
    if (part.type === 'image') {
      return {
        type: 'input_image',
        image_url: toDataUrl(part),
      };
    }

    return {
      type: 'input_text',
      text: part.text,
    };
  });
}

export function parseOpenAIResponsesResponse(
  response: OpenAIResponsesResponse,
  generateToolCallId: GenerateToolCallId,
): { content: string; reasoningContent?: string; toolCalls: ChatToolCall[] } {
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: ChatToolCall[] = [];

  for (const item of response.output ?? []) {
    if (item.type === 'function_call' && typeof item.name === 'string' && item.name.trim().length > 0) {
      toolCalls.push({
        id:
          typeof item.call_id === 'string' && item.call_id.trim().length > 0
            ? item.call_id
            : typeof item.id === 'string' && item.id.trim().length > 0
              ? item.id
              : generateToolCallId(),
        type: 'function',
        function: {
          name: item.name,
          arguments: typeof item.arguments === 'string' ? item.arguments : '{}',
        },
      });
      continue;
    }

    if (item.type === 'reasoning') {
      const reasoningItem = item as { type: 'reasoning'; summary?: Array<{ type?: string; text?: string }> };
      for (const summaryPart of reasoningItem.summary ?? []) {
        if (summaryPart.type === 'summary_text' && typeof summaryPart.text === 'string') {
          reasoningParts.push(summaryPart.text);
        }
      }
      continue;
    }

    if (item.type === 'message') {
      for (const contentPart of item.content ?? []) {
        if (
          (contentPart.type === 'output_text' || contentPart.type === 'text') &&
          typeof contentPart.text === 'string' &&
          contentPart.text.trim().length > 0
        ) {
          textParts.push(contentPart.text);
        }
      }
    }
  }

  if (textParts.length === 0 && typeof response.output_text === 'string' && response.output_text.trim().length > 0) {
    textParts.push(response.output_text);
  }

  const reasoningContent = reasoningParts.join('') || undefined;

  return {
    content: textParts.join(''),
    ...(reasoningContent ? { reasoningContent } : {}),
    toolCalls,
  };
}

function appendAnthropicTextBlock(message: AnthropicChatMessage, text: string): void {
  if (text.trim().length === 0) {
    return;
  }

  if (Array.isArray(message.content)) {
    message.content.push({ type: 'text', text });
    return;
  }

  message.content = `${message.content}${text}`;
}

function appendAnthropicContentBlocks(message: AnthropicChatMessage, content: ChatMessageContent): void {
  const blocks = toAnthropicContentBlocks(content);
  if (blocks.length === 0) {
    return;
  }

  if (Array.isArray(message.content)) {
    message.content.push(...blocks);
    return;
  }

  const existingText = message.content;
  message.content = [
    ...(existingText.trim().length > 0 ? [{ type: 'text' as const, text: existingText }] : []),
    ...blocks,
  ];
}

export function toAnthropicMessages(
  messages: ChatMessage[],
  generateToolCallId: GenerateToolCallId,
): { system: string; messages: AnthropicChatMessage[] } {
  const systemParts: string[] = [];
  const normalizedMessages: AnthropicChatMessage[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      const textContent = getTextContent(message.content);
      if (textContent.trim().length > 0) {
        systemParts.push(textContent);
      }
      continue;
    }

    if (message.role === 'tool') {
      const toolResultBlock: AnthropicToolResultContentBlock = {
        type: 'tool_result',
        tool_use_id: message.tool_call_id || generateToolCallId(),
        content: getTextContent(message.content),
      };
      const lastMessage = normalizedMessages[normalizedMessages.length - 1];
      if (lastMessage?.role === 'user') {
        if (Array.isArray(lastMessage.content)) {
          lastMessage.content.push(toolResultBlock);
        } else if (typeof lastMessage.content === 'string') {
          const blocks: AnthropicRequestContentBlock[] = [];
          if (lastMessage.content.trim().length > 0) {
            blocks.push({ type: 'text', text: lastMessage.content });
          }
          blocks.push(toolResultBlock);
          lastMessage.content = blocks;
        }
      } else {
        normalizedMessages.push({
          role: 'user',
          content: [toolResultBlock],
        });
      }
      continue;
    }

    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      const contentBlocks: AnthropicRequestContentBlock[] = [];
      const textContent = getTextContent(message.content);
      if (textContent.trim().length > 0) {
        contentBlocks.push({ type: 'text', text: textContent });
      }
      for (const toolCall of message.tool_calls) {
        contentBlocks.push({
          type: 'tool_use',
          id: toolCall.id || generateToolCallId(),
          name: toolCall.function.name,
          input: parseToolArgumentsSafe(toolCall.function.arguments),
        });
      }
      normalizedMessages.push({ role: 'assistant', content: contentBlocks });
      continue;
    }

    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const lastMessage = normalizedMessages[normalizedMessages.length - 1];
    if (role === 'user' && lastMessage?.role === 'user') {
      appendAnthropicContentBlocks(lastMessage, message.content);
      continue;
    }

    const contentBlocks = toAnthropicContentBlocks(message.content);
    normalizedMessages.push({
      role,
      content: contentBlocks.length > 0 ? contentBlocks : getTextContent(message.content),
    });
  }

  return {
    system: systemParts.join('\n\n').trim(),
    messages: normalizedMessages,
  };
}

export function parseAnthropicResponse(
  response: AnthropicChatResponse,
  generateToolCallId: GenerateToolCallId,
): { content: string; reasoningContent?: string; toolCalls: ChatToolCall[] } {
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls: ChatToolCall[] = [];

  for (const block of response.content ?? []) {
    if (block.type === 'thinking' && typeof (block as AnthropicResponseThinkingContentBlock).thinking === 'string') {
      const thinkingText = (block as AnthropicResponseThinkingContentBlock).thinking;
      if (thinkingText.trim().length > 0) {
        thinkingParts.push(thinkingText);
      }
      continue;
    }

    if (isAnthropicTextBlock(block)) {
      if (typeof block.text === 'string' && block.text.trim().length > 0) {
        textParts.push(block.text);
      }
      continue;
    }

    if (isAnthropicToolUseBlock(block)) {
      const toolUseBlock = block as AnthropicResponseToolUseContentBlock;
      if (typeof toolUseBlock.name === 'string' && toolUseBlock.name.trim().length > 0) {
        toolCalls.push({
          id:
            typeof toolUseBlock.id === 'string' && toolUseBlock.id.trim().length > 0
              ? toolUseBlock.id
              : generateToolCallId(),
          type: 'function',
          function: {
            name: toolUseBlock.name,
            arguments: JSON.stringify(toolUseBlock.input ?? {}),
          },
        });
      }
    }
  }

  const reasoningContent = thinkingParts.join('') || undefined;

  return {
    content: textParts.join(''),
    ...(reasoningContent ? { reasoningContent } : {}),
    toolCalls,
  };
}

function getTextContent(content: ChatMessageContent): string {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .filter((part): part is Extract<ChatContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function toDataUrl(part: ChatImageContentPart): string {
  return `data:${part.mimeType};base64,${part.data}`;
}

function toAnthropicContentBlocks(content: ChatMessageContent): AnthropicRequestContentBlock[] {
  if (typeof content === 'string') {
    return content.trim().length > 0 ? [{ type: 'text', text: content }] : [];
  }

  const blocks: AnthropicRequestContentBlock[] = content.map((part) => {
    if (part.type === 'image') {
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: part.mimeType,
          data: part.data,
        },
      };
    }

    return {
      type: 'text',
      text: part.text,
    };
  });

  return blocks.filter((block) => block.type !== 'text' || block.text.trim().length > 0);
}

function isAnthropicTextBlock(block: AnthropicResponseContentBlock): block is AnthropicResponseTextContentBlock {
  const text = (block as { text?: unknown }).text;
  return block.type === 'text' || (typeof text === 'string' && !isAnthropicToolUseType(block.type));
}

function isAnthropicToolUseBlock(block: { type?: string; name?: string; input?: unknown }): boolean {
  return (
    isAnthropicToolUseType(block.type) ||
    (typeof block.name === 'string' && block.name.trim().length > 0 && block.input !== undefined)
  );
}

function isAnthropicToolUseType(type: string | undefined): boolean {
  if (typeof type !== 'string') {
    return false;
  }

  const normalized = type.trim().toLowerCase();
  return normalized === 'tool_use' || normalized.endsWith('_tool_use');
}

export function summarizeOpenAIChatResponse(response: OpenAIChatResponse): Record<string, unknown> {
  return {
    id: response.id,
    created: response.created,
    model: response.model,
    choiceCount: response.choices.length,
    choices: response.choices.map((choice) => ({
      index: choice.index,
      finishReason: choice.finish_reason,
      role: choice.message?.role,
      contentLength: readOpenAIChatMessageText(choice.message).length,
      toolCallCount: choice.message?.tool_calls?.length ?? 0,
      toolCalls: (choice.message?.tool_calls ?? []).map((toolCall) => ({
        id: toolCall.id,
        type: toolCall.type,
        functionName: toolCall.function?.name,
        argumentsLength: typeof toolCall.function?.arguments === 'string' ? toolCall.function.arguments.length : 0,
      })),
    })),
    usage: response.usage,
  };
}

export function summarizeOpenAIResponsesResponse(response: OpenAIResponsesResponse): Record<string, unknown> {
  return {
    id: response.id,
    outputCount: response.output?.length ?? 0,
    outputTextLength: typeof response.output_text === 'string' ? response.output_text.length : 0,
    output: (response.output ?? []).map((item) => ({
      type: item.type,
      role: 'role' in item ? item.role : undefined,
      name: 'name' in item ? item.name : undefined,
      callId: 'call_id' in item ? item.call_id : undefined,
      argumentsLength: 'arguments' in item && typeof item.arguments === 'string' ? item.arguments.length : 0,
      contentPartCount: 'content' in item && Array.isArray(item.content) ? item.content.length : 0,
      contentTextLengths:
        'content' in item && Array.isArray(item.content)
          ? item.content.map((contentPart) => (typeof contentPart.text === 'string' ? contentPart.text.length : 0))
          : undefined,
    })),
    usage: response.usage,
  };
}

export function summarizeAnthropicResponseForLogging(
  response: AnthropicChatResponse | string,
): Record<string, unknown> {
  if (typeof response === 'string') {
    return {
      responseType: 'string',
      contentBlockCount: 0,
      contentBlocks: [],
      contentTextPreview: buildPreview(response, 100),
    };
  }

  const content = Array.isArray(response.content) ? response.content : [];
  return {
    id: response.id,
    role: response.role,
    stopReason: response.stop_reason,
    contentBlockCount: content.length,
    contentBlocks: content.map((block) => ({
      type: block.type,
      id: 'id' in block ? block.id : undefined,
      name: 'name' in block ? block.name : undefined,
      textLength: 'text' in block && typeof block.text === 'string' ? block.text.length : 0,
      hasInput: 'input' in block && block.input !== undefined,
    })),
    contentTextPreview: buildPreview(
      content
        .filter((block): block is AnthropicResponseTextContentBlock => isAnthropicTextBlock(block))
        .map((block) => block.text ?? '')
        .join(''),
      100,
    ),
    usage: response.usage,
  };
}

function parseToolArgumentsSafe(rawArgs: string): object {
  if (!rawArgs) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawArgs);
    if (parsed && typeof parsed === 'object') {
      return parsed as object;
    }
    return { value: parsed };
  } catch {
    return { raw: rawArgs };
  }
}

function buildPreview(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}...`;
}
