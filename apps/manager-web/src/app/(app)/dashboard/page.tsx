"use client";

import * as React from "react";
import { GitBranch, Clock, MapPin, ShieldCheck } from "lucide-react";

import { LoadingState } from "@/components/shared/loading-state";
import { ErrorState } from "@/components/shared/error-state";
import { cn } from "@/lib/utils";
import { ApiError, fetchMeta, type MetaResponse } from "@/lib/api-client";

interface StatTile {
  label: string;
  value: string;
  icon: React.ElementType;
}

/**
 * Branded hero + stat tiles, styled after the UltraKIL marketing site's own
 * palette (deep forest green, a lime accent) — deliberately fixed colors
 * rather than the app's --background/--primary tokens, so this reads as the
 * brand identity regardless of the manager portal's light/dark setting, the
 * same way the rest of the app treats the sidebar. Everything below the
 * hero (the stat tiles) still uses the shared card/text tokens, so it stays
 * readable in both themes.
 */
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
    <div className="-m-6 space-y-8 pb-6">
      {/* Hero band */}
      <div className="relative overflow-hidden bg-[radial-gradient(ellipse_120%_100%_at_0%_0%,#123a26_0%,#081a11_55%,#04100a_100%)] px-6 pt-10 pb-14 text-white">
        {/* Faint oversized watermark letter — the "mesmerizing" flourish,
            purely decorative (aria-hidden) so it never competes with real
            content for a screen reader or for contrast. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -top-10 right-[-2rem] select-none font-[family-name:var(--font-display)] text-[16rem] leading-none font-bold text-white/[0.04]"
        >
          U
        </span>

        <h1 className="relative font-[family-name:var(--font-display)] text-4xl leading-[1.1] font-bold tracking-tight sm:text-5xl">
          Dashboard
        </h1>
        <p className="relative mt-3 max-w-xl font-[family-name:var(--font-display)] text-xl leading-snug font-medium text-white/90">
          Good to see you. Here&apos;s <span className="text-brand-lime">today&apos;s dispatch.</span>
        </p>
        <p className="relative mt-3 max-w-md text-sm text-white/60">
          Overview of today&apos;s schedule and dispatch status, and the live connection this portal
          runs on.
        </p>
      </div>

      {/* Content */}
      <div className="space-y-4 px-6">
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-brand-lime" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-muted-foreground">API connection</h2>
        </div>

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
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {tiles.map(({ label, value, icon: Icon }, index) => (
              <div
                key={label}
                className={cn(
                  "group rounded-2xl border border-border bg-card p-4 shadow-sm",
                  "transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
                )}
                style={{ transitionDelay: `${index * 30}ms` }}
              >
                <dt className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-lime/15 text-[#2a6b17] dark:text-brand-lime">
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                  {label}
                </dt>
                <dd className="mt-2 truncate font-[family-name:var(--font-display)] text-lg font-semibold text-foreground">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </div>
  );
}
