/** "a-very-long-account-name.near" → "a-very-lo…name.near"; 64-hex implicit ids → "16f9aa…22ee". */
export function shortAccount(id: string, max = 22): string {
  if (id.length <= max) return id;
  if (/^[0-9a-f]{64}$/.test(id)) return `${id.slice(0, 6)}…${id.slice(-4)}`;
  const keep = Math.floor((max - 1) / 2);
  return `${id.slice(0, keep)}…${id.slice(-keep)}`;
}
