import type { KeyboardEvent } from 'react'
import { useState, useRef, useEffect, useCallback } from 'react'
import { NavLink, useNavigate } from 'react-router'
import { useAuth } from '../../contexts/AuthContext'
import { useAvatarImage } from '../../hooks/useAvatarImage'
import { displayIdentity } from '../../lib/displayIdentity'
import { usePrefetchConnectors } from '../../hooks/useConnectors'
import { usePendingApprovalCount } from '../../hooks/useOversight'
import { useInsightsUnreadCount } from '../../hooks/useInsightsUnread'
import HomeIcon from '../../assets/icons/home.svg?react'
import PeopleIcon from '../../assets/icons/people.svg?react'
import ActivityIcon from '../../assets/icons/activity.svg?react'
import EyeIcon from '../../assets/icons/eye.svg?react'
import InsightsIcon from '../../assets/icons/insights.svg?react'
import ServerIcon from '../../assets/icons/server.svg?react'
import BookOpenIcon from '../../assets/icons/book-open.svg?react'
import BellIcon from '../../assets/icons/bell.svg?react'
import GearIcon from '../../assets/icons/gear.svg?react'
import ChevronLeftIcon from '../../assets/icons/chevron-left.svg?react'
import ChevronRightIcon from '../../assets/icons/chevron-right.svg?react'
import PersonIcon from '../../assets/icons/person.svg?react'
import CheckIcon from '../../assets/icons/check.svg?react'
import LogoutIcon from '../../assets/icons/logout.svg?react'
import LifeBuoyIcon from '../../assets/icons/life-buoy.svg?react'
import GiftIcon from '../../assets/icons/gift.svg?react'
import RocketIcon from '../../assets/icons/rocket.svg?react'
import LiftoffLogo from '../../assets/logo.svg?react'
import Tooltip from '../Tooltip'
import { track } from '../../lib/analytics'
import { prefetchRoute } from './routePrefetch'
import { getInitialsFromName } from '../../utils/avatar'
import './Sidebar.css'

interface SidebarProps {
  isCollapsed: boolean
  onToggle: () => void
  isMobileOpen?: boolean
  onNavigate?: () => void
}

interface NavItem {
  path: string
  label: string
  icon: string
}

const navItems: NavItem[] = [
  { path: '/dashboard', label: 'Home', icon: 'home' },
  { path: '/dashboard/agents', label: 'Teams', icon: 'teams' },
  { path: '/dashboard/knowledge', label: 'Knowledge', icon: 'knowledge' },
  { path: '/dashboard/oversight', label: 'Oversight', icon: 'oversight' },
  { path: '/dashboard/activity', label: 'Activity', icon: 'activity' },
  { path: '/dashboard/insights', label: 'Insights', icon: 'insights' },
  { path: '/dashboard/connections', label: 'Connections', icon: 'connections' },
]

// The top nav is top-aligned and the footer is pushed down by margin-top:auto,
// so an item appended to navItems lands under the last one, nowhere near the
// bottom. Review belongs against the account button, so it renders in the
// footer instead of the scrolling list above.
const bottomNavItem: NavItem = { path: '/dashboard/review', label: 'Review', icon: 'review' }


const icons: Record<string, React.ReactNode> = {
  home: <HomeIcon />,
  teams: <PeopleIcon />,
  activity: <ActivityIcon />,
  oversight: <EyeIcon />,
  insights: <InsightsIcon />,
  connections: <ServerIcon />,
  knowledge: <BookOpenIcon />,
  review: <BellIcon />,
  settings: <GearIcon />,
}

export default function Sidebar({ isCollapsed, onToggle, isMobileOpen, onNavigate }: SidebarProps) {
  const navigate = useNavigate()
  const { user, account, signOut, tenants, currentTenant, switchTenant } = useAuth()
  const [showUserMenu, setShowUserMenu] = useState(false)
  const userMenuRef = useRef<HTMLDivElement>(null)
  const { data: pendingCounts } = usePendingApprovalCount()
  const hasPendingReviews = (pendingCounts?.total ?? 0) > 0
  // The dot on the Insights icon reads the same count the history modal's row
  // dots read, so the two indicators cannot disagree.
  const { data: insightsUnreadCount } = useInsightsUnreadCount()
  const hasUnreadInsights = (insightsUnreadCount ?? 0) > 0
  const visibleNavItems = navItems
  const prefetchConnectors = usePrefetchConnectors()

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false)
      }
    }
    function handleEscapeKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') {
        setShowUserMenu(false)
      }
    }
    if (showUserMenu) {
      document.addEventListener('mousedown', handleClickOutside)
      document.addEventListener('keydown', handleEscapeKey)
      return () => {
        document.removeEventListener('mousedown', handleClickOutside)
        document.removeEventListener('keydown', handleEscapeKey)
      }
    }
  }, [showUserMenu])

  const handleMenuKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    const menuItems = userMenuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"], button:not([role])')
    if (!menuItems || menuItems.length === 0) return

    const currentIndex = Array.from(menuItems).findIndex(item => item === document.activeElement)

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        if (currentIndex < menuItems.length - 1) {
          menuItems[currentIndex + 1].focus()
        } else {
          menuItems[0].focus()
        }
        break
      case 'ArrowUp':
        e.preventDefault()
        if (currentIndex > 0) {
          menuItems[currentIndex - 1].focus()
        } else {
          menuItems[menuItems.length - 1].focus()
        }
        break
      case 'Home':
        e.preventDefault()
        menuItems[0].focus()
        break
      case 'End':
        e.preventDefault()
        menuItems[menuItems.length - 1].focus()
        break
    }
  }, [])

  const handleUserMenuAction = (path: string) => {
    track('sidebar_nav_clicked', { destination: path })
    setShowUserMenu(false)
    navigate(path)
    onNavigate?.()
  }

  const handleSwitchTenant = (tenantId: string) => {
    switchTenant(tenantId)
    setShowUserMenu(false)
  }

  const handleSignOut = async () => {
    setShowUserMenu(false)
    await signOut()
    navigate('/login')
  }

  // One resolved identity for every surface below. Under a support delegation
  // session this is the CUSTOMER and never falls back to the operator, so the
  // name, the email and the face all describe the same person.
  const identity = displayIdentity(account, user)
  const displayName = identity.name
  // Only use actual names for initials, never email - fall back to icon if no name
  const initials = getInitialsFromName(identity.fullName)
  // A photo that will not load falls through to those initials rather than
  // leaving the circle empty.
  const photo = useAvatarImage(identity.avatarUrl)

  // Shared by both nav groups so the bottom item behaves exactly like the rest:
  // same active state, prefetch, analytics, and collapsed-mode tooltip.
  //
  // `srText` is the dot's text equivalent, appended to the link's accessible
  // name: colour alone reaches neither a screen reader nor a colour-blind
  // reader. A sibling of the label rather than a child, because collapsed mode
  // hides .sidebar__label with display:none and would take the sr text with it.
  function renderNavLink(item: NavItem, hasPending?: boolean, srText?: string) {
    const link = (
      <NavLink
        key={item.path}
        to={item.path}
        end={item.path === '/dashboard'}
        className={({ isActive }) =>
          `sidebar__link ${isActive ? 'sidebar__link--active' : ''}`
        }
        onClick={() => {
          track('sidebar_nav_clicked', { destination: item.path })
          onNavigate?.()
        }}
        onMouseEnter={() => {
          prefetchRoute(item.path)
          if (item.icon === 'connections') prefetchConnectors()
        }}
        onFocus={() => {
          prefetchRoute(item.path)
          if (item.icon === 'connections') prefetchConnectors()
        }}
      >
        <span className="sidebar__icon">
          {icons[item.icon]}
          {hasPending && <span className="sidebar__icon-dot" aria-hidden="true" />}
        </span>
        <span className="sidebar__label">{item.label}</span>
        {hasPending && srText && <span className="sr-only">{srText}</span>}
      </NavLink>
    )
    return isCollapsed ? (
      <Tooltip key={item.path} text={item.label} position="right">
        {link}
      </Tooltip>
    ) : (
      link
    )
  }

  return (
    <aside className={`sidebar ${isCollapsed ? 'sidebar--collapsed' : ''} ${isMobileOpen ? 'sidebar--open' : ''}`}>
      <div className="sidebar__header">
        <a href="/" className="sidebar__logo">
          <RocketIcon className="sidebar__logo-icon" />
          <LiftoffLogo className="sidebar__logo-text" />
        </a>
        <button
          className="sidebar__toggle"
          onClick={onToggle}
          aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {isCollapsed ? <ChevronRightIcon width="16" height="16" /> : <ChevronLeftIcon width="16" height="16" />}
        </button>
      </div>

      <nav className="sidebar__nav">
        {visibleNavItems.map(item =>
          item.path === '/dashboard/insights'
            ? renderNavLink(item, hasUnreadInsights, ', unread replies')
            : renderNavLink(item),
        )}
      </nav>

      <div className="sidebar__footer">
        <nav className="sidebar__nav sidebar__nav--bottom">
          {renderNavLink(bottomNavItem, hasPendingReviews)}
        </nav>

        <div className="sidebar__user-wrapper" ref={userMenuRef}>
          {isCollapsed ? (
            <Tooltip text="Account" position="right">
              <button
                className="sidebar__user"
                onClick={() => {
                  const next = !showUserMenu
                  if (next) {
                    track('user_menu_opened', {})
                    track('tenant_switcher_opened', {})
                  }
                  setShowUserMenu(next)
                }}
              >
                {photo.src ? (
                  <img src={photo.src} alt="" className="sidebar__avatar sidebar__avatar--image" referrerPolicy="no-referrer" onError={photo.onError} />
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
            </Tooltip>
          ) : (
            <button
              className="sidebar__user"
              onClick={() => {
                const next = !showUserMenu
                if (next) {
                  track('user_menu_opened', {})
                  track('tenant_switcher_opened', {})
                }
                setShowUserMenu(next)
              }}
            >
              {photo.src ? (
                <img src={photo.src} alt="" className="sidebar__avatar sidebar__avatar--image" referrerPolicy="no-referrer" onError={photo.onError} />
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
          )}
          {showUserMenu && (
            <div className="sidebar__user-menu" role="menu" tabIndex={-1} onKeyDown={handleMenuKeyDown}>
              {/* Settings */}
              <button role="menuitem" onClick={() => handleUserMenuAction('/dashboard/settings')}>
                <span className="sidebar__icon">{icons.settings}</span>
                Settings
              </button>

              {/* Refer and earn. Account-level rather than a workspace area, so it
                  sits with Settings in this menu instead of the nav above. */}
              <button role="menuitem" onClick={() => handleUserMenuAction('/dashboard/refer')}>
                <span className="sidebar__icon"><GiftIcon width="16" height="16" /></span>
                Refer and earn
              </button>

              {/* Help */}
              <button role="menuitem" onClick={() => handleUserMenuAction('/dashboard/support')}>
                <span className="sidebar__icon"><LifeBuoyIcon width="16" height="16" /></span>
                Help
              </button>

              {/* Workspace switcher - only show if user has multiple workspaces */}
              {/* For invitation-only users, filter out self-owned tenants (personal workspace) */}
              {(() => {
                const visibleTenants = account?.accessReason === 'invitation'
                  ? tenants.filter(t => t.accountId !== account?.id)
                  : tenants
                return visibleTenants.length > 1 ? (
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
                      {tenant.id === currentTenant?.id && (
                        <CheckIcon width="16" height="16" />
                      )}
                      {tenant.name}
                    </button>
                  ))}
                </>
              ) : null})()}

              {/* Sign Out - always last */}
              <div className="sidebar__menu-divider" />
              <button role="menuitem" onClick={handleSignOut}>
                <span className="sidebar__icon"><LogoutIcon width="16" height="16" /></span>
                Sign Out
              </button>
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}
