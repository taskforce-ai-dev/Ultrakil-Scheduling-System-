import { toast } from "sonner";

import { TOAST_DURATION_MS } from "@/components/ui/sonner";

/**
 * A refusal gets longer on screen than a confirmation.
 *
 * "Saved" is read at a glance and confirms what the manager just did; "could
 * not save, because…" is the only place some of these sentences appear, and
 * is usually longer. Both still clear themselves: a notification that stays
 * up until the page is reloaded ends up sitting over the next thing the
 * manager needs to click.
 */
const ERROR_DURATION_MS = 10_000;

/** Thin wrapper over sonner so every notification in the portal goes through one place. */
export const notify = {
  success: (message: string) => toast.success(message, { duration: TOAST_DURATION_MS }),
  error: (message: string) => toast.error(message, { duration: ERROR_DURATION_MS }),
  info: (message: string) => toast(message, { duration: TOAST_DURATION_MS }),
};
