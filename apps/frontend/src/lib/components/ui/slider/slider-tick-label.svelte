<script lang="ts">
	import { Slider as SliderPrimitive } from "bits-ui";
	import { cn, type WithoutChild } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithoutChild<SliderPrimitive.TickLabelProps> = $props();
</script>

<SliderPrimitive.TickLabel
	bind:ref
	data-slot="slider-tick-label"
	class={cn(
		"text-muted-foreground data-selected:text-foreground pointer-events-none text-[10px] leading-none tabular-nums data-[position=top]:mb-3 data-[position=bottom]:mt-3 data-[position=left]:mr-3 data-[position=right]:ml-3",
		className
	)}
	{...restProps}
>
	{@render children?.()}
</SliderPrimitive.TickLabel>
