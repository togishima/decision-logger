import { test } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateReminder,
  recordNotification,
  recordDistillation,
  readState,
} from "../src/core/review/reminder.ts";
import { insertDecision, markReviewed, countUnreviewed, listDecisions } from "../src/core/storage/decisions-repo.ts";
import { insertProposal, getProposal } from "../src/core/storage/proposals-repo.ts";
import { acceptProposal } from "../src/core/review/actions.ts";
import { rendererFor, listRenderers } from "../src/renderers/registry.ts";
import { PROPOSAL_KINDS } from "../src/core/model/proposal.ts";
import type { Db } from "../src/core/storage/db.ts";
import { testDb, testConfig } from "./helpers.ts";

const WS = "ws_test";

function seed(db: Db, count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(
      insertDecision(db, {
        workspaceId: WS,
        source: "claude-code",
        sourceSessionId: `s${i}`,
        domain: "software-engineering",
        category: "tradeoff",
        subject: `Subject ${i}`,
        decision: `Decision ${i}`,
        reasoning: `Reason ${i}`,
      }).id,
    );
  }
  return ids;
}

/* ------------------------------------------------------------------ */
/* Review state and reminders                                          */
/* ------------------------------------------------------------------ */

test("the unreviewed count reflects what distillation has not yet seen", () => {
  const db = testDb();
  const ids = seed(db, 5);
  assert.equal(countUnreviewed(db, WS), 5);

  markReviewed(db, ids.slice(0, 3));
  assert.equal(countUnreviewed(db, WS), 2);
  assert.equal(listDecisions(db, { unreviewedOnly: true }).length, 2);
});

test("marking reviewed is idempotent", () => {
  const db = testDb();
  const ids = seed(db, 3);
  assert.equal(markReviewed(db, ids), 3);
  assert.equal(markReviewed(db, ids), 0, "an already reviewed decision is not re-stamped");
});

test("the reminder threshold gates notification", () => {
  const db = testDb();
  const config = testConfig().notifications;
  config.unreviewedThreshold = 5;

  seed(db, 4);
  assert.equal(evaluateReminder(db, config, { workspaceId: WS }).notify, false);

  seed(db, 1);
  const decision = evaluateReminder(db, config, { workspaceId: WS });
  assert.equal(decision.notify, true);
  assert.match(decision.message ?? "", /5 unreviewed decisions/);
  assert.match(decision.message ?? "", /\/distill/);
});

test("a reminder never fires on an empty store, however old", () => {
  const db = testDb();
  const config = testConfig().notifications;
  config.reviewAgeDays = 14;

  // Last distillation a year ago, nothing waiting: the time trigger alone
  // must not produce an infinite reminder.
  recordDistillation(db, new Date(Date.now() - 365 * 86_400_000));

  const decision = evaluateReminder(db, config, { workspaceId: WS });
  assert.equal(decision.notify, false);
  assert.match(decision.reason, /nothing unreviewed/);
});

test("the age threshold fires once decisions are waiting", () => {
  const db = testDb();
  const config = testConfig().notifications;
  config.unreviewedThreshold = 1000;
  config.reviewAgeDays = 14;

  seed(db, 2);
  recordDistillation(db, new Date(Date.now() - 30 * 86_400_000));

  const decision = evaluateReminder(db, config, { workspaceId: WS });
  assert.equal(decision.notify, true);
  assert.match(decision.reason, /review age/);
});

test("a reminder fires at most once per session", () => {
  const db = testDb();
  const config = testConfig().notifications;
  config.unreviewedThreshold = 1;
  seed(db, 3);

  const first = evaluateReminder(db, config, { workspaceId: WS, sessionId: "abc" });
  assert.equal(first.notify, true);
  recordNotification(db, "abc");

  const second = evaluateReminder(db, config, { workspaceId: WS, sessionId: "abc" });
  assert.equal(second.notify, false);
  assert.match(second.reason, /already notified in this session/);
});

test("the cooldown suppresses a reminder in a new session", () => {
  const db = testDb();
  const config = testConfig().notifications;
  config.unreviewedThreshold = 1;
  config.cooldownHours = 20;
  seed(db, 3);

  recordNotification(db, "session-1");
  const next = evaluateReminder(db, config, { workspaceId: WS, sessionId: "session-2" });
  assert.equal(next.notify, false);
  assert.match(next.reason, /cooldown/);
});

test("notifications can be switched off entirely", () => {
  const db = testDb();
  const config = testConfig().notifications;
  config.enabled = false;
  config.unreviewedThreshold = 1;
  seed(db, 50);

  assert.equal(evaluateReminder(db, config, { workspaceId: WS }).notify, false);
});

test("reminder state reports what it used to decide", () => {
  const db = testDb();
  seed(db, 3);
  recordDistillation(db, new Date(Date.now() - 5 * 86_400_000));

  const state = readState(db, WS);
  assert.equal(state.unreviewed, 3);
  assert.equal(state.daysSinceDistill, 5);
});

/* ------------------------------------------------------------------ */
/* Renderer boundary                                                   */
/* ------------------------------------------------------------------ */

function proposalFor(db: Db, domain: string) {
  const ids = seed(db, 2);
  const proposal = insertProposal(db, {
    domain,
    kind: "principle",
    title: "Check the existing stack first",
    statement:
      "Before introducing a new managed service, verify that the existing stack cannot satisfy the requirement.",
    rationale: "Three separate rejections came down to the same reasoning.",
    evidenceDecisionIds: ids,
  });
  return { proposal: acceptProposal(db, proposal.id), evidence: ids.map((id) => ({ id })) };
}

test("renderer-specific markup never leaks into the stored proposal", () => {
  const db = testDb();
  const { proposal } = proposalFor(db, "software-engineering");
  const renderer = rendererFor("software-engineering");

  const before = JSON.stringify(getProposal(db, proposal.id));

  for (const target of renderer.targets()) {
    const artifact = renderer.render({
      proposal,
      evidence: listDecisions(db, {}),
      target,
    });
    assert.ok(artifact.content.length > 0);
  }

  // Rendering is pure: the persisted record is byte-identical afterwards.
  assert.equal(JSON.stringify(getProposal(db, proposal.id)), before);

  // And the core proposal carries no target-specific fields.
  const stored = getProposal(db, proposal.id)!;
  const keys = Object.keys(stored);
  for (const forbidden of ["content", "suggestedPath", "mode", "target", "frontmatter", "markdown"]) {
    assert.ok(!keys.includes(forbidden), `core proposal must not carry "${forbidden}"`);
  }
});

test("the software-engineering renderer produces its documented targets", () => {
  const db = testDb();
  const { proposal } = proposalFor(db, "software-engineering");
  const renderer = rendererFor("software-engineering");

  const skill = renderer.render({ proposal, evidence: [], target: "skill" });
  assert.match(skill.content, /^---\nname: /);
  assert.equal(skill.mode, "create");
  assert.match(skill.suggestedPath ?? "", /\.claude\/skills\/.+\/SKILL\.md$/);

  const claudeMd = renderer.render({ proposal, evidence: [], target: "claude-md" });
  assert.equal(claudeMd.suggestedPath, "CLAUDE.md");
  assert.equal(claudeMd.mode, "append");
  assert.ok(!claudeMd.content.includes("---\nname:"), "instructions files get no frontmatter");
});

test("a domain with no dedicated renderer still renders generically", () => {
  const db = testDb();
  const { proposal } = proposalFor(db, "product-management");
  const renderer = rendererFor("product-management");

  assert.equal(renderer.domain, "generic", "falls back rather than failing");
  const artifact = renderer.render({ proposal, evidence: [], target: "checklist" });
  assert.match(artifact.content, /- \[ \] /);
});

test("every renderer handles every proposal kind", () => {
  const db = testDb();
  const ids = seed(db, 2);

  for (const renderer of listRenderers()) {
    for (const kind of PROPOSAL_KINDS) {
      const proposal = insertProposal(db, {
        domain: renderer.domain,
        kind,
        title: `A ${kind}`,
        statement: "Do the first thing. Then do the second thing. Finally check the result.",
        evidenceDecisionIds: ids,
      });
      for (const target of renderer.targets()) {
        const artifact = renderer.render({ proposal, evidence: [], target });
        assert.ok(artifact.content.trim().length > 0, `${renderer.domain}/${kind}/${target}`);
      }
    }
  }
});

test("rendering carries provenance back to the originating decisions", () => {
  const db = testDb();
  const { proposal } = proposalFor(db, "software-engineering");
  const evidence = listDecisions(db, {});
  const artifact = rendererFor("software-engineering").render({
    proposal,
    evidence,
    target: "claude-md",
  });

  assert.match(artifact.content, /decision-logger:/);
  for (const d of evidence) assert.ok(artifact.content.includes(d.id));
});
