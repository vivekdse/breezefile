// task-6255239581b2 / task-2c5448be520a — Projects-page view preferences.
//
// Two knobs today, both small self-contained localStorage prefs (like
// sideBySidePrefs / the fm.* flags) rather than threaded through the core
// reducer — they're local UI preferences scoped to this one page:
//   showAll       reveal hidden idle/quiet projects (the "Show all" toggle).
//   showArchived  include ARCHIVED projects (the "Show archived" toggle); off by
//                 default, mirroring the server which omits them from the list.

const KEY = 'fm.projectsView.v1';

export type ProjectsViewPrefs = {
  /** Reveal hidden idle/quiet projects in the list. */
  showAll: boolean;
  /** Include archived projects (off by default — the server hides them too). */
  showArchived: boolean;
};

const DEFAULTS: ProjectsViewPrefs = {
  showAll: false,
  showArchived: false,
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
      showArchived:
        typeof parsed.showArchived === 'boolean'
          ? parsed.showArchived
          : DEFAULTS.showArchived,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveProjectsViewPrefs(prefs: ProjectsViewPrefs): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        showAll: !!prefs.showAll,
        showArchived: !!prefs.showArchived,
      }),
    );
  } catch {
    /* ignore quota / unavailable storage */
  }
}
