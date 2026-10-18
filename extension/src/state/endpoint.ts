import type { ExtensionEndpoint } from "@shared/extension";

/**
 * The optional host permission to request for an endpoint. Chrome match patterns ignore the port,
 * so `http://localhost:3000` asks for `http://localhost/*`, a subset of the manifest's
 * `optional_host_permissions`. An `ExtensionEndpoint` is a bare origin, so dropping a trailing
 * `:port` leaves `scheme://host`.
 */
export function hostPermissionPattern(endpoint: ExtensionEndpoint): string {
  return `${endpoint.replace(/:\d+$/, "")}/*`;
}
