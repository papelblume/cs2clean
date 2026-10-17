// How many players of a lobby the app looks up. Shared, so that the Steam source (how many players it looks for)
// and the lobby service (how many it asks Leetify about) can't disagree.

/** Only the first this-many players of a lobby, ourselves included, are looked up; the rest are shown as not checked. */
export const MAX_LOOKUPS = 10;

/** Players the user can add by hand at one time. They are looked up on top of the lobby's MAX_LOOKUPS. */
export const MAX_MANUAL = 5;
