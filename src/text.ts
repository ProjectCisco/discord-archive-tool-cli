// "1 message", "2 messages". Pass `many` when adding an "s" isn't right.
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
