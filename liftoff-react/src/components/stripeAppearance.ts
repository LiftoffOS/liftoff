// Shared Stripe Elements appearance — mirrors the Liftoff design system so the
// embedded payment iframe visually matches our own <TextInput /> and surrounding
// surfaces.  Stripe iframes can't read parent CSS variables, so design-token
// values are duplicated here as string literals.
//
// Tokens kept in sync manually with src/index.css:
//   --color-accent      #FB411F
//   --color-black       #1e1e1e
//   --color-gray-50     #f7f7f7
//   --color-gray-400    rgba(64, 64, 64, 0.6)
//   --border-light      rgba(124, 124, 124, 0.08)
//   --status-error      #ef4444
//   --radius-md         8px
import type { Appearance } from '@stripe/stripe-js'

export const stripeAppearance: Appearance = {
  theme: 'stripe',
  variables: {
    colorPrimary: '#FB411F',
    colorBackground: '#f7f7f7',
    colorText: '#1e1e1e',
    colorTextPlaceholder: 'rgba(64, 64, 64, 0.6)',
    colorTextSecondary: 'rgba(64, 64, 64, 0.6)',
    colorDanger: '#ef4444',
    fontFamily: '"Inter Variable", "Inter Variable Placeholder", system-ui, sans-serif',
    fontSizeBase: '14px',
    borderRadius: '8px',
    spacingUnit: '4px',
  },
  rules: {
    '.Input': {
      backgroundColor: '#f7f7f7',
      border: '1px solid rgba(124, 124, 124, 0.08)',
      padding: '10px 20px',
      fontSize: '14px',
      borderRadius: '9999px',
      transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
    },
    '.Input:focus': {
      borderColor: '#FB411F',
      boxShadow: '0 0 0 3px rgba(251, 65, 31, 0.18)',
    },
    '.Label': {
      fontSize: '14px',
      fontWeight: '400',
      color: '#1e1e1e',
      marginBottom: '8px',
    },
    '.Tab': {
      border: '1px solid rgba(124, 124, 124, 0.08)',
      backgroundColor: '#ffffff',
      // Stripe's Tab content is a flex row that defaults to flex-start; the
      // Appearance API doesn't expose flexbox props, but `textAlign: center`
      // is honored for the inline label and Tab's internal flex justifies
      // around it when contents are short.
      textAlign: 'center',
      paddingLeft: '24px',
      paddingRight: '24px',
    },
    '.Tab--selected': {
      borderColor: '#FB411F',
      backgroundColor: '#ffffff',
    },
    '.Tab:hover': {
      backgroundColor: '#f7f7f7',
    },
    '.Error': {
      fontSize: '12px',
    },
  },
}
