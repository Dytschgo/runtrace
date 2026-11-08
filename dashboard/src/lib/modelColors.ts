/** Each provider owns its company colour, and its models are steps on that one scale, most used first. */
export type Provider = 'openai' | 'anthropic' | 'xai' | 'meta' | 'google' | 'qwen' | 'other';

export const FAMILIES: Record<Provider, string[]> = {
  openai: ['#ffffff', '#bdbdbd', '#8a8a8a', '#636363', '#dcdcdc', '#a3a3a3'],
  anthropic: ['#ee7a33', '#f7ab78', '#bb5420', '#fbcfae', '#d76a28'],
  xai: ['#3d63e0', '#7d97f0', '#2f50c9'],
  meta: ['#6ec6ff', '#a9deff', '#3ea8ec'],
  google: ['#34c46d', '#86e3a9', '#1f9f52'],
  qwen: ['#b18cf0', '#d6c4f8'],
  other: ['#b18cf0', '#d6c4f8', '#8d66d6'],
};

export const OTHER_COLOR = 'oklch(0.42 0 none)';

const providerOf = new Map<string, Provider>();
/** Model names are few and turns are many, so each name is classified once. */
export function modelProvider(model: string | null | undefined): Provider {
  if (!model) return 'other';
  let p = providerOf.get(model);
  if (!p) { p = classify(model); providerOf.set(model, p); }
  return p;
}

function classify(model: string): Provider {
  if (/^(gpt|codex|o\d|chatgpt)/i.test(model)) return 'openai';
  if (/claude/i.test(model)) return 'anthropic';
  if (/grok/i.test(model)) return 'xai';
  if (/muse|llama/i.test(model)) return 'meta';
  if (/gemini/i.test(model)) return 'google';
  if (/qwen/i.test(model)) return 'qwen';
  return 'other';
}

/**
 * A colour for every model, given models ranked by tokens. Each takes the next shade in its provider's family,
 * so filtering never repaints a model, and one with no reported usage cannot take a shade from one that draws a line.
 */
export function assignModelColors(ranked: string[]): Map<string, string> {
  const used = new Map<Provider, number>();
  const colors = new Map<string, string>();
  for (const model of ranked) {
    const provider = modelProvider(model);
    const family = FAMILIES[provider];
    const i = used.get(provider) ?? 0;
    // Past the end of a scale, shades repeat, but never the top one: that belongs to the busiest model.
    colors.set(model, i < family.length ? family[i] : family[1 + ((i - 1) % (family.length - 1))]);
    used.set(provider, i + 1);
  }
  return colors;
}

/** A model's colour comes from its provider's family. Text never uses it. */
export const seriesColor = (color: string | undefined) => color ?? OTHER_COLOR;
