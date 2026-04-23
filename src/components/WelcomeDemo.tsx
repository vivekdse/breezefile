/*
 * WelcomeDemo — a scripted mini-replay of the chip-prompt verb system.
 *
 * Plays three scenes on a forever loop inside the welcome card:
 *   1. Navigate (go to Documents)
 *   2. Find (search recursively across folders)
 *   3. Copy (stage a row, target Desktop)
 *
 * It fakes the UI rather than mounting real ChipPrompt/FileRow, so the
 * demo is cheap to iterate on but owes a debt: if we restyle the real
 * chip prompt, this file needs to follow. All colors / fonts go
 * through theme tokens so every palette (Dusk / Paper / Plum / …)
 * looks correct without this file knowing about them.
 *
 * The runner is a single async useEffect that walks through SCRIPT
 * and restarts from the top. A `cancelled` flag makes unmount clean.
 */

import { useEffect, useState } from 'react';
import './WelcomeDemo.css';

type Row = { name: string; kind: 'folder' | 'file' | 'image' | 'doc'; meta?: string };
type Completion = { label: string; detail?: string; chord?: string };

const HOME_ROWS: Row[] = [
  { name: 'Desktop', kind: 'folder' },
  { name: 'Documents', kind: 'folder' },
  { name: 'Downloads', kind: 'folder' },
  { name: 'Pictures', kind: 'folder' },
  { name: 'Projects', kind: 'folder' },
];

// Landing view after `goto documents` — deliberately no "proposal"
// file in this list. The Find scene below is supposed to demonstrate
// the value of recursive find by surfacing a match the user couldn't
// see by browsing the current folder.
const DOCS_ROWS: Row[] = [
  { name: 'budget.xlsx', kind: 'doc', meta: '412 KB · 5d ago' },
  { name: 'kickoff-slides.key', kind: 'doc', meta: '22 MB · 1w ago' },
  { name: 'notes', kind: 'folder' },
  { name: 'meeting-minutes.md', kind: 'doc', meta: '8 KB · 1d ago' },
  { name: 'archive', kind: 'folder' },
];

// Results view shown after committing `find proposal` — matches
// pulled from folders outside the current one, which is the whole
// point of recursive find.
const FIND_ROWS: Row[] = [
  { name: 'Q2 proposal.pdf', kind: 'doc', meta: '1.8 MB · ~/Projects/outbound' },
  { name: 'proposal-draft.md', kind: 'doc', meta: '14 KB · ~/Projects/ideas' },
  { name: 'proposal-template.docx', kind: 'doc', meta: '84 KB · recents' },
];

function glyph(kind: Row['kind']): string {
  switch (kind) {
    case 'folder':
      return '▸';
    case 'image':
      return '▨';
    case 'doc':
      return '▤';
    default:
      return '◦';
  }
}

type ScriptStep =
  | { kind: 'wait'; ms: number }
  | { kind: 'openChip' }
  | { kind: 'closeChip' }
  | { kind: 'type'; text: string; pace?: number }
  | { kind: 'completions'; items: Completion[]; cursor?: number }
  | { kind: 'cursor'; idx: number }
  | { kind: 'commit' }
  | { kind: 'navigate'; path: string; rows: Row[] }
  | { kind: 'highlight'; idx: number }
  | { kind: 'clearHighlight' }
  | { kind: 'toast'; msg: string }
  | { kind: 'clearToast' };

const SCRIPT: ScriptStep[] = [
  { kind: 'wait', ms: 700 },

  // ── Scene 1: Navigate to Documents ────────────────────────────────
  { kind: 'openChip' },
  { kind: 'type', text: 'goto', pace: 95 },
  {
    kind: 'completions',
    cursor: 0,
    items: [
      { label: 'Documents', detail: '~/Documents', chord: 'gd' },
      { label: 'Downloads', detail: '~/Downloads' },
      { label: 'Desktop', detail: '~/Desktop' },
    ],
  },
  { kind: 'wait', ms: 900 },
  { kind: 'commit' },
  { kind: 'closeChip' },
  { kind: 'navigate', path: '~/Documents', rows: DOCS_ROWS },
  { kind: 'wait', ms: 1500 },

  // ── Scene 2: Find "proposal" across folders ───────────────────────
  // Nothing matching is visible in the current folder — which is
  // exactly the moment recursive Find pays off.
  { kind: 'openChip' },
  { kind: 'type', text: 'find proposal', pace: 85 },
  {
    kind: 'completions',
    cursor: 0,
    items: [
      { label: 'Q2 proposal.pdf', detail: '~/Projects/outbound · 2d ago' },
      { label: 'proposal-draft.md', detail: '~/Projects/ideas · 5d ago' },
      { label: 'proposal-template.docx', detail: 'recents' },
    ],
  },
  { kind: 'wait', ms: 900 },
  { kind: 'commit' },
  { kind: 'closeChip' },
  { kind: 'navigate', path: 'find: proposal', rows: FIND_ROWS },
  { kind: 'highlight', idx: 0 },
  { kind: 'wait', ms: 1400 },

  // ── Scene 3: Copy the highlighted row to Desktop ──────────────────
  { kind: 'openChip' },
  { kind: 'type', text: 'copy', pace: 95 },
  {
    kind: 'completions',
    cursor: 0,
    items: [
      { label: '~/Desktop', detail: 'in this folder' },
      { label: '~/Projects/active', detail: 'bookmark · p' },
      { label: '~/Downloads', detail: 'recent' },
    ],
  },
  { kind: 'wait', ms: 900 },
  { kind: 'commit' },
  { kind: 'closeChip' },
  { kind: 'toast', msg: 'copied to ~/Desktop' },
  { kind: 'wait', ms: 1500 },
  { kind: 'clearToast' },
  { kind: 'clearHighlight' },

  // Reset for loop
  { kind: 'navigate', path: '~', rows: HOME_ROWS },
  { kind: 'wait', ms: 900 },
];

export function WelcomeDemo() {
  const [path, setPath] = useState<string>('~');
  const [rows, setRows] = useState<Row[]>(HOME_ROWS);
  const [chipOpen, setChipOpen] = useState(false);
  const [input, setInput] = useState('');
  const [completions, setCompletions] = useState<Completion[]>([]);
  const [cursor, setCursor] = useState(0);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const id = window.setTimeout(resolve, ms);
        // If cancelled, clear early so the loop doesn't keep running
        // tasks after unmount.
        const cancelCheck = window.setInterval(() => {
          if (cancelled) {
            window.clearTimeout(id);
            window.clearInterval(cancelCheck);
            resolve();
          }
        }, 80);
      });

    async function typeText(text: string, pace: number) {
      setInput('');
      for (let i = 0; i < text.length; i++) {
        if (cancelled) return;
        await sleep(pace);
        if (cancelled) return;
        setInput(text.slice(0, i + 1));
      }
    }

    async function run() {
      while (!cancelled) {
        for (const step of SCRIPT) {
          if (cancelled) return;
          switch (step.kind) {
            case 'wait':
              await sleep(step.ms);
              break;
            case 'openChip':
              setChipOpen(true);
              setInput('');
              setCompletions([]);
              setCursor(0);
              break;
            case 'closeChip':
              setChipOpen(false);
              setCompletions([]);
              setInput('');
              break;
            case 'type':
              await typeText(step.text, step.pace ?? 100);
              break;
            case 'completions':
              setCompletions(step.items);
              setCursor(step.cursor ?? 0);
              break;
            case 'cursor':
              setCursor(step.idx);
              break;
            case 'commit':
              setCommitting(true);
              await sleep(160);
              setCommitting(false);
              break;
            case 'navigate':
              setPath(step.path);
              setRows(step.rows);
              break;
            case 'highlight':
              setHighlight(step.idx);
              break;
            case 'clearHighlight':
              setHighlight(null);
              break;
            case 'toast':
              setToast(step.msg);
              break;
            case 'clearToast':
              setToast(null);
              break;
          }
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="demo" aria-hidden>
      <div className="demo__pathbar">
        <span className="demo__path">{path}</span>
      </div>

      <ul className="demo__rows">
        {rows.map((r, i) => (
          <li
            key={r.name}
            className={'demo__row' + (highlight === i ? ' demo__row--hl' : '')}
          >
            <span className="demo__glyph" data-kind={r.kind}>
              {glyph(r.kind)}
            </span>
            <span className="demo__name">{r.name}</span>
            {r.meta && <span className="demo__meta">{r.meta}</span>}
          </li>
        ))}
      </ul>

      {chipOpen && (
        <div className={'demo__chip' + (committing ? ' demo__chip--commit' : '')}>
          <div className="demo__chip-input">
            <span className="demo__chip-prompt">›</span>
            <span className="demo__chip-text">{input}</span>
            <span className="demo__chip-caret" />
          </div>
          {completions.length > 0 && (
            <ul className="demo__chip-completions">
              {completions.map((c, i) => (
                <li
                  key={c.label}
                  className={
                    'demo__chip-completion' +
                    (i === cursor ? ' demo__chip-completion--active' : '')
                  }
                >
                  <span className="demo__chip-label">{c.label}</span>
                  {c.detail && (
                    <span className="demo__chip-detail">{c.detail}</span>
                  )}
                  {c.chord && (
                    <span className="demo__chip-chord">{c.chord}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {toast && <div className="demo__toast">{toast}</div>}
    </div>
  );
}
