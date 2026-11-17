import { useEffect, useRef } from 'react'
import './WaveBackground.css'

export default function WaveBackground() {
  const groupRef = useRef<SVGGElement>(null)
  const animationRef = useRef<number>(null)

  useEffect(() => {
    const lineCount = 50
    const baseY = 400
    const spread = 60

    const generatePaths = (time: number) => {
      const paths: { d: string; opacity: number }[] = []
      const t = time * 0.001 // Faster time factor

      for (let i = 0; i < lineCount; i++) {
        const progress = i / (lineCount - 1)
        const yOffset = (progress - 0.5) * spread * 2

        // Animated amplitudes
        const amp1 = 80 + Math.sin(progress * Math.PI + t) * 40
        const amp2 = 70 + Math.cos(progress * Math.PI * 0.7 + t * 0.8) * 30
        const amp3 = 60 + Math.sin(progress * Math.PI * 1.3 + t * 1.2) * 35

        // Animated phase creates flowing effect
        const phase = progress * 150 + Math.sin(t + progress * 2) * 30

        const y = baseY + yOffset

        // Animated control points
        const wave1 = Math.sin(t * 1.1 + progress * 3) * 50
        const wave2 = Math.cos(t * 0.9 + progress * 2.5) * 40
        const wave3 = Math.sin(t * 1.3 + progress * 2) * 45
        const wave4 = Math.cos(t * 0.7 + progress * 3.5) * 35
        const wave5 = Math.sin(t * 1.0 + progress * 2.8) * 40

        const d = `M-100,${y + wave1 * 0.3}
          C${100 + phase},${y + amp1 * Math.sin(progress * Math.PI * 2) + wave1}
           ${300 - phase * 0.5},${y - amp2 * Math.sin(progress * Math.PI * 2 + 0.5) + wave2}
           500,${y + wave2 * 0.5}
          S${700 + phase * 0.3},${y + amp3 * Math.sin(progress * Math.PI * 2 + 1) + wave3}
           900,${y + wave3 * 0.3}
          S${1100 - phase * 0.4},${y - amp1 * Math.sin(progress * Math.PI * 2 + 1.5) + wave4}
           1300,${y + wave4 * 0.4}
          S${1500 + phase * 0.2},${y + amp2 * Math.sin(progress * Math.PI * 2 + 2) + wave5}
           1700,${y + wave5 * 0.3}`

        const edgeFade = Math.sin(progress * Math.PI)
        const opacity = (0.15 + edgeFade * 0.35) * 0.5

        paths.push({ d, opacity })
      }

      return paths
    }

    const animate = (time: number) => {
      if (!groupRef.current) return

      const paths = generatePaths(time)
      const pathElements = groupRef.current.querySelectorAll('path')

      pathElements.forEach((el, i) => {
        if (paths[i]) {
          el.setAttribute('d', paths[i].d)
        }
      })

      animationRef.current = requestAnimationFrame(animate)
    }

    // Initial render
    if (groupRef.current) {
      const initialPaths = generatePaths(0)
      groupRef.current.innerHTML = initialPaths
        .map(
          (p) =>
            `<path d="${p.d}" stroke="rgba(140, 140, 140, 1)" stroke-width="0.8" stroke-opacity="${p.opacity}" fill="none" class="wave-line" />`
        )
        .join('')
    }

    animationRef.current = requestAnimationFrame(animate)

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [])

  return (
    <div className="wave-background">
      <svg
        className="wave-svg"
        viewBox="0 0 1440 800"
        preserveAspectRatio="xMidYMid slice"
        xmlns="http://www.w3.org/2000/svg"
      >
        <g ref={groupRef} className="wave-group" />
      </svg>
    </div>
  )
}
