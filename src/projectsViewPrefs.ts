// task-6255239581b2 — Projects-page view preferences.
//
// One knob today: whether the Atlas grid reveals idle/quiet projects (the
// "Show all projects (N hidden)" toggle) or keeps them below the fold. Persisted
// in localStorage as a small self-contained pref (like sideBySidePrefs / the
// fm.* flags) rather than threaded through the core reducer — it's a local UI
// preference scoped to this one page.

const KEY = 'fm.projectsView.v1';

export type ProjectsViewPrefs = {
  /** Reveal hidden idle/quiet projects in the grid. */
  showAll: boolean;
};

const DEFAULTS: ProjectsViewPrefs = {
  showAll: false,
};

export function loadProjectsViewPrefs(): ProjectsViewPrefs {
  if (typeof localStorage === 'undefined') return { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<ProjectsViewPrefs>;
    return {
      showAll:
        typeof parsed.showAll === 'boolean' ? parsed.showAll : DEFAULTS.showAll,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveProjectsViewPrefs(prefs: ProjectsViewPrefs): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ showAll: !!prefs.showAll }));
  } catch {
    /* ignore quota / unavailable storage */
  }
}
