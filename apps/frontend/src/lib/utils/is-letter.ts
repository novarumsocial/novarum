export const LETTER_REGEX = new RegExp(/[a-zA-Z]/);

export function isLetter(char: string): boolean {
  if (char.length > 1) {
    throw new Error(
      `You probably only meant to pass a character to this function. Instead you gave ${char}`
    );
  }

  return LETTER_REGEX.test(char);
}
