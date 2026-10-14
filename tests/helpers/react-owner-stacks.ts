/**
 * Test setup for jsdom files: turns off React's owner stacks.
 *
 * The React 19 development build creates an Error per element to record where it was
 * rendered, and the UI suite renders the dashboard thousands of times. That was about a
 * quarter of the UI tests' CPU time (BUNNDLY-75). React stops collecting them once the
 * counter below passes its limit, so the counter reads high and ignores React's resets.
 * Only debugging output loses the owner frames; rendering is unchanged.
 */
if ('document' in globalThis) {
  const React = await import('react');
  const internals = (React as unknown as Record<string, Record<string, unknown>>)
    .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  Object.defineProperty(internals, 'recentlyCreatedOwnerStacks', {
    configurable: true,
    get: () => 1e9,
    set: () => {},
  });
}
