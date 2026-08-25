"use client";

import * as React from "react";

import {
  ApiError,
  fetchCurrentUser,
  login as loginRequest,
  type CurrentUser,
} from "./api-client";
import { clearToken, readToken, writeToken } from "./session-token";

/**
 * Real sessions, backed by the API's `/api/auth/*` endpoints.
 *
 * The role list comes from the backend's UserRole enum. There is deliberately
 * no SUPERVISOR here: the API knows ADMIN and MANAGER, and inventing a third
 * role in the UI would mean the portal offering actions the API refuses.
 */
export type ManagerRole = CurrentUser["role"];

export type AuthUser = CurrentUser;

interface AuthContextValue {
  user: AuthUser | null;
  isAuthenticated: boolean;
  /** True until the stored token has been checked against the API. */
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = React.createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;

    async function restore() {
      // A token in storage is not proof of a session: it may have expired, or
      // the account may have been deactivated since. Ask the API rather than
      // trusting what the browser kept.
      if (!readToken()) {
        if (!cancelled) setIsLoading(false);
        return;
      }

      try {
        const current = await fetchCurrentUser();
        if (!cancelled) setUser(current);
      } catch {
        // api-client already dropped the token for session-ended codes.
        clearToken();
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    // Talks to an external system on mount, which is what effects are for.
    void restore();

    return () => {
      cancelled = true;
    };
  }, []);

  const login = React.useCallback(async (email: string, password: string) => {
    const result = await loginRequest(email, password);
    writeToken(result.accessToken);
    setUser(result.user);
  }, []);

  const logout = React.useCallback(() => {
    clearToken();
    setUser(null);
  }, []);

  const value = React.useMemo<AuthContextValue>(
    () => ({ user, isAuthenticated: user !== null, isLoading, login, logout }),
    [user, isLoading, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = React.useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

/** Turns a failed sign-in into something worth showing a manager. */
export function describeLoginError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "Could not sign in. Please try again.";
}
