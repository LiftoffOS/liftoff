// Trigger every scroll-reveal (once:true) to its final state, then freeze looping/in-flight CSS
// animation + transition so a screenshot is a stable frame. Returns mask rects for the JS typewriters.
export async function normalize(page) {
  await page.evaluate(async () => {
    // 1. Walk the whole scroll height so every IntersectionObserver reveal fires -> .visible (final).
    const H = document.body.scrollHeight
    for (let y = 0; y <= H; y += 400) { window.scrollTo(0, y); await new Promise(r => requestAnimationFrame(r)) }
    window.scrollTo(0, 0)
    await new Promise(r => setTimeout(r, 400))
    // 2. Freeze CSS animations/transitions at base state (loops -> resting; blink -> visible).
    const s = document.createElement('style')
    s.textContent = `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;}`
    document.head.appendChild(s)
  })
  // 3. Mask rects for JS-driven text animations (typewriters) that CSS-freeze can't stop.
  return page.evaluate(() =>
    ['.team-builder-input__animated-placeholder', '.lf-caret', '[class*="animated-text"]', '[class*="TypingText"]']
      .flatMap(sel => [...document.querySelectorAll(sel)])
      .map(el => el.getBoundingClientRect())
      .filter(r => r.width && r.height)
      .map(r => ({ x: Math.floor(r.x), y: Math.floor(r.y), w: Math.ceil(r.width), h: Math.ceil(r.height) })))
}
