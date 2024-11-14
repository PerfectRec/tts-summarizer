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

export function replaceAbbreviations(
  text: string,
  specialAbbreviations: Abbreviation[]
): string {
  specialAbbreviations.forEach(({ abbreviation, replacement }) => {
    const regex = new RegExp(`\\b${abbreviation}\\b`, "g");
    text = text.replace(regex, replacement);
  });
  return text;
}
