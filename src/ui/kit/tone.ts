/**
 * What a colour means (tokens.css): `ok` buy / fill, `danger` sell / error, `warn` hold /
 * retry, `watch` armed / scheduled, `sim` DRY-RUN, `run` in flight, `muted` nothing yet.
 */
export type Tone = 'muted' | 'ok' | 'danger' | 'warn' | 'watch' | 'sim' | 'run';
