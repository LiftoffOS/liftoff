import './PageHeader.css'

interface PageHeaderProps {
  title: string
  subtitle?: string
  children?: React.ReactNode
  className?: string
}

export default function PageHeader({ title, subtitle, children, className = '' }: PageHeaderProps) {
  return (
    <div className={`page-header ${className}`.trim()}>
      <div className="page-header__left">
        <h1 className="page-header__title">{title}</h1>
        {subtitle && <p className="page-header__subtitle">{subtitle}</p>}
      </div>
      {children && (
        <div className="page-header__actions">
          {children}
        </div>
      )}
    </div>
  )
}
