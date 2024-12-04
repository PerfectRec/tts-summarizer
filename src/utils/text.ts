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

export function collapseConsecutiveLetters(text: string): string {
  return text.replace(/(\w)\1{21}/g, "$1");
}

export function countSentences(text: string): number {
  return text.split(/[.!?]+/).filter(Boolean).length;
}
