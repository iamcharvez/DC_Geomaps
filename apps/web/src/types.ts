export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  refresh_expires_in?: number;
  token_type: string;
};

export type User = { username: string; roles: string[] };

export type BasemapVersion = {
  version: string;
  url: string;
  osm_timestamp: string;
  source_checksum: string;
  pmtiles_checksum: string;
  archive_size: number;
  native_max_zoom: number;
  activated_at: string;
};

export type BasemapStatus = {
  service: string;
  active: BasemapVersion | null;
  previous: BasemapVersion | null;
  source: {
    mode: string;
    osm_timestamp: string;
    checksum_sha256: string;
    remote_checksum_md5: string;
    updated_at: string;
  } | null;
  job: {
    status: "idle" | "queued" | "running" | "cancelling";
    action: string | null;
    stage: string | null;
    progress: number;
    message: string;
    started_at: string | null;
    updated_at: string;
    cancel_requested: boolean;
    bytes_downloaded: number;
    bytes_total: number;
    bytes_per_second: number;
    eta_seconds: number | null;
    attempt: number | null;
    max_attempts: number | null;
    resumed: boolean;
    scheduled_kind: string | null;
    scheduled_key: string | null;
    scheduled_attempt: number | null;
  };
  last_check: { checksum_md5: string; last_modified: string; content_length: number; checked_at: string } | null;
  last_success: { at: string; action: string; version: string } | null;
  last_failure: {
    at: string;
    message: string;
    category?: string;
    action?: string;
    stage?: string;
    cancelled?: boolean;
    retry_at?: string | null;
    retry_exhausted?: boolean;
    resolved_at?: string;
    resolved_by?: string;
  } | null;
  disk: { total: number; used: number; free: number };
  resources?: {
    safe: boolean;
    warnings: string[];
    disk_required_free: number;
    disk_configured_floor: number;
    memory_total: number;
    memory_available: number;
    java_heap: number;
    memory_reserve: number;
    minimum_available_memory: number;
  };
  schedule: {
    timezone: string;
    daily_incremental: string;
    monthly_full: string;
    next_daily: string;
    next_monthly: string;
    retry: {
      kind: string;
      key: string;
      action: string;
      attempt: number;
      max_attempts: number;
      due_at: string;
      last_error: string;
    } | null;
  };
  native_max_zoom: number;
  display_max_zoom: number;
};

export type AuditEvent = {
  at: string;
  actor: string;
  action: string;
  outcome: string;
  detail: string;
};

export type IntegrationKey = {
  id: string;
  name: string;
  prefix: string;
  scopes: ["basemap:read"];
  allowed_origins: string[];
  rate_limit_per_minute: number;
  created_at: string;
  created_by: string;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  last_used_at: string | null;
  last_origin: string | null;
  request_count: number;
  status: "active" | "expired" | "revoked";
};

export type IssuedIntegrationKey = { api_key: string; key: IntegrationKey };
