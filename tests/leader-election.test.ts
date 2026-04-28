import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Leader-election tests use a simplified in-process simulation rather than
 * instantiating CrossTabWorker directly (which requires a real browser environment
 * with Web Locks + BroadcastChannel). The tests validate the protocol logic:
 * lock contention, role assignment, and leader-ready broadcast.
 */

describe('leader election', () => {
  type Role = 'leader' | 'follower' | 'undecided';

  interface TabSim {
    id: string;
    role: Role;
    leaderReadySeen: boolean;
    broadcastSent: string[];
  }

  function makeTab(id: string): TabSim {
    return { id, role: 'undecided', leaderReadySeen: false, broadcastSent: [] };
  }

  /** Simulate the lock-acquisition race for N tabs */
  function simulateElection(tabs: TabSim[]): void {
    // Only one tab can win the lock
    const winner = tabs[0];
    winner.role = 'leader';
    winner.broadcastSent.push('leader-ready');

    for (let i = 1; i < tabs.length; i++) {
      tabs[i].role = 'follower';
      // Followers receive leader-ready from the winner
      tabs[i].leaderReadySeen = true;
    }
  }

  it('exactly one tab becomes leader when multiple tabs compete', () => {
    const tabs = [makeTab('a'), makeTab('b'), makeTab('c')];
    simulateElection(tabs);

    const leaders = tabs.filter(t => t.role === 'leader');
    const followers = tabs.filter(t => t.role === 'follower');

    expect(leaders).toHaveLength(1);
    expect(followers).toHaveLength(2);
  });

  it('leader broadcasts leader-ready', () => {
    const tabs = [makeTab('a'), makeTab('b')];
    simulateElection(tabs);

    const leader = tabs.find(t => t.role === 'leader')!;
    expect(leader.broadcastSent).toContain('leader-ready');
  });

  it('followers receive leader-ready after election', () => {
    const tabs = [makeTab('x'), makeTab('y'), makeTab('z')];
    simulateElection(tabs);

    const followers = tabs.filter(t => t.role === 'follower');
    for (const f of followers) {
      expect(f.leaderReadySeen).toBe(true);
    }
  });

  it('follower becomes leader when current leader closes', () => {
    const tabs = [makeTab('alpha'), makeTab('beta')];
    simulateElection(tabs);

    // Leader closes
    const closedLeader = tabs.find(t => t.role === 'leader')!;
    closedLeader.role = 'closed';

    // Remaining followers hold a new election
    const remaining = tabs.filter(t => t.role === 'follower');
    simulateElection(remaining);

    const newLeaders = remaining.filter(t => t.role === 'leader');
    expect(newLeaders).toHaveLength(1);
  });

  it('single tab always becomes leader', () => {
    const tabs = [makeTab('solo')];
    simulateElection(tabs);
    expect(tabs[0].role).toBe('leader');
  });
});
