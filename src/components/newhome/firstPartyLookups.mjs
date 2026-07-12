// docs/connections-design.md §J.5 — client-side lookup templates for
// FIRST-PARTY catalog tiles (auth:'first_party_mcp'). A catalog entry carries
// only name + serviceUrl — no spec — so something must know HOW to search a
// first-party service before its rows can back a typeahead field. For
// first-party services we own both ends, so the templates ship in the client
// (per-toolkit), the same way the client already knows how to mount the
// first-party MCP. Third-party connections don't belong here — their lookups
// are authored per-binding (§D.2) or derived from a server-held spec.
//
// Shape per toolkit:
//   sourceLabel        — the picker group name ("Scheduler").
//   scopeLookup        — a CallSpec that enumerates the caller's reachable
//                        scope rows (e.g. /businesses); the FIRST row's
//                        externalId parameterizes the field lookups. null when
//                        a toolkit's paths need no scope segment.
//   fields[]           — the pickable typeahead fields: key/label/type/
//                        entityType + buildLookup(scopeId) → CallSpec, with
//                        `{q}` as the typed-search slot (connection-exec.ts
//                        fillTemplate) and output.fields naming the row
//                        columns a pick snapshots (§D.2 bundle).
//
// Pure data + builders only (mirrors fieldCatalog.mjs's node-testable
// discipline): no imports, no I/O — callers do the fetching.

export const FIRST_PARTY_LOOKUPS = {
  'scheduling-api': {
    sourceLabel: 'Scheduler',
    scopeLookup: {
      method: 'GET',
      path: '/businesses',
      output: {
        shape: 'rows',
        rowsPath: 'businesses',
        ref: { entityType: 'business', externalIdPath: 'business_id' },
        fields: { name: 'name' },
      },
    },
    fields: [
      {
        name: 'patient_name',
        label: 'Patient name',
        type: 'text',
        entityType: 'customer',
        buildLookup: (scopeId) => ({
          method: 'GET',
          path: `/businesses/${scopeId}/customers/search`,
          query: { q: '{q}', limit: '10' },
          output: {
            shape: 'rows',
            rowsPath: 'customers',
            ref: { entityType: 'customer', externalIdPath: 'id' },
            fields: { name: 'name', phone: 'phone', email: 'email' },
          },
        }),
      },
    ],
  },
};

/** The lookup template for a catalog tile's toolkit, or null when this client
 *  has none (the tile then simply doesn't appear as a field source). */
export function firstPartyTemplateFor(toolkit) {
  return (typeof toolkit === 'string' && FIRST_PARTY_LOOKUPS[toolkit]) || null;
}

/** Sentinel `connectionVersion` for first-party bindings — catalog tiles
 *  carry no spec hash (§B) to pin, and the service is ours, so version drift
 *  is governed by the client release instead. */
export const FIRST_PARTY_CONNECTION_VERSION = 'first-party';
