export function escapeSSMLCharacters(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function convertBreaks(text: string): string {
  // Adjust the regex to match decimal numbers
  return text.replace(/\[break(\d+(\.\d+)?)\]/g, '<break time="$1s"/>');
}

export function removeBreaks(text: string): string {
  // Adjust the regex to match decimal numbers
  return text.replace(/\[break\d+(\.\d+)?\]/g, "");
}
