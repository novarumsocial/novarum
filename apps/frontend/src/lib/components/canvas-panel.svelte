<script lang="ts">
  import { onMount } from 'svelte';
  import { Editor } from '@tiptap/core';
  import StarterKit from '@tiptap/starter-kit';
  import { TaskItem, TaskList } from '@tiptap/extension-list';
  import { Placeholder } from '@tiptap/extensions';
  import Collaboration from '@tiptap/extension-collaboration';
  import CollaborationCaret from '@tiptap/extension-collaboration-caret';
  import {
    Bold,
    Code,
    Heading1,
    Heading2,
    Italic,
    List,
    ListOrdered,
    ListTodo,
    NotebookPen,
    Quote,
    SquareCode,
    Strikethrough,
    X,
  } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import Avatar from './avatar.svelte';
  import { CanvasSession } from '$lib/canvas.svelte';
  import { realtime } from '$lib/realtime.svelte';
  import { session } from '$lib/session.svelte';
  import { cn } from '$lib/utils';

  // everyone's profile colors default to the same one, so carets get their own, picked from the user id
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

  type Peer = { id: string; name: string; color: string; avatarUrl?: string | null };

  let { channelId, onClose }: { channelId: string; onClose: () => void } = $props();

  let element = $state<HTMLDivElement>();
  let canvas = $state.raw<CanvasSession>();
  let editor = $state.raw<Editor>();
  // bumped on every editor change so the toolbar's active states follow the cursor
  let revision = $state(0);
  let peers = $state<Peer[]>([]);

  onMount(() => {
    const user = session.user;
    const current = new CanvasSession(channelId, (message) => realtime.sendCanvas(message));
    canvas = current;
    editor = new Editor({
      element,
      editable: false,
      extensions: [
        // Collaboration brings its own undo history, one that only undoes your own edits
        StarterKit.configure({ undoRedo: false, link: { openOnClick: false } }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Placeholder.configure({ placeholder: 'Write something, or type [ ] for a checklist…' }),
        Collaboration.configure({ document: current.doc }),
        CollaborationCaret.configure({
          provider: current,
          user: {
            id: user?.id,
            name: user?.displayName || user?.username || 'Someone',
            color:
              caretColors[
                [...(user?.id ?? '')].reduce((sum, c) => sum + c.charCodeAt(0), 0) %
                  caretColors.length
              ],
            avatarUrl: user?.avatarUrl,
          },
        }),
      ],
      onTransaction: () => revision++,
    });

    const updatePeers = () => {
      // one face per person, however many tabs they have the canvas open in
      const others = [...current.awareness.getStates().values()]
        .map((state) => state.user as Peer | undefined)
        .filter((peer) => peer && peer.id !== user?.id) as Peer[];
      peers = [...new Map(others.map((peer) => [peer.id, peer])).values()];
    };
    current.awareness.on('change', updatePeers);

    return () => {
      editor?.destroy();
      current.destroy();
    };
  });

  $effect(() => {
    editor?.setEditable(!!canvas?.synced && canvas.writable);
  });

  const tools = $derived.by(() => {
    void revision;
    const e = editor;
    if (!e) return [];
    const tool = (label: string, icon: typeof Bold, active: boolean, run: () => unknown) => ({
      label,
      icon,
      active,
      run,
    });
    const chain = () => e.chain().focus();
    return [
      tool('Bold', Bold, e.isActive('bold'), () => chain().toggleBold().run()),
      tool('Italic', Italic, e.isActive('italic'), () => chain().toggleItalic().run()),
      tool('Strikethrough', Strikethrough, e.isActive('strike'), () =>
        chain().toggleStrike().run()
      ),
      tool('Inline code', Code, e.isActive('code'), () => chain().toggleCode().run()),
      null,
      tool('Heading', Heading1, e.isActive('heading', { level: 1 }), () =>
        chain().toggleHeading({ level: 1 }).run()
      ),
      tool('Subheading', Heading2, e.isActive('heading', { level: 2 }), () =>
        chain().toggleHeading({ level: 2 }).run()
      ),
      null,
      tool('Bulleted list', List, e.isActive('bulletList'), () => chain().toggleBulletList().run()),
      tool('Numbered list', ListOrdered, e.isActive('orderedList'), () =>
        chain().toggleOrderedList().run()
      ),
      tool('Checklist', ListTodo, e.isActive('taskList'), () => chain().toggleTaskList().run()),
      null,
      tool('Quote', Quote, e.isActive('blockquote'), () => chain().toggleBlockquote().run()),
      tool('Code block', SquareCode, e.isActive('codeBlock'), () =>
        chain().toggleCodeBlock().run()
      ),
    ];
  });
</script>

<aside
  class="absolute inset-0 z-20 flex min-h-0 flex-col bg-background md:static md:w-md md:shrink-0 md:border-l md:border-border"
  aria-label="Channel canvas"
>
  <div class="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
    <NotebookPen class="size-4 text-muted-foreground" />
    <span class="truncate text-sm font-semibold text-foreground">Canvas</span>
    {#if canvas?.synced && !canvas.writable}
      <span class="text-xs text-muted-foreground">View only</span>
    {/if}
    <div class="ml-auto flex items-center -space-x-1.5">
      {#each peers as peer (peer.id)}
        <span title={`${peer.name} is here`}>
          <Avatar
            src={peer.avatarUrl}
            name={peer.name}
            class="size-6 text-[10px]"
            bgColor={peer.color}
          />
        </span>
      {/each}
    </div>
    <Button variant="ghost" size="icon-sm" onclick={onClose} aria-label="Close canvas">
      <X class="size-4" />
    </Button>
  </div>

  {#if canvas?.writable}
    <div
      class="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-border px-2 py-1"
      role="toolbar"
      aria-label="Formatting"
    >
      {#each tools as tool, index (index)}
        {#if tool}
          <Button
            variant={tool.active ? 'secondary' : 'ghost'}
            size="icon-sm"
            aria-label={tool.label}
            aria-pressed={tool.active}
            title={tool.label}
            onclick={tool.run}
          >
            <tool.icon class="size-4" />
          </Button>
        {:else}
          <span class="mx-1 h-4 w-px bg-border"></span>
        {/if}
      {/each}
    </div>
  {/if}

  {#if !canvas?.synced}
    <div class="space-y-2 p-4">
      <div class="h-5 w-1/2 animate-pulse bg-muted"></div>
      <div class="h-3 w-3/4 animate-pulse bg-muted/70"></div>
      <div class="h-3 w-2/3 animate-pulse bg-muted/70"></div>
    </div>
  {/if}
  <div
    bind:this={element}
    class={cn('canvas-editor min-h-0 flex-1 overflow-y-auto', !canvas?.synced && 'hidden')}
  ></div>
</aside>

<style>
  .canvas-editor :global(.ProseMirror) {
    min-height: 100%;
    padding: 0.75rem 1rem 3rem;
    font-size: 0.875rem;
    line-height: 1.6;
    color: var(--foreground);
    outline: none;
  }
  .canvas-editor :global(.ProseMirror > * + *) {
    margin-top: 0.6em;
  }
  .canvas-editor :global(h1) {
    font-size: 1.25rem;
    font-weight: 700;
    line-height: 1.3;
  }
  .canvas-editor :global(h2) {
    font-size: 1.05rem;
    font-weight: 700;
    line-height: 1.3;
  }
  .canvas-editor :global(h1:not(:first-child)),
  .canvas-editor :global(h2:not(:first-child)) {
    margin-top: 1.1em;
  }
  .canvas-editor :global(ul:not([data-type='taskList'])) {
    list-style: disc;
    padding-left: 1.5rem;
  }
  .canvas-editor :global(ol) {
    list-style: decimal;
    padding-left: 1.5rem;
  }
  .canvas-editor :global(li::marker) {
    color: var(--muted-foreground);
  }
  .canvas-editor :global(ul[data-type='taskList']) {
    padding-left: 0.1rem;
  }
  .canvas-editor :global(ul[data-type='taskList'] li) {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
  }
  .canvas-editor :global(ul[data-type='taskList'] li > label) {
    flex-shrink: 0;
    margin-top: 0.2em;
  }
  .canvas-editor :global(ul[data-type='taskList'] li > div) {
    flex: 1;
    min-width: 0;
  }
  .canvas-editor :global(ul[data-type='taskList'] input[type='checkbox']) {
    width: 0.95rem;
    height: 0.95rem;
    accent-color: var(--primary);
    cursor: pointer;
  }
  .canvas-editor :global(li[data-checked='true'] > div) {
    color: var(--muted-foreground);
    text-decoration: line-through;
  }
  .canvas-editor :global(blockquote) {
    border-left: 3px solid color-mix(in oklch, var(--muted-foreground) 40%, transparent);
    padding-left: 0.75rem;
  }
  .canvas-editor :global(code) {
    background: var(--muted);
    padding: 0.1em 0.3em;
    font-size: 0.85em;
    font-family: var(--font-mono, monospace);
  }
  .canvas-editor :global(pre) {
    background: var(--muted);
    border: 1px solid var(--border);
    padding: 0.5rem 0.75rem;
    overflow-x: auto;
    font-family: var(--font-mono, monospace);
    font-size: 0.85em;
  }
  .canvas-editor :global(pre code) {
    background: none;
    padding: 0;
  }
  .canvas-editor :global(a) {
    color: var(--link);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .canvas-editor :global(p.is-editor-empty:first-child::before) {
    content: attr(data-placeholder);
    float: left;
    height: 0;
    pointer-events: none;
    color: var(--muted-foreground);
  }
  /* other people's cursors and names */
  .canvas-editor :global(.collaboration-carets__caret) {
    position: relative;
    margin: 0 -1px;
    border-left: 1px solid;
    border-right: 1px solid;
    word-break: normal;
    pointer-events: none;
  }
  .canvas-editor :global(.collaboration-carets__label) {
    position: absolute;
    top: -1.35em;
    left: -1px;
    padding: 0.05rem 0.3rem;
    font-size: 0.7rem;
    font-weight: 600;
    line-height: normal;
    white-space: nowrap;
    color: #fff;
    user-select: none;
  }
</style>
