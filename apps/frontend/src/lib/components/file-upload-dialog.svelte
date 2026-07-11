<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Separator } from '$lib/components/ui/separator/index.js';
  import {
    FileArchive,
    FileAudio,
    FileImage,
    FileText,
    FileVideo,
    Files,
    Plus,
    Trash2,
    UploadCloud,
  } from '@lucide/svelte';

  let {
    open = $bindable(false),
    files = $bindable([]),
    maxFiles = 5,
    maxFileSize = 10 * 1024 * 1024,
  }: {
    open: boolean;
    files: File[];
    maxFiles?: number;
    maxFileSize?: number;
  } = $props();

  let input: HTMLInputElement;
  let dragging = $state(false);
  let error = $state('');

  const totalSize = $derived(files.reduce((total, file) => total + file.size, 0));

  function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function fileKey(file: File) {
    return `${file.name}:${file.size}:${file.lastModified}`;
  }

  function addFiles(nextFiles: File[]) {
    error = '';
    const existing = new Set(files.map(fileKey));
    const unique = nextFiles.filter((file) => !existing.has(fileKey(file)));
    const oversized = unique.find((file) => file.size > maxFileSize);

    if (oversized) {
      error = `${oversized.name} exceeds the ${formatBytes(maxFileSize)} limit.`;
      return;
    }

    if (files.length + unique.length > maxFiles) {
      error = `You can attach up to ${maxFiles} files at once.`;
      return;
    }

    files = [...files, ...unique];
  }

  function handleInput(event: Event) {
    const target = event.currentTarget as HTMLInputElement;
    addFiles(Array.from(target.files ?? []));
    target.value = '';
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    addFiles(Array.from(event.dataTransfer?.files ?? []));
  }

  function removeFile(file: File) {
    files = files.filter((item) => fileKey(item) !== fileKey(file));
    error = '';
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="gap-0 overflow-hidden p-0 sm:max-w-xl">
    <Dialog.Header class="p-4 pb-3">
      <div class="flex items-center gap-2">
        <div class="flex size-8 items-center justify-center border border-primary/30 bg-primary/10">
          <UploadCloud class="size-4 text-primary" />
        </div>
        <div>
          <Dialog.Title>Add attachments</Dialog.Title>
          <Dialog.Description>Files upload when you send the message.</Dialog.Description>
        </div>
      </div>
    </Dialog.Header>

    <Separator />

    <div class="space-y-3 p-4">
      <button
        type="button"
        class={`group flex min-h-36 w-full flex-col items-center justify-center border border-dashed px-6 py-5 text-center transition-colors hover:border-primary/60 hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 focus-visible:outline-none ${dragging ? 'border-primary bg-primary/5' : 'border-border bg-muted/20'}`}
        onclick={() => input?.click()}
        ondragenter={(event) => {
          event.preventDefault();
          dragging = true;
        }}
        ondragover={(event) => event.preventDefault()}
        ondragleave={(event) => {
          if (event.currentTarget === event.target) dragging = false;
        }}
        ondrop={handleDrop}
      >
        <div
          class="mb-3 flex size-10 items-center justify-center border border-border bg-background transition-transform group-hover:-translate-y-0.5"
        >
          <Plus class="size-5 text-muted-foreground" />
        </div>
        <span class="text-sm font-medium text-foreground">Drop files here or browse</span>
        <span class="mt-1 text-xs text-muted-foreground">
          Up to {maxFiles} files, {formatBytes(maxFileSize)} each
        </span>
      </button>

      <input
        bind:this={input}
        type="file"
        multiple
        class="sr-only"
        aria-label="Choose files to attach"
        onchange={handleInput}
      />

      {#if error}
        <p
          class="border-l-2 border-destructive bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </p>
      {/if}

      {#if files.length > 0}
        <div class="border border-border">
          <div class="flex items-center justify-between bg-muted/30 px-3 py-2">
            <div class="flex items-center gap-2 text-xs font-medium text-foreground">
              <Files class="size-3.5 text-muted-foreground" />
              <span>{files.length} {files.length === 1 ? 'file' : 'files'}</span>
            </div>
            <span class="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              {formatBytes(totalSize)} total
            </span>
          </div>
          <Separator />

          <div class="max-h-52 divide-y divide-border overflow-y-auto">
            {#each files as file (fileKey(file))}
              <div class="flex min-w-0 items-center gap-3 px-3 py-2.5">
                <div
                  class="flex size-8 shrink-0 items-center justify-center bg-muted text-muted-foreground"
                >
                  {#if file.type.startsWith('image/')}
                    <FileImage class="size-4" />
                  {:else if file.type.startsWith('video/')}
                    <FileVideo class="size-4" />
                  {:else if file.type.startsWith('audio/')}
                    <FileAudio class="size-4" />
                  {:else if file.type.includes('zip') || file.type.includes('compressed')}
                    <FileArchive class="size-4" />
                  {:else}
                    <FileText class="size-4" />
                  {/if}
                </div>
                <div class="min-w-0 flex-1">
                  <p class="truncate text-xs font-medium text-foreground">{file.name}</p>
                  <p class="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                    {file.name.split('.').pop() ?? 'file'} · {formatBytes(file.size)}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${file.name}`}
                  onclick={() => removeFile(file)}
                >
                  <Trash2 class="size-3.5" />
                </Button>
              </div>
            {/each}
          </div>
        </div>
      {/if}
    </div>

    <Dialog.Footer class="border-t border-border bg-muted/20 p-3">
      {#if files.length > 0}
        <Button variant="ghost" class="mr-auto" onclick={() => (files = [])}>Clear all</Button>
      {/if}
      <Button variant="outline" onclick={() => (open = false)}>Cancel</Button>
      <Button onclick={() => (open = false)}>{files.length > 0 ? 'Attach files' : 'Done'}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
