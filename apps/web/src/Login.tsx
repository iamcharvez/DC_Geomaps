import { useState, type FormEvent } from "react";

export function Login({
  requiredRole,
  pending,
  error,
  onSubmit,
}: {
  requiredRole: string;
  pending: boolean;
  error: string | null;
  onSubmit: (username: string, password: string) => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void onSubmit(username, password);
  };

  return (
    <main className="login-page">
      <div className="login-backdrop" aria-hidden="true">
        <div className="login-grid" />
        <i className="login-glow glow-one" />
        <i className="login-glow glow-two" />
        <div className="login-orbit orbit-a" />
        <div className="login-orbit orbit-b" />
        <div className="login-islands"><i /><i /><i /><i /><i /></div>
      </div>
      <section className="login-panel">
        <div className="login-card">
          <div className="login-brand">
            <span className="logo-mark">DC</span>
            <div><strong>GEOMAP</strong><small>BASEMAP OPERATIONS</small></div>
          </div>
          <div className="login-heading">
            <span><i /> SECURE CONSOLE</span>
            <h1>Sign in</h1>
          </div>
          <form onSubmit={submit}>
            <label>
              <span>Username</span>
              <input
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="operator@example.com"
                maxLength={254}
                required
                autoFocus
              />
            </label>
            <label>
              <span>Password</span>
              <div className="password-field">
                <input
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Enter your password"
                  maxLength={2048}
                  required
                />
                <button type="button" aria-label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword((value) => !value)}>
                  {showPassword ? "Hide" : "Show"}
                </button>
              </div>
            </label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="primary login-button" disabled={pending}>
              {pending ? "Verifying…" : "Continue"}
              <span aria-hidden="true">→</span>
            </button>
          </form>
          <div className="login-security">
            <span><i /> Keycloak protected</span>
            <code>{requiredRole}</code>
          </div>
        </div>
      </section>
    </main>
  );
}
