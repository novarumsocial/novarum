<script lang="ts">
	import { Slider as SliderPrimitive } from "bits-ui";
	import { cn, type WithoutChild } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: WithoutChild<SliderPrimitive.TickProps> = $props();
</script>

<SliderPrimitive.Tick
	bind:ref
	data-slot="slider-tick"
	class={cn(
		"bg-background/70 data-selected:bg-primary pointer-events-none z-10 data-horizontal:h-1 data-horizontal:w-px data-vertical:h-px data-vertical:w-1",
		className
	)}
	{...restProps}
/>
