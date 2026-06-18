// fm-awii — renderer-side handler for the agent tagging API.
//
// Tags live in the renderer store (Redux + localStorage), so the main-process
// HTTP API can't touch them directly. It proxies through the control bridge
// (controlRenderer → onControlRequest); this module turns a tag control
// request into store dispatches + a JSON-able reply. Agents address tags by
// NAME (case-insensitive) or id; `tagApply` auto-creates a missing tag so an
// agent can "tag these files as invoices" in one call.

import {
  getAllTags,
  newTagId,
  assignTagKey,
  TAG_PALETTE,
  RESERVED_KEYS,
} from './tags';
import type { CustomTag, TagPaths } from './types';

type TagDispatch = (
  a:
    | { type: 'createCustomTag'; tag: CustomTag }
    | { type: 'applyTag'; id: string; paths: string[] }
    | { type: 'untagPaths'; id: string; paths: string[] }
    | { type: 'addTagViz'; id: string },
) => void;

export type TagControlReq =
  | { kind: 'tagsList' }
  | { kind: 'tagApply'; tag: string; paths: string[]; create?: boolean }
  | { kind: 'tagUntag'; tag: string; paths: string[] }
  | { kind: 'tagCreate'; name: string; color?: string }
  | { kind: 'tagsForPath'; path: string };

export type TagControlCtx = {
  customTags: CustomTag[];
  tagPaths: TagPaths;
  dispatch: TagDispatch;
  now: number;
};

const TAG_KINDS = new Set([
  'tagsList',
  'tagApply',
  'tagUntag',
  'tagCreate',
  'tagsForPath',
]);

export function isTagControl(kind: string): boolean {
  return TAG_KINDS.has(kind);
}

function createTag(
  rawName: string,
  color: string | undefined,
  ctx: TagControlCtx,
): { id: string; name: string; color: string } {
  const name = rawName.trim();
  const id = newTagId(name);
  const taken = new Set<string>([
    ...RESERVED_KEYS,
    ...ctx.customTags.map((t) => t.key).filter((k): k is string => !!k),
  ]);
  const key = assignTagKey(name, taken);
  const chosen =
    color ?? TAG_PALETTE[ctx.customTags.length % TAG_PALETTE.length].color;
  const tag: CustomTag = { id, name, color: chosen, key, createdAt: ctx.now };
  ctx.dispatch({ type: 'createCustomTag', tag });
  return { id, name, color: chosen };
}

export function handleTagControl(req: TagControlReq, ctx: TagControlCtx): unknown {
  const all = getAllTags(ctx.customTags);
  const resolve = (ref: string) => {
    const lc = ref.trim().toLowerCase();
    return all.find((t) => t.id === ref || t.name.toLowerCase() === lc);
  };

  switch (req.kind) {
    case 'tagsList':
      return {
        tags: all.map((t) => ({
          id: t.id,
          name: t.name,
          color: t.color,
          builtin: !!t.builtin,
          manualCount: (ctx.tagPaths[t.id] ?? []).length,
        })),
      };

    case 'tagsForPath': {
      const tags = all
        .filter((t) => (ctx.tagPaths[t.id] ?? []).includes(req.path))
        .map((t) => ({ id: t.id, name: t.name, color: t.color }));
      return { path: req.path, tags };
    }

    case 'tagCreate': {
      const existing = resolve(req.name);
      if (existing) {
        return {
          id: existing.id,
          name: existing.name,
          color: existing.color,
          created: false,
        };
      }
      return { ...createTag(req.name, req.color, ctx), created: true };
    }

    case 'tagApply': {
      const paths = req.paths ?? [];
      if (paths.length === 0) throw new Error('paths required');
      let tag = resolve(req.tag);
      let created = false;
      if (!tag) {
        if (req.create === false) throw new Error(`no such tag: ${req.tag}`);
        const c = createTag(req.tag, undefined, ctx);
        tag = { id: c.id, name: c.name, color: c.color };
        created = true;
      }
      ctx.dispatch({ type: 'applyTag', id: tag.id, paths });
      // Visualize the tag on the active tab so its color band shows up in
      // list view immediately — mirrors the manual TagPicker apply path,
      // which also opts the tab into visualizing the tag it just applied.
      // Without this an agent-applied tag stays invisible (fm-awii bug).
      ctx.dispatch({ type: 'addTagViz', id: tag.id });
      return { id: tag.id, name: tag.name, applied: paths.length, created };
    }

    case 'tagUntag': {
      const paths = req.paths ?? [];
      if (paths.length === 0) throw new Error('paths required');
      const tag = resolve(req.tag);
      if (!tag) throw new Error(`no such tag: ${req.tag}`);
      ctx.dispatch({ type: 'untagPaths', id: tag.id, paths });
      return { id: tag.id, name: tag.name, removed: paths.length };
    }
  }
}
