/** Browser replacement for the shell's unused Node createRequire import. */
export function createRequire(): never {
  throw new Error('desktop browser shell: createRequire is unavailable')
}
