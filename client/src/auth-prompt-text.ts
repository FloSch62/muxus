/** A server's prompt as the sign-in dialog lays it out. */
export interface AuthPromptText {
  /** What the field is labelled with. */
  label: string;
  /** Lines the server sent ahead of the question, shown above the field. */
  text?: string;
}

/**
 * A keyboard-interactive prompt may be a whole screen of text: Duo sends its
 * menu of options and the question as one prompt. A field label holds a single
 * line, so only the last line labels the field and the rest stays readable
 * above it.
 */
export function authPromptText(prompt: string): AuthPromptText {
  const lines = prompt.replace(/\r\n?/g, '\n').trimEnd().split('\n');
  const label = (lines.pop() ?? '').trim().replace(/:\s*$/, '');
  while (lines.length > 0 && !lines[0]!.trim()) lines.shift();
  const text = lines.join('\n').trimEnd();
  return text ? { label, text } : { label };
}
