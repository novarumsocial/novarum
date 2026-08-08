<script lang="ts">
	import { PinInput as InputOTPPrimitive } from "bits-ui";
	import { cn } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		cell,
		class: className,
		...restProps
	}: InputOTPPrimitive.CellProps = $props();
</script>

<InputOTPPrimitive.Cell
	{cell}
	bind:ref
	data-slot="input-otp-slot"
	class={cn(
		"size-8 border-y border-r border-input text-xs transition-all outline-none first:rounded-none first:border-l last:rounded-none aria-invalid:border-destructive data-[active=true]:border-ring data-[active=true]:ring-1 data-[active=true]:ring-ring/50 data-[active=true]:aria-invalid:border-destructive data-[active=true]:aria-invalid:ring-destructive/20 dark:bg-input/30 dark:data-[active=true]:aria-invalid:ring-destructive/40 relative flex items-center justify-center data-[active=true]:z-10",
		className
	)}
	{...restProps}
>
	{cell.char}
	{#if cell.hasFakeCaret}
		<div
			class="cn-input-otp-caret pointer-events-none absolute inset-0 flex items-center justify-center"
		>
			<div class="h-4 w-px animate-caret-blink bg-foreground duration-1000 h-4 w-px bg-foreground"></div>
		</div>
	{/if}
</InputOTPPrimitive.Cell>
