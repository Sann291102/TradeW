import { NotBuiltYet } from '@/components/workspace-shells/NotBuiltYet';

export const metadata = { title: 'Community — TradeW' };

/**
 * Community is a NEW product area. Nothing in this repository implements it:
 * there is no posts table, no threads, no memberships, no moderation, no feed
 * service — the search for one turned up zero matches across apps, services
 * and packages.
 *
 * So this route is navigation architecture plus an honest empty state. Seeding
 * it with a few discussion threads to make the screenshot look alive would
 * have been the easy version and the dishonest one: a user would reply to a
 * post that nobody wrote and nobody will read.
 */
export default function CommunityPage() {
  return (
    <NotBuiltYet
      title="Community"
      intent="Where TradeW traders will compare notes — on strategies, on what the Sentinel flagged, and on what they are learning."
      status={
        <>
          There is no community backend in TradeW today. No posts, threads, replies, profiles,
          follows or moderation exist in the database or in any service, so this page has nothing to
          read from. It is deliberately empty rather than populated with example discussions.
        </>
      }
      planned={[
        'Trader discussions, scoped to instruments and to market sessions',
        'Strategy discussion threads linked to the strategies in AI Sentinel',
        'Learning discussions attached to specific concepts and courses',
        'Sharing research findings from the Research workspace',
        'Sentinel insights a trader chooses to publish',
        'Moderation, reporting and the rules that have to exist before any of the above',
      ]}
      instead={[
        { href: '/learning', label: 'Learning', hint: 'Courses and concepts, with real progress tracking' },
        { href: '/sentinel', label: 'AI Sentinel', hint: 'Live observations on the markets you follow' },
        { href: '/research', label: 'Research', hint: 'Market research and analysis' },
        { href: '/news', label: 'News Feed', hint: 'Real newswire coverage, filtered by symbol' },
      ]}
    />
  );
}
