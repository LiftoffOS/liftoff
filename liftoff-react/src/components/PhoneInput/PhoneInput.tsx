import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import ChevronDownIcon from '../../assets/icons/chevron-down.svg?react'
import './PhoneInput.css'

interface CountryCode {
  code: string
  dial: string
  flag: string
  name: string
}

const COUNTRY_CODES: CountryCode[] = [
  { code: 'US', dial: '+1', flag: '🇺🇸', name: 'United States' },
  // { code: 'CA', dial: '+1', flag: '🇨🇦', name: 'Canada' },
  // { code: 'GB', dial: '+44', flag: '🇬🇧', name: 'United Kingdom' },
  // { code: 'AU', dial: '+61', flag: '🇦🇺', name: 'Australia' },
  // { code: 'DE', dial: '+49', flag: '🇩🇪', name: 'Germany' },
  // { code: 'FR', dial: '+33', flag: '🇫🇷', name: 'France' },
  // { code: 'JP', dial: '+81', flag: '🇯🇵', name: 'Japan' },
  // { code: 'IN', dial: '+91', flag: '🇮🇳', name: 'India' },
  // { code: 'BR', dial: '+55', flag: '🇧🇷', name: 'Brazil' },
  // { code: 'MX', dial: '+52', flag: '🇲🇽', name: 'Mexico' },
]

const FORMAT_PATTERNS: Record<string, { pattern: string; maxDigits: number; placeholder: string }> = {
  US: { pattern: '(###) ###-####', maxDigits: 10, placeholder: '(555) 555-5555' },
  CA: { pattern: '(###) ###-####', maxDigits: 10, placeholder: '(555) 555-5555' },
  GB: { pattern: '#### ### ####', maxDigits: 11, placeholder: '7911 123 4567' },
  AU: { pattern: '#### ### ###', maxDigits: 10, placeholder: '0412 345 678' },
  DE: { pattern: '#### #######', maxDigits: 11, placeholder: '0170 1234567' },
  FR: { pattern: '## ## ## ## ##', maxDigits: 10, placeholder: '06 12 34 56 78' },
  JP: { pattern: '###-####-####', maxDigits: 11, placeholder: '090-1234-5678' },
  IN: { pattern: '##### #####', maxDigits: 10, placeholder: '98765 43210' },
  BR: { pattern: '(##) #####-####', maxDigits: 11, placeholder: '(11) 98765-4321' },
  MX: { pattern: '(##) ####-####', maxDigits: 10, placeholder: '(55) 1234-5678' },
}

function formatPhone(digits: string, code: string): string {
  const fmt = FORMAT_PATTERNS[code]
  if (!fmt) return digits
  let result = ''
  let di = 0
  for (const ch of fmt.pattern) {
    if (di >= digits.length) break
    if (ch === '#') { result += digits[di]; di++ }
    else result += ch
  }
  return result
}

interface PhoneInputProps {
  value: string
  countryCode: string
  onChange: (phone: string) => void
  onCountryCodeChange: (code: string) => void
  required?: boolean
  /** Goes on the number field, which is the control the label names. The
   *  country-code button beside it is a second control with its own name. */
  id?: string
}

export default function PhoneInput({ value, countryCode, onChange, onCountryCodeChange, required, id }: PhoneInputProps) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const selected = COUNTRY_CODES.find(c => c.code === countryCode) ?? COUNTRY_CODES[0]
  const fmt = FORMAT_PATTERNS[countryCode] ?? FORMAT_PATTERNS.US

  const updatePos = useCallback(() => {
    if (containerRef.current) {
      const r = containerRef.current.getBoundingClientRect()
      setPos({ top: r.bottom + window.scrollY + 4, left: r.left + window.scrollX, width: Math.max(r.width, 240) })
    }
  }, [])

  useEffect(() => {
    if (!open) return
    updatePos()
    window.addEventListener('scroll', updatePos, true)
    window.addEventListener('resize', updatePos)
    return () => { window.removeEventListener('scroll', updatePos, true); window.removeEventListener('resize', updatePos) }
  }, [open, updatePos])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const t = e.target as Node
      if (containerRef.current && !containerRef.current.contains(t) && menuRef.current && !menuRef.current.contains(t)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div className="phone-input" ref={containerRef}>
      <button
        type="button"
        className="phone-input__prefix"
        onClick={() => setOpen(!open)}
        aria-label="Select country code"
        aria-expanded={open}
      >
        <span className="phone-input__flag">{selected.flag}</span>
        <span className="phone-input__dial">{selected.dial}</span>
        <ChevronDownIcon className="dropdown__trigger-icon" style={{ width: 12, height: 12, transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s ease' }} />
      </button>

      <input
        id={id}
        className="phone-input__number"
        type="tel"
        value={formatPhone(value, countryCode)}
        onChange={e => onChange(e.target.value.replace(/\D/g, '').slice(0, fmt.maxDigits))}
        placeholder={fmt.placeholder}
        required={required}
      />

      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="dropdown__menu"
          role="listbox"
          style={{ position: 'absolute', top: pos.top, left: pos.left, width: pos.width, zIndex: 9999 }}
        >
          {COUNTRY_CODES.map(c => (
            <button
              key={c.code}
              type="button"
              className={`dropdown__option ${c.code === countryCode ? 'dropdown__option--selected' : ''}`}
              role="option"
              aria-selected={c.code === countryCode}
              onClick={() => { onCountryCodeChange(c.code); setOpen(false) }}
              style={{ display: 'flex', alignItems: 'center', gap: 8 }}
            >
              <span style={{ fontSize: 18, lineHeight: 1 }}>{c.flag}</span>
              <span style={{ flex: 1 }}>{c.name}</span>
              <span style={{ color: 'var(--color-gray-400)', fontSize: 'var(--text-xs)' }}>{c.dial}</span>
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}
