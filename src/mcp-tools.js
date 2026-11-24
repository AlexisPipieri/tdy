'use strict';
// Tools and prompts exposed by the MCP server (mcp/index.js), kept free of MCP plumbing so they can be tested.
// The UI calls projects "labels", so the MCP surface does too.
const { randomUUID } = require('crypto');
const { getNextColor } = require('./task-store');
const { toLocalISO } = require('./date-parser');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

class ToolError extends Error {}

function checkDate(value, field) {
  if (value === undefined || value === null || value === '') return;
  const d = new Date(`${value}T00:00:00`);
  if (!ISO_DATE.test(value) || isNaN(d) || toLocalISO(d) !== value) {
    throw new ToolError(`${field} must be a date as YYYY-MM-DD, got "${value}"`);
  }
}

function checkBucket(value) {
  if (value !== undefined && value !== 'today' && value !== 'anytime') {
    throw new ToolError(`bucket must be "today" or "anytime", got "${value}"`);
  }
}

const TOOLS = [
  {
    name: 'list_tasks',
    description: "Returns the user's open tasks in the order they appear in the app, plus today's date. Use when the user asks about their tasks or workload, or before planning, triaging or updating tasks. Completed tasks are not included: use list_completed for those.",
    inputSchema: {
      type: 'object',
      properties: {
        bucket:     { type: 'string', enum: ['today', 'anytime', 'all'], description: "'today' is the user's focus list, 'anytime' the backlog. Defaults to 'all'." },
        label:      { type: 'string', description: 'Only tasks with this label.' },
        overdue:    { type: 'boolean', description: 'Only tasks whose deadline is before today.' },
        due_before: { type: 'string', description: 'Only tasks with a deadline on or before this date (YYYY-MM-DD).' },
      },
    },
  },
  {
    name: 'list_completed',
    description: 'Returns the tasks the user completed between two dates, oldest first. Use for reviews, standups and "what did I do" questions.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'First day included (YYYY-MM-DD). Defaults to 7 days ago.' },
        until: { type: 'string', description: 'Last day included (YYYY-MM-DD). Defaults to today.' },
      },
    },
  },
  {
    name: 'list_labels',
    description: "Returns the user's labels with their number of open tasks. Check it before adding or labelling tasks so existing labels are reused instead of near-duplicates.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_tasks',
    description: "Adds one or more tasks to the user's list. Use when the user asks to add or capture tasks, including tasks extracted from text they shared. Keep titles short and actionable. An unknown label is created.",
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              title:    { type: 'string', description: 'Task title' },
              bucket:   { type: 'string', enum: ['today', 'anytime'], description: "Defaults to 'anytime'." },
              deadline: { type: 'string', description: 'Due date as YYYY-MM-DD. Optional.' },
              label:    { type: 'string', description: 'Label name. Optional.' },
            },
            required: ['title'],
          },
        },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'complete_task',
    description: 'Marks a task as done. Use when the user says, or the conversation makes clear, that a task on their list is finished.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Task id from list_tasks' } },
      required: ['id'],
    },
  },
  {
    name: 'update_task',
    description: "Changes a task: title, bucket, deadline, label, position in its list, or reopens a completed task. Only the fields passed are changed.",
    inputSchema: {
      type: 'object',
      properties: {
        id:        { type: 'string', description: 'Task id from list_tasks or list_completed' },
        title:     { type: 'string' },
        bucket:    { type: 'string', enum: ['today', 'anytime'] },
        deadline:  { type: 'string', description: 'YYYY-MM-DD, or an empty string to remove it.' },
        label:     { type: 'string', description: 'Label name, or an empty string to remove it. An unknown label is created.' },
        position:  { type: 'string', enum: ['top', 'bottom'], description: 'Move the task to the top or bottom of its list.' },
        completed: { type: 'boolean', description: 'false reopens a completed task.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_task',
    description: 'Permanently deletes a task. Only when the user asks to delete or remove it; for finished work use complete_task.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Task id' } },
      required: ['id'],
    },
  },
];

const PROMPTS = [
  {
    name: 'plan_my_day',
    description: "Pick what to work on today from your tdy tasks",
    text: [
      "Help me decide what to work on today using my tdy tasks.",
      "1. Call list_tasks to see what is already in Today, what is in Anytime, and which deadlines are close or overdue.",
      "2. Propose a short, realistic list for today (what is already in Today, plus anything overdue or due soon), and say in one line why for each task you suggest adding.",
      "3. Wait for my answer. Only then move the tasks I approve to Today with update_task, and offer to send the ones I drop back to Anytime.",
      "Be brief: no motivational talk.",
    ].join('\n'),
  },
  {
    name: 'weekly_review',
    description: 'Review the past week in tdy and tidy the backlog',
    text: [
      "Run a short weekly review of my tdy tasks.",
      "1. Call list_completed for the last 7 days and summarise what I got done, grouped by label.",
      "2. Call list_tasks and point out: overdue tasks, tasks with no deadline that have been open for more than 3 weeks, and likely duplicates.",
      "3. Suggest what to do with each of those (reschedule, rename, move, complete or delete), then wait for my answer before changing anything.",
      "Be brief.",
    ].join('\n'),
  },
];

// store: createStore(...) instance. readPrefs: () => prefs object. now: () => Date (tests pass a fixed one).
function createTools(store, { readPrefs = () => ({}), now = () => new Date() } = {}) {
  function todayISO() { return toLocalISO(now()); }

  function labelName(data, task) {
    const p = task.projectId && (data.projects || []).find(p => p.id === task.projectId);
    return p ? p.name : null;
  }

  function findLabel(data, name) {
    return (data.projects || []).find(p => p.name.toLowerCase() === name.trim().toLowerCase());
  }

  // Returns the label id, creating the label when needed. `created` collects new names for the reply.
  function resolveLabel(data, name, created) {
    if (!name || !name.trim()) return null;
    const existing = findLabel(data, name);
    if (existing) return existing.id;
    if (!data.projects) data.projects = [];
    const label = { id: randomUUID(), name: name.trim(), color: getNextColor(data.projects) };
    data.projects.push(label);
    created.push(label.name);
    return label.id;
  }

  function findTask(data, id) {
    const task = data.tasks.find(t => t.id === id);
    if (!task) throw new ToolError(`No task with id "${id}". Call list_tasks to get current ids.`);
    return task;
  }

  function format(data, t) {
    const out = { id: t.id, title: t.title, bucket: t.bucket, deadline: t.deadline || null, label: labelName(data, t) };
    if (t.completed) out.completed_at = t.completedAt;
    else out.created_at = t.createdAt;
    return out;
  }

  // Same placement rules as moveToTop / moveToBottom in the renderer: relative to open tasks of the same bucket.
  function place(data, task, position) {
    const rest = data.tasks.filter(t => t !== task);
    const same = t => !t.completed && t.bucket === task.bucket;
    let idx;
    if (position === 'top') {
      idx = rest.findIndex(same);
      if (idx === -1) idx = 0;
    } else {
      idx = rest.length;
      for (let i = rest.length - 1; i >= 0; i--) if (same(rest[i])) { idx = i + 1; break; }
    }
    rest.splice(idx, 0, task);
    data.tasks = rest;
  }

  function labelNote(created) {
    return created.length ? ` (new label${created.length > 1 ? 's' : ''}: ${created.join(', ')})` : '';
  }

  const handlers = {
    list_tasks(args, data) {
      const { bucket = 'all', label, overdue, due_before } = args;
      checkDate(due_before, 'due_before');
      const today = todayISO();
      let tasks = data.tasks.filter(t => !t.completed && (bucket === 'all' || t.bucket === bucket));
      if (label) {
        const l = findLabel(data, label);
        tasks = l ? tasks.filter(t => t.projectId === l.id) : [];
      }
      if (overdue)    tasks = tasks.filter(t => t.deadline && t.deadline < today);
      if (due_before) tasks = tasks.filter(t => t.deadline && t.deadline <= due_before);
      return { today, tasks: tasks.map(t => format(data, t)) };
    },

    list_completed(args, data) {
      const today = todayISO();
      const weekAgo = new Date(now()); weekAgo.setDate(weekAgo.getDate() - 7);
      const { since = toLocalISO(weekAgo), until = today } = args;
      checkDate(since, 'since');
      checkDate(until, 'until');
      const tasks = data.tasks
        .filter(t => t.completed && t.completedAt)
        .filter(t => { const day = toLocalISO(new Date(t.completedAt)); return day >= since && day <= until; })
        .sort((a, b) => new Date(a.completedAt) - new Date(b.completedAt));
      return { since, until, tasks: tasks.map(t => format(data, t)) };
    },

    list_labels(args, data) {
      return (data.projects || []).map(p => ({
        name: p.name,
        open_tasks: data.tasks.filter(t => !t.completed && t.projectId === p.id).length,
      }));
    },

    add_tasks(args, data) {
      const items = Array.isArray(args.tasks) ? args.tasks : [];
      if (!items.length) throw new ToolError('tasks must contain at least one task');
      items.forEach((item, i) => {
        if (!item || typeof item.title !== 'string' || !item.title.trim()) throw new ToolError(`tasks[${i}] needs a title`);
        checkBucket(item.bucket);
        checkDate(item.deadline, `tasks[${i}].deadline`);
      });
      const created = [];
      const added = items.map(item => ({
        id:          randomUUID(),
        title:       item.title.trim(),
        bucket:      item.bucket || 'anytime',
        completed:   false,
        createdAt:   now().toISOString(),
        completedAt: null,
        projectId:   resolveLabel(data, item.label, created),
        deadline:    item.deadline || null,
      }));
      // Follow the app's "Add new tasks at the" setting, keeping the batch in the order given
      data.tasks = readPrefs().newTaskPosition === 'top' ? [...added, ...data.tasks] : [...data.tasks, ...added];
      return {
        write: true,
        text: `Added ${added.length} task${added.length > 1 ? 's' : ''}${labelNote(created)}:\n`
          + added.map(t => `- ${t.title} [${t.bucket}${t.deadline ? `, due ${t.deadline}` : ''}${t.projectId ? `, ${labelName(data, t)}` : ''}] id=${t.id}`).join('\n'),
      };
    },

    complete_task(args, data) {
      const task = findTask(data, args.id);
      if (task.completed) return { text: `Already completed: "${task.title}"` };
      task.completed = true;
      task.completedAt = now().toISOString();
      return { write: true, text: `Completed: "${task.title}"` };
    },

    update_task(args, data) {
      const task = findTask(data, args.id);
      checkBucket(args.bucket);
      checkDate(args.deadline, 'deadline');
      if (args.position !== undefined && args.position !== 'top' && args.position !== 'bottom') {
        throw new ToolError(`position must be "top" or "bottom", got "${args.position}"`);
      }
      if (args.title !== undefined && !String(args.title).trim()) throw new ToolError('title cannot be empty');
      const created = [];
      if (args.title     !== undefined) task.title     = String(args.title).trim();
      if (args.bucket    !== undefined) task.bucket    = args.bucket;
      if (args.deadline  !== undefined) task.deadline  = args.deadline || null;
      if (args.label     !== undefined) task.projectId = resolveLabel(data, args.label, created);
      if (args.completed !== undefined && args.completed !== task.completed) {
        task.completed   = !!args.completed;
        task.completedAt = task.completed ? now().toISOString() : null;
      }
      if (args.position) place(data, task, args.position);
      return { write: true, text: `Updated: "${task.title}"${labelNote(created)}` };
    },

    delete_task(args, data) {
      const task = findTask(data, args.id);
      data.tasks = data.tasks.filter(t => t !== task);
      return { write: true, text: `Deleted: "${task.title}"` };
    },
  };

  // Returns { text, isError } for the MCP response. Reads fresh data on every call so edits made in the app are seen.
  function call(name, args = {}) {
    const handler = handlers[name];
    if (!handler) return { text: `Unknown tool: ${name}`, isError: true };
    try {
      const data = store.read();
      if (!data.projects) data.projects = [];
      const result = handler(args || {}, data);
      if (result && result.write) {
        store.write(data);
        return { text: result.text };
      }
      if (result && typeof result.text === 'string') return { text: result.text };
      return { text: JSON.stringify(result, null, 2) };
    } catch (err) {
      if (err instanceof ToolError) return { text: err.message, isError: true };
      throw err;
    }
  }

  return { tools: TOOLS, prompts: PROMPTS, call };
}

module.exports = { createTools, TOOLS, PROMPTS };
