import { redirect } from 'next/navigation';

/**
 * `/signup` no longer exists as a page — see the note in `login/page.tsx`.
 * Account creation is the Email tab's "Need an account?" toggle on `/#auth`,
 * so the redirect carries `?auth=signup`: someone who asked for the signup
 * route lands on the signup half of the panel, with a heading that agrees with
 * it, rather than on a sign-in form. See `lib/auth-mode.ts`.
 */
export default function SignupRedirect() {
  redirect('/?auth=signup#auth');
}
