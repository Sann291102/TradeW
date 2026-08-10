import { redirect } from 'next/navigation';

/**
 * `/login` no longer exists as a page.
 *
 * Sign-in moved into the landing page (`/#auth`) so a visitor reads what the
 * platform is before being asked for credentials, rather than being dropped
 * onto a bare card with no context. This redirect stays because the path is
 * already in bookmarks, and because AuthPanel's own "Forgot password?" link
 * and any external references should keep resolving rather than 404.
 */
export default function LoginRedirect() {
  redirect('/#auth');
}
