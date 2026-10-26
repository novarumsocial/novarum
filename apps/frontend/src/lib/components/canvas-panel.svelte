<script lang="ts">
  import { NotebookPen, Pencil, TriangleAlert, X } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Textarea } from '$lib/components/ui/textarea/index.js';
  import Markdown from './markdown.svelte';
  import { canvases } from '$lib/canvas.svelte';
  import { formatDate, formatTime } from '$lib/formatDate';

  let { channelId, onClose }: { channelId: string; onClose: () => void } = $props();

  const canvas = $derived(canvases.byChannel[channelId]);
  // null while reading; the text being written otherwise
  let draft = $state<string | null>(null);
  // the version the draft started from: a newer one means someone saved in the meantime
  let baseVersion = $state(0);
  let saving = $state(false);
  let failed = $state(false);
  const outdated = $derived(draft !== null && !!canvas && canvas.version > baseVersion);
  const editor = $derived(canvas?.updatedBy?.displayName || canvas?.updatedBy?.username);

  $effect(() => {
    const id = channelId;
    draft = null;
    failed = false;
    canvases.load(id).catch(() => (failed = true));
  });

  function edit() {
    draft = canvas?.content ?? '';
    baseVersion = canvas?.version ?? 0;
  }

  async function save() {
    if (draft === null || saving) return;
    saving = true;
    failed = false;
    try {
      if (await canvases.save(channelId, draft, baseVersion)) draft = null;
    } catch {
      failed = true;
    } finally {
      saving = false;
    }
  }

  // keeps my text and saves it over whatever was saved meanwhile
  function overwrite() {
    baseVersion = canvas?.version ?? 0;
    void save();
  }
</script>

<aside
  class="absolute inset-0 z-20 flex min-h-0 flex-col bg-background md:static md:w-md md:shrink-0 md:border-l md:border-border"
  aria-label="Channel canvas"
>
  <div class="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
    <NotebookPen class="size-4 text-muted-foreground" />
    <span class="truncate text-sm font-semibold text-foreground">Canvas</span>
    <div class="ml-auto flex items-center gap-1">
      {#if draft === null}
        <Button variant="ghost" size="sm" onclick={edit} disabled={!canvas}>
          <Pencil class="size-3.5" /> Edit
        </Button>
      {:else}
        <Button variant="ghost" size="sm" onclick={() => (draft = null)} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" onclick={save} disabled={saving || outdated}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      {/if}
      <Button variant="ghost" size="icon-sm" onclick={onClose} aria-label="Close canvas">
        <X class="size-4" />
      </Button>
    </div>
  </div>

  {#if failed}
    <p class="shrink-0 border-b border-border px-3 py-2 text-xs text-destructive">
      Couldn't reach the canvas. Try again in a moment.
    </p>
  {/if}

  {#if outdated}
    <div
      class="flex shrink-0 flex-col gap-2 border-b border-border bg-destructive/5 px-3 py-2 text-xs"
    >
      <span class="flex items-center gap-1.5 text-foreground">
        <TriangleAlert class="size-3.5 shrink-0 text-destructive" />
        {editor ?? 'Someone'} saved a newer version while you were editing.
      </span>
      <div class="flex gap-1">
        <Button variant="outline" size="xs" onclick={overwrite}>Overwrite with mine</Button>
        <Button variant="ghost" size="xs" onclick={() => (draft = null)}>Discard mine</Button>
      </div>
    </div>
  {/if}

  {#if draft !== null}
    <Textarea
      bind:value={draft}
      autofocus
      disableResize
      placeholder={'# Title\n\nNotes, links, decisions…'}
      class="min-h-0 flex-1 border-0 px-4 py-3 font-mono text-sm field-sizing-fixed focus-visible:ring-0 md:text-sm"
      onkeydown={(event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void save();
        if (event.key === 'Escape') draft = null;
      }}
    />
    <p class="shrink-0 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
      Markdown supported · Ctrl+Enter to save · Esc to cancel
    </p>
  {:else if !canvas}
    <div class="space-y-2 p-4">
      <div class="h-5 w-1/2 animate-pulse bg-muted"></div>
      <div class="h-3 w-3/4 animate-pulse bg-muted/70"></div>
      <div class="h-3 w-2/3 animate-pulse bg-muted/70"></div>
    </div>
  {:else if !canvas.content.trim()}
    <div class="m-4 flex flex-col items-start gap-3 border border-dashed border-border p-4">
      <div>
        <p class="text-sm font-medium text-foreground">This canvas is empty</p>
        <p class="mt-1 text-sm text-muted-foreground">
          Keep notes, links and decisions in one place everyone here can edit.
        </p>
      </div>
      <Button size="sm" onclick={edit}><Pencil class="size-3.5" /> Start writing</Button>
    </div>
  {:else}
    <!-- chat markdown is dense; a document reads better with room between blocks -->
    <div
      class="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm leading-relaxed text-foreground/90 [&>div>*+*]:mt-2.5"
    >
      <Markdown content={canvas.content} links />
    </div>
    {#if canvas.updatedAt}
      {@const updatedAt = new Date(canvas.updatedAt)}
      <p class="shrink-0 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        Last edited by {editor ?? 'someone'}
        {formatDate(updatedAt).toLowerCase()} at {formatTime(updatedAt)}
      </p>
    {/if}
  {/if}
</aside>
