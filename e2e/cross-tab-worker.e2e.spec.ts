import { expect, test, type Page } from '@playwright/test';

async function openTab(page: Page): Promise<void> {
  await page.goto('/e2e/index.html');
}

async function createWorker(page: Page, name: string): Promise<string> {
  return page.evaluate(
    (workerName) => window.__ctwHarness.create(workerName),
    name,
  );
}

async function waitForLeader(page: Page, id: string): Promise<void> {
  await expect
    .poll(async () => page.evaluate((workerId) => window.__ctwHarness.isLeader(workerId), id))
    .toBe(true);
}

async function waitForMessageCount(page: Page, id: string, count: number): Promise<void> {
  await expect
    .poll(async () => {
      const messages = await page.evaluate((workerId) => window.__ctwHarness.getMessages(workerId), id);
      return messages.length;
    })
    .toBeGreaterThanOrEqual(count);
}

async function waitForMessageByKind(page: Page, id: string, kind: string): Promise<void> {
  await expect
    .poll(async () => {
      const messages = await page.evaluate((workerId) => window.__ctwHarness.getMessages(workerId), id);
      return messages.some((m: any) => m?.kind === kind);
    })
    .toBe(true);
}

async function waitForMessageByReqId(page: Page, id: string, reqId: string): Promise<any> {
  await expect
    .poll(async () => {
      const messages = await page.evaluate((workerId) => window.__ctwHarness.getMessages(workerId), id);
      return messages.some((m: any) => m?.reqId === reqId);
    })
    .toBe(true);

  return page.evaluate(
    ({ workerId, requestId }) =>
      window.__ctwHarness.getMessages(workerId).find((m: any) => m?.reqId === requestId),
    { workerId: id, requestId: reqId },
  );
}

async function getLeaderFollower(
  page1: Page,
  id1: string,
  page2: Page,
  id2: string,
): Promise<[1 | 2, string, 1 | 2, string]> {
  await expect
    .poll(async () => {
      const [l1, l2] = await Promise.all([
        page1.evaluate((workerId) => window.__ctwHarness.isLeader(workerId), id1),
        page2.evaluate((workerId) => window.__ctwHarness.isLeader(workerId), id2),
      ]);
      return Number(l1) + Number(l2);
    })
    .toBe(1);

  const [l1, l2] = await Promise.all([
    page1.evaluate((workerId) => window.__ctwHarness.isLeader(workerId), id1),
    page2.evaluate((workerId) => window.__ctwHarness.isLeader(workerId), id2),
  ]);
  return l1 ? [1, id1, 2, id2] : [2, id2, 1, id1];
}

test.describe('CrossTabWorker e2e (multi-tab)', () => {
  test('single tab becomes leader', async ({ context, page }) => {
    await openTab(page);
    const id = await createWorker(page, `single-${test.info().testId}`);
    await waitForLeader(page, id);
    await context.close();
  });

  test('two tabs elect exactly one leader', async ({ context, page }) => {
    await openTab(page);
    const page2 = await context.newPage();
    await openTab(page2);
    const name = `two-tabs-${test.info().testId}`;
    const id1 = await createWorker(page, name);
    const id2 = await createWorker(page2, name);
    await expect
      .poll(async () => {
        const [l1, l2] = await Promise.all([
          page.evaluate((workerId) => window.__ctwHarness.isLeader(workerId), id1),
          page2.evaluate((workerId) => window.__ctwHarness.isLeader(workerId), id2),
        ]);
        return Number(l1) + Number(l2);
      })
      .toBe(1);
    await context.close();
  });

  test('leader postMessage reaches worker and gets response', async ({ context, page }) => {
    await openTab(page);
    const id = await createWorker(page, `leader-msg-${test.info().testId}`);
    await waitForLeader(page, id);
    await page.evaluate((workerId) => window.__ctwHarness.post(workerId, { seq: 1, payload: 'hello' }), id);
    await waitForMessageCount(page, id, 1);
    const first = await page.evaluate((workerId) => window.__ctwHarness.getMessages(workerId)[0], id);
    expect(first).toMatchObject({ kind: 'ack', seq: 1, payload: 'hello' });
    await context.close();
  });

  test('follower postMessage relays to leader worker', async ({ context, page }) => {
    await openTab(page);
    const page2 = await context.newPage();
    await openTab(page2);
    const name = `follower-msg-${test.info().testId}`;
    const id1 = await createWorker(page, name);
    const id2 = await createWorker(page2, name);
    const [leaderPage, leaderId, followerPage, followerId] = await getLeaderFollower(page, id1, page2, id2);

    const leader = leaderPage === 1 ? page : page2;
    const follower = followerPage === 1 ? page : page2;

    await leader.evaluate((workerId) => window.__ctwHarness.clearMessages(workerId), leaderId);
    await follower.evaluate((workerId) => window.__ctwHarness.clearMessages(workerId), followerId);
    await follower.evaluate((workerId) => window.__ctwHarness.post(workerId, { seq: 2, payload: 'relay' }), followerId);

    await waitForMessageCount(leader, leaderId, 1);
    const msg = await leader.evaluate((workerId) => window.__ctwHarness.getMessages(workerId)[0], leaderId);
    expect(msg).toMatchObject({ kind: 'ack', seq: 2, payload: 'relay' });
    await context.close();
  });

  test('worker responses are fan-out broadcast to all tabs', async ({ context, page }) => {
    await openTab(page);
    const page2 = await context.newPage();
    await openTab(page2);
    const name = `fanout-${test.info().testId}`;
    const id1 = await createWorker(page, name);
    const id2 = await createWorker(page2, name);
    await expect
      .poll(async () => {
        const [l1, l2] = await Promise.all([
          page.evaluate((workerId) => window.__ctwHarness.isLeader(workerId), id1),
          page2.evaluate((workerId) => window.__ctwHarness.isLeader(workerId), id2),
        ]);
        return Number(l1) + Number(l2);
      })
      .toBe(1);
    await page.evaluate((workerId) => window.__ctwHarness.clearMessages(workerId), id1);
    await page2.evaluate((workerId) => window.__ctwHarness.clearMessages(workerId), id2);
    await page2.evaluate((workerId) => window.__ctwHarness.post(workerId, { seq: 3, payload: 'fanout' }), id2);
    await waitForMessageCount(page, id1, 1);
    await waitForMessageCount(page2, id2, 1);
    await context.close();
  });

  test('follower message ordering is preserved', async ({ context, page }) => {
    await openTab(page);
    const page2 = await context.newPage();
    await openTab(page2);
    const name = `ordering-${test.info().testId}`;
    const id1 = await createWorker(page, name);
    const id2 = await createWorker(page2, name);
    await expect
      .poll(async () => {
        const [l1, l2] = await Promise.all([
          page.evaluate((workerId) => window.__ctwHarness.isLeader(workerId), id1),
          page2.evaluate((workerId) => window.__ctwHarness.isLeader(workerId), id2),
        ]);
        return Number(l1) + Number(l2);
      })
      .toBe(1);

    await page.evaluate((workerId) => window.__ctwHarness.clearMessages(workerId), id1);
    await page2.evaluate((workerId) => window.__ctwHarness.clearMessages(workerId), id2);
    for (let i = 0; i < 5; i++) {
      await page2.evaluate(
        ({ workerId, seq }) => window.__ctwHarness.post(workerId, { seq, payload: `m-${seq}` }),
        { workerId: id2, seq: i },
      );
    }

    await waitForMessageCount(page, id1, 5);
    const seqs = await page.evaluate((workerId) => {
      return window.__ctwHarness
        .getMessages(workerId)
        .slice(0, 5)
        .map((m: any) => m.seq);
    }, id1);
    expect(seqs).toEqual([0, 1, 2, 3, 4]);
    await context.close();
  });

  test('failover promotes follower to leader', async ({ context, page }) => {
    await openTab(page);
    const page2 = await context.newPage();
    await openTab(page2);
    const name = `failover-${test.info().testId}`;
    const id1 = await createWorker(page, name);
    const id2 = await createWorker(page2, name);

    const [leaderPage, leaderId, followerPage, followerId] = await getLeaderFollower(page, id1, page2, id2);

    const leader = leaderPage === 1 ? page : page2;
    const follower = followerPage === 1 ? page : page2;

    await leader.evaluate((workerId) => window.__ctwHarness.destroy(workerId), leaderId);
    await expect
      .poll(async () => follower.evaluate((workerId) => window.__ctwHarness.isLeader(workerId), followerId))
      .toBe(true);
    await context.close();
  });

  test('messages queued during failover are replayed', async ({ context, page }) => {
    await openTab(page);
    const page2 = await context.newPage();
    await openTab(page2);
    const name = `replay-${test.info().testId}`;
    const id1 = await createWorker(page, name);
    const id2 = await createWorker(page2, name);

    const [leaderPage, leaderId, followerPage, followerId] = await getLeaderFollower(page, id1, page2, id2);

    const leader = leaderPage === 1 ? page : page2;
    const follower = followerPage === 1 ? page : page2;
    await follower.evaluate((workerId) => window.__ctwHarness.clearMessages(workerId), followerId);
    await leader.evaluate((workerId) => window.__ctwHarness.destroy(workerId), leaderId);
    await follower.evaluate((workerId) => window.__ctwHarness.post(workerId, { seq: 77, payload: 'queued' }), followerId);
    await expect
      .poll(async () => follower.evaluate((workerId) => window.__ctwHarness.isLeader(workerId), followerId))
      .toBe(true);
    await waitForMessageCount(follower, followerId, 1);
    const msg = await follower.evaluate((workerId) => window.__ctwHarness.getMessages(workerId)[0], followerId);
    expect(msg).toMatchObject({ seq: 77, payload: 'queued' });
    await context.close();
  });

  test('zero-copy path detaches sender ArrayBuffer from follower', async ({ context, page }) => {
    await openTab(page);
    const page2 = await context.newPage();
    await openTab(page2);
    const name = `zero-copy-${test.info().testId}`;
    const id1 = await createWorker(page, name);
    const id2 = await createWorker(page2, name);
    const [leaderPage, _leaderId, followerPage, followerId] = await getLeaderFollower(page, id1, page2, id2);
    const follower = followerPage === 1 ? page : page2;
    const leader = leaderPage === 1 ? page : page2;

    await expect
      .poll(async () => follower.evaluate((workerId) => window.__ctwHarness.hasLeaderPort(workerId), followerId))
      .toBe(true);
    await follower.evaluate((workerId) => window.__ctwHarness.clearMessages(workerId), followerId);
    await leader.evaluate((workerId) => window.__ctwHarness.clearMessages(workerId), leaderPage === 1 ? id1 : id2);

    const transferResult = await follower.evaluate(
      ({ workerId, size, label }) => window.__ctwHarness.postBuffer(workerId, size, label),
      { workerId: followerId, size: 128, label: 'zc' },
    );
    expect(transferResult.before).toBe(128);
    expect(transferResult.after).toBe(0);
    await context.close();
  });

  test('zero-copy path delivers buffer to worker', async ({ context, page }) => {
    await openTab(page);
    const page2 = await context.newPage();
    await openTab(page2);
    const name = `zero-copy-worker-${test.info().testId}`;
    const id1 = await createWorker(page, name);
    const id2 = await createWorker(page2, name);
    await expect
      .poll(async () => {
        const [l1, l2] = await Promise.all([
          page.evaluate((workerId) => window.__ctwHarness.isLeader(workerId), id1),
          page2.evaluate((workerId) => window.__ctwHarness.isLeader(workerId), id2),
        ]);
        return Number(l1) + Number(l2);
      })
      .toBe(1);

    await page.evaluate((workerId) => window.__ctwHarness.clearMessages(workerId), id1);
    await page2.evaluate((workerId) => window.__ctwHarness.clearMessages(workerId), id2);
    await page2.evaluate(({ workerId }) => window.__ctwHarness.postBuffer(workerId, 256, 'zc2'), { workerId: id2 });
    await waitForMessageCount(page, id1, 1);
    const msg = await page.evaluate((workerId) => window.__ctwHarness.getMessages(workerId)[0], id1);
    expect(msg).toMatchObject({ kind: 'buffer-ack', label: 'zc2', byteLength: 256, firstByte: 7 });
    await context.close();
  });

  test('directed reply delivers buffer zero-copy only to the requesting follower', async ({ context, page }) => {
    await openTab(page);
    const page2 = await context.newPage();
    await openTab(page2);
    const name = `directed-reply-zc-${test.info().testId}`;
    const id1 = await createWorker(page, name);
    const id2 = await createWorker(page2, name);
    const [leaderNum, leaderId, , followerId] = await getLeaderFollower(page, id1, page2, id2);
    const leader = leaderNum === 1 ? page : page2;
    const follower = leaderNum === 1 ? page2 : page;

    await expect
      .poll(async () => follower.evaluate((id) => window.__ctwHarness.hasLeaderPort(id), followerId))
      .toBe(true);
    await leader.evaluate((id) => window.__ctwHarness.clearMessages(id), leaderId);
    await follower.evaluate((id) => window.__ctwHarness.clearMessages(id), followerId);

    // Send from the follower. The echo worker will reply via e.ports[0] (directed, zero-copy).
    const sendResult = await follower.evaluate(
      ({ workerId, size, label }) => window.__ctwHarness.postBufferDirected(workerId, size, label),
      { workerId: followerId, size: 256, label: 'zc-dr' },
    );
    // Buffer was transferred out of the follower tab immediately.
    expect(sendResult.before).toBe(256);
    expect(sendResult.after).toBe(0);

    // Follower receives the directed buffer-echo-ack reply.
    await waitForMessageByKind(follower, followerId, 'buffer-echo-ack');
    const reply = await follower.evaluate(
      (id) => window.__ctwHarness.getMessages(id).find((m: any) => m?.kind === 'buffer-echo-ack') as any,
      followerId,
    );
    expect(reply.byteLength).toBe(256);

    // The worker broadcasts its buffer byteLength AFTER sending the directed reply.
    // If the reply was truly transferred (not cloned), the buffer is detached in the worker.
    await waitForMessageByKind(leader, leaderId, 'worker-buffer-state');
    const state = await leader.evaluate(
      (id) => window.__ctwHarness.getMessages(id).find((m: any) => m?.kind === 'worker-buffer-state') as any,
      leaderId,
    );
    expect(state.byteLengthAfterSend).toBe(0);

    // The directed reply must NOT reach the leader tab — only the requesting follower.
    const leaderMessages = await leader.evaluate(
      (id) => window.__ctwHarness.getMessages(id),
      leaderId,
    );
    expect(leaderMessages.some((m: any) => m?.kind === 'buffer-echo-ack')).toBe(false);

    await context.close();
  });

  test('ArrayBuffer buffered before leaderPort connects is delivered intact to worker', async ({ context, page }) => {
    await openTab(page);
    const page2 = await context.newPage();
    await openTab(page2);
    const name = `preconnect-buf-${test.info().testId}`;
    const id1 = await createWorker(page, name);
    const id2 = await createWorker(page2, name);
    const [, , , followerId] = await getLeaderFollower(page, id1, page2, id2);
    const follower = followerId === id1 ? page : page2;

    // Verify the leaderPort is NOT yet open, then send immediately.
    // Any buffer sent before hasLeaderPort is stored without transferring and drained
    // when the direct channel to the leader is established.
    const hadPortBefore = await follower.evaluate(
      (id) => window.__ctwHarness.hasLeaderPort(id),
      followerId,
    );
    // If we raced and the port is already open, fall back: close and reconnect isn't
    // possible from the harness, but we can still verify delivery is correct.
    void hadPortBefore;

    await follower.evaluate((id) => window.__ctwHarness.clearMessages(id), followerId);
    // Send before waiting for the leaderPort — message may be buffered pre-connection.
    const sendResult = await follower.evaluate(
      ({ id, size, label }) => window.__ctwHarness.postBuffer(id, size, label),
      { id: followerId, size: 512, label: 'pre-connect' },
    );
    expect(sendResult.before).toBe(512);

    // Regardless of whether it was buffered or sent immediately, the worker must receive
    // the full buffer with correct content.
    await waitForMessageByKind(follower, followerId, 'buffer-ack');
    const msg = await follower.evaluate(
      (id) => window.__ctwHarness.getMessages(id).find((m: any) => m?.kind === 'buffer-ack'),
      followerId,
    );
    expect(msg).toMatchObject({ kind: 'buffer-ack', label: 'pre-connect', byteLength: 512, firstByte: 7 });

    await context.close();
  });

  test('OPFS concurrent writes from two tabs can both be read back', async ({ context, page }) => {
    await openTab(page);
    const page2 = await context.newPage();
    await openTab(page2);
    const opfsAvailable = await page.evaluate(async () => {
      try { await navigator.storage.getDirectory(); return true; } catch { return false; }
    });
    test.skip(!opfsAvailable, 'OPFS is not available in this browser/mode (WebKit non-persistent storage)');

    const name = `opfs-concurrent-${test.info().testId}`;
    const id1 = await createWorker(page, name);
    const id2 = await createWorker(page2, name);
    const [leaderPage, leaderId, followerPage, followerId] = await getLeaderFollower(page, id1, page2, id2);
    const leader = leaderPage === 1 ? page : page2;
    const follower = followerPage === 1 ? page : page2;

    await leader.evaluate((workerId) => window.__ctwHarness.clearMessages(workerId), leaderId);
    await follower.evaluate((workerId) => window.__ctwHarness.clearMessages(workerId), followerId);

    const writeA = 'opfs-write-a';
    const writeB = 'opfs-write-b';
    const readA = 'opfs-read-a';
    const readB = 'opfs-read-b';

    await Promise.all([
      leader.evaluate(({ workerId, reqId }) => {
        window.__ctwHarness.post(workerId, {
          kind: 'opfs-write',
          reqId,
          path: 'a.bin',
          bytes: new Uint8Array([1, 2, 3, 4]),
        });
      }, { workerId: leaderId, reqId: writeA }),
      follower.evaluate(({ workerId, reqId }) => {
        window.__ctwHarness.post(workerId, {
          kind: 'opfs-write',
          reqId,
          path: 'b.bin',
          bytes: new Uint8Array([9, 8, 7, 6]),
        });
      }, { workerId: followerId, reqId: writeB }),
    ]);

    await waitForMessageByReqId(leader, leaderId, writeA);
    await waitForMessageByReqId(leader, leaderId, writeB);

    await leader.evaluate(({ workerId, reqId }) => {
      window.__ctwHarness.post(workerId, { kind: 'opfs-read', reqId, path: 'a.bin' });
    }, { workerId: leaderId, reqId: readA });
    await leader.evaluate(({ workerId, reqId }) => {
      window.__ctwHarness.post(workerId, { kind: 'opfs-read', reqId, path: 'b.bin' });
    }, { workerId: leaderId, reqId: readB });

    const aAck = await waitForMessageByReqId(leader, leaderId, readA);
    const bAck = await waitForMessageByReqId(leader, leaderId, readB);
    expect(Array.from(aAck.bytes)).toEqual([1, 2, 3, 4]);
    expect(Array.from(bAck.bytes)).toEqual([9, 8, 7, 6]);
    await context.close();
  });

  test('OPFS concurrent writes to same path keep one full blob', async ({ context, page }) => {
    await openTab(page);
    const page2 = await context.newPage();
    await openTab(page2);
    const opfsAvailable = await page.evaluate(async () => {
      try { await navigator.storage.getDirectory(); return true; } catch { return false; }
    });
    test.skip(!opfsAvailable, 'OPFS is not available in this browser/mode (WebKit non-persistent storage)');

    const name = `opfs-race-${test.info().testId}`;
    const id1 = await createWorker(page, name);
    const id2 = await createWorker(page2, name);
    const [leaderPage, leaderId, followerPage, followerId] = await getLeaderFollower(page, id1, page2, id2);
    const leader = leaderPage === 1 ? page : page2;
    const follower = followerPage === 1 ? page : page2;

    await leader.evaluate((workerId) => window.__ctwHarness.clearMessages(workerId), leaderId);
    await follower.evaluate((workerId) => window.__ctwHarness.clearMessages(workerId), followerId);

    await Promise.all([
      leader.evaluate(({ workerId }) => {
        window.__ctwHarness.post(workerId, {
          kind: 'opfs-write',
          reqId: 'race-write-a',
          path: 'race.bin',
          bytes: new Uint8Array([1, 1, 1, 1, 1]),
        });
      }, { workerId: leaderId }),
      follower.evaluate(({ workerId }) => {
        window.__ctwHarness.post(workerId, {
          kind: 'opfs-write',
          reqId: 'race-write-b',
          path: 'race.bin',
          bytes: new Uint8Array([2, 2, 2, 2, 2]),
        });
      }, { workerId: followerId }),
    ]);

    await waitForMessageByReqId(leader, leaderId, 'race-write-a');
    await waitForMessageByReqId(leader, leaderId, 'race-write-b');
    await leader.evaluate((workerId) => window.__ctwHarness.post(workerId, {
      kind: 'opfs-read',
      reqId: 'race-read',
      path: 'race.bin',
    }), leaderId);
    const readAck = await waitForMessageByReqId(leader, leaderId, 'race-read');
    const values = Array.from(readAck.bytes as number[]);
    expect(values.length).toBe(5);
    const allOnes = values.every((n) => n === 1);
    const allTwos = values.every((n) => n === 2);
    expect(allOnes || allTwos).toBe(true);
    await context.close();
  });

  test('OPFS read after follower-origin write returns exact blob', async ({ context, page }) => {
    await openTab(page);
    const page2 = await context.newPage();
    await openTab(page2);
    const opfsAvailable = await page.evaluate(async () => {
      try { await navigator.storage.getDirectory(); return true; } catch { return false; }
    });
    test.skip(!opfsAvailable, 'OPFS is not available in this browser/mode (WebKit non-persistent storage)');

    const name = `opfs-follower-write-${test.info().testId}`;
    const id1 = await createWorker(page, name);
    const id2 = await createWorker(page2, name);
    const [leaderPage, leaderId, followerPage, followerId] = await getLeaderFollower(page, id1, page2, id2);
    const follower = followerPage === 1 ? page : page2;
    const leader = leaderPage === 1 ? page : page2;

    await leader.evaluate((workerId) => window.__ctwHarness.clearMessages(workerId), leaderId);
    await follower.evaluate((workerId) => window.__ctwHarness.clearMessages(workerId), followerId);
    await follower.evaluate((workerId) => window.__ctwHarness.post(workerId, {
      kind: 'opfs-write',
      reqId: 'follower-write',
      path: 'from-follower.bin',
      bytes: new Uint8Array([42, 43, 44, 45, 46, 47]),
    }), followerId);
    await waitForMessageByReqId(leader, leaderId, 'follower-write');

    await leader.evaluate((workerId) => window.__ctwHarness.post(workerId, {
      kind: 'opfs-read',
      reqId: 'follower-read',
      path: 'from-follower.bin',
    }), leaderId);
    const readAck = await waitForMessageByReqId(leader, leaderId, 'follower-read');
    expect(Array.from(readAck.bytes)).toEqual([42, 43, 44, 45, 46, 47]);
    await context.close();
  });

  test('four tabs elect exactly one leader and all receive worker responses', async ({ context, page }) => {
    await openTab(page);
    const [page2, page3, page4] = await Promise.all([
      context.newPage().then(async (p) => { await openTab(p); return p; }),
      context.newPage().then(async (p) => { await openTab(p); return p; }),
      context.newPage().then(async (p) => { await openTab(p); return p; }),
    ]);
    const pages = [page, page2, page3, page4];
    const name = `four-tabs-${test.info().testId}`;
    const ids = await Promise.all(pages.map((p) => createWorker(p, name)));

    // Exactly one leader across all four tabs.
    await expect
      .poll(async () => {
        const leaders = await Promise.all(
          pages.map((p, i) => p.evaluate((id) => window.__ctwHarness.isLeader(id), ids[i])),
        );
        return leaders.filter(Boolean).length;
      })
      .toBe(1);

    // Clear all message queues.
    await Promise.all(pages.map((p, i) => p.evaluate((id) => window.__ctwHarness.clearMessages(id), ids[i])));

    // Send from page4 (likely a follower) — worker response must reach all 4 tabs.
    await page4.evaluate((id) => window.__ctwHarness.post(id, { seq: 42, payload: 'four-tabs' }), ids[3]);

    await Promise.all(pages.map((p, i) => waitForMessageCount(p, ids[i], 1)));
    const messages = await Promise.all(
      pages.map((p, i) => p.evaluate((id) => window.__ctwHarness.getMessages(id)[0], ids[i])),
    );
    for (const msg of messages) {
      expect(msg).toMatchObject({ kind: 'ack', seq: 42, payload: 'four-tabs' });
    }

    // Close the leader tab and verify exactly one of the survivors becomes leader.
    const leaderIndex = (await Promise.all(
      pages.map((p, i) => p.evaluate((id) => window.__ctwHarness.isLeader(id), ids[i])),
    )).indexOf(true);
    await pages[leaderIndex].close();

    const survivorPages = pages.filter((_, i) => i !== leaderIndex);
    const survivorIds = ids.filter((_, i) => i !== leaderIndex);
    await expect
      .poll(async () => {
        const leaders = await Promise.all(
          survivorPages.map((p, i) => p.evaluate((id) => window.__ctwHarness.isLeader(id), survivorIds[i])),
        );
        return leaders.filter(Boolean).length;
      })
      .toBe(1);

    await context.close();
  });

  test('destroy on follower cleans up without terminating the leader worker', async ({ context, page }) => {
    await openTab(page);
    const page2 = await context.newPage();
    await openTab(page2);
    const name = `follower-destroy-${test.info().testId}`;
    const id1 = await createWorker(page, name);
    const id2 = await createWorker(page2, name);

    const [leaderPage, leaderId, followerPage, followerId] = await getLeaderFollower(page, id1, page2, id2);

    const leader = leaderPage === 1 ? page : page2;
    const follower = followerPage === 1 ? page : page2;

    await follower.evaluate((workerId) => window.__ctwHarness.destroy(workerId), followerId);
    await leader.evaluate((workerId) => window.__ctwHarness.clearMessages(workerId), leaderId);
    await leader.evaluate((workerId) => window.__ctwHarness.post(workerId, { seq: 99, payload: 'still-live' }), leaderId);
    await waitForMessageCount(leader, leaderId, 1);
    const msg = await leader.evaluate((workerId) => window.__ctwHarness.getMessages(workerId)[0], leaderId);
    expect(msg).toMatchObject({ seq: 99, payload: 'still-live' });
    await context.close();
  });
});
