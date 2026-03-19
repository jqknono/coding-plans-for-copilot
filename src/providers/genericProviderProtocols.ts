import * as vscode from 'vscode';
import { ChatMessage, ChatToolCall, ChatToolDefinition } from './baseProvider';

export interface OpenAIChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatToolDefinition[];
  tool_choice?: 'auto' | 'required';
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface OpenAIChatResponse {
  id: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
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

type OpenAIResponsesInputContent = OpenAIResponsesInputTextContent;

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
  input: OpenAIResponsesInputItem[];
  tools?: OpenAIResponsesToolDefinition[];
  tool_choice?: 'auto' | 'required';
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  stream?: boolean;
}

interface OpenAIResponsesFunctionCallItem {
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

type OpenAIResponsesOutputItem = OpenAIResponsesFunctionCallItem | OpenAIResponsesMessageItem;

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
  | AnthropicToolUseContentBlock
  | AnthropicToolResultContentBlock;

export interface AnthropicChatMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicRequestContentBlock[];
}

export interface AnthropicChatRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicChatMessage[];
  tools?: AnthropicToolDefinition[];
  tool_choice?: AnthropicToolChoice;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
}

export interface AnthropicToolChoice {
  type: 'auto' | 'any' | 'tool' | 'none';
  name?: string;
}

interface AnthropicResponseTextContentBlock {
  type: 'text';
  text?: string;
}

interface AnthropicResponseToolUseContentBlock {
  type: 'tool_use';
  id?: string;
  name?: string;
  input?: unknown;
}

type AnthropicResponseContentBlock = AnthropicResponseTextContentBlock | AnthropicResponseToolUseContentBlock;

export interface AnthropicChatResponse {
  id: string;
  role: 'assistant';
  content?: AnthropicResponseContentBlock[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

export interface OpenAIChatStreamChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string;
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
      content?: string;
      tool_calls?: ChatToolCall[];
    };
    finish_reason?: string | null;
  }>;
  usage?: OpenAIChatResponse['usage'];
}

export interface OpenAIResponsesStreamEvent {
  type?: string;
  response?: OpenAIResponsesResponse;
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
    partial_json?: string;
    stop_reason?: string | null;
  };
  content_block?: {
    type?: string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
  };
}

export interface OpenAIChatStreamState {
  content: string;
  responseId?: string;
  usage?: OpenAIChatResponse['usage'];
  finishReason?: string;
  toolCalls: Map<number, {
    id?: string;
    name?: string;
    arguments: string;
  }>;
}

export interface OpenAIResponsesStreamState {
  content: string;
  responseId?: string;
  usage?: OpenAIResponsesResponse['usage'];
  finalResponse?: OpenAIResponsesResponse;
  toolCalls: Map<string, {
    id: string;
    name?: string;
    arguments: string;
  }>;
}

export interface AnthropicStreamState {
  content: string;
  responseId?: string;
  usage?: AnthropicChatResponse['usage'];
  stopReason?: string;
  finalMessage?: AnthropicChatResponse;
  blocks: Map<number, {
    type: 'text' | 'tool_use';
    text: string;
    id?: string;
    name?: string;
    inputJson: string;
  }>;
}

type GenerateToolCallId = () => string;

export function createOpenAIChatStreamState(): OpenAIChatStreamState {
  return {
    content: '',
    toolCalls: new Map()
  };
}

export function applyOpenAIChatStreamChunk(
  state: OpenAIChatStreamState,
  chunk: OpenAIChatStreamChunk,
  generateToolCallId: GenerateToolCallId
): { textDelta: string } {
  let textDelta = '';
  if (typeof chunk.id === 'string' && chunk.id.trim().length > 0) {
    state.responseId = chunk.id;
  }
  if (chunk.usage) {
    state.usage = chunk.usage;
  }

  for (const choice of chunk.choices ?? []) {
    const directContent = typeof choice.message?.content === 'string'
      ? choice.message.content
      : undefined;
    const deltaContent = typeof choice.delta?.content === 'string'
      ? choice.delta.content
      : undefined;
    const nextText = deltaContent ?? directContent ?? '';
    if (nextText.length > 0) {
      state.content += nextText;
      textDelta += nextText;
    }

    const toolCalls = choice.delta?.tool_calls
      ?? choice.message?.tool_calls?.map((toolCall, index) => ({
        index,
        id: toolCall.id,
        type: toolCall.type,
        function: toolCall.function
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

  if (textDelta.length === 0 && state.content.length === 0) {
    const fallbackText = chunk.choices?.map(choice => choice.message?.content ?? '').join('') ?? '';
    if (fallbackText.length > 0) {
      state.content = fallbackText;
      textDelta = fallbackText;
    }
  }

  if (state.toolCalls.size === 0 && chunk.choices?.some(choice => Array.isArray(choice.message?.tool_calls))) {
    for (const choice of chunk.choices) {
      for (const [index, toolCall] of (choice.message?.tool_calls ?? []).entries()) {
        state.toolCalls.set(index, {
          id: toolCall.id || generateToolCallId(),
          name: toolCall.function?.name,
          arguments: toolCall.function?.arguments ?? '{}'
        });
      }
    }
  }

  return { textDelta };
}

export function finalizeOpenAIChatStreamState(
  state: OpenAIChatStreamState,
  generateToolCallId: GenerateToolCallId
): { content: string; toolCalls: ChatToolCall[]; usage?: OpenAIChatResponse['usage'] } {
  return {
    content: state.content,
    toolCalls: [...state.toolCalls.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([, toolCall]) => ({
        id: toolCall.id || generateToolCallId(),
        type: 'function',
        function: {
          name: toolCall.name || 'unknown_tool',
          arguments: toolCall.arguments || '{}'
        }
      })),
    usage: state.usage
  };
}

export function createOpenAIResponsesStreamState(): OpenAIResponsesStreamState {
  return {
    content: '',
    toolCalls: new Map()
  };
}

export function applyOpenAIResponsesStreamEvent(
  state: OpenAIResponsesStreamState,
  eventType: string | undefined,
  payload: OpenAIResponsesStreamEvent,
  generateToolCallId: GenerateToolCallId
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
  }
  if (payload.usage) {
    state.usage = payload.usage;
  }

  if (resolvedEventType === 'response.output_text.delta') {
    const deltaText = typeof payload.delta === 'string'
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

  if (resolvedEventType === 'response.function_call_arguments.delta') {
    const toolId = payload.item?.call_id || payload.item?.id || generateToolCallId();
    const existing = state.toolCalls.get(toolId) ?? { id: toolId, arguments: '' };
    if (typeof payload.item?.name === 'string' && payload.item.name.trim().length > 0) {
      existing.name = payload.item.name;
    }
    if (typeof payload.delta === 'string' && payload.delta.length > 0) {
      existing.arguments += payload.delta;
    }
    state.toolCalls.set(toolId, existing);
    return { textDelta };
  }

  if (resolvedEventType === 'response.output_item.done' || resolvedEventType === 'response.output_item.added') {
    if (payload.item?.type === 'function_call') {
      const toolId = payload.item.call_id || payload.item.id || generateToolCallId();
      const existing = state.toolCalls.get(toolId) ?? { id: toolId, arguments: '' };
      if (typeof payload.item.name === 'string' && payload.item.name.trim().length > 0) {
        existing.name = payload.item.name;
      }
      if (typeof payload.item.arguments === 'string' && payload.item.arguments.length > 0) {
        existing.arguments = payload.item.arguments;
      }
      state.toolCalls.set(toolId, existing);
      return { textDelta };
    }

    if (payload.item?.type === 'message' && state.content.length === 0) {
      const fallbackText = (payload.item.content ?? [])
        .map(content => typeof content.text === 'string' ? content.text : '')
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
  generateToolCallId: GenerateToolCallId
): { content: string; toolCalls: ChatToolCall[]; usage?: OpenAIResponsesResponse['usage'] } {
  const mergedToolCalls = new Map<string, ChatToolCall>();
  for (const toolCall of state.toolCalls.values()) {
    mergedToolCalls.set(toolCall.id, {
      id: toolCall.id,
      type: 'function',
      function: {
        name: toolCall.name || 'unknown_tool',
        arguments: toolCall.arguments || '{}'
      }
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
  }

  return {
    content: state.content,
    toolCalls: [...mergedToolCalls.values()],
    usage: state.usage
  };
}

export function createAnthropicStreamState(): AnthropicStreamState {
  return {
    content: '',
    blocks: new Map()
  };
}

export function applyAnthropicStreamEvent(
  state: AnthropicStreamState,
  eventType: string | undefined,
  payload: AnthropicStreamEvent
): { textDelta: string } {
  const resolvedEventType = eventType || payload.type;
  let textDelta = '';

  if (resolvedEventType === 'message_start' && payload.message) {
    state.finalMessage = payload.message;
    if (typeof payload.message.id === 'string' && payload.message.id.trim().length > 0) {
      state.responseId = payload.message.id;
    }
    if (payload.message.usage) {
      state.usage = payload.message.usage;
    }
    return { textDelta };
  }

  if (resolvedEventType === 'content_block_start' && typeof payload.index === 'number' && payload.content_block) {
    if (payload.content_block.type === 'tool_use') {
      state.blocks.set(payload.index, {
        type: 'tool_use',
        text: '',
        id: payload.content_block.id,
        name: payload.content_block.name,
        inputJson: payload.content_block.input !== undefined
          ? JSON.stringify(payload.content_block.input)
          : ''
      });
      return { textDelta };
    }

    const initialText = typeof payload.content_block.text === 'string' ? payload.content_block.text : '';
    state.blocks.set(payload.index, {
      type: 'text',
      text: initialText,
      inputJson: ''
    });
    if (initialText.length > 0) {
      state.content += initialText;
      textDelta = initialText;
    }
    return { textDelta };
  }

  if (resolvedEventType === 'content_block_delta' && typeof payload.index === 'number') {
    const block = state.blocks.get(payload.index);
    if (!block) {
      return { textDelta };
    }

    if (payload.delta?.type === 'text_delta' && typeof payload.delta.text === 'string') {
      block.text += payload.delta.text;
      state.content += payload.delta.text;
      textDelta = payload.delta.text;
      return { textDelta };
    }

    if (payload.delta?.type === 'input_json_delta' && typeof payload.delta.partial_json === 'string') {
      block.inputJson += payload.delta.partial_json;
    }
    return { textDelta };
  }

  if (resolvedEventType === 'message_delta') {
    if (payload.usage) {
      state.usage = payload.usage;
    }
    if (typeof payload.delta?.stop_reason === 'string' && payload.delta.stop_reason.length > 0) {
      state.stopReason = payload.delta.stop_reason;
    }
  }

  return { textDelta };
}

export function finalizeAnthropicStreamState(
  state: AnthropicStreamState,
  generateToolCallId: GenerateToolCallId
): { content: string; toolCalls: ChatToolCall[]; usage?: AnthropicChatResponse['usage'] } {
  const toolCalls: ChatToolCall[] = [];
  for (const [, block] of [...state.blocks.entries()].sort((left, right) => left[0] - right[0])) {
    if (block.type !== 'tool_use' || !block.name) {
      continue;
    }
    const parsedArguments = parseToolArgumentsSafe(block.inputJson || '{}');
    toolCalls.push({
      id: block.id || generateToolCallId(),
      type: 'function',
      function: {
        name: block.name,
        arguments: JSON.stringify(parsedArguments)
      }
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
  }

  return {
    content: state.content,
    toolCalls,
    usage: state.usage
  };
}

export function buildAnthropicToolDefinitions(
  tools?: ChatToolDefinition[]
): AnthropicToolDefinition[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map(tool => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters
  }));
}

export function buildAnthropicToolChoice(
  options?: vscode.LanguageModelChatRequestOptions
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
  tools?: ChatToolDefinition[]
): OpenAIResponsesToolDefinition[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map(tool => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters
  }));
}

export function toOpenAIResponsesInput(
  messages: ChatMessage[],
  generateToolCallId: GenerateToolCallId
): OpenAIResponsesInputItem[] {
  const input: OpenAIResponsesInputItem[] = [];

  for (const message of messages) {
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id || generateToolCallId(),
        output: message.content
      });
      continue;
    }

    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      if (message.content.trim().length > 0) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: message.content
        });
      }

      for (const toolCall of message.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: toolCall.id || generateToolCallId(),
          name: toolCall.function.name,
          arguments: toolCall.function.arguments
        });
      }
      continue;
    }

    input.push({
      type: 'message',
      role: message.role,
      content: message.content
    });
  }

  return input;
}

export function parseOpenAIResponsesResponse(
  response: OpenAIResponsesResponse,
  generateToolCallId: GenerateToolCallId
): { content: string; toolCalls: ChatToolCall[] } {
  const textParts: string[] = [];
  const toolCalls: ChatToolCall[] = [];

  for (const item of response.output ?? []) {
    if (item.type === 'function_call' && typeof item.name === 'string' && item.name.trim().length > 0) {
      toolCalls.push({
        id: typeof item.call_id === 'string' && item.call_id.trim().length > 0 ? item.call_id : generateToolCallId(),
        type: 'function',
        function: {
          name: item.name,
          arguments: typeof item.arguments === 'string' ? item.arguments : '{}'
        }
      });
      continue;
    }

    if (item.type === 'message') {
      for (const contentPart of item.content ?? []) {
        if ((contentPart.type === 'output_text' || contentPart.type === 'text') && typeof contentPart.text === 'string' && contentPart.text.trim().length > 0) {
          textParts.push(contentPart.text);
        }
      }
    }
  }

  if (textParts.length === 0 && typeof response.output_text === 'string' && response.output_text.trim().length > 0) {
    textParts.push(response.output_text);
  }

  return {
    content: textParts.join(''),
    toolCalls
  };
}

export function toAnthropicMessages(
  messages: ChatMessage[],
  generateToolCallId: GenerateToolCallId
): { system: string; messages: AnthropicChatMessage[] } {
  const systemParts: string[] = [];
  const normalizedMessages: AnthropicChatMessage[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content.trim().length > 0) {
        systemParts.push(message.content);
      }
      continue;
    }

    if (message.role === 'tool') {
      normalizedMessages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: message.tool_call_id || generateToolCallId(),
          content: message.content
        }]
      });
      continue;
    }

    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      const contentBlocks: AnthropicRequestContentBlock[] = [];
      if (message.content.trim().length > 0) {
        contentBlocks.push({ type: 'text', text: message.content });
      }
      for (const toolCall of message.tool_calls) {
        contentBlocks.push({
          type: 'tool_use',
          id: toolCall.id || generateToolCallId(),
          name: toolCall.function.name,
          input: parseToolArgumentsSafe(toolCall.function.arguments)
        });
      }
      normalizedMessages.push({ role: 'assistant', content: contentBlocks });
      continue;
    }

    const role = message.role === 'assistant' ? 'assistant' : 'user';
    normalizedMessages.push({ role, content: message.content });
  }

  return {
    system: systemParts.join('\n\n').trim(),
    messages: normalizedMessages
  };
}

export function parseAnthropicResponse(
  response: AnthropicChatResponse,
  generateToolCallId: GenerateToolCallId
): { content: string; toolCalls: ChatToolCall[] } {
  const textParts: string[] = [];
  const toolCalls: ChatToolCall[] = [];

  for (const block of response.content ?? []) {
    if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text.trim().length > 0) {
        textParts.push(block.text);
      }
      continue;
    }

    if (block.type === 'tool_use' && typeof block.name === 'string' && block.name.trim().length > 0) {
      toolCalls.push({
        id: typeof block.id === 'string' && block.id.trim().length > 0 ? block.id : generateToolCallId(),
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {})
        }
      });
    }
  }

  return {
    content: textParts.join(''),
    toolCalls
  };
}

export function summarizeOpenAIChatResponse(response: OpenAIChatResponse): Record<string, unknown> {
  return {
    id: response.id,
    created: response.created,
    model: response.model,
    choiceCount: response.choices.length,
    choices: response.choices.map(choice => ({
      index: choice.index,
      finishReason: choice.finish_reason,
      role: choice.message?.role,
      contentLength: typeof choice.message?.content === 'string' ? choice.message.content.length : 0,
      toolCallCount: choice.message?.tool_calls?.length ?? 0,
      toolCalls: (choice.message?.tool_calls ?? []).map(toolCall => ({
        id: toolCall.id,
        type: toolCall.type,
        functionName: toolCall.function?.name,
        argumentsLength: typeof toolCall.function?.arguments === 'string' ? toolCall.function.arguments.length : 0
      }))
    })),
    usage: response.usage
  };
}

export function summarizeOpenAIResponsesResponse(response: OpenAIResponsesResponse): Record<string, unknown> {
  return {
    id: response.id,
    outputCount: response.output?.length ?? 0,
    outputTextLength: typeof response.output_text === 'string' ? response.output_text.length : 0,
    output: (response.output ?? []).map(item => ({
      type: item.type,
      role: 'role' in item ? item.role : undefined,
      name: 'name' in item ? item.name : undefined,
      callId: 'call_id' in item ? item.call_id : undefined,
      argumentsLength: 'arguments' in item && typeof item.arguments === 'string' ? item.arguments.length : 0,
      contentPartCount: 'content' in item && Array.isArray(item.content) ? item.content.length : 0,
      contentTextLengths: 'content' in item && Array.isArray(item.content)
        ? item.content.map(contentPart => typeof contentPart.text === 'string' ? contentPart.text.length : 0)
        : undefined
    })),
    usage: response.usage
  };
}

export function summarizeAnthropicResponseForLogging(response: AnthropicChatResponse | string): Record<string, unknown> {
  if (typeof response === 'string') {
    return {
      responseType: 'string',
      contentBlockCount: 0,
      contentBlocks: [],
      contentTextPreview: buildPreview(response, 100)
    };
  }

  const content = Array.isArray(response.content) ? response.content : [];
  return {
    id: response.id,
    role: response.role,
    stopReason: response.stop_reason,
    contentBlockCount: content.length,
    contentBlocks: content.map(block => ({
      type: block.type,
      id: 'id' in block ? block.id : undefined,
      name: 'name' in block ? block.name : undefined,
      textLength: 'text' in block && typeof block.text === 'string' ? block.text.length : 0,
      hasInput: 'input' in block && block.input !== undefined
    })),
    contentTextPreview: buildPreview(
      content
        .filter((block): block is AnthropicResponseTextContentBlock => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join(''),
      100
    ),
    usage: response.usage
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
