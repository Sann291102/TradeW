import { redirect } from 'next/navigation';

/**
 * The notification feed is called "Alerts" in the sidebar. Same reasoning as
 * `/home`: rename the label, keep the route, and make the new name resolve.
 */
export default function AlertsPage() {
  redirect('/notifications');
}
