// Deterministic gradient avatar for members without avatar_url (ui-guidelines §9).

export const AVATAR_PALETTE_SIZE = 8;

/** FNV-1a 32-bit hash — stable across sessions and platforms. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface AvatarStyle {
  index: number;
  angle: number;
  from: string;
  to: string;
}

export function avatarGradient(name: string): AvatarStyle {
  const h = hashString(name || "?");
  const index = h % AVATAR_PALETTE_SIZE;
  const angle = 100 + ((h >>> 8) % 8) * 20; // 100..240deg
  return { index, angle, from: `var(--avatar-${index}-a)`, to: `var(--avatar-${index}-b)` };
}

/** First visible letter: Latin → uppercase initial; CJK → first character. */
export function avatarInitial(displayName: string, name?: string): string {
  const src = (displayName || name || "?").trim();
  const ch = Array.from(src)[0] ?? "?";
  return ch.toUpperCase();
}
