"use client";

import * as React from "react";

import { LoadingState } from "@/components/shared/loading-state";
import { ErrorState } from "@/components/shared/error-state";
import { fetchMeta, type MetaResponse } from "@/lib/api-client";

export default function DashboardPage() {
  const [meta, setMeta] = React.useState<MetaResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);

  const loadMeta = React.useCallback(() => {
    setIsLoading(true);
    setError(null);
    fetchMeta()
      .then((response) => setMeta(response))
      .catch(() => setError("Could not reach the API."))
      .finally(() => setIsLoading(false));
  }, []);

  React.useEffect(() => {
    // Fetching from an external system (the API) on mount — the linter
    // can't see that loadMeta's own setState calls are gated behind an
    // async boundary, not synchronous derived state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadMeta();
  }, [loadMeta]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-muted-foreground">Overview of today&apos;s schedule and dispatch status.</p>
      </div>

      <div className="rounded-lg border p-4">
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">API connection</h2>
        {isLoading ? (
          <LoadingState rows={2} />
        ) : error ? (
          <ErrorState title="Couldn't load API metadata" description={error} onRetry={loadMeta} />
        ) : meta ? (
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">API version</dt>
              <dd className="font-medium">{meta.apiVersion}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Timezone</dt>
              <dd className="font-medium">{meta.timezone}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Branches</dt>
              <dd className="font-medium">{meta.branchCodes.join(", ")}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">PMS grades</dt>
              <dd className="font-medium">{meta.pmsGradeLabels.length}</dd>
            </div>
          </dl>
        ) : null}
      </div>
    </div>
  );
}
