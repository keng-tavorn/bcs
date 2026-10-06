import { LIGHT_LINK_CLASS, LightLink } from '../light-link'

// A link between LIFF pages: the app's light link (../light-link.tsx), an <a href> that moves with router.push on a plain
// tap, so the LIFF bootstrap stays as it is — liff.init is not run again and the session keeper keeps counting — without
// next/link's client code in the first JavaScript of a LIFF page (§9.4: at most 200 KB gzip with the LINE SDK). A link
// out of the LIFF app (the web settings, the web sign-in) is a plain <a>, which loads that page.

export const LIFF_LINK_CLASS = LIGHT_LINK_CLASS

export const LiffLink = LightLink
