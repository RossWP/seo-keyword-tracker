/** Only same-app paths are allowed as a redirect target after sign-in (no open redirects). */
export function safeReturnTo(value: string | null): string {
  if (!value?.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value;
}
