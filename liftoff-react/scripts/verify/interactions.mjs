// Auto-discover interactive elements + curated flows, so interaction-only UI is actually exercised.
// Each returns a list of {name, apply(page)} states to capture after the default state.
export async function interactionStates(page, viewport) {
  const states = []
  // Auto-discover: menu/dropdown triggers, buttons, inputs, toggles.
  const handles = await page.$$(
    '[aria-haspopup],[aria-expanded],[class*="dropdown"] > button,[class*="menu"] [role="button"],' +
    '.navbar a,.navbar button,button,[role="button"],input,[class*="toggle"],[class*="accordion"] button,summary')
  let i = 0
  for (const h of handles.slice(0, 40)) {
    const label = await page.evaluate(el => (el.getAttribute('aria-label') || el.textContent || el.className || el.tagName).trim().slice(0, 24), h).catch(() => 'el')
    const idx = i++
    states.push({ name: `hover_${idx}_${label.replace(/\W+/g, '_')}`, apply: async () => { await h.hover().catch(() => {}); await new Promise(r => setTimeout(r, 250)) } })
    states.push({ name: `focus_${idx}_${label.replace(/\W+/g, '_')}`, apply: async () => { await h.focus().catch(() => {}); await new Promise(r => setTimeout(r, 150)) } })
  }
  // Curated: mobile hamburger (mobile viewport only).
  if (viewport === 'mobile') states.push({ name: 'mobile_menu', apply: async () => {
    await page.click('[aria-label*="menu" i],[class*="hamburger"],[class*="mobile"] button').catch(() => {})
    await new Promise(r => setTimeout(r, 300))
  } })
  return states
}
