import { OpportunityId } from "@shared/api";
import { ApplicationSessionId, ExtensionEndpoint, PairingId, PairingToken } from "@shared/extension";
import { z } from "zod";

// What the extension keeps (docs/plans/chrome-extension.md, "Storage"):
// chrome.storage.local: endpoint, pairing token, granted origins, UI settings.
// chrome.storage.session: the application session bound to a tab.
// No answers, page text or files, ever. Every read is parsed; a value that does not parse reads
// as absent, so a corrupted token is "unpaired", never a half-trusted state.

/** The part of `chrome.storage.StorageArea` the store uses. Tests pass an in-memory one. */
export type KeyValueArea = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
};

export const StoredPairing = z.strictObject({ pairingId: PairingId, token: PairingToken });
export type StoredPairing = z.infer<typeof StoredPairing>;

/** Origins the user approved for prefill, as `https://host`. Managed by the per-origin approve flow. */
export const GrantedOrigins = z
  .array(
    z
      .string()
      .max(300)
      .regex(/^https:\/\/[^/?#\s]+$/),
  )
  .max(500);
export type GrantedOrigins = z.infer<typeof GrantedOrigins>;

export const UiSettings = z.strictObject({ showDiagnostics: z.boolean() });
export type UiSettings = z.infer<typeof UiSettings>;
const DEFAULT_UI: UiSettings = { showDiagnostics: false };

/** The application session the panel claimed for a tab. Lives in `chrome.storage.session` only. */
export const SessionBinding = z.strictObject({
  sessionId: ApplicationSessionId,
  opportunityId: OpportunityId,
  tabId: z.number().int().min(0),
  claimedAt: z.number().int().min(0),
});
export type SessionBinding = z.infer<typeof SessionBinding>;

const LOCAL_KEYS = { endpoint: "endpoint", pairing: "pairing", grantedOrigins: "grantedOrigins", ui: "ui" } as const;
const SESSION_KEYS = { binding: "binding" } as const;

export type LocalState = {
  endpoint: ExtensionEndpoint | null;
  pairing: StoredPairing | null;
  grantedOrigins: GrantedOrigins;
  ui: UiSettings;
};

function parsed<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

export function createStore({ local, session }: { local: KeyValueArea; session: KeyValueArea }) {
  return {
    async readLocal(): Promise<LocalState> {
      const raw = await local.get(Object.values(LOCAL_KEYS));
      return {
        endpoint: parsed(ExtensionEndpoint, raw[LOCAL_KEYS.endpoint]),
        pairing: parsed(StoredPairing, raw[LOCAL_KEYS.pairing]),
        grantedOrigins: parsed(GrantedOrigins, raw[LOCAL_KEYS.grantedOrigins]) ?? [],
        ui: parsed(UiSettings, raw[LOCAL_KEYS.ui]) ?? DEFAULT_UI,
      };
    },

    /** Endpoint and token are written together so a token never points at another server. */
    async savePairing({ endpoint, pairing }: { endpoint: ExtensionEndpoint; pairing: StoredPairing }): Promise<void> {
      await session.remove([SESSION_KEYS.binding]);
      await local.set({ [LOCAL_KEYS.endpoint]: endpoint, [LOCAL_KEYS.pairing]: pairing });
    },

    async saveEndpoint(endpoint: ExtensionEndpoint): Promise<void> {
      await local.set({ [LOCAL_KEYS.endpoint]: endpoint });
    },

    /** Unpaired: drop the token and the session binding, keep the endpoint for the pairing screen. */
    async clearPairing(): Promise<void> {
      await session.remove([SESSION_KEYS.binding]);
      await local.remove([LOCAL_KEYS.pairing]);
    },

    async saveGrantedOrigins(origins: GrantedOrigins): Promise<void> {
      await local.set({ [LOCAL_KEYS.grantedOrigins]: GrantedOrigins.parse(origins) });
    },

    async saveUi(ui: UiSettings): Promise<void> {
      await local.set({ [LOCAL_KEYS.ui]: ui });
    },

    async readBinding(): Promise<SessionBinding | null> {
      const raw = await session.get([SESSION_KEYS.binding]);
      return parsed(SessionBinding, raw[SESSION_KEYS.binding]);
    },

    async saveBinding(binding: SessionBinding): Promise<void> {
      await session.set({ [SESSION_KEYS.binding]: binding });
    },

    async clearBinding(): Promise<void> {
      await session.remove([SESSION_KEYS.binding]);
    },
  };
}

export type Store = ReturnType<typeof createStore>;

/** Adapts a real `chrome.storage` area to `KeyValueArea`. */
export function chromeArea(area: chrome.storage.StorageArea): KeyValueArea {
  return {
    get: (keys) => area.get(keys),
    set: (items) => area.set(items),
    remove: (keys) => area.remove(keys),
  };
}
