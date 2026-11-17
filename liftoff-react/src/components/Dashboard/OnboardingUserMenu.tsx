// User menu shown at the bottom-left of /onboarding.
//
// Reuses the Sidebar's user-menu visual chrome (avatar + popover) but with a
// trimmed item set appropriate for a user who hasn't finished setting up:
// workspace switcher, Help, Sign Out.  No Settings — the user can't fully
// configure a workspace until onboarding is complete.
//
// Workspace switcher routing:
//   * target tenant has onboardingCompletedAt    → switch + navigate /dashboard
//   * target tenant is still onboarding          → switch + stay on /onboarding
//
// This is the "if they go to a workspace that has done onboarding already,
// they should get the full experience" behavior; the dashboard's own routing
// gate (forthcoming) handles the inverse case.
import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router'
import { useAuth } from '../../contexts/AuthContext'
import { useAvatarImage } from '../../hooks/useAvatarImage'
import { displayIdentity } from '../../lib/displayIdentity'
import PersonIcon from '../../assets/icons/person.svg?react'
import CheckIcon from '../../assets/icons/check.svg?react'
import LogoutIcon from '../../assets/icons/logout.svg?react'
import { getInitialsFromName } from '../../utils/avatar'
import './OnboardingUserMenu.css'
import './Sidebar.css' // reuses .sidebar__user / .sidebar__user-menu styles

export default function OnboardingUserMenu() {
  const navigate = useNavigate()
  const { user, account, signOut, tenants, currentTenant, switchTenant } = useAuth()
  const [showMenu, setShowMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close on outside click + ESC
  useEffect(() => {
    if (!showMenu) return
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false)
      }
    }
    function handleEscape(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') setShowMenu(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [showMenu])

  const handleMenuKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('button')
    if (!items || items.length === 0) return
    const idx = Array.from(items).findIndex((el) => el === document.activeElement)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      items[(idx + 1) % items.length].focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      items[(idx - 1 + items.length) % items.length].focus()
    }
  }, [])

  const handleSwitchTenant = (tenantId: string) => {
    const target = tenants.find((t) => t.id === tenantId)
    setShowMenu(false)
    if (tenantId === currentTenant?.id) return
    switchTenant(tenantId)
    // Onboarded target → full dashboard. Otherwise stay on this same route so
    // the user can keep onboarding the new tenant from where it left off.
    if (target?.onboardingCompletedAt) {
      navigate('/dashboard')
    }
  }

  const handleSignOut = async () => {
    setShowMenu(false)
    await signOut()
    navigate('/login')
  }

  // Same single resolved identity as the sidebar: under a support delegation
  // session this is the CUSTOMER, with no fallback to the operator.
  const identity = displayIdentity(account, user)
  const displayName = identity.name
  const initials = getInitialsFromName(identity.fullName)
  // A photo that will not load falls through to those initials rather than
  // leaving the circle empty.
  const photo = useAvatarImage(identity.avatarUrl)

  // Workspace switcher entries.  Filter out self-owned personal workspace for
  // invitation-only users (mirrors Sidebar.tsx logic) so the switcher matches
  // the rest of the product.
  const visibleTenants = account?.accessReason === 'invitation'
    ? tenants.filter((t) => t.accountId !== account?.id)
    : tenants

  return (
    <div className="onboarding-user-menu" ref={menuRef}>
      <button
        type="button"
        className="sidebar__user"
        onClick={() => setShowMenu((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={showMenu}
      >
        {photo.src ? (
          <img src={photo.src} alt="" className="sidebar__avatar sidebar__avatar--image" onError={photo.onError} />
        ) : initials ? (
          <div className="sidebar__avatar">{initials}</div>
        ) : (
          <div className="sidebar__avatar sidebar__avatar--icon">
            <PersonIcon width="16" height="16" />
          </div>
        )}
        <div className="sidebar__user-info">
          <span className="sidebar__user-name">{displayName}</span>
          <span className="sidebar__user-role">{identity.email}</span>
        </div>
      </button>

      {showMenu && (
        <div className="sidebar__user-menu" role="menu" tabIndex={-1} onKeyDown={handleMenuKeyDown}>
          {visibleTenants.length > 1 && (
            <>
              <div className="sidebar__menu-divider" />
              <div className="sidebar__menu-label">Switch to...</div>
              {visibleTenants.map((tenant) => (
                <button
                  key={tenant.id}
                  role="menuitemradio"
                  aria-checked={tenant.id === currentTenant?.id}
                  onClick={() => handleSwitchTenant(tenant.id)}
                  className={tenant.id === currentTenant?.id ? 'sidebar__menu-item--active' : ''}
                >
                  {tenant.id === currentTenant?.id && <CheckIcon width="16" height="16" />}
                  {tenant.name}
                </button>
              ))}
            </>
          )}

          <div className="sidebar__menu-divider" />
          <button role="menuitem" onClick={handleSignOut}>
            <span className="sidebar__icon">
              <LogoutIcon width="16" height="16" />
            </span>
            Sign Out
          </button>
        </div>
      )}
    </div>
  )
}
