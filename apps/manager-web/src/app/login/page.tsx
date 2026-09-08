"use client";

import * as React from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, ShieldCheck, CalendarClock, Users, MapPin } from "lucide-react";

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

/**
 * Purely decorative "live dispatch" scene for the hero panel — three stops
 * on a route, a dashed line between them with a marching-ants shimmer, and
 * a dot that travels the route on a loop. Built from the brand palette
 * rather than a stock photo (none were available to source), so it reads as
 * this product specifically: scheduling and dispatch, not a generic login
 * splash. aria-hidden throughout; every animation used here is defined in
 * globals.css and collapses under prefers-reduced-motion.
 */
function DispatchIllustration() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <svg
        viewBox="0 0 480 480"
        className="absolute -right-16 bottom-[-4rem] h-[34rem] w-[34rem] opacity-90"
      >
        <defs>
          <radialGradient id="login-map-fade" cx="50%" cy="50%" r="60%">
            <stop offset="0%" stopColor="white" stopOpacity="0.06" />
            <stop offset="100%" stopColor="white" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="240" cy="240" r="220" fill="url(#login-map-fade)" />

        {/* the route */}
        <path
          d="M 96 360 C 150 300, 150 220, 210 200 S 320 230, 360 160"
          fill="none"
          stroke="white"
          strokeOpacity="0.22"
          strokeWidth="3"
        />
        <path
          d="M 96 360 C 150 300, 150 220, 210 200 S 320 230, 360 160"
          fill="none"
          stroke="var(--brand-lime)"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray="2 10"
          className="login-dash"
        />

        {/* stops */}
        <circle cx="96" cy="360" r="6" fill="white" fillOpacity="0.7" />
        <circle cx="210" cy="200" r="6" fill="white" fillOpacity="0.7" />
        <circle cx="360" cy="160" r="9" className="login-pin-pulse" fill="var(--brand-lime)" />
        <circle cx="360" cy="160" r="9" fill="var(--brand-lime)" />
        <circle cx="360" cy="160" r="9" fill="none" stroke="white" strokeOpacity="0.5" strokeWidth="2" />
      </svg>

      {/* floating chips, echoing the highlight icons below without repeating them */}
      <div
        className="login-float absolute right-[18%] bottom-[38%] flex h-11 w-11 items-center justify-center rounded-xl bg-white/10 backdrop-blur-sm"
        style={{ animationDelay: "0.4s" }}
      >
        <MapPin className="h-5 w-5 text-brand-lime" aria-hidden="true" />
      </div>
      <div
        className="login-float absolute right-[38%] bottom-[62%] flex h-10 w-10 items-center justify-center rounded-xl bg-white/10 backdrop-blur-sm"
        style={{ animationDelay: "1.6s" }}
      >
        <ShieldCheck className="h-4 w-4 text-white/80" aria-hidden="true" />
      </div>
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

        <DispatchIllustration />

        <div className="login-animate-in relative" style={{ animationDelay: "0ms" }}>
          <Logo />
        </div>

        <div className="relative space-y-8">
          <div className="login-animate-in space-y-3" style={{ animationDelay: "80ms" }}>
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
