<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as Carousel from '$lib/components/ui/carousel/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import type { Attachment } from '$lib/types/chat';
  import type { CarouselAPI } from '$lib/components/ui/carousel/context.js';
  import { Download } from '@lucide/svelte';

  let {
    open = $bindable(false),
    attachments,
    index = $bindable(0),
  }: {
    open: boolean;
    attachments: Attachment[];
    index: number;
  } = $props();

  const attachment = $derived(attachments[index]);
  let api = $state<CarouselAPI>();

  $effect(() => {
    if (!api) return;
    const updateIndex = () => (index = api!.selectedScrollSnap());
    api.on('select', updateIndex);
    return () => api?.off('select', updateIndex);
  });

  $effect(() => {
    if (open && api) api.scrollTo(index, true);
  });
</script>

<Dialog.Root bind:open>
  <Dialog.Content
    class="flex h-[min(85vh,52rem)] max-w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden bg-background/95 p-0 sm:max-w-[min(90vw,72rem)] [&_[data-slot=dialog-close]]:top-1.5"
  >
    <Dialog.Title class="sr-only">Attachment viewer</Dialog.Title>
    <Dialog.Description class="sr-only">Preview attached files</Dialog.Description>

    {#if attachment}
      <div class="flex h-10 shrink-0 items-center gap-3 border-b border-border px-3 pr-11">
        <span class="min-w-0 flex-1 truncate text-xs font-medium">{attachment.filename}</span>
        {#if attachments.length > 1}
          <span class="shrink-0 font-mono text-[10px] text-muted-foreground">
            {index + 1} / {attachments.length}
          </span>
        {/if}
        <Button
          href={attachment.url}
          target="_blank"
          rel="noreferrer"
          variant="ghost"
          size="icon-sm"
          aria-label={`Download ${attachment.filename}`}
        >
          <Download class="size-4" />
        </Button>
      </div>

      <Carousel.Root
        setApi={(carouselApi) => (api = carouselApi)}
        opts={{ loop: attachments.length > 1 }}
        class="min-h-0 flex-1 bg-black/40"
      >
        <Carousel.Content class="ml-0 h-full">
          {#each attachments as item (item.id)}
            <Carousel.Item
              class="flex h-[calc(min(85vh,52rem)-2.5rem)] items-center justify-center pl-0 p-3 sm:p-6"
            >
              {#if item.contentType.startsWith('image/')}
                <img
                  src={item.url}
                  alt={item.filename}
                  class="max-h-full max-w-full object-contain"
                />
              {:else if item.contentType.startsWith('video/')}
                <video
                  src={item.url}
                  aria-label={item.filename}
                  controls
                  class="max-h-full max-w-full"
                >
                  <track kind="captions" />
                </video>
              {:else if item.contentType.startsWith('audio/')}
                <audio src={item.url} aria-label={item.filename} controls class="w-full max-w-xl">
                  <track kind="captions" />
                </audio>
              {:else if item.contentType === 'application/pdf'}
                <iframe src={item.url} title={item.filename} class="h-full w-full bg-white"
                ></iframe>
              {/if}
            </Carousel.Item>
          {/each}
        </Carousel.Content>
        {#if attachments.length > 1}
          <Carousel.Previous class="left-2 z-10 sm:left-4" variant="secondary" size="icon-lg" />
          <Carousel.Next class="right-2 z-10 sm:right-4" variant="secondary" size="icon-lg" />
        {/if}
      </Carousel.Root>
    {/if}
  </Dialog.Content>
</Dialog.Root>
