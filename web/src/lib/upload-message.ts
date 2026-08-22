/** Build the Claude @-ref send payload after a temp upload. */

export function composeAttachMessage(existingText: string, absPath: string): string {
  const ref = `@${absPath}`;
  return existingText ? `${existingText}\n${ref}` : ref;
}

export function uploadTempNote(absPath: string): string {
  return `临时文件 @${absPath}`;
}
