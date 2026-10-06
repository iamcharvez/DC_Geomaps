# Keycloak authentication

DC Geomap uses a backend-mediated Resource Owner Password Credentials/direct-access grant because direct access is an explicit deployment requirement. The password is sent to the API over the site connection, forwarded to Keycloak, and never persisted.

## Client configuration

Create a dedicated OpenID Connect client:

1. Client ID: `dcgeomaps` (or update `KEYCLOAK_CLIENT_ID`).
2. Enable **Client authentication**.
3. Enable **Direct access grants**.
4. Disable unnecessary flows and service accounts.
5. Create the exact realm or client role `role_dcgeomaps_admin`.
6. Scope that role into this client's access token.
7. Assign the role only to basemap operators.
8. No audience protocol mapper is required. The access token must contain `sub`, `iss`, `exp`, the issuing client (`client_id` or `azp`), and either `realm_access.roles` or `resource_access.dcgeomaps.roles`.

The API requires all of the following on every protected request:

- RS256 signature matches a public key published by the configured Keycloak realm.
- Token is unexpired and not before its optional `nbf` time.
- Issuer equals the configured realm.
- Issuing/authorized client equals `KEYCLOAK_CLIENT_ID`.
- Exact role `role_dcgeomaps_admin` is present.

Generic `admin`, sibling-application roles, or a similarly named role do not grant access. The API verifies tokens itself; it never trusts browser-decoded claims. Keycloak public keys are cached for five minutes, and an unknown key ID forces an immediate refresh so signing-key rotation continues to work.

Local verification avoids an introspection request for every API operation and therefore does not require the client to appear in the token's `aud` claim. A revoked access token can remain usable until its short expiration time; configure a suitably short Keycloak access-token lifetime. Refresh and logout still go through Keycloak, and logout performs best-effort token revocation.

The access token is held in React state. A refresh token, when issued, is stored in tab-scoped `sessionStorage`, rotated during refresh, and cleared on logout or authorization failure. Logout asks Keycloak to revoke both tokens.

Use HTTPS in production. `KEYCLOAK_ALLOW_HTTP=true` exists only for controlled internal development networks.
