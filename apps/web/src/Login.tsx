import { useState, type FormEvent } from "react";

export function Login({
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
        <i className="login-glow glow-one" />
        <i className="login-glow glow-two" />
      </div>
      <section className="login-panel">
        <div className="login-card">
          <div className="login-heading">
            <h1>Sign in</h1>
          </div>
          <form onSubmit={submit}>
            <label>
              <span className="sr-only">Username</span>
              <input
                aria-label="Username"
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="Username"
                maxLength={254}
                required
                autoFocus
              />
            </label>
            <label>
              <span className="sr-only">Password</span>
              <div className="password-field">
                <input
                  aria-label="Password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Password"
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
              {pending ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
