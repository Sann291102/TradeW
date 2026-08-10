import { redirect } from 'next/navigation';

/**
 * `/signup` no longer exists as a page — see the note in `login/page.tsx`.
 * Account creation is the Email tab's "Need an account?" toggle on `/#auth`.
 */
export default function SignupRedirect() {
  redirect('/#auth');
}
