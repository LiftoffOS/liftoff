import { useEffect, useRef, useMemo } from 'react'
import './StreamingSparkline.css'

interface StreamingSparklineProps {
  color?: string
  opacity?: number
  speed?: number // pixels per second
  trend?: 'up' | 'down' | 'stable'
  seed?: number // for deterministic data generation
  value?: number // baseline value (0-100 scale), sparkline fluctuates around this
}

// Generate realistic time-series data centered around a value
// For trending data: each point is consistently higher/lower than previous
function generateRealisticData(
  points: number,
  trend: 'up' | 'down' | 'stable',
  seed: number,
  baseValue: number
): number[] {
  const data: number[] = []

  // Simple seeded random for reproducibility
  let s = seed
  const random = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }

  // Calculate fluctuation range based on how close to edges
  const roomAbove = 100 - baseValue
  const roomBelow = baseValue
  const maxFluctuation = Math.min(roomAbove, roomBelow, 12)

  // For trending data, we create a sawtooth pattern that always goes in one direction
  // then resets smoothly, giving the illusion of continuous upward/downward motion
  const cycleLength = 80 // points per cycle
  const trendAmplitude = maxFluctuation * 0.6

  for (let i = 0; i < points; i++) {
    // Sawtooth for consistent directional movement
    const cycleProgress = (i % cycleLength) / cycleLength

    let trendOffset = 0
    if (trend === 'up') {
      // Always rising within each cycle
      trendOffset = (cycleProgress - 0.5) * trendAmplitude * 2
    } else if (trend === 'down') {
      // Always falling within each cycle
      trendOffset = (0.5 - cycleProgress) * trendAmplitude * 2
    }

    // Smaller waves that don't override the trend direction
    const waveScale = maxFluctuation * 0.15
    const wave1 = Math.sin(i * 0.08 + seed * 0.01) * waveScale
    const wave2 = Math.sin(i * 0.03 + seed * 0.02) * waveScale * 0.7

    // Tiny noise
    const noise = (random() - 0.5) * maxFluctuation * 0.1

    const finalValue = baseValue + trendOffset + wave1 + wave2 + noise
    data.push(Math.max(5, Math.min(98, finalValue)))
  }

  return data
}

export default function StreamingSparkline({
  color = '#22c55e',
  opacity = 0.15,
  speed = 30,
  trend = 'stable',
  seed = 12345,
  value = 50
}: StreamingSparklineProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const offsetRef = useRef(0)
  const animationRef = useRef<number | undefined>(undefined)
  const lastTimeRef = useRef(0)

  // Generate a large dataset centered around the value
  const data = useMemo(() => {
    return generateRealisticData(500, trend, seed, value)
  }, [trend, seed, value])

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Parse color once
    const r = parseInt(color.slice(1, 3), 16)
    const g = parseInt(color.slice(3, 5), 16)
    const b = parseInt(color.slice(5, 7), 16)

    const animate = (timestamp: number) => {
      const rect = container.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) {
        animationRef.current = requestAnimationFrame(animate)
        return
      }

      const width = rect.width
      const height = rect.height
      const dpr = window.devicePixelRatio || 1

      // Resize canvas if needed
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr
        canvas.height = height * dpr
        canvas.style.width = `${width}px`
        canvas.style.height = `${height}px`
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      }

      // Calculate delta time and update offset
      const deltaTime = lastTimeRef.current ? (timestamp - lastTimeRef.current) / 1000 : 0
      lastTimeRef.current = timestamp

      offsetRef.current += speed * deltaTime

      // Loop offset when we've scrolled through the data
      const pointSpacing = 8
      const totalDataWidth = data.length * pointSpacing
      if (offsetRef.current > totalDataWidth / 2) {
        offsetRef.current -= totalDataWidth / 2
      }

      // Clear canvas
      ctx.clearRect(0, 0, width, height)

      const scaleY = height / 100
      const offset = offsetRef.current

      // Calculate which data points are visible
      const startIndex = Math.floor(offset / pointSpacing)
      const visiblePoints = Math.ceil(width / pointSpacing) + 2

      // Build points array for visible portion
      const points: { x: number; y: number }[] = []
      for (let i = 0; i < visiblePoints; i++) {
        const dataIndex = (startIndex + i) % data.length
        const x = (i * pointSpacing) - (offset % pointSpacing)
        const y = height - data[dataIndex] * scaleY
        points.push({ x, y })
      }

      if (points.length < 2) {
        animationRef.current = requestAnimationFrame(animate)
        return
      }

      // Draw filled area with smooth cardinal spline
      ctx.beginPath()
      ctx.moveTo(points[0].x, height)
      ctx.lineTo(points[0].x, points[0].y)

      // Cardinal spline interpolation
      const tension = 0.4
      for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[Math.max(0, i - 1)]
        const p1 = points[i]
        const p2 = points[i + 1]
        const p3 = points[Math.min(points.length - 1, i + 2)]

        const cp1x = p1.x + (p2.x - p0.x) * tension
        const cp1y = p1.y + (p2.y - p0.y) * tension
        const cp2x = p2.x - (p3.x - p1.x) * tension
        const cp2y = p2.y - (p3.y - p1.y) * tension

        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y)
      }

      ctx.lineTo(points[points.length - 1].x, height)
      ctx.closePath()

      // Gradient fill
      const gradient = ctx.createLinearGradient(0, 0, 0, height)
      gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${opacity})`)
      gradient.addColorStop(0.6, `rgba(${r}, ${g}, ${b}, ${opacity * 0.4})`)
      gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`)
      ctx.fillStyle = gradient
      ctx.fill()

      // Draw the line on top
      ctx.beginPath()
      ctx.moveTo(points[0].x, points[0].y)

      for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[Math.max(0, i - 1)]
        const p1 = points[i]
        const p2 = points[i + 1]
        const p3 = points[Math.min(points.length - 1, i + 2)]

        const cp1x = p1.x + (p2.x - p0.x) * tension
        const cp1y = p1.y + (p2.y - p0.y) * tension
        const cp2x = p2.x - (p3.x - p1.x) * tension
        const cp2y = p2.y - (p3.y - p1.y) * tension

        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y)
      }

      ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${opacity * 2.5})`
      ctx.lineWidth = 1.5
      ctx.stroke()

      animationRef.current = requestAnimationFrame(animate)
    }

    animationRef.current = requestAnimationFrame(animate)

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [data, color, opacity, speed])

  return (
    <div ref={containerRef} className="streaming-sparkline-container">
      <canvas ref={canvasRef} />
    </div>
  )
}
