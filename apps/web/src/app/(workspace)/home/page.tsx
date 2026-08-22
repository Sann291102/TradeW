import { redirect } from 'next/navigation';

/**
 * "Dashboard" is called "Home" in the sidebar now. The page it names did not
 * move: `/dashboard` is still the route, still the same component, still the
 * same data. This file exists so the name a user sees also works as a URL —
 * typed, bookmarked or linked from outside the app.
 *
 * A redirect rather than a copy of the page, deliberately. Two routes
 * rendering the same workspace would be two things to keep in sync, and the
 * first divergence would be invisible until someone reported that "Home shows
 * different numbers to Dashboard".
 */
export default function HomePage() {
  redirect('/dashboard');
}
