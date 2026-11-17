// The two chat surfaces an agent can be reached from, split out of
// IntegrationIcons so a page can show them without pulling the whole
// connector icon set. That file is ~6.5k lines and bundles as one ~411 kB
// chunk; importing a single icon from it puts the entire chunk on the
// first-load path and over the CI bundle gate. IntegrationIcons
// re-exports both names, so the dashboard and its registry are unaffected.

export const SlackIcon = () => (
  <svg viewBox="0 0 24 24" fill="none">
    <path d="M5.042 15.165a2.528 2.528 0 01-2.52 2.523A2.528 2.528 0 010 15.165a2.527 2.527 0 012.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 012.521-2.52 2.527 2.527 0 012.521 2.52v6.313A2.528 2.528 0 018.834 24a2.528 2.528 0 01-2.521-2.522v-6.313z" fill="#E01E5A"/>
    <path d="M8.834 5.042a2.528 2.528 0 01-2.521-2.52A2.528 2.528 0 018.834 0a2.528 2.528 0 012.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 012.521 2.521 2.528 2.528 0 01-2.521 2.521H2.522A2.528 2.528 0 010 8.834a2.528 2.528 0 012.522-2.521h6.312z" fill="#36C5F0"/>
    <path d="M18.956 8.834a2.528 2.528 0 012.522-2.521A2.528 2.528 0 0124 8.834a2.528 2.528 0 01-2.522 2.521h-2.522V8.834zm-1.27 0a2.528 2.528 0 01-2.522 2.521 2.528 2.528 0 01-2.521-2.521V2.522A2.528 2.528 0 0115.165 0a2.528 2.528 0 012.521 2.522v6.312z" fill="#2EB67D"/>
    <path d="M15.165 18.956a2.528 2.528 0 012.521 2.522A2.528 2.528 0 0115.165 24a2.528 2.528 0 01-2.521-2.522v-2.522h2.521zm0-1.27a2.528 2.528 0 01-2.521-2.522 2.528 2.528 0 012.521-2.521h6.313A2.528 2.528 0 0124 15.165a2.528 2.528 0 01-2.522 2.521h-6.313z" fill="#ECB22E"/>
  </svg>
)

export const MicrosoftTeamsIcon = () => (
  <svg viewBox="4 4 36 38" fill="none">
    <path fill="url(#teams-a)" d="M22 20h12c3.314 0 6 2.686 6 6v10c0 3.314-2.686 6-6 6s-6-2.686-6-6V26c0-3.314-2.686-6-6-6"/>
    <path fill="url(#teams-b)" d="M8 24c0-3.314 2.686-6 6-6h8c3.314 0 6 2.686 6 6v12c0 3.314 2.686 6 6 6H14c-5.523 0-10-4.477-10-10z"/>
    <path fill="url(#teams-c)" fillOpacity=".7" d="M8 24c0-3.314 2.686-6 6-6h8c3.314 0 6 2.686 6 6v12c0 3.314 2.686 6 6 6H14c-5.523 0-10-4.477-10-10z"/>
    <path fill="url(#teams-d)" fillOpacity=".7" d="M8 24c0-3.314 2.686-6 6-6h8c3.314 0 6 2.686 6 6v12c0 3.314 2.686 6 6 6H14c-5.523 0-10-4.477-10-10z"/>
    <path fill="url(#teams-e)" d="M33 18a5 5 0 100-10 5 5 0 000 10z"/>
    <path fill="url(#teams-f)" fillOpacity=".46" d="M33 18a5 5 0 100-10 5 5 0 000 10z"/>
    <path fill="url(#teams-g)" d="M18 16a6 6 0 100-12 6 6 0 000 12z"/>
    <path fill="url(#teams-h)" fillOpacity=".6" d="M18 16a6 6 0 100-12 6 6 0 000 12z"/>
    <rect width="16" height="16" x="4" y="23" fill="url(#teams-i)" rx="3.25"/>
    <rect width="16" height="16" x="4" y="23" fill="url(#teams-j)" fillOpacity=".7" rx="3.25"/>
    <path fill="#fff" d="M15.479 28.105h-2.447v7.466h-2.065v-7.466H8.52v-1.677h6.959z"/>
    <defs>
      <radialGradient id="teams-a" cx="0" cy="0" r="1" gradientTransform="matrix(13.478 0 0 33.27 39.797 22.174)" gradientUnits="userSpaceOnUse">
        <stop stopColor="#a98aff"/>
        <stop offset=".14" stopColor="#8c75ff"/>
        <stop offset=".565" stopColor="#5f50e2"/>
        <stop offset=".9" stopColor="#3c2cb8"/>
      </radialGradient>
      <radialGradient id="teams-b" cx="0" cy="0" r="1" gradientTransform="rotate(68.154 -7.716 14.714)scale(32.752 33.123)" gradientUnits="userSpaceOnUse">
        <stop stopColor="#85c2ff"/>
        <stop offset=".69" stopColor="#7588ff"/>
        <stop offset="1" stopColor="#6459fe"/>
      </radialGradient>
      <linearGradient id="teams-c" x1="20.594" x2="20.594" y1="18" y2="42" gradientUnits="userSpaceOnUse">
        <stop offset=".801" stopColor="#6864f6" stopOpacity="0"/>
        <stop offset="1" stopColor="#5149de"/>
      </linearGradient>
      <radialGradient id="teams-d" cx="0" cy="0" r="1" gradientTransform="rotate(113.326 8.093 17.645)scale(19.22 15.43)" gradientUnits="userSpaceOnUse">
        <stop stopColor="#bd96ff"/>
        <stop offset=".687" stopColor="#bd96ff" stopOpacity="0"/>
      </radialGradient>
      <radialGradient id="teams-e" cx="0" cy="0" r="1" gradientTransform="matrix(0 -10 12.622 0 33 11.57)" gradientUnits="userSpaceOnUse">
        <stop offset=".268" stopColor="#6868f7"/>
        <stop offset="1" stopColor="#3923b1"/>
      </radialGradient>
      <radialGradient id="teams-f" cx="0" cy="0" r="1" gradientTransform="rotate(40.05 -.03 44.87)scale(7.15 10.34)" gradientUnits="userSpaceOnUse">
        <stop offset=".271" stopColor="#a1d3ff"/>
        <stop offset=".813" stopColor="#a1d3ff" stopOpacity="0"/>
      </radialGradient>
      <radialGradient id="teams-g" cx="0" cy="0" r="1" gradientTransform="matrix(0 -12 15.15 0 18 8.29)" gradientUnits="userSpaceOnUse">
        <stop offset=".268" stopColor="#8282ff"/>
        <stop offset="1" stopColor="#3923b1"/>
      </radialGradient>
      <radialGradient id="teams-h" cx="0" cy="0" r="1" gradientTransform="rotate(40.05 -3.15 21.42)scale(8.58 12.4)" gradientUnits="userSpaceOnUse">
        <stop offset=".271" stopColor="#a1d3ff"/>
        <stop offset=".813" stopColor="#a1d3ff" stopOpacity="0"/>
      </radialGradient>
      <radialGradient id="teams-i" cx="0" cy="0" r="1" gradientTransform="rotate(45 -25.76 16.33)scale(22.63)" gradientUnits="userSpaceOnUse">
        <stop offset=".047" stopColor="#688eff"/>
        <stop offset=".947" stopColor="#230f94"/>
      </radialGradient>
      <radialGradient id="teams-j" cx="0" cy="0" r="1" gradientTransform="matrix(0 11.2 -13.07 0 12 32.6)" gradientUnits="userSpaceOnUse">
        <stop offset=".571" stopColor="#6965f6" stopOpacity="0"/>
        <stop offset="1" stopColor="#8f8fff"/>
      </radialGradient>
    </defs>
  </svg>
)
