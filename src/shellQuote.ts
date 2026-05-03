// fm-zf3m — POSIX shell quoting helper, shared by anywhere we hand a
// path to the user as something they'll paste into a shell. If the path
// is plain (only safe characters), we leave it bare so it reads as a
// normal path; otherwise we single-quote it with the standard '\'' dance.

export function shellQuote(p: string): string {
  if (/^[A-Za-z0-9_./~:@+\-,=]+$/.test(p)) return p;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}
