/** Turn a formatted currency string back into a number.
 *
 *  Its own module because a file that exports a component AND a helper cannot
 *  be fast-refreshed: editing the component reloads the module, and anything
 *  holding a reference to the helper keeps the old one.
 */
export function parseCurrencyValue(formatted: string): number {
  const num = parseFloat(formatted.replace(/,/g, ''))
  return isNaN(num) ? 0 : Math.round(num * 100) / 100
}
