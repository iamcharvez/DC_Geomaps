import { useEffect, useRef, useState } from "react";
import { api, rememberRefresh, savedRefresh } from "./api";
import { Dashboard } from "./Dashboard";
import { Login } from "./Login";
import type { TokenResponse, User } from "./types";

type Session = { token: string; refresh?: string; expiresAt: number; user: User };

export default function App() {
  const [requiredRole, setRequiredRole] = useState("role_dcgeomaps_admin");
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshTimer = useRef<number | null>(null);

  const accept = async (tokens: TokenResponse) => {
    const user = await api.me(tokens.access_token);
    const refresh = tokens.refresh_token || savedRefresh() || undefined;
    rememberRefresh(refresh);
    setSession({ token: tokens.access_token, refresh, expiresAt: Date.now() + tokens.expires_in * 1000, user });
  };

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const config = await api.config();
        if (active) setRequiredRole(config.required_role);
        const refresh = savedRefresh();
        if (refresh) await accept(await api.refresh(refresh));
      } catch (cause) {
        rememberRefresh();
        if (active && savedRefresh()) setError(cause instanceof Error ? cause.message : "Session restoration failed.");
      } finally {
        if (active) setChecking(false);
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    if (!session?.refresh) return;
    const delay = Math.max(5_000, session.expiresAt - Date.now() - 30_000);
    refreshTimer.current = window.setTimeout(() => {
      void api.refresh(session.refresh!).then(accept).catch((cause) => {
        rememberRefresh();
        setSession(null);
        setError(cause instanceof Error ? cause.message : "Your session expired.");
      });
    }, delay);
    return () => {
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    };
  }, [session?.expiresAt, session?.refresh]);

  const login = async (username: string, password: string) => {
    setPending(true);
    setError(null);
    try {
      await accept(await api.login(username, password));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-in failed.");
    } finally {
      setPending(false);
    }
  };

  const logout = async () => {
    const current = session;
    rememberRefresh();
    setSession(null);
    if (current) await api.logout(current.token, current.refresh).catch(() => undefined);
  };

  if (checking) return <div className="loading-screen"><span className="logo-mark">DC</span><p>Securing the control plane…</p></div>;
  if (!session) return <Login requiredRole={requiredRole} pending={pending} error={error} onSubmit={login} />;
  return <Dashboard token={session.token} user={session.user} onLogout={logout} />;
}

