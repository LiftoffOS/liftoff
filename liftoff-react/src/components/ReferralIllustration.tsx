// ReferralIllustration — orbit visual for the referral page rail.
//
// The same orbit the /dashboard/agents hero uses: an accent glyph at the centre, a
// dashed ring turning slowly around it, and nodes on the ring that counter-rotate
// so they stay upright the whole way round.
//
// Read here as: Liftoff travels through the people you know. The centre is
// deliberately NOT the money. A currency glyph ringed by people draws the
// reward as the thing a network revolves around, which is both mercenary and
// untrue of how a recommendation actually spreads. The payment is stated in
// words directly beneath the drawing, where it does not have to be the hub.
//
// Motion is pure CSS, so the global prefers-reduced-motion rule in index.css
// stops it without this component knowing anything about the preference.

import RocketIcon from '../assets/icons/rocket.svg?react'
import PersonIcon from '../assets/icons/person.svg?react'
import PeopleIcon from '../assets/icons/people.svg?react'
import UserRoundPlusIcon from '../assets/icons/user-round-plus.svg?react'
import './ReferralIllustration.css'

export default function ReferralIllustration() {
  return (
    <div className="refer-orbit" aria-hidden="true">
      <div className="refer-orbit__center">
        <RocketIcon />
      </div>
      <div className="refer-orbit__ring">
        <div className="refer-orbit__node">
          <PersonIcon />
        </div>
        <div className="refer-orbit__node">
          <UserRoundPlusIcon />
        </div>
        <div className="refer-orbit__node">
          <PeopleIcon />
        </div>
      </div>
    </div>
  )
}
