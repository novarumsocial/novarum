<script lang="ts">
	let {
		class: className
	}: { class?: string } = $props();

	let canvas: HTMLCanvasElement | null = $state(null);

	$effect(() => {
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		const c = ctx;

		const reduce = typeof matchMedia === "function"
			&& matchMedia("(prefers-reduced-motion: reduce)").matches;

		const ACCENT: readonly [number, number, number] = [130, 175, 235];
		const HOT: readonly [number, number, number] = [188, 212, 250];
		const MAX_DIST = 150;

		let raf = 0;
		let width = 0;
		let height = 0;
		let dpr = 1;

		type Node = {
			x: number;
			y: number;
			vx: number;
			vy: number;
			r: number;
			hub: boolean;
			phase: number;
		};
		type Packet = { a: Node; b: Node; t: number; speed: number };

		let nodes: Node[] = [];
		let packets: Packet[] = [];
		const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
		let seeded = false;

		function resize() {
			const rect = canvas!.getBoundingClientRect();
			width = rect.width;
			height = rect.height;
			if (width === 0 || height === 0) return;
			dpr = Math.min(window.devicePixelRatio || 1, 2);
			canvas!.width = Math.floor(width * dpr);
			canvas!.height = Math.floor(height * dpr);
			c.setTransform(dpr, 0, 0, dpr, 0, 0);
			const count = Math.min(85, Math.floor((width * height) / 17000));
			nodes = [];
			for (let i = 0; i < count; i++) {
				const hub = Math.random() < 0.12;
				nodes.push({
					x: Math.random() * width,
					y: Math.random() * height,
					vx: (Math.random() - 0.5) * 0.22,
					vy: (Math.random() - 0.5) * 0.22,
					r: hub ? 2.1 + Math.random() * 1.1 : 0.9 + Math.random() * 0.8,
					hub,
					phase: Math.random() * Math.PI * 2
				});
			}
			if (!seeded) {
				mouse.x = mouse.tx = width / 2;
				mouse.y = mouse.ty = height / 2;
				seeded = true;
			}
		}

		function frame() {
			c.clearRect(0, 0, width, height);
			mouse.x += (mouse.tx - mouse.x) * 0.045;
			mouse.y += (mouse.ty - mouse.y) * 0.045;
			const ox = ((mouse.x - width / 2) / width) * 10;
			const oy = ((mouse.y - height / 2) / height) * 10;

			for (const p of nodes) {
				p.x += p.vx;
				p.y += p.vy;
				p.phase += 0.018;
				if (p.x < -24) p.x = width + 24;
				else if (p.x > width + 24) p.x = -24;
				if (p.y < -24) p.y = height + 24;
				else if (p.y > height + 24) p.y = -24;
			}

			for (let i = 0; i < nodes.length; i++) {
				for (let j = i + 1; j < nodes.length; j++) {
					const a = nodes[i];
					const b = nodes[j];
					if (!a || !b) continue;
					const dx = a.x - b.x;
					const dy = a.y - b.y;
					const d = Math.hypot(dx, dy);
					if (d >= MAX_DIST) continue;
					const alpha = (1 - d / MAX_DIST) * 0.2;
					c.strokeStyle = `rgba(${ACCENT[0]},${ACCENT[1]},${ACCENT[2]},${alpha})`;
					c.lineWidth = 0.6;
					c.beginPath();
					c.moveTo(a.x + ox, a.y + oy);
					c.lineTo(b.x + ox, b.y + oy);
					c.stroke();
					if (a.hub && b.hub && Math.random() < 0.0009) {
						packets.push({ a, b, t: 0, speed: 0.007 + Math.random() * 0.012 });
					}
				}
			}

			for (let i = packets.length - 1; i >= 0; i--) {
				const pk = packets[i];
				if (!pk) continue;
				pk.t += pk.speed;
				if (pk.t >= 1) {
					packets.splice(i, 1);
					continue;
				}
				const px = pk.a.x + (pk.b.x - pk.a.x) * pk.t + ox;
				const py = pk.a.y + (pk.b.y - pk.a.y) * pk.t + oy;
				const fade = Math.sin(pk.t * Math.PI);
				c.fillStyle = `rgba(${ACCENT[0]},${ACCENT[1]},${ACCENT[2]},${0.22 * fade})`;
				c.beginPath();
				c.arc(px, py, 4.5, 0, Math.PI * 2);
				c.fill();
				c.fillStyle = `rgba(${HOT[0]},${HOT[1]},${HOT[2]},${0.95 * fade})`;
				c.beginPath();
				c.arc(px, py, 1.6, 0, Math.PI * 2);
				c.fill();
			}

			for (const p of nodes) {
				const px = p.x + ox;
				const py = p.y + oy;
				if (p.hub) {
					const pulse = 0.55 + Math.sin(p.phase) * 0.45;
					c.fillStyle = `rgba(${ACCENT[0]},${ACCENT[1]},${ACCENT[2]},${0.16 * pulse})`;
					c.beginPath();
					c.arc(px, py, p.r * 4.2, 0, Math.PI * 2);
					c.fill();
					c.fillStyle = `rgba(${HOT[0]},${HOT[1]},${HOT[2]},${0.85 * pulse})`;
				} else {
					c.fillStyle = `rgba(${ACCENT[0]},${ACCENT[1]},${ACCENT[2]},0.5)`;
				}
				c.beginPath();
				c.arc(px, py, p.r, 0, Math.PI * 2);
				c.fill();
			}

			raf = requestAnimationFrame(frame);
		}

		function onMove(e: PointerEvent) {
			const rect = canvas!.getBoundingClientRect();
			mouse.tx = e.clientX - rect.left;
			mouse.ty = e.clientY - rect.top;
		}

		resize();
		if (reduce) {
			frame();
			cancelAnimationFrame(raf);
		} else {
			window.addEventListener("resize", resize);
			window.addEventListener("pointermove", onMove, { passive: true });
			raf = requestAnimationFrame(frame);
		}

		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener("resize", resize);
			window.removeEventListener("pointermove", onMove);
		};
	});
</script>

<canvas bind:this={canvas} class={className} aria-hidden="true"></canvas>
