/** The client command the chat plugin registers to arm its composer (D946). */
const ARM_COMPOSER_COMMAND = "chat.composer.paste-as-text";

export interface PasteAsTextDeps {
  /** Whether a client command is registered. */
  has(command: string): boolean;
  execute(command: string): Promise<unknown>;
  /** The bridge's paste; undefined in an older app. */
  readonly paste: (() => Promise<void>) | undefined;
}

/**
 * T3's Paste as Text from the Edit menu (D946): the composer is armed first,
 * then the app pastes, so the paste stays inline however large it is. An older
 * app cannot paste for the page, and then nothing is armed.
 */
export async function pasteAsText(deps: PasteAsTextDeps): Promise<void> {
  if (deps.paste === undefined) return;
  if (deps.has(ARM_COMPOSER_COMMAND)) await deps.execute(ARM_COMPOSER_COMMAND);
  await deps.paste();
}
