// Port of apps/frontend/src/lib/canvas.svelte.ts + the editor in apps/frontend/src/lib/components/canvas-panel.svelte
// Runs inside the canvas WebView, not in React Native: TipTap needs a DOM. `bun run build-canvas` bundles it
// into src/lib/canvas-editor.generated.ts. The app relays socket events in and our messages out
// (see src/components/canvas-panel.tsx), so the document is exactly the web's.
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Placeholder } from '@tiptap/extensions';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { fromBase64, toBase64 } from 'lib0/buffer';

export type CanvasUser = { id: string; name: string; avatarUrl: string | null };
export type CanvasPeer = CanvasUser & { color: string };
export type CanvasTool =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | 'heading1'
  | 'heading2'
  | 'bulletList'
  | 'orderedList'
  | 'taskList'
  | 'blockquote'
  | 'codeBlock';

// what the app sends in
export type CanvasInbound =
  | { type: 'init'; user: CanvasUser; colors: Record<string, string> }
  | { type: 'colors'; colors: Record<string, string> }
  | { type: 'sync'; state: string; writable: boolean }
  | { type: 'update'; update: string }
  | { type: 'awareness'; update: string; hello?: boolean }
  | { type: 'run'; tool: CanvasTool };

// what goes back out to the app
export type CanvasOutbound =
  | { type: 'ready' }
  | { type: 'update'; update: string }
  | { type: 'awareness'; update: string; hello?: boolean; goodbye: string }
  | {
      type: 'state';
      synced: boolean;
      writable: boolean;
      active: CanvasTool[];
      peers: CanvasPeer[];
    }
  | { type: 'link'; url: string };

declare global {
  interface Window {
    ReactNativeWebView: { postMessage(message: string): void };
    canvasReceive: (message: CanvasInbound) => void;
  }
}

// same palette and pick as the web, so a person has the same caret color on every device
const caretColors = [
  '#e5484d',
  '#f76b15',
  '#ffc53d',
  '#30a46c',
  '#12a594',
  '#0090ff',
  '#6e56cf',
  '#d6409f',
];
const caretColor = (id: string) =>
  caretColors[[...id].reduce((sum, c) => sum + c.charCodeAt(0), 0) % caretColors.length];

const post = (message: CanvasOutbound) =>
  window.ReactNativeWebView.postMessage(JSON.stringify(message));

const doc = new Y.Doc();
const awareness = new Awareness(doc);
let editor: Editor | null = null;
let synced = false;
let writable = false;
let self: CanvasUser | null = null;

// the app can't ask this view for anything once it is closing, so every message about us carries a ready-made
// "left" update (our state set to null at the current clock) for the app to send when it closes the canvas
const sendAwareness = (clients: number[], hello?: boolean) =>
  post({
    type: 'awareness',
    update: toBase64(encodeAwarenessUpdate(awareness, clients)),
    hello,
    // with no states given, our state is encoded as null
    goodbye: toBase64(encodeAwarenessUpdate(awareness, [doc.clientID], new Map())),
  });

// unlike the web, edits go out right away: the app can close this view at any moment, and a batch
// still waiting here would be lost. Before the first sync they stay local; the sync sends them.
doc.on('update', (update: Uint8Array, origin: unknown) => {
  if (origin !== 'remote' && synced && writable) post({ type: 'update', update: toBase64(update) });
});
awareness.on('update', ({ added, updated, removed }: Record<string, number[]>, origin: unknown) => {
  if (origin === 'local') sendAwareness([...added, ...updated, ...removed]);
});

function reportState() {
  const e = editor;
  const active: CanvasTool[] = [];
  if (e) {
    const checks: [CanvasTool, boolean][] = [
      ['bold', e.isActive('bold')],
      ['italic', e.isActive('italic')],
      ['strike', e.isActive('strike')],
      ['code', e.isActive('code')],
      ['heading1', e.isActive('heading', { level: 1 })],
      ['heading2', e.isActive('heading', { level: 2 })],
      ['bulletList', e.isActive('bulletList')],
      ['orderedList', e.isActive('orderedList')],
      ['taskList', e.isActive('taskList')],
      ['blockquote', e.isActive('blockquote')],
      ['codeBlock', e.isActive('codeBlock')],
    ];
    for (const [tool, on] of checks) if (on) active.push(tool);
  }
  // one face per person, however many devices they have the canvas open on
  const others = [...awareness.getStates().values()]
    .map((state) => state.user as CanvasPeer | undefined)
    .filter((peer): peer is CanvasPeer => !!peer && peer.id !== self?.id);
  const peers = [...new Map(others.map((peer) => [peer.id, peer])).values()];
  post({ type: 'state', synced, writable, active, peers });
}

function applyColors(colors: Record<string, string>) {
  for (const [name, value] of Object.entries(colors)) {
    document.documentElement.style.setProperty(`--${name}`, value);
  }
}

function run(tool: CanvasTool) {
  if (!editor || !writable) return;
  const chain = editor.chain().focus();
  const commands: Record<CanvasTool, () => unknown> = {
    bold: () => chain.toggleBold().run(),
    italic: () => chain.toggleItalic().run(),
    strike: () => chain.toggleStrike().run(),
    code: () => chain.toggleCode().run(),
    heading1: () => chain.toggleHeading({ level: 1 }).run(),
    heading2: () => chain.toggleHeading({ level: 2 }).run(),
    bulletList: () => chain.toggleBulletList().run(),
    orderedList: () => chain.toggleOrderedList().run(),
    taskList: () => chain.toggleTaskList().run(),
    blockquote: () => chain.toggleBlockquote().run(),
    codeBlock: () => chain.toggleCodeBlock().run(),
  };
  commands[tool]();
}

window.canvasReceive = (message) => {
  if (message.type === 'init') {
    if (editor) return;
    self = message.user;
    applyColors(message.colors);
    editor = new Editor({
      element: document.getElementById('editor')!,
      editable: false,
      extensions: [
        // Collaboration brings its own undo history, one that only undoes your own edits
        StarterKit.configure({ undoRedo: false, link: { openOnClick: false } }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Placeholder.configure({ placeholder: 'Write something, or type [ ] for a checklist…' }),
        Collaboration.configure({ document: doc }),
        CollaborationCaret.configure({
          provider: { awareness },
          user: { ...message.user, color: caretColor(message.user.id) },
        }),
      ],
      onTransaction: reportState,
    });
    awareness.on('change', reportState);
    reportState();
  }
  if (message.type === 'colors') applyColors(message.colors);
  if (message.type === 'sync') {
    const state = fromBase64(message.state);
    Y.applyUpdate(doc, state, 'remote');
    writable = message.writable;
    synced = true;
    editor?.setEditable(writable);
    // whatever we typed while offline (or before this sync) and the server doesn't have yet
    const missing = Y.encodeStateAsUpdate(doc, Y.encodeStateVectorFromUpdate(state));
    if (writable && missing.length > 2) post({ type: 'update', update: toBase64(missing) });
    sendAwareness([doc.clientID], true);
    reportState();
  }
  if (message.type === 'update') Y.applyUpdate(doc, fromBase64(message.update), 'remote');
  if (message.type === 'awareness') {
    applyAwarenessUpdate(awareness, fromBase64(message.update), 'remote');
    // someone just opened the canvas; tell them we're here too
    if (message.hello) sendAwareness([doc.clientID]);
  }
  if (message.type === 'run') run(message.tool);
};

// links open in the browser instead of inside this view
document.addEventListener('click', (event) => {
  const link = (event.target as HTMLElement).closest?.('a[href]');
  if (!link || editor?.isEditable) return;
  event.preventDefault();
  post({ type: 'link', url: (link as HTMLAnchorElement).href });
});

// the keyboard shrinks the view; keep the caret on screen
window.addEventListener('resize', () => {
  if (editor?.isFocused) editor.commands.scrollIntoView();
});

post({ type: 'ready' });
