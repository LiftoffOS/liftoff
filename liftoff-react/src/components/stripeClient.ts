import { loadStripe } from '@stripe/stripe-js'

// One Stripe instance for the app.
//
// `loadStripe` already dedupes the script tag, so a second call is not a second
// download. The reason this is shared is the key: two call sites reading
// VITE_STRIPE_PUBLISHABLE_KEY are two places to get it wrong, and a wrong or
// missing key fails at confirmation time rather than at load.
export const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY ?? '')
