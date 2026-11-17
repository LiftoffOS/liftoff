import { Link } from 'react-router'
import './CTA.css'

export default function CTA() {
  return (
    <section className="cta section--light">
      <div className="cta__container">
        <div className="cta__content card card--no-border card--static">
          <h2 className="cta__title">
            Ready to Scale Faster With AI?
          </h2>
          <p className="cta__description">
            See how Liftoff runs agents alongside your people to accelerate growth.
          </p>
          <div className="cta__actions">
            <Link to="/request-a-demo" className="btn btn--primary">
              Request a Demo
            </Link>
          </div>
        </div>
      </div>
    </section>
  )
}
