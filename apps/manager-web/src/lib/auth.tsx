"use client";

import * as React from "react";

/**
 * Chanya's API has no auth endpoint yet. Every component talks to `useAuth()`
 * only, so swapping the placeholder below for a real session check is a
 * one-file change when that endpoint exists.
 */
export type ManagerRole = "MANAGER" | "SUPERVISOR" | "ADMIN";

export interface AuthUser {
  id: string;
  name: string;
  role: ManagerRole;
}

interface AuthContextValue {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (name: string) => void;
  logout: () => void;
}

const AuthContext = React.createContext<AuthContextValue | undefined>(undefined);

const SESSION_STORAGE_KEY = "ultrakil.manager-web.session";

function readStoredSession(): AuthUser | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);

  React.useEffect(() => {
    // Reads browser storage (an external system), which is exactly the case
    // React's effect docs recommend an effect for. Runs once, deferred until
    // after the client mount, so SSR and the first client render agree
    // before this reconciles with the real session.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUser(readStoredSession());
    setIsLoading(false);
  }, []);

  const login = React.useCallback((name: string) => {
    const nextUser: AuthUser = { id: "placeholder-user", name, role: "MANAGER" };
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(nextUser));
    setUser(nextUser);
  }, []);

  const logout = React.useCallback(() => {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
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
