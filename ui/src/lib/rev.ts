/** Revision letters the way drawing registers run them: A…Z, then AA, AB… (0 is A). */
export const rev = (i: number): string => {
  let n = Math.max(0, Math.floor(i)), s = "";
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
};
