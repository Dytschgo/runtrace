const NOT_TEXT = new Set(['radio', 'checkbox', 'range', 'button', 'submit', 'reset', 'color', 'file']);

/** Whether a key press belongs to the field that has focus. A radio or checkbox takes no text, so shortcuts still work after clicking one. */
export function isTypingTarget(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  if (!el) return false;
  if (el.tagName === 'INPUT') return !NOT_TEXT.has((el as HTMLInputElement).type);
  return el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable === true;
}
