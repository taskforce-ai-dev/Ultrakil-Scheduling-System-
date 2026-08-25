import { ShieldAlert } from "lucide-react";

export function PermissionDenied({
  message = "You don't have permission to view this.",
}: {
  message?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border p-10 text-center">
      <ShieldAlert className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
      <p className="font-medium">Access restricted</p>
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}
