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
    cancel_requested: boolean;
  };
  last_check: { checksum_md5: string; last_modified: string; checked_at: string } | null;
  last_success: { at: string; action: string; version: string } | null;
  last_failure: { at: string; message: string; cancelled?: boolean } | null;
  disk: { total: number; used: number; free: number };
  schedule: {
    timezone: string;
    daily_incremental: string;
    monthly_full: string;
    next_daily: string;
    next_monthly: string;
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

