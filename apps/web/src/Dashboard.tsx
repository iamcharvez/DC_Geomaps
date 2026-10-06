import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { Integrations } from "./Integrations";
import { resourceSafety } from "./status-compat";
import type { AuditEvent, BasemapStatus, User } from "./types";

const MapPreview = lazy(() =>
  import("./MapPreview").then((module) => ({ default: module.MapPreview })),
);

const actions = [
  { id: "check", label: "Check for updates", icon: "↻", detail: "Compare Geofabrik metadata" },
  { id: "update", label: "Update now", icon: "↓", detail: "Incremental when possible" },
  { id: "rebuild", label: "Force full rebuild", icon: "◫", detail: "Fresh Philippines download" },
  { id: "validate", label: "Validate active", icon: "✓", detail: "Archive, samples and Range" },
  { id: "rollback", label: "Roll back", icon: "↶", detail: "Activate previous version" },
] as const;

function bytes(value = 0) {
  if (!Number.isFinite(value)) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(unit < 2 ? 0 : 1)} ${units[unit]}`;
}

function date(value?: string | null) {
  if (!value) return "Not yet";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function short(value?: string | null) {
  return value ? `${value.slice(0, 10)}…${value.slice(-6)}` : "—";
}

function duration(seconds?: number | null) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function elapsed(value?: string | null) {
  if (!value) return "—";
  const started = new Date(value).getTime();
  return Number.isNaN(started) ? "—" : duration((Date.now() - started) / 1000);
}

function stage(value?: string | null) {
  return value ? value.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Preparing";
}

export function Dashboard({
  token,
  user,
  onLogout,
}: {
  token: string;
  user: User;
  onLogout: () => Promise<void>;
}) {
  const [status, setStatus] = useState<BasemapStatus | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [tab, setTab] = useState<"overview" | "logs" | "audit" | "integrations">("overview");
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [nextStatus, nextLogs, nextAudit] = await Promise.all([
        api.get<BasemapStatus>("/api/v1/basemap/status", token),
        api.get<{ lines: string[] }>("/api/v1/basemap/logs?tail=300", token),
        api.get<{ events: AuditEvent[] }>("/api/v1/basemap/audit", token),
      ]);
      setStatus(nextStatus);
      setLogs(nextLogs.lines);
      setAudit(nextAudit.events);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The service status could not be loaded.");
    }
  }, [token]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), status?.job.status === "idle" ? 20_000 : 3_000);
    return () => window.clearInterval(timer);
  }, [load, status?.job.status]);

  const busy = status?.job.status !== "idle";
  const diskPercent = status ? Math.round((status.disk.used / status.disk.total) * 100) : 0;
  const initials = user.username.slice(0, 2).toUpperCase();
  const healthy = !!status && status.service === "healthy";
  const resources = status?.resources;
  const resourcesSafe = resourceSafety(resources);

  const run = async (action: string) => {
    const dangerous = action === "rebuild" || action === "rollback";
    if (dangerous && !window.confirm(action === "rollback"
      ? "Activate the previous validated basemap?"
      : "Start a full Philippines download and rebuild?")) return;
    setActionPending(action);
    setError(null);
    try {
      await api.post(`/api/v1/basemap/${action}`, token);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The action could not be started.");
    } finally {
      setActionPending(null);
    }
  };

  const timeline = useMemo(() => {
    if (!status) return [];
    return [
      { label: "Last successful operation", value: date(status.last_success?.at), tone: "success" },
      { label: "Last source check", value: date(status.last_check?.checked_at), tone: "neutral" },
      ...(status.schedule.retry ? [{
        label: `Automatic retry ${status.schedule.retry.attempt}/${status.schedule.retry.max_attempts}`,
        value: date(status.schedule.retry.due_at),
        tone: "danger",
      }] : []),
      { label: "Next daily update", value: date(status.schedule.next_daily), tone: "neutral" },
      { label: "Next monthly rebuild", value: date(status.schedule.next_monthly), tone: "accent" },
    ];
  }, [status]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup compact">
          <span className="logo-mark">DC</span>
          <div><strong>GEOMAP</strong><small>BASEMAP OPERATIONS</small></div>
        </div>
        <nav aria-label="Console sections">
          <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>Overview</button>
          <button className={tab === "logs" ? "active" : ""} onClick={() => setTab("logs")}>Build logs</button>
          <button className={tab === "audit" ? "active" : ""} onClick={() => setTab("audit")}>Audit</button>
          <button className={tab === "integrations" ? "active" : ""} onClick={() => setTab("integrations")}>Integrations</button>
        </nav>
        <div className="operator">
          <span className="avatar">{initials}</span>
          <div><strong>{user.username}</strong><small>Administrator</small></div>
          <button className="icon-button" title="Sign out" onClick={() => void onLogout()}>↗</button>
        </div>
      </header>

      <main className="dashboard">
        <header className="page-heading">
          <div>
            <p className="eyebrow">PHILIPPINES · SELF-HOSTED</p>
            <h1>Basemap control room</h1>
            <p>Watch, validate, and promote OpenStreetMap updates without interrupting the live archive.</p>
          </div>
          <div className={`service-pill ${healthy ? "online" : "offline"}`}>
            <i /> {healthy ? "Systems operational" : "Status unavailable"}
          </div>
        </header>

        {error && <div className="banner-error" role="alert"><strong>Needs attention</strong><span>{error}</span></div>}

        {tab === "overview" && (
          <>
            <section className="metric-grid">
              <article className="metric-card hero-metric">
                <span className="metric-icon">◉</span>
                <div><small>ACTIVE BASEMAP</small><strong>{status?.active?.version || "Not installed"}</strong><p>{status?.active ? `Activated ${date(status.active.activated_at)}` : "Run the first full build to publish a map"}</p></div>
                <span className={`mini-status ${status?.active ? "ready" : "waiting"}`}>{status?.active ? "LIVE" : "WAITING"}</span>
              </article>
              <article className="metric-card"><span className="metric-icon">◇</span><div><small>OSM SNAPSHOT</small><strong>{status?.active?.osm_timestamp?.slice(0, 10) || "—"}</strong><p>{status?.source ? `${status.source.mode} source` : "No source installed"}</p></div></article>
              <article className="metric-card"><span className="metric-icon">≋</span><div><small>ARCHIVE SIZE</small><strong>{bytes(status?.active?.archive_size)}</strong><p>PMTiles · native z{status?.native_max_zoom ?? 15}</p></div></article>
              <article className="metric-card"><span className="metric-icon">◫</span><div><small>FREE DISK</small><strong>{bytes(status?.disk.free)}</strong><p>{diskPercent}% used{resources ? ` · ${bytes(resources.disk_required_free)} safety requirement` : ""}</p></div></article>
            </section>

            <section className="main-grid">
              <article className="panel map-panel">
                <header><div><p className="eyebrow">LIVE ARCHIVE</p><h2>Philippines coverage</h2></div><span className="coordinate">122.2° E · 12.4° N</span></header>
                <Suspense fallback={<div className="map-empty"><p>Loading map renderer…</p></div>}>
                  <MapPreview active={status?.active ?? null} job={status?.job} token={token} />
                </Suspense>
              </article>

              <aside className="panel operations-panel">
                <header><div><p className="eyebrow">CONTROL PLANE</p><h2>Operations</h2></div><span className="lock-badge">◆ ADMIN</span></header>
                {status && resources && (
                  <div className={`resource-status ${resourcesSafe ? "safe" : "warning"}`}>
                    <div><span>Memory available</span><strong>{bytes(resources.memory_available || Number.NaN)}</strong><small>{bytes(resources.java_heap)} Java heap</small></div>
                    <div><span>Disk headroom</span><strong>{bytes(Math.max(0, status.disk.free - resources.disk_required_free))}</strong><small>{bytes(resources.disk_required_free)} required</small></div>
                    <b>{resourcesSafe ? "Safety checks passed" : `Blocked: ${resources.warnings.join(", ")}`}</b>
                  </div>
                )}
                {!busy && status?.schedule.retry && (
                  <div className="retry-notice">
                    <strong>Automatic retry scheduled</strong>
                    <span>{status.schedule.retry.kind} attempt {status.schedule.retry.attempt}/{status.schedule.retry.max_attempts} · {date(status.schedule.retry.due_at)}</span>
                  </div>
                )}
                {busy && status && (
                  <div className="job-progress">
                    <div><strong>{status.job.message}</strong><span>{status.job.progress}%</span></div>
                    <progress max="100" value={status.job.progress} />
                    <small>{stage(status.job.stage)} · running {elapsed(status.job.started_at)} · started {date(status.job.started_at)}</small>
                    {(status.job.bytes_total > 0 || status.job.bytes_per_second > 0) && (
                      <div className="transfer-grid">
                        <span><small>Transferred</small><strong>{bytes(status.job.bytes_downloaded)} / {bytes(status.job.bytes_total)}</strong></span>
                        <span><small>Speed</small><strong>{bytes(status.job.bytes_per_second)}/s</strong></span>
                        <span><small>ETA</small><strong>{duration(status.job.eta_seconds)}</strong></span>
                        <span><small>Attempt</small><strong>{status.job.attempt || 1}/{status.job.max_attempts || 1}{status.job.resumed ? " · resumed" : ""}</strong></span>
                      </div>
                    )}
                    <button className="danger-soft" disabled={status.job.status === "cancelling"} onClick={() => void run("cancel")}>{status.job.status === "cancelling" ? "Stopping safely…" : "Cancel update"}</button>
                  </div>
                )}
                <div className="action-list">
                  {actions.map((action) => (
                    <button key={action.id} disabled={!!busy || !!actionPending || (action.id === "rollback" && !status?.previous)} onClick={() => void run(action.id)}>
                      <span className="action-icon">{action.icon}</span>
                      <span><strong>{action.label}</strong><small>{action.detail}</small></span>
                      <span className="arrow">→</span>
                    </button>
                  ))}
                </div>
              </aside>
            </section>

            <section className="detail-grid">
              <article className="panel schedule-panel">
                <header><div><p className="eyebrow">AUTOMATION</p><h2>Update schedule</h2></div><span className="timezone">Asia/Manila</span></header>
                <div className="timeline">
                  {timeline.map((item) => <div key={item.label}><i className={item.tone} /><span><small>{item.label}</small><strong>{item.value}</strong></span></div>)}
                </div>
              </article>
              <article className="panel integrity-panel">
                <header><div><p className="eyebrow">INTEGRITY</p><h2>Checksums & rollback</h2></div></header>
                <dl>
                  <div><dt>Source SHA-256</dt><dd title={status?.active?.source_checksum}>{short(status?.active?.source_checksum)}</dd></div>
                  <div><dt>PMTiles SHA-256</dt><dd title={status?.active?.pmtiles_checksum}>{short(status?.active?.pmtiles_checksum)}</dd></div>
                  <div><dt>Previous version</dt><dd>{status?.previous?.version || "None retained"}</dd></div>
                  <div><dt>Display zoom</dt><dd>z0–{status?.display_max_zoom ?? 22} · vector overzoom</dd></div>
                </dl>
                {status?.last_failure && (
                  <div className={`failure-note ${status.last_failure.resolved_at ? "resolved" : ""}`}>
                    <strong>{status.last_failure.resolved_at ? "Previous failure · resolved" : busy ? "Previous failure · recovery running" : "Last failure · attention needed"}</strong>
                    <span>{status.last_failure.message}</span>
                    <small>
                      {status.last_failure.category ? `${status.last_failure.category} · ` : ""}{date(status.last_failure.at)}
                      {status.last_failure.resolved_at ? ` · resolved ${date(status.last_failure.resolved_at)}` : ""}
                      {!status.last_failure.resolved_at && status.last_failure.retry_at ? ` · retry ${date(status.last_failure.retry_at)}` : ""}
                    </small>
                  </div>
                )}
              </article>
            </section>
          </>
        )}

        {tab === "logs" && (
          <section className="panel console-panel">
            <header><div><p className="eyebrow">WORKER OUTPUT</p><h2>Build logs</h2></div><button className="soft-button" onClick={() => void load()}>Refresh</button></header>
            <pre>{logs.length ? logs.join("\n") : "No worker log entries yet."}</pre>
          </section>
        )}

        {tab === "audit" && (
          <section className="panel audit-panel">
            <header><div><p className="eyebrow">SECURITY RECORD</p><h2>Administrator audit trail</h2></div><span>{audit.length} recent events</span></header>
            <div className="audit-table" role="table">
              <div className="audit-row audit-head" role="row"><span>Time</span><span>Actor</span><span>Action</span><span>Outcome</span><span>Detail</span></div>
              {audit.map((event, index) => <div className="audit-row" role="row" key={`${event.at}-${index}`}><span>{date(event.at)}</span><span>{event.actor}</span><strong>{event.action}</strong><span className={`outcome ${event.outcome}`}>{event.outcome}</span><span>{event.detail || "—"}</span></div>)}
              {!audit.length && <p className="empty-row">No administrator actions have been recorded.</p>}
            </div>
          </section>
        )}

        {tab === "integrations" && <Integrations token={token} />}
      </main>
    </div>
  );
}
