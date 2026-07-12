// Hand-written types for firstPartyLookups.mjs (mirrors fieldCatalog.d.mts's
// convention: the .mjs stays pure/node-testable, TS consumers get shapes).
import type { CallSpec } from '../../types';
import type { FieldType } from './rosterGroups.d.mts';

export type FirstPartyField = {
  name: string;
  label: string;
  type: FieldType;
  entityType: string;
  buildLookup: (scopeId: string) => CallSpec;
};

export type FirstPartyTemplate = {
  sourceLabel: string;
  scopeLookup: CallSpec | null;
  fields: FirstPartyField[];
};

export const FIRST_PARTY_LOOKUPS: Record<string, FirstPartyTemplate>;
export function firstPartyTemplateFor(toolkit: string | undefined): FirstPartyTemplate | null;
export const FIRST_PARTY_CONNECTION_VERSION: string;
