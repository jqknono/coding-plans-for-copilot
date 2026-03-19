import * as vscode from 'vscode';
import messagesEn from './messages.en.json';
import messagesZhCn from './messages.zh-cn.json';
import { logger } from '../logging/outputChannelLogger';

interface Messages {
  [key: string]: string;
}

let currentMessages: Messages;
let currentLocale: string;

export async function initI18n(): Promise<void> {
  const config = vscode.env.language;
  const locale = config.startsWith('zh') ? 'zh-cn' : 'en';
  currentLocale = locale;

  try {
    currentMessages = locale === 'zh-cn' ? messagesZhCn : messagesEn;
  } catch (error) {
    logger.error('Failed to load messages', error);
    // 回退到英文
    currentMessages = messagesEn;
  }
}

export function getMessage(key: string, ...args: any[]): string {
  if (!currentMessages || !currentMessages[key]) {
    return key;
  }

  let message = currentMessages[key];

  // 替换占位符 {0}, {1}, 等
  args.forEach((arg, index) => {
    message = message.replace(`{${index}}`, String(arg));
  });

  return message;
}

export function getLocale(): string {
  return currentLocale || 'zh-cn';
}

export function isChinese(): boolean {
  return currentLocale === 'zh-cn';
}
