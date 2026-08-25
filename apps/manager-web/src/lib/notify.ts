import { toast } from "sonner";

/** Thin wrapper over sonner so every notification in the portal goes through one place. */
export const notify = {
  success: (message: string) => toast.success(message),
  error: (message: string) => toast.error(message),
  info: (message: string) => toast(message),
};
