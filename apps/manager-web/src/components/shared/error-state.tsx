import { AlertOctagon } from "lucide-react";

import { Button } from "@/components/ui/button";

interface ErrorStateProps {
  title?: string;
  description?: string;
  code?: string;
  onRetry?: () => void;
}

/**
 * Chanya's API returns a stable `code` on every error response. Surface it
 * here for support/debugging — branch UI logic on `code`, never on `message`
 * (messages are written for managers and can be reworded).
 */
export function ErrorState({
  title = "Something went wrong",
  description,
  code,
  onRetry,
}: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-10 text-center">
      <AlertOctagon className="h-8 w-8 text-destructive" aria-hidden="true" />
      <p className="font-medium">{title}</p>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
      {code && <p className="font-mono text-xs text-muted-foreground">{code}</p>}
      {onRetry && (
        <Button size="sm" variant="outline" className="mt-2" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
