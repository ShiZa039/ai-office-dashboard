import * as assert from 'assert';
import { AgentStateStore } from '../src/agentState';
import { AgentEvent } from '../src/types';

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

// --- session_stop only resets agents in this store (filter is implicit) ---

{
  const storeA = new AgentStateStore();
  storeA.setCwdFilter('/home/user/projectA');
  storeA.processEvent(mkEvent({ cwd: '/home/user/projectA' }));

  // Simulate session_stop coming from ANOTHER project → dropped entirely
  storeA.processEvent({
    ts: new Date().toISOString(),
    event: 'session_stop',
    agent: '',
    session: 'S2',
    cwd: '/home/user/projectB',
  });

  assert.strictEqual(
    storeA.getSnapshot()['backend-lead'].state,
    'working',
    'session_stop from other project does not reset our agents',
  );

  // Session_stop from OUR project does reset
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
    'session_stop from our project resets our agents',
  );
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

console.log('All agentState tests passed.');
