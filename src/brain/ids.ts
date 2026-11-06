// Person ids are derived from the name, so the same name finds the same memory.
export function personId(name: string) {
  return (
    name
      .trim()
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'anonymous'
  );
}
