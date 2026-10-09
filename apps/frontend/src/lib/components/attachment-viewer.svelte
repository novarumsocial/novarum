<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as Carousel from '$lib/components/ui/carousel/index.js';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import Avatar from './avatar.svelte';
  import type { Attachment, Author } from '$lib/types/chat';
  import type { CarouselAPI } from '$lib/components/ui/carousel/context.js';
  import { cn, formatBytes } from '$lib/utils';
  import { formatDate, formatTime } from '$lib/formatDate';
  import { Download, ExternalLink, FileText, Music, Video, X } from '@lucide/svelte';
  import { flushSync } from 'svelte';

  let {
    open = $bindable(false),
    attachments,
    index = $bindable(0),
    author,
    timestamp,
  }: {
    open: boolean;
    attachments: Attachment[];
    index: number;
    author: Author;
    timestamp: Date;
  } = $props();

  const attachment = $derived(attachments[index]);
  const authorName = $derived(author.displayName || author.username);
  let api = $state<CarouselAPI>();
  let zoomed = $state(false);
  let pan = $state<HTMLDivElement>();
  let zoomWidth = $state(0);

  $effect(() => {
    if (!api) return;
    const updateIndex = () => (index = api!.selectedScrollSnap());
    api.on('select', updateIndex);
    return () => api?.off('select', updateIndex);
  });

  $effect(() => {
    if (open && api) api.scrollTo(index, true);
  });

  // leaving the current image always drops back to the fitted view
  $effect(() => {
    void [open, index];
    zoomed = false;
  });

  function onkeydown(event: KeyboardEvent) {
    if (!open || zoomed) return;
    if (event.key === 'ArrowLeft') api?.scrollPrev();
    if (event.key === 'ArrowRight') api?.scrollNext();
  }

  // morphs the fitted image into the full-size one (and back) with a view transition
  function setZoom(value: boolean, focus = { x: 0.5, y: 0.5 }) {
    const update = () => {
      flushSync(() => (zoomed = value));
      // land the zoom on the spot that was clicked
      if (pan) {
        pan.scrollLeft = focus.x * pan.scrollWidth - pan.clientWidth / 2;
        pan.scrollTop = focus.y * pan.scrollHeight - pan.clientHeight / 2;
      }
    };
    if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches)
      return update();
    document.startViewTransition(update);
  }

  // zoom to actual size, or at least double what's on screen so small images still grow
  function zoomIn(event: MouseEvent & { currentTarget: HTMLImageElement }) {
    const img = event.currentTarget;
    zoomWidth = Math.max(img.naturalWidth, img.clientWidth * 2);
    setZoom(true, { x: event.offsetX / img.clientWidth, y: event.offsetY / img.clientHeight });
  }
</script>

<svelte:window {onkeydown} />

{#snippet action(label: string, Icon: typeof X, props: Record<string, unknown>)}
  <Tooltip.Root>
    <Tooltip.Trigger>
      {#snippet child({ props: tooltipProps })}
        <Button variant="ghost" size="icon" aria-label={label} {...tooltipProps} {...props}>
          <Icon />
        </Button>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Content side="bottom">{label}</Tooltip.Content>
  </Tooltip.Root>
{/snippet}

<Dialog.Root bind:open>
  <Dialog.Content
    showCloseButton={false}
    onOpenAutoFocus={(event) => event.preventDefault()}
    onEscapeKeydown={(event) => {
      if (!zoomed) return;
      event.preventDefault();
      setZoom(false);
    }}
    class="top-0 left-0 flex h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden bg-background/40 p-0 ring-0 sm:max-w-none in-[.desktop]:top-9 in-[.desktop]:h-[calc(100dvh-36px)]"
  >
    <Dialog.Title class="sr-only">{attachment?.filename ?? 'Attachment'}</Dialog.Title>
    <Dialog.Description class="sr-only">
      Sent by {authorName}. Use the arrow keys to switch between attachments.
    </Dialog.Description>

    {#if attachment}
      <header class="relative z-10 flex shrink-0 items-center gap-3 p-3 sm:px-4">
        <Avatar
          src={author.avatarUrl}
          name={authorName}
          bgColor={author.avatarColor}
          class="size-9 text-xs"
        />
        <div class="min-w-0 flex-1">
          <p class="flex items-baseline gap-2">
            <span class="truncate text-sm font-semibold">{authorName}</span>
            <span class="shrink-0 text-[11px] text-muted-foreground">
              {formatDate(timestamp)} at {formatTime(timestamp)}
            </span>
          </p>
          <p class="truncate text-[11px] text-muted-foreground">
            {attachment.filename}, {formatBytes(attachment.size)}
          </p>
        </div>
        <div class="flex shrink-0 items-center">
          {@render action('Open in new tab', ExternalLink, {
            href: attachment.url,
            target: '_blank',
            rel: 'noreferrer',
          })}
          {@render action('Download', Download, {
            href: attachment.url,
            download: attachment.filename,
          })}
          {@render action('Close', X, { onclick: () => (open = false) })}
        </div>
      </header>

      <Carousel.Root
        setApi={(carouselApi) => (api = carouselApi)}
        opts={{ loop: attachments.length > 1 }}
        class="relative min-h-0 flex-1 [&_[data-slot=carousel-content]]:h-full"
      >
        <Carousel.Content class="ms-0 h-full">
          {#each attachments as item (item.id)}
            <!-- clicking the empty space around the media closes the viewer -->
            <Carousel.Item
              class="flex h-full items-center justify-center px-3 pb-3 sm:px-20 sm:pb-6"
              onclick={(event) => event.target === event.currentTarget && (open = false)}
            >
              {#if item.contentType.startsWith('image/')}
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
                <img
                  src={item.url}
                  alt={item.filename}
                  draggable="false"
                  class="max-h-full max-w-full cursor-zoom-in object-contain shadow-2xl shadow-black/50 select-none"
                  style:view-transition-name={item.id === attachment.id && !zoomed
                    ? 'viewer-image'
                    : undefined}
                  onclick={zoomIn}
                />
              {:else if item.contentType.startsWith('video/')}
                <video
                  src={item.url}
                  aria-label={item.filename}
                  controls
                  class="max-h-full max-w-full shadow-2xl shadow-black/50"
                >
                  <track kind="captions" />
                </video>
              {:else if item.contentType.startsWith('audio/')}
                <audio src={item.url} aria-label={item.filename} controls class="w-full max-w-xl">
                  <track kind="captions" />
                </audio>
              {:else if item.contentType === 'application/pdf'}
                <iframe
                  src={item.url}
                  title={item.filename}
                  class="h-full w-full max-w-4xl bg-white shadow-2xl shadow-black/50"
                ></iframe>
              {/if}
            </Carousel.Item>
          {/each}
        </Carousel.Content>
        {#if attachments.length > 1}
          <Carousel.Previous
            class="start-4 z-10 hidden bg-background/60 backdrop-blur sm:inline-flex"
            variant="ghost"
            size="icon-lg"
          />
          <Carousel.Next
            class="end-4 z-10 hidden bg-background/60 backdrop-blur sm:inline-flex"
            variant="ghost"
            size="icon-lg"
          />
        {/if}

        {#if zoomed}
          <!-- actual size, scroll to pan, click anywhere to fit again -->
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div
            bind:this={pan}
            class="absolute inset-0 z-20 flex cursor-zoom-out overflow-auto bg-background/80 backdrop-blur-xl"
            onclick={() => setZoom(false)}
          >
            <img
              src={attachment.url}
              alt={attachment.filename}
              class="m-auto max-w-none shrink-0"
              style:width="{zoomWidth}px"
              style:view-transition-name="viewer-image"
            />
          </div>
        {/if}
      </Carousel.Root>

      {#if attachments.length > 1}
        <nav
          aria-label="Attachments"
          class="relative z-10 flex shrink-0 justify-center gap-1.5 overflow-x-auto px-3 pb-3"
        >
          {#each attachments as item, i (item.id)}
            <button
              type="button"
              aria-label={`View ${item.filename}`}
              aria-current={i === index}
              class={cn(
                'flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-none bg-muted opacity-40 outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring',
                i === index && 'opacity-100 ring-2 ring-primary'
              )}
              onclick={() => api?.scrollTo(i)}
            >
              {#if item.contentType.startsWith('image/')}
                <img src={item.previewUrl} alt="" class="size-full object-cover" />
              {:else if item.contentType.startsWith('video/')}
                <Video class="size-4 text-muted-foreground" />
              {:else if item.contentType.startsWith('audio/')}
                <Music class="size-4 text-muted-foreground" />
              {:else}
                <FileText class="size-4 text-muted-foreground" />
              {/if}
            </button>
          {/each}
        </nav>
      {/if}
    {/if}
  </Dialog.Content>
</Dialog.Root>

<style>
  :global(::view-transition-group(viewer-image)) {
    animation-duration: 320ms;
    animation-timing-function: cubic-bezier(0.2, 0, 0, 1);
  }
</style>
