/**
 * Single source of truth for user-facing TEST terminology.
 *
 * Every label, button, notification, email and error the user can see should
 * come from here. Internal names (tables, routes, variables) may say "test",
 * "exam" or anything else — only what the user reads must say TEST.
 */
export const T = {
  // Navigation / areas
  management: 'TEST Management',
  create: 'Create TEST',
  aiGeneration: 'AI TEST Generation',
  manualGeneration: 'Manual TEST Generation',
  myTests: 'My TESTS',
  schedule: 'TEST Schedule',
  settings: 'TEST Settings',
  history: 'TEST History',
  results: 'TEST Results',
  analytics: 'TEST Analytics',

  // Fields
  title: 'TEST Title',
  duration: 'TEST Duration',
  durationMinutes: 'TEST Duration (minutes)',
  date: 'TEST Date',
  startTime: 'TEST Start Time',
  endTime: 'TEST End Time',
  link: 'TEST Link',
  batches: 'TEST Batches',
  questions: 'TEST Questions',
  timezone: 'Time zone',

  // Groups
  active: 'Active TESTS',
  upcoming: 'Upcoming TESTS',
  completed: 'Completed TESTS',
  drafts: 'Draft TESTS',
  cancelled: 'Cancelled TESTS',

  // Batch labels
  batch: 'Batch',
  batchStart: 'Batch Start Time',
  batchEnd: 'Batch End Time',
  batchDuration: 'Batch Duration (minutes)',
  batchStudents: 'Students in Batch',
  numberOfBatches: 'Number of Batches',

  // Actions
  editSchedule: 'Edit TEST Schedule',
  reviewChanges: 'Review changes',
  applyChanges: 'Apply changes',
  publish: 'Publish TEST',
  lock: 'Lock TEST',
  unlock: 'Unlock TEST',
  postpone: 'Postpone TEST',
  cancel: 'Cancel TEST',
  start: 'Start TEST',
  resume: 'Resume TEST',
  submit: 'Submit TEST',

  // Student
  timeRemaining: 'Time remaining',
  autoSubmitted: 'Your TEST was submitted automatically when the time ran out.',
  submitted: 'Your TEST has been submitted.',
} as const;

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Notification / email copy. Kept here so wording stays consistent. */
export const Messages = {
  scheduleChangedSubject: (title: string) => `TEST schedule changed: ${title}`,
  scheduleChangedBody: (name: string, title: string, oldWhen: string, newWhen: string, reason?: string) =>
    `Hello ${name},\n\nThe schedule for your TEST "${title}" has changed.\n\n` +
    `Previous: ${oldWhen}\nNew: ${newWhen}\n` +
    (reason ? `\nReason: ${reason}\n` : '') +
    `\nPlease use the TEST Link in your dashboard at the new time.\n`,
  batchAssignedSubject: (title: string) => `TEST batch assignment: ${title}`,
  batchAssignedBody: (name: string, title: string, batch: string, when: string) =>
    `Hello ${name},\n\nYou have been assigned to ${batch} for the TEST "${title}".\nWhen: ${when}\n`,
  cancelledSubject: (title: string) => `TEST cancelled: ${title}`,
  cancelledBody: (name: string, title: string, reason?: string) =>
    `Hello ${name},\n\nThe TEST "${title}" has been cancelled.` + (reason ? `\nReason: ${reason}` : '') + '\n',
  publishedSubject: (title: string) => `New TEST scheduled: ${title}`,
  publishedBody: (name: string, title: string, when: string) =>
    `Hello ${name},\n\nA TEST has been scheduled for you: "${title}".\nWhen: ${when}\n`,
};
