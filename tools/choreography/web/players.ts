/** Each dancer's colour, as in the game: blue, purple, green and pink (P1 to P4). */
export const DANCER_COLORS = ['#078fff', '#b86bff', '#1fcf72', '#ff5fb4'] as const;
/** Lighter versions for skeletons, labels and lanes over the dark editor. */
export const DANCER_TINTS = ['#51daf0', '#be9cff', '#6fe3a4', '#ff8fcb'] as const;
export const dancerColor = (playerId: number) => DANCER_COLORS[playerId % DANCER_COLORS.length];
export const dancerTint = (playerId: number) => DANCER_TINTS[playerId % DANCER_TINTS.length];
/** "P1", "P1 and P2", "P1, P2 and P3". */
export const playerList = (ids: readonly number[]) => {
  const names = ids.map(id => `P${id + 1}`);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join('');
};
