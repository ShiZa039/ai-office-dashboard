import * as assert from 'assert';
import { AgentStateStore } from '../src/agentState';
import { AgentEvent, MAIN_AGENT_NAME } from '../src/types';

function mkEvent(overrides: Partial<AgentEvent>): AgentEvent {
  return {
    ts: new Date().toISOString(),
    event: 'agent_start',
    agent: 'backend-lead',
    session: 'S1',
    cwd: '/home/user/projectA',
    ...overrides,
  };
}

// --- No filter: legacy global behavior (everything passes) ---

{
  const store = new AgentStateStore();
  store.processEvent(mkEvent({ cwd: '/home/user/projectA' }));
  store.processEvent(mkEvent({ agent: 'qa-lead', cwd: '/home/user/projectB' }));
  const snap = store.getSnapshot();
  assert.ok(snap['backend-lead'], 'no filter: accepts projectA');
  assert.ok(snap['qa-lead'], 'no filter: accepts projectB');
}

// --- With filter: other-project events are dropped ---

{
  const store = new AgentStateStore();
  store.setCwdFilter('/home/user/projectA');
  store.processEvent(mkEvent({ cwd: '/home/user/projectA' }));
  store.processEvent(mkEvent({ agent: 'qa-lead', cwd: '/home/user/projectB' }));
  const snap = store.getSnapshot();
  assert.ok(snap['backend-lead'], 'filter matches: projectA kept');
  assert.ok(!snap['qa-lead'], 'filter rejects: projectB dropped');
}

// --- Filter with Windows backslashes + case differences ---

{
  const store = new AgentStateStore();
  store.setCwdFilter('D:\\Code projects\\BAZA_CRM');
  store.processEvent(mkEvent({ cwd: 'd:/Code projects/BAZA_CRM' }));
  store.processEvent(mkEvent({ agent: 'qa-lead', cwd: 'D:/Code projects/Other' }));
  const snap = store.getSnapshot();
  assert.ok(snap['backend-lead'], 'normalized path match (slashes + case)');
  assert.ok(!snap['qa-lead'], 'non-matching sibling folder dropped');
}

// --- Multi-root filter: any of several folders matches (.code-workspace) ---

{
  const store = new AgentStateStore();
  store.setCwdFilter(['/home/user/projectA', '/home/user/projectB']);
  store.processEvent(mkEvent({ cwd: '/home/user/projectA' }));
  store.processEvent(mkEvent({ agent: 'qa-lead', cwd: '/home/user/projectB' }));
  store.processEvent(mkEvent({ agent: 'devops-lead', cwd: '/home/user/projectC' }));
  const snap = store.getSnapshot();
  assert.ok(snap['backend-lead'], 'multi-root: first folder matches');
  assert.ok(snap['qa-lead'], 'multi-root: second folder matches');
  assert.ok(!snap['devops-lead'], 'multi-root: unlisted folder dropped');
}

// --- Subfolder invocation counts as a match (startsWith) ---

{
  const store = new AgentStateStore();
  store.setCwdFilter('/home/user/projectA');
  store.processEvent(mkEvent({ cwd: '/home/user/projectA/apps/crm' }));
  assert.ok(store.getSnapshot()['backend-lead'], 'subfolder cwd still matches');
}

// --- Sibling whose name prefixes ours shouldn't match (no slash boundary) ---

{
  const store = new AgentStateStore();
  store.setCwdFilter('/home/user/project');
  store.processEvent(mkEvent({ cwd: '/home/user/projectABC' }));
  assert.ok(!store.getSnapshot()['backend-lead'], 'prefix without slash boundary rejected');
}

// --- session_stop (turn end) never kills working agents; tidies finished ones ---

{
  const storeA = new AgentStateStore();
  storeA.setCwdFilter('/home/user/projectA');
  storeA.processEvent(mkEvent({ cwd: '/home/user/projectA' }));

  // Main turn ends while the background agent still runs → agent survives.
  storeA.processEvent({
    ts: new Date().toISOString(),
    event: 'session_stop',
    agent: '',
    session: 'S1',
    cwd: '/home/user/projectA',
  });
  assert.strictEqual(
    storeA.getSnapshot()['backend-lead'].state,
    'working',
    'turn-end session_stop leaves working agents alone',
  );

  // Once the agent is done, the next turn-end sweeps the badge to idle.
  storeA.processEvent(mkEvent({ event: 'agent_stop', cwd: '/home/user/projectA' }));
  assert.strictEqual(storeA.getSnapshot()['backend-lead'].state, 'done');
  storeA.processEvent({
    ts: new Date().toISOString(),
    event: 'session_stop',
    agent: '',
    session: 'S1',
    cwd: '/home/user/projectA',
  });
  assert.strictEqual(
    storeA.getSnapshot()['backend-lead'].state,
    'idle',
    'session_stop tidies finished agents to idle',
  );
  storeA.stop();
}

// --- Real-world regression: parallel background agents vs turn-end Stop ---
// agent_start ×2 → session_stop (main turn ended) → agent_stop ×2 later.

{
  const store = new AgentStateStore();
  store.processEvent(mkEvent({ agent: 'mqtt-broker-specialist' }));
  store.processEvent(mkEvent({ agent: 'docs-writer' }));
  store.processEvent(mkEvent({ event: 'session_stop', agent: '' }));

  let snap = store.getSnapshot();
  assert.strictEqual(snap['mqtt-broker-specialist'].state, 'working', 'agent 1 survives turn end');
  assert.strictEqual(snap['docs-writer'].state, 'working', 'agent 2 survives turn end');

  store.processEvent(mkEvent({ event: 'agent_stop', agent: 'docs-writer' }));
  snap = store.getSnapshot();
  assert.strictEqual(snap['docs-writer'].state, 'done', 'own stop lands as done');
  assert.strictEqual(snap['mqtt-broker-specialist'].state, 'working', 'other agent unaffected');
  store.stop();
}

// --- Event without cwd is dropped when filter is set (strict mode) ---

{
  const store = new AgentStateStore();
  store.setCwdFilter('/home/user/projectA');
  store.processEvent(mkEvent({ cwd: undefined }));
  assert.ok(
    !store.getSnapshot()['backend-lead'],
    'events without cwd dropped under filter',
  );
}

// --- Model tracking: any event carrying model updates it, newest wins ---

{
  const store = new AgentStateStore();
  assert.strictEqual(store.getModel(), null, 'model unknown initially');

  store.processEvent(mkEvent({ event: 'session_start', agent: '', model: 'claude-fable-5' }));
  assert.strictEqual(store.getModel(), 'claude-fable-5', 'session_start sets model');
  assert.strictEqual(
    Object.keys(store.getSnapshot()).length,
    0,
    'session_start does not create agents',
  );

  store.processEvent(mkEvent({ event: 'agent_stop', model: 'claude-sonnet-5' }));
  assert.strictEqual(store.getModel(), 'claude-sonnet-5', 'later event overrides model');

  store.processEvent(mkEvent({ event: 'agent_start', agent: 'qa-lead' }));
  assert.strictEqual(store.getModel(), 'claude-sonnet-5', 'event without model keeps last known');

  store.clear();
  assert.strictEqual(store.getModel(), null, 'clear resets model');
}

// --- Model tracking respects the cwd filter ---

{
  const store = new AgentStateStore();
  store.setCwdFilter('/home/user/projectA');
  store.processEvent(
    mkEvent({ event: 'session_start', agent: '', cwd: '/home/user/projectB', model: 'claude-opus-4-8' }),
  );
  assert.strictEqual(store.getModel(), null, 'model from other project ignored');

  store.processEvent(
    mkEvent({ event: 'session_start', agent: '', cwd: '/home/user/projectA', model: 'claude-opus-4-8' }),
  );
  assert.strictEqual(store.getModel(), 'claude-opus-4-8', 'model from our project applied');
}

// --- Parallel same-type agents: one stop must not hide the rest ---

{
  const store = new AgentStateStore();
  store.processEvent(mkEvent({ agent: 'Explore', task: 'find A' }));
  store.processEvent(mkEvent({ agent: 'Explore', task: 'find B' }));
  store.processEvent(mkEvent({ agent: 'Explore', task: 'find C' }));

  let snap = store.getSnapshot();
  assert.strictEqual(snap['Explore'].state, 'working', 'parallel starts keep working');
  assert.strictEqual(snap['Explore'].activeCount, 3, 'three instances counted');

  store.processEvent(mkEvent({ event: 'agent_stop', agent: 'Explore', task: 'done A' }));
  snap = store.getSnapshot();
  assert.strictEqual(snap['Explore'].state, 'working', 'still working after first stop');
  assert.strictEqual(snap['Explore'].activeCount, 2, 'count drained by one');

  store.processEvent(mkEvent({ event: 'agent_stop', agent: 'Explore', task: 'done B' }));
  store.processEvent(mkEvent({ event: 'agent_stop', agent: 'Explore', task: 'done C' }));
  snap = store.getSnapshot();
  assert.strictEqual(snap['Explore'].state, 'done', 'last stop flips to done');

  store.stop();
}

// --- Unmatched stop (no prior start) still lands as done, count never negative ---

{
  const store = new AgentStateStore();
  store.processEvent(mkEvent({ event: 'agent_stop', agent: 'qa-lead' }));
  const snap = store.getSnapshot();
  assert.strictEqual(snap['qa-lead'].state, 'done', 'orphan stop shows done');
  store.stop();
}

// --- session_stop preserves parallel counters of running agents ---

{
  const store = new AgentStateStore();
  store.processEvent(mkEvent({ agent: 'Explore' }));
  store.processEvent(mkEvent({ agent: 'Explore' }));
  store.processEvent(mkEvent({ event: 'session_stop', agent: '' }));
  const snap = store.getSnapshot();
  assert.strictEqual(snap['Explore'].state, 'working', 'parallel agents survive turn end');
  assert.strictEqual(snap['Explore'].activeCount, 2, 'counter preserved');
  store.stop();
}

// --- Waiting: Notification sets it, user activity clears it ---

{
  const store = new AgentStateStore();
  assert.strictEqual(store.getWaiting(), null, 'no waiting initially');

  store.processEvent(
    mkEvent({ event: 'agent_waiting', agent: '', task: 'Claude needs your permission to use Bash' }),
  );
  const w = store.getWaiting();
  assert.ok(w, 'notification sets waiting');
  assert.strictEqual(w!.message, 'Claude needs your permission to use Bash', 'message carried');

  store.processEvent(mkEvent({ event: 'user_prompt', agent: '' }));
  assert.strictEqual(store.getWaiting(), null, 'user prompt clears waiting');
}

// --- Waiting cleared by resumed agent activity and by session_stop ---

{
  const store = new AgentStateStore();
  store.processEvent(mkEvent({ event: 'agent_waiting', agent: '', task: 'permission?' }));
  store.processEvent(mkEvent({ event: 'agent_start' }));
  assert.strictEqual(store.getWaiting(), null, 'agent_start clears waiting');

  store.processEvent(mkEvent({ event: 'agent_waiting', agent: '', task: 'permission?' }));
  store.processEvent(mkEvent({ event: 'session_stop', agent: '' }));
  assert.strictEqual(store.getWaiting(), null, 'session_stop clears waiting');
}

// --- Stale notifications replayed from history never raise the banner ---

{
  const store = new AgentStateStore();
  const oldTs = new Date(Date.now() - 25 * 60 * 1000).toISOString();
  store.processEvent(mkEvent({ event: 'agent_waiting', agent: '', task: 'old', ts: oldTs }));
  assert.strictEqual(store.getWaiting(), null, 'stale notification ignored');
}

// --- Waiting respects the cwd filter ---

{
  const store = new AgentStateStore();
  store.setCwdFilter('/home/user/projectA');
  store.processEvent(
    mkEvent({ event: 'agent_waiting', agent: '', task: 'other', cwd: '/home/user/projectB' }),
  );
  assert.strictEqual(store.getWaiting(), null, 'notification from other project ignored');

  store.processEvent(
    mkEvent({ event: 'agent_waiting', agent: '', task: 'ours', cwd: '/home/user/projectA' }),
  );
  assert.ok(store.getWaiting(), 'notification from our project raises waiting');

  // user_prompt from ANOTHER project must not clear our waiting
  store.processEvent(mkEvent({ event: 'user_prompt', agent: '', cwd: '/home/user/projectB' }));
  assert.ok(store.getWaiting(), 'user prompt from other project does not clear waiting');
}

// --- Main model figure: user_prompt → working in directors, Stop → done ---

{
  const store = new AgentStateStore();
  store.processEvent(mkEvent({ event: 'session_start', agent: '', model: 'claude-fable-5' }));
  store.processEvent(mkEvent({ event: 'user_prompt', agent: '' }));

  let main = store.getSnapshot()[MAIN_AGENT_NAME];
  assert.ok(main, 'main figure appears on user prompt');
  assert.strictEqual(main.state, 'working', 'main is working during the turn');
  assert.strictEqual(main.room, 'directors', 'main sits with the directors');
  assert.strictEqual(main.task, 'claude-fable-5', 'model shown as the task');
  assert.strictEqual(main.activeCount, 1, 'one session');

  store.processEvent(mkEvent({ event: 'session_stop', agent: '' }));
  main = store.getSnapshot()[MAIN_AGENT_NAME];
  assert.strictEqual(main.state, 'done', 'turn end flips main to done');
  assert.strictEqual(main.activeCount, undefined, 'counter cleared');
  store.stop();
  store.clear();
}

// --- Main model: two parallel sessions in one project ---

{
  const store = new AgentStateStore();
  store.processEvent(mkEvent({ event: 'user_prompt', agent: '', session: 'S1' }));
  store.processEvent(mkEvent({ event: 'user_prompt', agent: '', session: 'S2' }));
  assert.strictEqual(store.getSnapshot()[MAIN_AGENT_NAME].activeCount, 2, 'two sessions counted');

  store.processEvent(mkEvent({ event: 'session_stop', agent: '', session: 'S1' }));
  let main = store.getSnapshot()[MAIN_AGENT_NAME];
  assert.strictEqual(main.state, 'working', 'still working while another session runs');
  assert.strictEqual(main.activeCount, 1, 'counter drained');

  store.processEvent(mkEvent({ event: 'session_stop', agent: '', session: 'S2' }));
  assert.strictEqual(store.getSnapshot()[MAIN_AGENT_NAME].state, 'done', 'last turn ends main');
  store.stop();
  store.clear();
}

// --- Background agent_stop AFTER turn end must not resurrect main ---

{
  const store = new AgentStateStore();
  store.processEvent(mkEvent({ event: 'user_prompt', agent: '', session: 'S1' }));
  store.processEvent(mkEvent({ agent: 'docs-writer', session: 'S1' }));
  store.processEvent(mkEvent({ event: 'session_stop', agent: '', session: 'S1' }));
  store.processEvent(mkEvent({ event: 'agent_stop', agent: 'docs-writer', session: 'S1' }));

  const snap = store.getSnapshot();
  assert.strictEqual(snap[MAIN_AGENT_NAME].state, 'done', 'main stays finished');
  assert.strictEqual(snap['docs-writer'].state, 'done', 'agent lands as done');
  store.stop();
  store.clear();
}

// --- Main model respects the cwd filter ---

{
  const store = new AgentStateStore();
  store.setCwdFilter('/home/user/projectA');
  store.processEvent(mkEvent({ event: 'user_prompt', agent: '', cwd: '/home/user/projectB' }));
  assert.ok(!store.getSnapshot()[MAIN_AGENT_NAME], 'prompt from other project ignored');
}

// --- clear() resets waiting ---

{
  const store = new AgentStateStore();
  store.processEvent(mkEvent({ event: 'agent_waiting', agent: '', task: 'x' }));
  store.clear();
  assert.strictEqual(store.getWaiting(), null, 'clear resets waiting');
}

console.log('All agentState tests passed.');
