# Agent Hierarchy Communication Schema

Status: design draft  
Created: 2026-04-26

## Goal

Support a full manager/worker communication product instead of a flat "every child talks to the main coordinator" mailbox.

The target model is an explicit reporting tree:

```text
root / main coordinator
└── CEO
    └── CTO
        ├── engineer A
        ├── engineer B
        └── reviewer / QA / specialist
```

Communication is allowed along authorized hierarchy edges only:

- direct parent -> direct child
- direct child -> direct parent
- root/main -> anyone for admin/audit/override
- optional explicitly-granted delegation edges

Communication is denied by default:

- sibling -> sibling, e.g. engineer A -> engineer B
- descendant -> non-parent ancestor unless a policy explicitly allows escalation
- parent -> non-direct descendant unless using an approved routed chain or override

The database should make this enforceable. Prompts can describe the rule, but the DB/query layer must be the source of truth.

## Design principles

1. **Agents are principals in an org graph, not global chat participants.**
2. **Reporting relationships are first-class edges.** `agents.parent_agent_id` can remain as a compatibility cache, but policy should use an edge table.
3. **Messages are immutable records. Delivery/read state is per recipient.** This avoids global message status bugs and supports read receipts correctly.
4. **Unread counts are derived from recipient delivery rows, not message rows.** Fetching unread inbox rows atomically marks that recipient's rows as read.
5. **Visibility and send permissions are checked from the current actor.** A child session uses `PI_TMUX_AGENTS_CHILD_ID`; root/main has admin scope.
6. **Attention is assigned to an owner/recipient, not just attached to the sender.** If an engineer asks CTO a question, CTO owns the attention item.

## Existing schema issues this fixes

Current tables already have useful columns:

- `agents.parent_agent_id`
- `agent_messages.sender_agent_id`
- `agent_messages.recipient_agent_id`
- `agent_messages.status`
- `attention_items.message_id`

But the current model is too flat:

- `parent_agent_id` is mostly metadata, not an enforced graph.
- `agent_messages.status` is global, so read/delivery state cannot be correct per recipient.
- `subagent_inbox` is main/coordinator-centric.
- `attention_items.agent_id` points at the publishing agent, not the recipient who must act.
- There is no durable ACL decision or route audit.

## Proposed schema additions

These tables can be introduced in a new migration while keeping existing tables for compatibility during migration.

### 1. Agent roles

Roles define coarse authority. They do not grant direct communication by themselves; they validate allowed edge types and defaults.

```sql
CREATE TABLE IF NOT EXISTS agent_roles (
  role_key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  authority_rank INTEGER NOT NULL,
  default_visibility_scope TEXT NOT NULL CHECK (
    default_visibility_scope IN ('self_parent', 'direct_children', 'subtree', 'project', 'root')
  ),
  can_spawn_children INTEGER NOT NULL DEFAULT 0,
  can_admin_override INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_roles_rank
  ON agent_roles(authority_rank ASC);
```

Seed examples:

```sql
INSERT OR IGNORE INTO agent_roles
  (role_key, label, authority_rank, default_visibility_scope, can_spawn_children, can_admin_override, created_at, updated_at)
VALUES
  ('root', 'Root coordinator', 0, 'root', 1, 1, unixepoch('now') * 1000, unixepoch('now') * 1000),
  ('ceo', 'CEO', 10, 'subtree', 1, 0, unixepoch('now') * 1000, unixepoch('now') * 1000),
  ('cto', 'CTO', 20, 'subtree', 1, 0, unixepoch('now') * 1000, unixepoch('now') * 1000),
  ('engineer', 'Engineer', 30, 'self_parent', 0, 0, unixepoch('now') * 1000, unixepoch('now') * 1000),
  ('reviewer', 'Reviewer', 30, 'self_parent', 0, 0, unixepoch('now') * 1000, unixepoch('now') * 1000),
  ('qa-lead', 'QA lead', 30, 'self_parent', 0, 0, unixepoch('now') * 1000, unixepoch('now') * 1000);
```

### 2. Allowed role edges

This controls what reporting lines may exist and what each side may do across that edge.

```sql
CREATE TABLE IF NOT EXISTS agent_role_edge_policies (
  id TEXT PRIMARY KEY,
  parent_role_key TEXT NOT NULL REFERENCES agent_roles(role_key) ON DELETE CASCADE,
  child_role_key TEXT NOT NULL REFERENCES agent_roles(role_key) ON DELETE CASCADE,
  edge_type TEXT NOT NULL CHECK (edge_type IN ('reports_to', 'delegates_to', 'reviews_for', 'escalates_to')),
  allow_spawn INTEGER NOT NULL DEFAULT 0,
  allow_parent_to_child_message INTEGER NOT NULL DEFAULT 1,
  allow_child_to_parent_message INTEGER NOT NULL DEFAULT 1,
  allow_parent_inspect_child INTEGER NOT NULL DEFAULT 1,
  allow_child_inspect_parent INTEGER NOT NULL DEFAULT 1,
  allow_parent_inspect_subtree INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(parent_role_key, child_role_key, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_agent_role_edge_policies_child
  ON agent_role_edge_policies(child_role_key, edge_type);
```

Seed examples:

```text
root -> ceo, reports_to, spawn/message both ways, subtree inspect
ceo -> cto, reports_to, spawn/message both ways, subtree inspect
cto -> engineer, reports_to, spawn/message both ways, direct/subtree inspect
cto -> reviewer, reports_to, spawn/message both ways
cto -> qa-lead, reports_to, spawn/message both ways
```

Do **not** seed `engineer -> engineer`. That absence is what denies developer peer chat even if one knows another agent id.

### 3. Agent orgs

An org groups a hierarchy for a project/session. This lets us support multiple simultaneous hierarchies without overloading `project_key`.

```sql
CREATE TABLE IF NOT EXISTS agent_orgs (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  root_agent_id TEXT NULL REFERENCES agents(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'archived')) DEFAULT 'active',
  metadata_json TEXT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_orgs_project_state_updated
  ON agent_orgs(project_key, state, updated_at DESC);
```

Add compatibility columns to `agents`:

```sql
ALTER TABLE agents ADD COLUMN org_id TEXT NULL REFERENCES agent_orgs(id) ON DELETE SET NULL;
ALTER TABLE agents ADD COLUMN role_key TEXT NULL REFERENCES agent_roles(role_key) ON DELETE SET NULL;
ALTER TABLE agents ADD COLUMN spawned_by_agent_id TEXT NULL REFERENCES agents(id) ON DELETE SET NULL;
ALTER TABLE agents ADD COLUMN hierarchy_state TEXT NOT NULL DEFAULT 'attached'
  CHECK (hierarchy_state IN ('attached', 'detached', 'archived'));

CREATE INDEX IF NOT EXISTS idx_agents_org_role_updated
  ON agents(org_id, role_key, updated_at DESC);
```

`role_key` usually equals `profile`, but keeping it separate allows profiles like `principal-engineer` to map to a role class like `reviewer`.

### 4. Agent hierarchy edges

This is the authoritative reporting/delegation graph.

```sql
CREATE TABLE IF NOT EXISTS agent_edges (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES agent_orgs(id) ON DELETE CASCADE,
  parent_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  child_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  edge_type TEXT NOT NULL CHECK (edge_type IN ('reports_to', 'delegates_to', 'reviews_for', 'escalates_to')),
  role_policy_id TEXT NULL REFERENCES agent_role_edge_policies(id) ON DELETE SET NULL,
  task_id TEXT NULL REFERENCES tasks(id) ON DELETE SET NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'revoked', 'archived')) DEFAULT 'active',
  created_by_agent_id TEXT NULL REFERENCES agents(id) ON DELETE SET NULL,
  created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('root', 'agent', 'system')),
  reason TEXT NULL,
  metadata_json TEXT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER NULL,
  CHECK (parent_agent_id <> child_agent_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_edges_active_reports_child
  ON agent_edges(child_agent_id, edge_type)
  WHERE state = 'active' AND edge_type = 'reports_to';

CREATE INDEX IF NOT EXISTS idx_agent_edges_parent_active
  ON agent_edges(parent_agent_id, state, edge_type, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_edges_child_active
  ON agent_edges(child_agent_id, state, edge_type, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_edges_org_active
  ON agent_edges(org_id, state, edge_type, updated_at DESC);
```

`agents.parent_agent_id` can be kept in sync with the active `reports_to` edge for legacy filters.

### 5. Hierarchy closure table

Recursive CTEs can answer hierarchy questions, but a closure table makes visibility checks fast and simple.

```sql
CREATE TABLE IF NOT EXISTS agent_hierarchy_closure (
  org_id TEXT NOT NULL REFERENCES agent_orgs(id) ON DELETE CASCADE,
  ancestor_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  descendant_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  depth INTEGER NOT NULL,
  through_edge_id TEXT NULL REFERENCES agent_edges(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, ancestor_agent_id, descendant_agent_id),
  CHECK (depth >= 0)
);

CREATE INDEX IF NOT EXISTS idx_agent_hierarchy_descendant_depth
  ON agent_hierarchy_closure(descendant_agent_id, depth ASC);

CREATE INDEX IF NOT EXISTS idx_agent_hierarchy_ancestor_depth
  ON agent_hierarchy_closure(ancestor_agent_id, depth ASC);
```

Rows include self links with `depth = 0`.

Cycle prevention rule before creating an active edge:

```sql
-- Deny parent -> child if child is already an ancestor of parent.
SELECT 1
FROM agent_hierarchy_closure
WHERE org_id = :org_id
  AND ancestor_agent_id = :child_agent_id
  AND descendant_agent_id = :parent_agent_id;
```

### 6. Explicit grants / temporary delegation

This supports product-grade exceptions without breaking the org tree. Example: CTO grants a reviewer read access to a sibling engineer's task context without allowing chat.

```sql
CREATE TABLE IF NOT EXISTS agent_access_grants (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES agent_orgs(id) ON DELETE CASCADE,
  grantee_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  subject_agent_id TEXT NULL REFERENCES agents(id) ON DELETE CASCADE,
  subject_task_id TEXT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  grant_kind TEXT NOT NULL CHECK (
    grant_kind IN ('inspect_agent', 'inspect_subtree', 'inspect_task', 'message_agent', 'message_thread')
  ),
  granted_by_agent_id TEXT NULL REFERENCES agents(id) ON DELETE SET NULL,
  granted_by_kind TEXT NOT NULL CHECK (granted_by_kind IN ('root', 'agent', 'system')),
  reason TEXT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked', 'expired')) DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NULL,
  revoked_at INTEGER NULL,
  CHECK (subject_agent_id IS NOT NULL OR subject_task_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_agent_access_grants_grantee_active
  ON agent_access_grants(grantee_agent_id, state, expires_at);
```

Default implementation should not need grants for CEO/CTO/developer. Grants are for later product cases.

## Communication schema v2

### 7. Message threads

A thread groups a conversation around a task, escalation, blocker, review, or command.

```sql
CREATE TABLE IF NOT EXISTS agent_threads (
  id TEXT PRIMARY KEY,
  org_id TEXT NULL REFERENCES agent_orgs(id) ON DELETE SET NULL,
  project_key TEXT NOT NULL,
  task_id TEXT NULL REFERENCES tasks(id) ON DELETE SET NULL,
  subject_agent_id TEXT NULL REFERENCES agents(id) ON DELETE SET NULL,
  parent_thread_id TEXT NULL REFERENCES agent_threads(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (
    kind IN ('task_update', 'question', 'blocker', 'escalation', 'review', 'command', 'handoff', 'broadcast')
  ),
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'waiting', 'resolved', 'cancelled', 'archived')) DEFAULT 'open',
  created_by_agent_id TEXT NULL REFERENCES agents(id) ON DELETE SET NULL,
  created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('root', 'agent', 'user', 'system')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER NULL,
  metadata_json TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_threads_org_state_updated
  ON agent_threads(org_id, state, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_threads_task_state_updated
  ON agent_threads(task_id, state, updated_at DESC);
```

### 8. Immutable messages

Messages are immutable content. Do not store read/unread state here.

```sql
CREATE TABLE IF NOT EXISTS agent_messages_v2 (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  org_id TEXT NULL REFERENCES agent_orgs(id) ON DELETE SET NULL,
  project_key TEXT NOT NULL,
  sender_agent_id TEXT NULL REFERENCES agents(id) ON DELETE SET NULL,
  sender_kind TEXT NOT NULL CHECK (sender_kind IN ('root', 'agent', 'user', 'system')),
  kind TEXT NOT NULL CHECK (
    kind IN ('started', 'milestone', 'blocked', 'question', 'question_for_user', 'answer', 'note', 'redirect', 'cancel', 'priority', 'complete', 'handoff', 'escalation')
  ),
  summary TEXT NOT NULL,
  body_markdown TEXT NULL,
  payload_json TEXT NULL,
  action_policy TEXT NULL CHECK (action_policy IN ('fyi', 'resume_if_blocked', 'replan', 'interrupt_and_replan', 'stop')),
  priority INTEGER NOT NULL DEFAULT 3,
  requires_response INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  supersedes_message_id TEXT NULL REFERENCES agent_messages_v2(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_v2_thread_created
  ON agent_messages_v2(thread_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_agent_messages_v2_sender_created
  ON agent_messages_v2(sender_agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_messages_v2_project_created
  ON agent_messages_v2(project_key, created_at DESC);
```

### 9. Per-recipient delivery/read receipts

This is the key queue/read-receipt table.

```sql
CREATE TABLE IF NOT EXISTS agent_message_recipients (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES agent_messages_v2(id) ON DELETE CASCADE,
  recipient_agent_id TEXT NULL REFERENCES agents(id) ON DELETE CASCADE,
  recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('root', 'agent', 'user')),
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('immediate', 'steer', 'follow_up', 'idle_only', 'inbox_only')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'notified', 'read', 'acked', 'failed', 'expired')) DEFAULT 'queued',
  transport_kind TEXT NULL CHECK (transport_kind IN ('root_ui', 'rpc_bridge', 'poll_fallback', 'inbox')),
  route_id TEXT NULL,
  queued_at INTEGER NOT NULL,
  notified_at INTEGER NULL,
  read_at INTEGER NULL,
  acked_at INTEGER NULL,
  failed_at INTEGER NULL,
  expired_at INTEGER NULL,
  failure_summary TEXT NULL,
  metadata_json TEXT NULL,
  CHECK (recipient_kind <> 'agent' OR recipient_agent_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_message_recipients_unique
  ON agent_message_recipients(message_id, recipient_kind, recipient_agent_id);

CREATE INDEX IF NOT EXISTS idx_agent_message_recipients_agent_unread
  ON agent_message_recipients(recipient_agent_id, status, queued_at ASC)
  WHERE recipient_kind = 'agent' AND status IN ('queued', 'notified');

CREATE INDEX IF NOT EXISTS idx_agent_message_recipients_root_unread
  ON agent_message_recipients(recipient_kind, status, queued_at ASC)
  WHERE recipient_kind = 'root' AND status IN ('queued', 'notified');
```

Unread inbox query for a child agent must be atomic:

```sql
BEGIN IMMEDIATE;

SELECT m.*, r.id AS recipient_row_id
FROM agent_message_recipients r
JOIN agent_messages_v2 m ON m.id = r.message_id
WHERE r.recipient_kind = 'agent'
  AND r.recipient_agent_id = :current_agent_id
  AND r.status IN ('queued', 'notified')
ORDER BY r.queued_at ASC
LIMIT :limit;

UPDATE agent_message_recipients
SET status = 'read', read_at = :now
WHERE id IN (:recipient_row_ids)
  AND status IN ('queued', 'notified');

COMMIT;
```

For root/main inbox, use `recipient_kind = 'root'`.

### 10. Route audit / hops

Routes capture why a message was allowed and how it should travel. This is useful for debugging and for future multi-hop escalation.

```sql
CREATE TABLE IF NOT EXISTS agent_message_routes (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES agent_messages_v2(id) ON DELETE CASCADE,
  org_id TEXT NULL REFERENCES agent_orgs(id) ON DELETE SET NULL,
  from_agent_id TEXT NULL REFERENCES agents(id) ON DELETE SET NULL,
  to_agent_id TEXT NULL REFERENCES agents(id) ON DELETE SET NULL,
  from_kind TEXT NOT NULL CHECK (from_kind IN ('root', 'agent', 'user', 'system')),
  to_kind TEXT NOT NULL CHECK (to_kind IN ('root', 'agent', 'user')),
  route_kind TEXT NOT NULL CHECK (
    route_kind IN ('direct_parent', 'direct_child', 'root_override', 'explicit_grant', 'multi_hop', 'user_escalation')
  ),
  edge_id TEXT NULL REFERENCES agent_edges(id) ON DELETE SET NULL,
  policy_id TEXT NULL REFERENCES agent_role_edge_policies(id) ON DELETE SET NULL,
  grant_id TEXT NULL REFERENCES agent_access_grants(id) ON DELETE SET NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allowed', 'denied')),
  decision_reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_message_routes_message
  ON agent_message_routes(message_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_agent_message_routes_to_created
  ON agent_message_routes(to_agent_id, created_at DESC);
```

Denied sends should also insert a route row with `decision = 'denied'` and no recipient row, then throw a tool error. This gives a durable audit trail for attempted sibling messaging.

### 11. Attention items v2

The existing `attention_items` table can be migrated or extended. The important change is to assign attention to the actor who must respond.

```sql
CREATE TABLE IF NOT EXISTS agent_attention_items_v2 (
  id TEXT PRIMARY KEY,
  message_id TEXT NULL REFERENCES agent_messages_v2(id) ON DELETE SET NULL,
  recipient_row_id TEXT NULL REFERENCES agent_message_recipients(id) ON DELETE SET NULL,
  org_id TEXT NULL REFERENCES agent_orgs(id) ON DELETE SET NULL,
  project_key TEXT NOT NULL,
  task_id TEXT NULL REFERENCES tasks(id) ON DELETE SET NULL,
  subject_agent_id TEXT NULL REFERENCES agents(id) ON DELETE SET NULL,
  owner_agent_id TEXT NULL REFERENCES agents(id) ON DELETE SET NULL,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('root', 'agent', 'user')),
  kind TEXT NOT NULL CHECK (kind IN ('question', 'question_for_user', 'blocked', 'complete', 'approval', 'change_request')),
  priority INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'acknowledged', 'waiting_on_owner', 'resolved', 'cancelled', 'superseded')),
  summary TEXT NOT NULL,
  payload_json TEXT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER NULL,
  resolution_kind TEXT NULL,
  resolution_summary TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_attention_owner_state_priority
  ON agent_attention_items_v2(owner_kind, owner_agent_id, state, priority ASC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_attention_subject_state_priority
  ON agent_attention_items_v2(subject_agent_id, state, priority ASC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_attention_task_state_priority
  ON agent_attention_items_v2(task_id, state, priority ASC, updated_at DESC);
```

Example: engineer publishes a blocker to CTO.

- `subject_agent_id = engineer`
- `owner_agent_id = CTO`
- `owner_kind = agent`
- `kind = blocked`
- `state = waiting_on_owner`

Root can still see it as admin, but CTO owns the next action.

## Permission checks

### Direct send check

Pseudo-code:

```ts
function canSendMessage(actor, recipient, kind): Decision {
  if (actor.kind === 'root') return allow('root_override');
  if (actor.kind !== 'agent') return deny('unsupported sender');

  if (recipient.kind === 'root') {
    return allowTopLevelEscalationIfNoParentOrExplicitPolicy(actor.agentId);
  }

  if (recipient.kind !== 'agent') return deny('unsupported recipient');

  const directDown = activeEdge(parent = actor.agentId, child = recipient.agentId);
  if (directDown && rolePolicyAllowsParentToChild(directDown, kind)) {
    return allow('direct_child', directDown.edgeId, directDown.policyId);
  }

  const directUp = activeEdge(parent = recipient.agentId, child = actor.agentId);
  if (directUp && rolePolicyAllowsChildToParent(directUp, kind)) {
    return allow('direct_parent', directUp.edgeId, directUp.policyId);
  }

  const grant = activeGrant(actor.agentId, recipient.agentId, 'message_agent');
  if (grant) return allow('explicit_grant', grant.id);

  return deny('No active direct hierarchy edge or message grant.');
}
```

This denies engineer A -> engineer B because there is no direct parent/child edge and no seeded role edge.

### Visibility check

Default child visibility:

```text
self: always visible
parent: visible if active parent edge allows child inspect parent
direct children: visible if active child edge allows parent inspect child
subtree: visible if role/default/policy allows subtree inspect
explicit grants: visible according to grant
root/main: all visible
```

All list/get/inbox/attention queries should derive an allowed agent-id set first, then query with that set.

## Tool behavior on top of this schema

### `subagent_spawn`

- Root can choose any valid top-level parent.
- Inside a child session, default `parentAgentId = currentAgentId`.
- If a child passes a different parent, validate an admin/grant override.
- Validate `agent_role_edge_policies.allow_spawn` for parent role -> child role.
- Insert `agents`, `agent_edges`, closure rows, task link, and event in one transaction.

### `subagent_publish`

- Does not accept arbitrary recipient ids for normal use.
- Resolves recipient as:
  1. direct parent agent if active `reports_to` edge exists
  2. root/main if no parent exists
  3. user only for `question_for_user`
- Creates thread/message/recipient/route/attention rows.
- Attempts live delivery to recipient bridge if recipient is an active agent.
- Falls back to inbox queue.

### `subagent_message`

- Accepts target agent id.
- Uses `canSendMessage` before queueing.
- Root/main may override.
- Child sessions may send to direct parent or direct children only, unless explicit grant.
- Creates route audit row for allowed and denied attempts.

### `subagent_inbox`

- In root/main: fetch root recipient rows by default, with admin options for all.
- In child session: fetch rows where `recipient_agent_id = currentAgentId`.
- Fetch marks returned rows read atomically.
- History mode can include `read`/`acked` rows without changing status.

### `subagent_attention`

- In root/main: admin view, optionally grouped by owner.
- In child session: items where `owner_agent_id = currentAgentId`, plus subtree if policy allows.

### `subagent_list` / `subagent_get`

- In root/main: current project/session filters remain admin views.
- In child session: default to visible hierarchy slice.
- Add explicit admin override only available from root/main.

## Migration path from current schema

1. Add role/org/edge/closure/message-v2/recipient/route/attention-v2 tables.
2. Backfill `agent_roles` from known profile names.
3. Create one `agent_orgs` row per project/session or per active root session.
4. Backfill `agents.org_id` and `agents.role_key`.
5. For every `agents.parent_agent_id`, create active `agent_edges` rows.
6. Build closure rows for all active `reports_to` edges.
7. Keep old `agent_messages` writes during compatibility period, but write v2 rows for new communication.
8. Switch unread counts to `agent_message_recipients`.
9. Switch attention surfaces to `agent_attention_items_v2`.
10. Remove or archive old mailbox queries after compatibility is proven.

## Product invariant checklist

- Sibling developers cannot message each other because there is no active edge or grant.
- CTO can message direct developers because `cto -> engineer` edge exists and policy allows parent->child.
- Developers can talk to CTO because the same edge allows child->parent.
- CEO can message CTO and CTO can message CEO through the `ceo -> cto` edge.
- CTO escalations to CEO are owned by CEO, not root/main.
- Root/main can inspect and override everything, but normal queue ownership is hierarchical.
- Read receipts are per recipient and automatic on inbox fetch.
- Message history remains intact even after messages are read.
