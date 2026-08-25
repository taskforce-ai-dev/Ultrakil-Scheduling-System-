"use client";

import * as React from "react";
import { GitBranch, Clock, MapPin, ShieldCheck } from "lucide-react";

import { LoadingState } from "@/components/shared/loading-state";
import { ErrorState } from "@/components/shared/error-state";
import { ApiError, fetchMeta, type MetaResponse } from "@/lib/api-client";

interface StatTile {
  label: string;
  value: string;
  icon: React.ElementType;
}

export default function DashboardPage() {
  const [meta, setMeta] = React.useState<MetaResponse | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);

  const loadMeta = React.useCallback(() => {
    setIsLoading(true);
    setError(null);
    fetchMeta()
      .then((response) => setMeta(response))
      .catch((caught: unknown) => {
        setError(
          caught instanceof ApiError
            ? caught
            : new ApiError({ code: "UNKNOWN_ERROR", message: "Something went wrong." })
        );
      })
      .finally(() => setIsLoading(false));
  }, []);

  React.useEffect(() => {
    // Fetching from an external system (the API) on mount — the linter
    // can't see that loadMeta's own setState calls are gated behind an
    // async boundary, not synchronous derived state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadMeta();
  }, [loadMeta]);

  const tiles: StatTile[] = meta
    ? [
        { label: "API version", value: meta.apiVersion, icon: GitBranch },
        { label: "Timezone", value: meta.timezone, icon: Clock },
        { label: "Branches", value: meta.branchCodes.join(", "), icon: MapPin },
        { label: "PMS grades", value: String(meta.pmsGradeLabels.length), icon: ShieldCheck },
      ]
    : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground">Overview of today&apos;s schedule and dispatch status.</p>
      </div>

      <div className="rounded-xl border bg-card p-4 shadow-sm">
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">API connection</h2>
        {isLoading ? (
          <LoadingState rows={2} />
        ) : error ? (
          <ErrorState
            title="Couldn't load API metadata"
            description={error.message}
            code={error.code}
            onRetry={loadMeta}
          />
        ) : meta ? (
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {tiles.map(({ label, value, icon: Icon }) => (
              <div key={label} className="rounded-lg bg-muted/60 p-3">
                <dt className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  {label}
                </dt>
                <dd className="mt-1 truncate text-sm font-semibold text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </div>
  );
}
