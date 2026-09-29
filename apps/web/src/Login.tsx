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

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void onSubmit(username, password);
  };

  return (
    <main className="login-page">
      <section className="login-visual" aria-label="DC Geomap overview">
        <div className="visual-grid" />
        <div className="brand-lockup">
          <span className="logo-mark">DC</span>
          <div>
            <strong>GEOMAP</strong>
            <small>PHILIPPINES BASEMAP OPERATIONS</small>
          </div>
        </div>
        <div className="hero-copy">
          <span className="signal"><i /> PRIVATE INFRASTRUCTURE</span>
          <h1>Your map.<br />Your infrastructure.</h1>
          <p>Self-hosted OpenStreetMap data, validated and promoted without taking the live map offline.</p>
        </div>
        <div className="island-orbit" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="islands"><i /><i /><i /><i /><i /></div>
        </div>
        <footer>
          <span>PHILIPPINES ONLY</span>
          <span>PMTILES · Z15</span>
          <span>NO PUBLIC TILE API</span>
        </footer>
      </section>
      <section className="login-panel">
        <div className="login-card">
          <p className="eyebrow">AUTHORIZED OPERATORS</p>
          <h2>Welcome back</h2>
          <p className="muted">Sign in with your organization Keycloak account.</p>
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
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Enter your password"
                maxLength={2048}
                required
              />
            </label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="primary login-button" disabled={pending}>
              {pending ? "Verifying access…" : "Enter operations console"}
              <span aria-hidden="true">→</span>
            </button>
          </form>
          <div className="role-note">
            <span className="shield">◆</span>
            <div>
              <strong>Restricted access</strong>
              <small>Requires exact Keycloak role <code>{requiredRole}</code></small>
            </div>
          </div>
        </div>
        <p className="login-footnote">Credentials are verified by Keycloak and are never stored by DC Geomap.</p>
      </section>
    </main>
  );
}

