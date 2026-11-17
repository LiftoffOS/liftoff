import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import ChevronDownIcon from '../assets/icons/chevron-down.svg?react'
import SearchIcon from '../assets/icons/search.svg?react'
import StatusBadge from './StatusBadge'
import './Dropdown.css'

export interface DropdownOption {
  value: string
  label: string
  /** Optional StatusBadge rendered after the label in the menu (e.g.
   *  'Recommended'). Menu only: the trigger stays plain text so the closed
   *  control does not carry the badge around, and `label` stays a string so
   *  the width sizer and the search filter keep working. */
  badge?: string
}

interface DropdownProps {
  options: DropdownOption[]
  value: string
  onChange: (value: string) => void
  className?: string
  disabled?: boolean
  searchable?: boolean
  searchPlaceholder?: string
  placeholder?: string
  /** Put on the trigger button so a <label htmlFor> can name it.
   *
   *  A button is a labelable element, so this is the ordinary association and
   *  not an ARIA workaround: 36 call sites had a <label> sitting beside a
   *  Dropdown naming it to a sighted reader and to nobody else. */
  id?: string
}

export function Dropdown({ options, value, onChange, className = '', disabled = false, searchable = false, searchPlaceholder = 'Search...', placeholder, id }: DropdownProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [alignRight, setAlignRight] = useState(false)
  const [search, setSearch] = useState('')
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const typeAheadRef = useRef({ buffer: '', timer: 0 })

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false)
        setSearch('')
        setFocusedIndex(-1)
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  useEffect(() => {
    if (isOpen && searchable && searchRef.current) {
      searchRef.current.focus()
    }
  }, [isOpen, searchable])

  // Scroll focused option into view
  useEffect(() => {
    if (focusedIndex >= 0 && menuRef.current) {
      const items = menuRef.current.querySelectorAll('[role="option"]')
      items[focusedIndex]?.scrollIntoView({ block: 'nearest' })
    }
  }, [focusedIndex])

  const filteredOptions = useMemo(() => {
    if (!search.trim()) return options
    const q = search.toLowerCase()
    return options.filter(opt => opt.label.toLowerCase().includes(q))
  }, [options, search])

  const selectedOption = options.find(opt => opt.value === value)

  const open = useCallback(() => {
    if (disabled) return
    if (!isOpen && dropdownRef.current) {
      const triggerRect = dropdownRef.current.getBoundingClientRect()
      const viewportWidth = window.innerWidth
      const estimatedMenuWidth = 200
      const wouldOverflowRight = triggerRect.left + estimatedMenuWidth > viewportWidth - 16
      setAlignRight(wouldOverflowRight)
    }
    // Set focus to current selection
    const idx = filteredOptions.findIndex(opt => opt.value === value)
    setFocusedIndex(idx >= 0 ? idx : 0)
    setIsOpen(true)
  }, [disabled, isOpen, filteredOptions, value])

  const close = useCallback(() => {
    setIsOpen(false)
    setSearch('')
    setFocusedIndex(-1)
  }, [])

  const select = useCallback((val: string) => {
    onChange(val)
    close()
  }, [onChange, close])

  const handleToggle = () => {
    if (disabled) return
    if (isOpen) {
      close()
    } else {
      open()
    }
  }

  // Type-ahead: cycle through options starting with the pressed letter
  const handleTypeAhead = useCallback((key: string) => {
    const ta = typeAheadRef.current
    clearTimeout(ta.timer)

    // If same key as buffer, cycle to next match; otherwise start new search
    const isSameKey = ta.buffer.length === 1 && ta.buffer === key
    if (isSameKey) {
      ta.buffer = key
    } else {
      ta.buffer += key
    }

    ta.timer = window.setTimeout(() => { ta.buffer = '' }, 500)

    const searchStr = ta.buffer.toLowerCase()
    const opts = filteredOptions

    // Find matches
    const matches = opts
      .map((opt, i) => ({ opt, i }))
      .filter(({ opt }) => opt.label.toLowerCase().startsWith(searchStr))

    if (matches.length === 0) return

    if (isSameKey && matches.length > 1) {
      // Cycle: find the match after the current focused index
      const nextMatch = matches.find(m => m.i > focusedIndex) || matches[0]
      setFocusedIndex(nextMatch.i)
      if (!isOpen) select(nextMatch.opt.value)
    } else {
      setFocusedIndex(matches[0].i)
      if (!isOpen) select(matches[0].opt.value)
    }
  }, [filteredOptions, focusedIndex, isOpen, select])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // If searchable and open, let the search input handle most keys
    if (searchable && isOpen && e.target === searchRef.current) {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
        dropdownRef.current?.querySelector('button')?.focus()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setFocusedIndex(prev => Math.min(prev + 1, filteredOptions.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setFocusedIndex(prev => Math.max(prev - 1, 0))
      } else if (e.key === 'Enter' && focusedIndex >= 0 && focusedIndex < filteredOptions.length) {
        e.preventDefault()
        select(filteredOptions[focusedIndex].value)
        dropdownRef.current?.querySelector('button')?.focus()
      }
      return
    }

    switch (e.key) {
      case 'Enter':
      case ' ':
        e.preventDefault()
        if (!isOpen) {
          open()
        } else if (focusedIndex >= 0 && focusedIndex < filteredOptions.length) {
          select(filteredOptions[focusedIndex].value)
          dropdownRef.current?.querySelector('button')?.focus()
        }
        break
      case 'Escape':
        if (isOpen) {
          e.preventDefault()
          close()
          dropdownRef.current?.querySelector('button')?.focus()
        }
        break
      case 'ArrowDown':
        e.preventDefault()
        if (!isOpen) {
          open()
        } else {
          setFocusedIndex(prev => Math.min(prev + 1, filteredOptions.length - 1))
        }
        break
      case 'ArrowUp':
        e.preventDefault()
        if (!isOpen) {
          open()
        } else {
          setFocusedIndex(prev => Math.max(prev - 1, 0))
        }
        break
      case 'Home':
        if (isOpen) {
          e.preventDefault()
          setFocusedIndex(0)
        }
        break
      case 'End':
        if (isOpen) {
          e.preventDefault()
          setFocusedIndex(filteredOptions.length - 1)
        }
        break
      case 'Tab':
        if (isOpen) close()
        break
      default:
        // Type-ahead for single printable characters
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault()
          handleTypeAhead(e.key)
        }
        break
    }
  }, [isOpen, focusedIndex, filteredOptions, open, close, select, handleTypeAhead, searchable])

  return (
    // The wrapper is not itself a control: it delegates for the two things that
    // can hold focus inside it, the trigger and the search input, which is why
    // the handler cannot simply sit on either one.
    <div
      className={`dropdown ${className}`}
      ref={dropdownRef}
      role="presentation"
      onKeyDown={handleKeyDown}
    >
      <button
        type="button"
        id={id}
        className={`dropdown__trigger ${isOpen ? 'dropdown__trigger--open' : ''}`}
        onClick={handleToggle}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-activedescendant={isOpen && focusedIndex >= 0 ? `dropdown-opt-${focusedIndex}` : undefined}
      >
        <span className="dropdown__trigger-text-wrap">
          <span className="dropdown__trigger-sizer" aria-hidden="true">
            {options.map(opt => (
              <span key={opt.value}>{opt.label}</span>
            ))}
          </span>
          <span className={`dropdown__trigger-text ${!selectedOption && placeholder ? 'dropdown__trigger-text--placeholder' : ''}`}>{selectedOption?.label || placeholder || value}</span>
        </span>
        <ChevronDownIcon className="dropdown__trigger-icon" />
      </button>
      {isOpen && (
        <div
          ref={menuRef}
          className={`dropdown__menu ${alignRight ? 'dropdown__menu--align-right' : ''}`}
          role="listbox"
        >
          {searchable && (
            <div className="dropdown__search">
              <SearchIcon className="dropdown__search-icon" width={14} height={14} />
              <input
                ref={searchRef}
                type="text"
                className="dropdown__search-input"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={searchPlaceholder}
                onClick={e => e.stopPropagation()}
              />
            </div>
          )}
          {filteredOptions.length === 0 ? (
            <div className="dropdown__empty">No results</div>
          ) : (
            filteredOptions.map((option, i) => (
              <button
                key={option.value}
                id={`dropdown-opt-${i}`}
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={`dropdown__option ${option.value === value ? 'dropdown__option--selected' : ''} ${i === focusedIndex ? 'dropdown__option--focused' : ''}`}
                onClick={() => select(option.value)}
                onMouseEnter={() => setFocusedIndex(i)}
              >
                {option.label}
                {option.badge && <StatusBadge variant="neutral">{option.badge}</StatusBadge>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
