export function collapseConsecutiveLetters(text: string): string {
  return text.replace(/(\w)\1{21}/g, "$1");
}
