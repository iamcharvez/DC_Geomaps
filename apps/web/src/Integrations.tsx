import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { IntegrationKey, IssuedIntegrationKey } from "./types";

function date(value?: string | null) {
  if (!value) return "Never";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

async function copy(value: string) {
  await navigator.clipboard.writeText(value);
}

export function Integrations({ token }: { token: string }) {
  const [keys, setKeys] = useState<IntegrationKey[]>([]);
  const [name, setName] = useState("");
  const [origins, setOrigins] = useState("*");
  const [rate, setRate] = useState("1200");
  const [expiry, setExpiry] = useState("90");
  const [issued, setIssued] = useState<IssuedIntegrationKey | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const origin = window.location.origin;

  const load = useCallback(async () => {
    try {
      const response = await api.get<{ keys: IntegrationKey[] }>("/api/v1/integration/keys", token);
      setKeys(response.keys);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Integration keys could not be loaded.");
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const endpoints = useMemo(() => ({
    discovery: `${origin}/api/v1/integration`,
    style: `${origin}/api/v1/integration/style.json`,
  }), [origin]);

  const markCopied = async (label: string, value: string) => {
    try {
      await copy(value);
      setCopied(label);
      window.setTimeout(() => setCopied((current) => current === label ? null : current), 1800);
    } catch {
      setError("Clipboard access was blocked. Copy the value manually.");
    }
  };

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending("create");
    setError(null);
    try {
      const allowed = origins.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
      const expiresAt = expiry === "never" ? null : new Date(Date.now() + Number(expiry) * 86_400_000).toISOString();
      const response = await api.send<IssuedIntegrationKey>(
        "/api/v1/integration/keys",
        "POST",
        {
          name,
          allowed_origins: allowed,
          rate_limit_per_minute: Number(rate),
          expires_at: expiresAt,
        },
        token,
      );
      setIssued(response);
      setName("");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The integration key could not be created.");
    } finally {
      setPending(null);
    }
  };

  const action = async (key: IntegrationKey, kind: "revoke" | "rotate") => {
    const message = kind === "revoke"
      ? `Revoke ${key.name}? Its map requests will stop immediately.`
      : `Rotate ${key.name}? The current key will stop working immediately.`;
    if (!window.confirm(message)) return;
    setPending(`${kind}:${key.id}`);
    setError(null);
    try {
      const response = await api.post<IssuedIntegrationKey | { key: IntegrationKey }>(
        `/api/v1/integration/keys/${key.id}/${kind}`,
        token,
      );
      if (kind === "rotate" && "api_key" in response) setIssued(response);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `The key could not be ${kind}d.`);
    } finally {
      setPending(null);
    }
  };

  return (
    <section className="integration-layout">
      {error && <div className="banner-error" role="alert"><strong>Needs attention</strong><span>{error}</span></div>}

      {issued && (
        <article className="secret-reveal">
          <div className="secret-icon">◆</div>
          <div>
            <p className="eyebrow">ONE-TIME SECRET</p>
            <h2>Copy this key now</h2>
            <p>DC Geomap stores only its hash. This secret cannot be displayed again.</p>
            <code>{issued.api_key}</code>
            <div className="secret-actions">
              <button className="primary compact-button" onClick={() => void markCopied("secret", issued.api_key)}>
                {copied === "secret" ? "Copied" : "Copy API key"}
              </button>
              <button className="soft-button" onClick={() => setIssued(null)}>I saved it</button>
            </div>
          </div>
        </article>
      )}

      <div className="integration-grid">
        <article className="panel key-create-panel">
          <header><div><p className="eyebrow">NEW CONSUMER</p><h2>Generate integration key</h2></div><span className="lock-badge">ADMIN ONLY</span></header>
          <form onSubmit={(event) => void create(event)} className="key-form">
            <label>
              Application name
              <input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="DC Field Ops" />
            </label>
            <label>
              Allowed browser origins
              <textarea required value={origins} onChange={(event) => setOrigins(event.target.value)} placeholder="https://fieldops.example.com" />
              <small>One exact origin per line, or * for any browser origin. Server-to-server requests have no Origin header.</small>
            </label>
            <div className="form-split">
              <label>
                Requests per minute
                <select value={rate} onChange={(event) => setRate(event.target.value)}>
                  <option value="300">300 · light</option>
                  <option value="1200">1,200 · standard</option>
                  <option value="5000">5,000 · busy map</option>
                  <option value="10000">10,000 · high traffic</option>
                </select>
              </label>
              <label>
                Expiration
                <select value={expiry} onChange={(event) => setExpiry(event.target.value)}>
                  <option value="30">30 days</option>
                  <option value="90">90 days</option>
                  <option value="365">1 year</option>
                  <option value="never">Never</option>
                </select>
              </label>
            </div>
            <button className="primary create-key-button" disabled={pending === "create"}>
              <span>{pending === "create" ? "Generating securely…" : "Generate API key"}</span><b>＋</b>
            </button>
          </form>
        </article>

        <article className="panel endpoint-panel">
          <header><div><p className="eyebrow">API V1</p><h2>Connection details</h2></div><span className="api-live"><i /> READY</span></header>
          <div className="endpoint-list">
            <div><span>Discovery</span><code>{endpoints.discovery}</code><button onClick={() => void markCopied("discovery", endpoints.discovery)}>{copied === "discovery" ? "✓" : "Copy"}</button></div>
            <div><span>MapLibre style</span><code>{endpoints.style}</code><button onClick={() => void markCopied("style", endpoints.style)}>{copied === "style" ? "✓" : "Copy"}</button></div>
          </div>
          <div className="integration-example">
            <strong>Authentication header</strong>
            <code>X-API-Key: dcgm_••••••••_••••••••••••••••</code>
            <p>PMTiles range requests use the same header. See the integration guide for MapLibre and React setup.</p>
          </div>
        </article>
      </div>

      <article className="panel key-list-panel">
        <header>
          <div><p className="eyebrow">ACCESS CONTROL</p><h2>Application keys</h2></div>
          <button className="soft-button" onClick={() => void load()}>Refresh</button>
        </header>
        <div className="key-list">
          {keys.map((key) => (
            <div className={`key-row ${key.status}`} key={key.id}>
              <div className="key-app"><span>{key.name.slice(0, 2).toUpperCase()}</span><div><strong>{key.name}</strong><code>{key.prefix}_••••••••</code></div></div>
              <div><small>Status</small><b className={`key-status ${key.status}`}>{key.status}</b></div>
              <div><small>Origin policy</small><strong title={key.allowed_origins.join(", ")}>{key.allowed_origins.includes("*") ? "Any origin" : `${key.allowed_origins.length} allowed`}</strong></div>
              <div><small>Usage</small><strong>{key.request_count.toLocaleString()} requests</strong><span>{key.last_used_at ? `Last ${date(key.last_used_at)}` : "Never used"}</span></div>
              <div><small>Expires</small><strong>{date(key.expires_at)}</strong><span>{key.rate_limit_per_minute.toLocaleString()}/min</span></div>
              <div className="key-actions">
                <button disabled={key.status !== "active" || !!pending} onClick={() => void action(key, "rotate")}>Rotate</button>
                <button className="revoke" disabled={key.status !== "active" || !!pending} onClick={() => void action(key, "revoke")}>Revoke</button>
              </div>
            </div>
          ))}
          {!keys.length && <div className="integration-empty"><span>◇</span><h3>No integration keys yet</h3><p>Generate a key to connect your first application.</p></div>}
        </div>
      </article>
    </section>
  );
}
