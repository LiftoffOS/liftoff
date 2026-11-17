const formatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
})

/** Format cents as USD currency string (e.g., 150000 -> "$1,500.00") */
export function formatCurrency(cents: number): string {
  return formatter.format(cents / 100)
}

/** Format dollars as USD currency string with 2-decimal rounding (e.g., 89.5 -> "$89.50") */
export function formatUsd(dollars: number): string {
  return formatter.format(dollars)
}
