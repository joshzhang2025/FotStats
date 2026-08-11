/**
 * Talking to the service worker from a content script.
 *
 * Reloading the extension orphans the content scripts already running in open
 * tabs: their `chrome.runtime` handle is dead, and using it throws "Extension
 * context invalidated" *synchronously* — so a `.catch()` on the returned promise
 * never sees it. Both content scripts need that guard, and it is subtle enough
 * that two copies would eventually disagree.
 */

let orphaned = false;

/** True once this content script has outlived the extension that injected it. */
export function isOrphaned(): boolean {
  // `chrome.runtime.id` is undefined once the context is gone.
  return orphaned || !chrome.runtime?.id;
}

/** Fire and forget. Goes quiet rather than logging on every poll once orphaned. */
export function notifyWorker(message: unknown): void {
  if (isOrphaned()) {
    orphaned = true;
    return;
  }
  try {
    void chrome.runtime.sendMessage(message).catch(() => {
      // The worker sleeps between messages; a rejected send just means it was
      // waking up and the next poll will land.
    });
  } catch {
    orphaned = true;
  }
}

/**
 * Ask the worker something. Resolves to null when there is no answer to be had
 * — orphaned context, or a worker that was still waking up — so callers can
 * treat "no data" and "no extension" the same way: render nothing.
 */
export async function askWorker<T>(message: unknown): Promise<T | null> {
  if (isOrphaned()) {
    orphaned = true;
    return null;
  }
  try {
    return ((await chrome.runtime.sendMessage(message)) as T) ?? null;
  } catch {
    if (!chrome.runtime?.id) orphaned = true;
    return null;
  }
}
