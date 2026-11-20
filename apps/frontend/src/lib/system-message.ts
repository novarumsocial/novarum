import type { SystemMessage } from 'anchor/system-message';

type Person = { displayName?: string | null; username: string };
const nameOf = (person: Person) => person.displayName || person.username;
const list = (targets: Person[]) => {
  const names = targets.map(nameOf);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
};

export function formatDuration(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

/** "Ana added Leo", "Missed call from Ana"... for a message the homeserver wrote. */
export function systemText(system: SystemMessage, author: Person) {
  const who = nameOf(author);
  switch (system.type) {
    case 'group.created':
      return `${who} created the group.`;
    case 'member.added':
      return `${who} added ${list(system.targets)} to the group.`;
    case 'member.removed':
      return `${who} removed ${list(system.targets)} from the group.`;
    case 'member.left':
      return `${who} left the group.`;
    case 'bot.added':
      return `${who} added the bot ${list(system.targets)}.`;
    case 'bot.removed':
      return `${who} removed the bot ${list(system.targets)}.`;
    case 'owner.changed':
      return `${who} made ${list(system.targets)} the group owner.`;
    case 'group.renamed':
      return system.name
        ? `${who} renamed the group to ${system.name}.`
        : `${who} removed the group name.`;
    case 'group.icon':
      return `${who} changed the group icon.`;
    case 'call':
      if (system.missed) return `Missed call from ${who}.`;
      return system.durationSeconds === null
        ? `${who} started a call.`
        : `${who} started a call that lasted ${formatDuration(system.durationSeconds)}.`;
  }
}
