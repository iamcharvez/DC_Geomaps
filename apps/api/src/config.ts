export type Config = {
  bind: string;
  port: number;
  appOrigin: string;
  keycloakBaseUrl: string;
  keycloakRealm: string;
  keycloakClientId: string;
  keycloakClientSecret: string;
  keycloakRequiredRole: string;
  workerUrl: string;
  workerSharedSecret: string;
  basemapManifestUrl: string;
  integrationDataPath: string;
};

function required(name: string, source = process.env): string {
  const value = source[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function secureUrl(name: string, allowHttp: boolean, source = process.env): string {
  const value = required(name, source).replace(/\/$/, "");
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) {
    throw new Error(`${name} must use HTTPS unless KEYCLOAK_ALLOW_HTTP=true`);
  }
  return value;
}

export function loadConfig(source = process.env): Config {
  const allowHttp = source.KEYCLOAK_ALLOW_HTTP === "true";
  const port = Number(source.API_PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("API_PORT must be a valid TCP port");
  }
  const secret = required("WORKER_SHARED_SECRET", source);
  if (secret.length < 32) throw new Error("WORKER_SHARED_SECRET must be at least 32 characters");
  return {
    bind: source.API_BIND?.trim() || "127.0.0.1",
    port,
    appOrigin: required("APP_ORIGIN", source),
    keycloakBaseUrl: secureUrl("KEYCLOAK_BASE_URL", allowHttp, source),
    keycloakRealm: required("KEYCLOAK_REALM", source),
    keycloakClientId: source.KEYCLOAK_CLIENT_ID?.trim() || "dcgeomaps",
    keycloakClientSecret: required("KEYCLOAK_CLIENT_SECRET", source),
    keycloakRequiredRole: source.KEYCLOAK_REQUIRED_ROLE?.trim() || "role_dcgeomaps_admin",
    workerUrl: (source.WORKER_URL?.trim() || "http://127.0.0.1:8788").replace(/\/$/, ""),
    workerSharedSecret: secret,
    basemapManifestUrl: source.BASEMAP_MANIFEST_URL?.trim() || "/basemap/active.json",
    integrationDataPath: source.INTEGRATION_DATA_PATH?.trim() || "/data/integration/keys.json",
  };
}
