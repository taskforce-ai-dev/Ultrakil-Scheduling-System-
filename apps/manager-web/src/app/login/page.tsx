"use client";

import * as React from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, ShieldCheck, CalendarClock, Users } from "lucide-react";

import { describeLoginError, useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const HIGHLIGHTS = [
  { icon: CalendarClock, text: "Build a schedule that never breaks a hard rule" },
  { icon: Users, text: "Keep crews, vehicles and permanent sites in sync" },
  { icon: ShieldCheck, text: "Every override is recorded, never silent" },
];

function Logo({ className }: { className?: string }) {
  return (
    <div className={`inline-flex w-fit rounded-lg bg-white px-2 py-1.5 shadow-sm ${className ?? ""}`}>
      <Image
        src="/ultrakil-logo.png"
        alt="UltraKIL — will keep them STiL"
        width={307}
        height={119}
        priority
        className="h-7 w-auto"
      />
    </div>
  );
}

/** A rounded map pin (teardrop) silhouette, centered at (cx, cyTop) with the
 * point resting `dropTo` px below it — used for every stop in the scene. */
function MapPinShape({
  cx,
  cyTop,
  dropTo,
  fill,
  className,
}: {
  cx: number;
  cyTop: number;
  dropTo: number;
  fill: string;
  className?: string;
}) {
  const r = 10;
  const tipY = cyTop + dropTo;
  return (
    <g className={className}>
      <path
        d={`M ${cx - r} ${cyTop} a ${r} ${r} 0 1 1 ${r * 2} 0 C ${cx + r} ${cyTop + r + 4}, ${cx} ${cyTop + r + 10}, ${cx} ${tipY} C ${cx} ${cyTop + r + 10}, ${cx - r} ${cyTop + r + 4}, ${cx - r} ${cyTop} Z`}
        fill={fill}
      />
      <circle cx={cx} cy={cyTop} r={4} fill="white" fillOpacity="0.9" />
    </g>
  );
}

/**
 * The hero panel's illustration — a framed "scene" (not a thin diagram):
 * layered terrain, a real road with lane markings winding through it, a
 * dispatch van on the road, and three pin markers, one pulsing as the
 * active destination. Built entirely from the brand palette rather than a
 * stock photo or generated art (neither was available to source in this
 * sandbox) — composed to read as a proper illustrated image, not a
 * background texture. aria-hidden throughout; the marching-ants road line,
 * pin pulse and van bob are defined in globals.css and collapse under
 * prefers-reduced-motion.
 */
function DispatchScene() {
  return (
    <div
      aria-hidden="true"
      className="relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04] shadow-inner"
    >
      <svg viewBox="0 0 400 220" className="block h-48 w-full sm:h-56">
        <defs>
          <linearGradient id="login-sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="white" stopOpacity="0.05" />
            <stop offset="100%" stopColor="white" stopOpacity="0" />
          </linearGradient>
        </defs>
        <rect x="0" y="0" width="400" height="140" fill="url(#login-sky)" />

        {/* soft sun/leaf accent, upper-left */}
        <circle cx="54" cy="54" r="30" fill="var(--brand-lime)" fillOpacity="0.1" />

        {/* rolling terrain, two layers for depth */}
        <path
          d="M0 176 C 60 150, 140 196, 220 164 S 360 140, 400 168 V 220 H 0 Z"
          fill="var(--brand-mid-green)"
          fillOpacity="0.55"
        />
        <path
          d="M0 200 C 70 182, 150 214, 240 192 S 340 176, 400 198 V 220 H 0 Z"
          fill="var(--brand-deep-green)"
        />

        {/* the road */}
        <path
          d="M 34 196 C 90 176, 100 140, 150 128 S 250 118, 300 78 S 330 56, 356 44"
          fill="none"
          stroke="white"
          strokeOpacity="0.9"
          strokeWidth="10"
          strokeLinecap="round"
        />
        <path
          d="M 34 196 C 90 176, 100 140, 150 128 S 250 118, 300 78 S 330 56, 356 44"
          fill="none"
          stroke="var(--brand-deep-green)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray="6 8"
          className="login-dash"
        />

        {/* dispatch van, riding the road */}
        <g className="login-float" style={{ transformOrigin: "222px 108px" }}>
          <ellipse cx="223" cy="119" rx="16" ry="3" fill="black" fillOpacity="0.12" />
          <rect x="204" y="98" width="30" height="18" rx="5" fill="white" />
          <rect x="210" y="91" width="16" height="12" rx="4" fill="white" />
          <rect x="212" y="94" width="10" height="6" rx="1.5" fill="var(--brand-deep-green)" />
          <circle cx="211" cy="117" r="4" fill="var(--brand-deep-green)" />
          <circle cx="228" cy="117" r="4" fill="var(--brand-deep-green)" />
          <circle cx="219" cy="107" r="2.5" fill="var(--brand-lime)" />
        </g>

        {/* stops along the route */}
        <MapPinShape cx={34} cyTop={176} dropTo={16} fill="white" />
        <MapPinShape cx={150} cyTop={108} dropTo={16} fill="white" />
        <g>
          <circle cx={356} cy={24} r={10} fill="var(--brand-lime)" className="login-pin-pulse" />
          <MapPinShape cx={356} cyTop={24} dropTo={16} fill="var(--brand-lime)" />
        </g>
      </svg>
    </div>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  // A ref alongside the state: two submits fired in the same tick (a fast
  // double-click, or Enter held down) both close over the same pre-update
  // `isSubmitting`, so the state check alone can't stop the second one.
  const isSubmittingRef = React.useRef(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!email.trim() || !password) return;
    if (isSubmittingRef.current) return; // Collapses a double-click into one request.
    isSubmittingRef.current = true;

    setIsSubmitting(true);
    setError(null);
    try {
      await login(email.trim(), password);
      router.push("/dashboard");
    } catch (caught) {
      setError(describeLoginError(caught));
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen bg-background">
      <div className="relative hidden w-1/2 flex-col justify-between overflow-hidden bg-sidebar p-10 text-sidebar-foreground lg:flex">
        <div
          className="login-blob pointer-events-none absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              "radial-gradient(circle at 15% 15%, var(--brand-primary-green) 0%, transparent 45%), radial-gradient(circle at 85% 85%, var(--brand-bright-green) 0%, transparent 40%)",
          }}
          aria-hidden="true"
        />

        <div className="login-animate-in relative" style={{ animationDelay: "0ms" }}>
          <Logo />
        </div>

        <div className="relative space-y-6">
          <div className="login-animate-in" style={{ animationDelay: "70ms" }}>
            <DispatchScene />
          </div>

          <div className="login-animate-in space-y-3" style={{ animationDelay: "150ms" }}>
            <h2 className="text-3xl font-semibold tracking-tight text-white">
              Scheduling &amp; dispatch,
              <br />
              built for the field.
            </h2>
            <p className="max-w-sm text-sm text-sidebar-foreground/70">
              The manager portal for UltraKIL&apos;s Colombo and Kandy pest-management
              operations — one place to plan, publish and track every visit.
            </p>
          </div>

          <ul className="space-y-3">
            {HIGHLIGHTS.map(({ icon: Icon, text }, index) => (
              <li
                key={text}
                className="login-animate-in flex items-center gap-3 text-sm text-sidebar-foreground/85"
                style={{ animationDelay: `${180 + index * 90}ms` }}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>

        <p className="login-animate-in relative text-xs text-sidebar-foreground/50" style={{ animationDelay: "480ms" }}>
          UltraKIL Phase 1 — pilot for Colombo &amp; Kandy operations.
        </p>
      </div>

      <div className="flex flex-1 items-center justify-center p-6">
        <form
          onSubmit={handleSubmit}
          className="login-animate-in w-full max-w-sm space-y-6 rounded-2xl border bg-card p-8 shadow-lg shadow-black/5 ring-1 ring-black/[0.03]"
          style={{ animationDelay: "120ms" }}
        >
          <div className="space-y-1.5 lg:hidden">
            <Logo />
          </div>

          <div className="space-y-1.5">
            <h1 className="text-xl font-semibold tracking-tight">Welcome back</h1>
            <p className="text-sm text-muted-foreground">
              Sign in with your manager account to continue.
            </p>
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@taskforceai.tech"
                className="h-10"
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="h-10 pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                  className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-r-lg"
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Eye className="h-4 w-4" aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>
          </div>

          {error ? (
            <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <Button type="submit" className="h-10 w-full" disabled={isSubmitting}>
            {isSubmitting ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </div>
    </div>
  );
}
