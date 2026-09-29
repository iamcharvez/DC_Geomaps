# Keycloak authentication

DC Geomap uses a backend-mediated Resource Owner Password Credentials/direct-access grant because direct access is an explicit deployment requirement. The password is sent to the API over the site connection, forwarded to Keycloak, and never persisted.

## Client configuration

Create a dedicated OpenID Connect client:

1. Client ID: `dcgeomaps` (or update `KEYCLOAK_CLIENT_ID`).
2. Enable **Client authentication**.
3. Enable **Direct access grants**.
4. Disable unnecessary flows and service accounts.
5. Create the exact realm or client role `role_dcgeomaps_admin`.
6. Scope that role into this client's tokens/introspection response.
7. Assign the role only to basemap operators.
8. Ensure introspection supplies `active`, `sub`, `iss`, `exp`, the issuing client (`client_id` or `azp`), and either `realm_access.roles` or `resource_access.dcgeomaps.roles`.

The API requires all of the following on every protected request:

- Token is active and unexpired.
- Issuer equals the configured realm.
- Issuing/authorized client equals `KEYCLOAK_CLIENT_ID`.
- Exact role `role_dcgeomaps_admin` is present.

Generic `admin`, sibling-application roles, or a similarly named role do not grant access. Tokens are introspected instead of trusting browser-decoded claims.

The access token is held in React state. A refresh token, when issued, is stored in tab-scoped `sessionStorage`, rotated during refresh, and cleared on logout or authorization failure. Logout asks Keycloak to revoke both tokens.

Use HTTPS in production. `KEYCLOAK_ALLOW_HTTP=true` exists only for controlled internal development networks.

