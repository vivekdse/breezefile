// fm-h8g7 — type surface for notify-settings.mjs (runtime is plain ESM).

export type TaskNotifyVerbosity = 'all' | 'failures' | 'off';

export function setTaskNotifyVerbosity(v: TaskNotifyVerbosity): void;
export function getTaskNotifyVerbosity(): TaskNotifyVerbosity;
export function shouldNotifyFailure(): boolean;
export function shouldNotifySuccess(): boolean;
export function shouldNotifyTransition(): boolean;
