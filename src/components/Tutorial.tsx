/*
 * Tutorial — interactive walkthrough.
 *
 * Two intro steps frame the app (you can click like Finder, but the win
 * is keyboard verbs), then five action steps drive the user through a
 * concrete sequence: open Documents, create a folder, open it, create
 * a file, copy it, paste somewhere else. Each action step watches store
 * state and advances only when the user actually performs the action.
 *
 * Manual steps (the intros) advance via a Next button. Auto steps
 * advance via state observation, with a brief celebratory flash.
 *
 * Visual treatment mirrors the TipsChip — bottom-right, accent border.
 */

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import './Tutorial.css';

const STEP_KEY = 'fm.tutorial.step';
const DONE_KEY = 'fm.tutorial.done';
const FLASH_MS = 1300;

type StepId =
  | 'intro'
  | 'gotoTargetFolder'
  | 'createFolder'
  | 'openFolder'
  | 'createFile'
  | 'copyFile'
  | 'pasteElsewhere';

interface StepCtx {
  target: string; // folder to nav to in step 1 — resolved dynamically
}

interface Step {
  id: StepId;
  title: string | ((ctx: StepCtx) => string);
  body: React.ReactNode | ((ctx: StepCtx) => React.ReactNode);
  done: string | ((ctx: StepCtx) => string);
  // Manual steps don't watch state — they show a Next button instead.
  manual?: boolean;
}

const STEPS: Step[] = [
  {
    id: 'intro',
    title: 'Welcome — two ways to drive',
    body: (
      <>
        You can click around like Finder, and that always works. But the
        real win is the keyboard: press <em>any letter</em> to open the
        verb prompt — <kbd>copy</kbd>, <kbd>move</kbd>, <kbd>sort</kbd>,{' '}
        <kbd>theme</kbd>, <kbd>find</kbd> — type to act. This walkthrough
        will get you fluent in a minute.
      </>
    ),
    done: '',
    manual: true,
  },
  {
    id: 'gotoTargetFolder',
    title: (ctx) => `Step 1 — Open ${ctx.target}`,
    body: (ctx) => (
      <>
        Type <kbd>{ctx.target.toLowerCase()}</kbd> and press{' '}
        <kbd>Enter</kbd>. The chip ranks current-folder + subfolders +
        recents above Spotlight, so any folder name works — try your
        project names later.
      </>
    ),
    done: (ctx) => `In ${ctx.target} — nice keystroke.`,
  },
  {
    id: 'createFolder',
    title: 'Step 2 — Make a practice folder',
    body: (
      <>
        Type <kbd>create</kbd>, pick <em>Folder</em>, name it anything
        (e.g. <kbd>Breeze Practice</kbd>).
      </>
    ),
    done: 'Folder created.',
  },
  {
    id: 'openFolder',
    title: 'Step 3 — Open the new folder',
    body: (
      <>
        Press <kbd>Enter</kbd> on the folder you just made (or
        double-click).
      </>
    ),
    done: 'Inside the folder.',
  },
  {
    id: 'createFile',
    title: 'Step 4 — Drop a file in',
    body: (
      <>
        Type <kbd>create</kbd>, pick <em>File</em>, name it anything —
        <kbd>hello.txt</kbd> works.
      </>
    ),
    done: 'File created.',
  },
  {
    id: 'copyFile',
    title: 'Step 5 — Copy the file',
    body: (
      <>
        Press <kbd>space</kbd> to mark it, then type <kbd>copy</kbd> and
        pick a destination outside this folder.
      </>
    ),
    done: 'Copy staged.',
  },
  {
    id: 'pasteElsewhere',
    title: 'Step 6 — Paste it',
    body: (
      <>
        Drill into the destination if you aren't there yet, then type{' '}
        <kbd>ph</kbd> (paste here) or click the floating chip.
      </>
    ),
    done: "You're set. Drag rows out to Slack or Gmail next.",
  },
];

function readStep(): number {
  try {
    const raw = localStorage.getItem(STEP_KEY);
    const n = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(n) && n >= 0 && n < STEPS.length ? n : 0;
  } catch {
    return 0;
  }
}

function writeStep(n: number) {
  try {
    localStorage.setItem(STEP_KEY, String(n));
  } catch {
    /* noop */
  }
}

export function isTutorialDone(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) === '1';
  } catch {
    return false;
  }
}

export function resetTutorial(): void {
  try {
    localStorage.removeItem(STEP_KEY);
    localStorage.removeItem(DONE_KEY);
  } catch {
    /* noop */
  }
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

interface TutorialProps {
  onClose: () => void;
}

export function Tutorial({ onClose }: TutorialProps) {
  const { state, activeTab } = useStore();
  const [stepIndex, setStepIndex] = useState<number>(() => readStep());
  const [flash, setFlash] = useState<string | null>(null);

  const cwd = activeTab ? activeTab.trail[activeTab.trail.length - 1] : '';
  const entryCount = (state.entriesByPath[cwd] ?? []).length;
  const yankCount = state.yank.length;

  // Mirror live values into refs so the timer-fired advance() reads the
  // current cwd/entryCount/yank rather than a stale closure snapshot.
  const cwdRef = useRef(cwd);
  const entryCountRef = useRef(entryCount);
  const yankCountRef = useRef(yankCount);
  const stepIndexRef = useRef(stepIndex);
  useEffect(() => { cwdRef.current = cwd; }, [cwd]);
  useEffect(() => { entryCountRef.current = entryCount; }, [entryCount]);
  useEffect(() => { yankCountRef.current = yankCount; }, [yankCount]);
  useEffect(() => { stepIndexRef.current = stepIndex; }, [stepIndex]);

  // Per-step baselines for transition triggers (count grew, yank
  // cleared). Indexed by cwd path so revisiting earlier folders still
  // works.
  const baseline = useRef<{
    cwd: string;
    entryCountByPath: Record<string, number>;
    yankCount: number;
  }>({
    cwd,
    entryCountByPath: { [cwd]: entryCount },
    yankCount,
  });

  // Pending advance timer — kept in a ref so re-renders during the
  // flash don't accidentally cancel it via effect cleanup. (The earlier
  // bug: `return () => clearTimeout(t)` on the trigger effect cleared
  // the timer the moment setFlash re-rendered the component.)
  const advanceTimer = useRef<number | null>(null);

  useEffect(() => {
    document.body.classList.add('tutorial-active');
    return () => {
      document.body.classList.remove('tutorial-active');
      if (advanceTimer.current) window.clearTimeout(advanceTimer.current);
    };
  }, []);

  function captureBaseline() {
    const c = cwdRef.current;
    baseline.current = {
      cwd: c,
      entryCountByPath: {
        ...baseline.current.entryCountByPath,
        [c]: entryCountRef.current,
      },
      yankCount: yankCountRef.current,
    };
  }

  function advance() {
    const next = stepIndexRef.current + 1;
    if (next >= STEPS.length) {
      try {
        localStorage.setItem(DONE_KEY, '1');
      } catch {
        /* noop */
      }
      onClose();
      return;
    }
    writeStep(next);
    setStepIndex(next);
    setFlash(null);
    captureBaseline();
  }

  // Refresh entry-count baseline on first sight of a new cwd so a
  // "count grew" check fires only against entries added after we
  // landed here.
  useEffect(() => {
    if (!(cwd in baseline.current.entryCountByPath)) {
      baseline.current.entryCountByPath[cwd] = entryCount;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  const step = STEPS[stepIndex];

  // Pick the goto target based on where the user is when step 1 starts.
  // If they're already in Documents, ask them to go to Downloads instead
  // — otherwise the step would auto-complete and feel like cheating.
  // Resolved against the baseline cwd captured when the prior step
  // advanced (or the initial mount cwd for step 1 itself).
  const stepCtx: StepCtx = {
    target: basename(baseline.current.cwd).toLowerCase() === 'documents'
      ? 'Downloads'
      : 'Documents',
  };

  function resolve<T>(v: T | ((c: StepCtx) => T)): T {
    return typeof v === 'function' ? (v as (c: StepCtx) => T)(stepCtx) : v;
  }

  // Auto-step completion detection.
  useEffect(() => {
    if (flash) return;
    if (step.manual) return;
    let triggered = false;

    if (step.id === 'gotoTargetFolder') {
      if (basename(cwd).toLowerCase() === stepCtx.target.toLowerCase()) {
        triggered = true;
      }
    } else if (step.id === 'createFolder') {
      const baseCount = baseline.current.entryCountByPath[cwd] ?? entryCount;
      if (entryCount > baseCount) triggered = true;
    } else if (step.id === 'openFolder') {
      if (cwd && cwd !== baseline.current.cwd) triggered = true;
    } else if (step.id === 'createFile') {
      const baseCount = baseline.current.entryCountByPath[cwd] ?? entryCount;
      if (entryCount > baseCount) triggered = true;
    } else if (step.id === 'copyFile') {
      if (yankCount > baseline.current.yankCount) triggered = true;
    } else if (step.id === 'pasteElsewhere') {
      if (baseline.current.yankCount > 0 && yankCount === 0) {
        triggered = true;
      } else if (yankCount > baseline.current.yankCount) {
        baseline.current.yankCount = yankCount;
      }
    }

    if (triggered) {
      setFlash(resolve(step.done));
      if (advanceTimer.current) window.clearTimeout(advanceTimer.current);
      advanceTimer.current = window.setTimeout(() => {
        advanceTimer.current = null;
        advance();
      }, FLASH_MS);
    }
    // We deliberately don't return a cleanup that clears the timer:
    // the timer must outlive the re-render caused by setFlash.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, flash, cwd, entryCount, yankCount]);

  function manualNext() {
    advance();
  }

  function skipStep() {
    advance();
  }

  function endTour() {
    if (advanceTimer.current) window.clearTimeout(advanceTimer.current);
    try {
      localStorage.setItem(DONE_KEY, '1');
    } catch {
      /* noop */
    }
    onClose();
  }

  return (
    <aside
      className="tutorial-chip"
      role="status"
      aria-live="polite"
      aria-label={`Tutorial — ${resolve(step.title)}`}
    >
      <div className="tutorial-chip__head">
        <span className="tutorial-chip__eyebrow">
          Tutorial · {stepIndex + 1} / {STEPS.length}
        </span>
        <button
          type="button"
          className="tutorial-chip__close"
          onClick={endTour}
          aria-label="End tutorial"
          title="End tutorial"
        >
          ×
        </button>
      </div>

      {flash ? (
        <div className="tutorial-chip__flash">
          <span className="tutorial-chip__flash-burst" aria-hidden>
            ✦
          </span>
          <span className="tutorial-chip__flash-text">{flash}</span>
        </div>
      ) : (
        <>
          <div className="tutorial-chip__title">{resolve(step.title)}</div>
          <div className="tutorial-chip__body">{resolve(step.body)}</div>
          <div className="tutorial-chip__actions">
            {step.manual ? (
              <button
                type="button"
                className="tutorial-chip__next"
                onClick={manualNext}
                autoFocus
              >
                Got it — let's go →
              </button>
            ) : (
              <button
                type="button"
                className="tutorial-chip__skip"
                onClick={skipStep}
              >
                Skip step
              </button>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
