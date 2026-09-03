import { describe, expect, it } from 'vitest';
import { leavesNoAdmins, normaliseEmail, parseKeepList, planReconcile } from './admin-reconcile';

const row = (email: string) => ({ id: `id-${email}`, email });

describe('parseKeepList', () => {
  it('accepts repeated flags and comma-separated lists interchangeably', () => {
    expect(parseKeepList(['a@x.com,b@x.com', 'c@x.com'])).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
  });

  it('normalises case and whitespace, and de-duplicates', () => {
    expect(parseKeepList([' A@X.com ', 'a@x.com'])).toEqual(['a@x.com']);
  });

  it('drops empty entries rather than keeping one that matches nothing', () => {
    expect(parseKeepList(['a@x.com,,  ,'])).toEqual(['a@x.com']);
    expect(parseKeepList([])).toEqual([]);
  });
});

describe('planReconcile', () => {
  it('revokes every admin not on the keep list', () => {
    // The reported state: an unfiltered updateMany made everyone an admin.
    const admins = [row('keep@x.com'), row('a@x.com'), row('b@x.com')];
    const plan = planReconcile(admins, ['keep@x.com']);

    expect(plan.keep.map((r) => r.email)).toEqual(['keep@x.com']);
    expect(plan.revoke.map((r) => r.email)).toEqual(['a@x.com', 'b@x.com']);
    expect(plan.unmatched).toEqual([]);
  });

  it('matches the keep list case-insensitively', () => {
    // The bulk grant upserted raw strings, so a database written by it can
    // hold mixed case that signup would have lower-cased.
    const plan = planReconcile([row('Vivek.Sannidhi29@Gmail.com')], ['vivek.sannidhi29@gmail.com']);
    expect(plan.revoke).toEqual([]);
    expect(plan.keep).toHaveLength(1);
  });

  it('reports a keep address that is not currently an admin instead of silently ignoring it', () => {
    // A typo here would revoke the very account the flag was protecting.
    const plan = planReconcile([row('a@x.com')], ['tpyo@x.com']);
    expect(plan.unmatched).toEqual(['tpyo@x.com']);
    expect(plan.revoke.map((r) => r.email)).toEqual(['a@x.com']);
  });

  it('revokes everyone when the keep list is empty', () => {
    const plan = planReconcile([row('a@x.com'), row('b@x.com')], []);
    expect(plan.revoke).toHaveLength(2);
    expect(plan.keep).toEqual([]);
  });

  it('plans nothing against an empty admin list', () => {
    const plan = planReconcile([], ['a@x.com']);
    expect(plan).toEqual({ revoke: [], keep: [], unmatched: ['a@x.com'] });
  });

  it('is idempotent — re-running after an apply plans no further revocations', () => {
    const admins = [row('keep@x.com')];
    expect(planReconcile(admins, ['keep@x.com']).revoke).toEqual([]);
  });
});

describe('leavesNoAdmins', () => {
  it('flags a plan that would clear the last admin', () => {
    expect(leavesNoAdmins(planReconcile([row('a@x.com')], []))).toBe(true);
  });

  it('does not flag a plan that keeps someone', () => {
    expect(leavesNoAdmins(planReconcile([row('a@x.com'), row('b@x.com')], ['a@x.com']))).toBe(false);
  });

  it('does not flag a no-op plan — there was nothing to lose', () => {
    expect(leavesNoAdmins(planReconcile([], []))).toBe(false);
  });
});

describe('normaliseEmail', () => {
  it('trims and lower-cases', () => {
    expect(normaliseEmail('  Foo@Bar.COM ')).toBe('foo@bar.com');
  });
});
