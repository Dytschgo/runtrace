import type { ComponentType } from 'react';
import { BookOpen, Bot, Camera, Cpu, Eye, FilePenLine, Globe, MessagesSquare, Network, Search, Terminal, Wrench, type LucideIcon } from 'lucide-react';
import { ClaudeMark, GeminiMark, GrokMark, MetaMark, OpenAIMark, QwenMark, type MarkProps } from '../components/providerMarks';
import { modelProvider, type Provider } from './modelColors';

const PROVIDER_MARKS: Partial<Record<Provider, ComponentType<MarkProps>>> = {
  openai: OpenAIMark, anthropic: ClaudeMark, xai: GrokMark, meta: MetaMark, google: GeminiMark, qwen: QwenMark,
};

export function providerIcon(provider: Provider): ComponentType<MarkProps> {
  return PROVIDER_MARKS[provider] ?? Cpu;
}

/** The logo of the provider that served a model, or a neutral chip for anything unrecognised. */
export function modelIcon(model: string | null | undefined): ComponentType<MarkProps> {
  return PROVIDER_MARKS[modelProvider(model)] ?? Cpu;
}

const TOOL_ICONS: [RegExp, LucideIcon][] = [
  [/command|shell|bash|exec/i, Terminal],
  [/file_change|edit|write|patch/i, FilePenLine],
  [/snapshot|screenshot/i, Camera],
  [/evaluate/i, Eye],
  [/read/i, BookOpen],
  [/thread/i, MessagesSquare],
  [/search|grep|glob/i, Search],
  [/agent|delegate|task/i, Bot],
  [/web|fetch|browser/i, Globe],
  [/mcp|t3-code/i, Network],
];

export function toolIcon(name: string | null | undefined): LucideIcon {
  if (!name) return Wrench;
  return TOOL_ICONS.find(([re]) => re.test(name))?.[1] ?? Wrench;
}
