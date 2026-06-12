// fm-7909 — the Tasks page was split into src/components/tasks/* (container +
// pure sections/primary-action modules + row/detail/kebab components). This
// file is now a thin re-export so existing importers (App.tsx imports the
// named `TasksPage`) keep working unchanged.
export { TasksPage, default } from './tasks/TasksPage';
