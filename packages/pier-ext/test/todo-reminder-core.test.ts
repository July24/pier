/**
 * stop 未完成提醒决策纯核心（D41 二修；session 01a040cc 实证）。
 * 缝：planStopTodoReminder（abort 抑制 / 封顶 / 在途 sub / blocked 深度 /
 * open 项判定 / 文案——对账而非祈使、问用户一等出口）+ 宽限常量。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TODO_REMINDERS_MAX,
  TODO_REMINDER_CUSTOM_TYPE,
  planStopTodoReminder,
  todoReminderGraceMs,
  type TodoReminderInput,
} from '../src/todo-reminder-core.ts';

const OPEN = [
  { content: 'restart CRM user-service', status: 'in_progress' },
  { content: 'push special- fix to repo', status: 'pending' },
  { content: 'verify E2E', status: 'completed' },
  { content: 'old idea', status: 'abandoned' },
  { content: 'wait for ops deploy', status: 'blocked' },
];

function base(over: Partial<TodoReminderInput> = {}): TodoReminderInput {
  return {
    lastStopReason: 'end_turn',
    reminders: 0,
    runningSubs: 0,
    blockedDepth: 0,
    items: OPEN,
    ...over,
  };
}

test('常量：封顶 3 + custom 通道类型 + 宽限缺省 30s', () => {
  assert.equal(TODO_REMINDERS_MAX, 3);
  assert.equal(TODO_REMINDER_CUSTOM_TYPE, 'pi-herdr.todo-reminder');
  const had = 'PI_HERDR_TODO_GRACE_MS' in process.env;
  const prev = process.env.PI_HERDR_TODO_GRACE_MS;
  delete process.env.PI_HERDR_TODO_GRACE_MS;
  assert.equal(todoReminderGraceMs(), 30_000);
  process.env.PI_HERDR_TODO_GRACE_MS = '50';
  assert.equal(todoReminderGraceMs(), 50, 'env 可调（测试用小值）');
  process.env.PI_HERDR_TODO_GRACE_MS = 'not-a-number';
  assert.equal(todoReminderGraceMs(), 30_000, '畸形 env 回落缺省');
  if (had) process.env.PI_HERDR_TODO_GRACE_MS = prev;
  else delete process.env.PI_HERDR_TODO_GRACE_MS;
});

test('due：open 项渲染 ▶/· 前缀 + 计数递增（01a040cc 事故形态）', () => {
  const plan = planStopTodoReminder(base());
  assert.equal(plan.due, true);
  assert.equal(plan.nextReminders, 1);
  assert.ok(plan.content);
  assert.match(plan.content!, /▶ restart CRM user-service/);
  assert.match(plan.content!, /· push special- fix to repo/);
  assert.doesNotMatch(plan.content!, /verify E2E/, 'completed 不进列表');
  assert.doesNotMatch(plan.content!, /old idea/, 'abandoned 不进列表');
  assert.doesNotMatch(plan.content!, /wait for ops deploy/, 'blocked 不算未完成——正确建模后不被催');
  assert.match(plan.content!, /Reminder 1\/3/);
});

test('文案：对账请求而非祈使——问用户一等出口、blocked 是等人工项的唯一归宿', () => {
  const { content } = planStopTodoReminder(base());
  assert.ok(content);
  // 旧版的越权诱因必须消失
  assert.doesNotMatch(content!, /Continue working on them before stopping/);
  // 新出口三件套
  assert.match(content!, /already authorized/);
  assert.match(content!, /mark it blocked with a blocker note/);
  assert.match(content!, /ask_user_question/);
  assert.match(content!, /never execute it yourself/);
  assert.match(content!, /todo_write/);
});

test('abort 抑制：ESC 中止后的 settled 不催（反唤醒风暴守卫保留）', () => {
  const plan = planStopTodoReminder(base({ lastStopReason: 'aborted' }));
  assert.equal(plan.due, false);
  assert.equal(plan.content, null);
  assert.equal(plan.nextReminders, 0);
});

test('封顶：已达 TODO_REMINDERS_MAX 不再注入', () => {
  const plan = planStopTodoReminder(base({ reminders: TODO_REMINDERS_MAX }));
  assert.equal(plan.due, false);
  assert.equal(plan.nextReminders, TODO_REMINDERS_MAX);
});

test('在途 subagent / blocked 深度：主控本就在等，不催', () => {
  assert.equal(planStopTodoReminder(base({ runningSubs: 2 })).due, false);
  assert.equal(planStopTodoReminder(base({ blockedDepth: 1 })).due, false);
});

test('无 open 项：全 completed/abandoned/blocked 的列表不触发', () => {
  const plan = planStopTodoReminder(base({
    items: [
      { content: 'done thing', status: 'completed' },
      { content: 'dropped thing', status: 'abandoned' },
      { content: 'waiting on human', status: 'blocked' },
    ],
  }));
  assert.equal(plan.due, false);
  assert.equal(plan.content, null);
});

test('空列表 / stopReason 未知：保守不注入或按自然结束处理', () => {
  assert.equal(planStopTodoReminder(base({ items: [] })).due, false);
  // null stopReason = 未知，视作自然结束 → 正常评估
  assert.equal(planStopTodoReminder(base({ lastStopReason: null })).due, true);
});

test('编号随计数递增（Reminder n/3）', () => {
  assert.match(planStopTodoReminder(base({ reminders: 2 })).content!, /Reminder 3\/3/);
});
