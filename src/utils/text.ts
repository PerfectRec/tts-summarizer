export function isTextCutoff(text: string): {
  isStartCutOff: boolean;
  isEndCutOff: boolean;
} {
  // Check if the first sentence starts with a properly capitalized word
  const isStartCutOff = !/^[A-Z]/.test(text.trim());

  // Check if the last sentence ends with a proper terminating punctuation
  const isEndCutOff = !/(?<!\.)[.!?)\]]$/.test(text.trim());

  return { isStartCutOff, isEndCutOff };
}
