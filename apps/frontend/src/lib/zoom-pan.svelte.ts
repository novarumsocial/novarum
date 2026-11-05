const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

// Zoom (wheel, trackpad pinch, touch pinch) and pan (drag while zoomed) for one element's content.
// The content is scaled from its top-left corner and kept covering the element, so it can't be
// dragged out of view.
export class ZoomPan {
  scale = $state(1);
  x = $state(0);
  y = $state(0);
  // true once a gesture moved the content, so the click that ends it can be ignored
  moved = false;
  #node: HTMLElement | null = null;
  #pointers = new Map<number, { x: number; y: number }>();
  #pinchDistance = 0;

  constructor(private max = 5) {}

  get zoomed() {
    return this.scale > 1.001;
  }

  get transform() {
    return `translate(${this.x}px, ${this.y}px) scale(${this.scale})`;
  }

  reset() {
    this.scale = 1;
    this.x = 0;
    this.y = 0;
  }

  // keeps the content point under (px, py) in place while scaling
  zoomAt(px: number, py: number, scale: number) {
    const next = clamp(scale, 1, this.max);
    const contentX = (px - this.x) / this.scale;
    const contentY = (py - this.y) / this.scale;
    this.scale = next;
    this.pan(px - contentX * next - this.x, py - contentY * next - this.y);
  }

  // zooms around the middle, for keyboard shortcuts
  zoomBy(factor: number) {
    const { width, height } = this.#node?.getBoundingClientRect() ?? { width: 0, height: 0 };
    this.zoomAt(width / 2, height / 2, this.scale * factor);
  }

  pan(dx: number, dy: number) {
    const { width, height } = this.#node?.getBoundingClientRect() ?? { width: 0, height: 0 };
    this.x = clamp(this.x + dx, width * (1 - this.scale), 0);
    this.y = clamp(this.y + dy, height * (1 - this.scale), 0);
  }

  #local(event: { clientX: number; clientY: number }) {
    const rect = this.#node!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  attach = (node: HTMLElement) => {
    this.#node = node;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = this.#local(event);
      // trackpad pinches arrive as ctrl+wheel with small deltas, so they get a stronger factor
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015));
      this.zoomAt(point.x, point.y, this.scale * factor);
    };

    const pinchDistance = () => {
      const [a, b] = [...this.#pointers.values()];
      return Math.hypot(a!.x - b!.x, a!.y - b!.y);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (this.#pointers.size === 0) this.moved = false;
      this.#pointers.set(event.pointerId, this.#local(event));
      if (this.#pointers.size === 2) this.#pinchDistance = pinchDistance();
    };

    const onPointerMove = (event: PointerEvent) => {
      const previous = this.#pointers.get(event.pointerId);
      if (!previous) return;
      const point = this.#local(event);
      this.#pointers.set(event.pointerId, point);

      if (this.#pointers.size === 2) {
        const distance = pinchDistance();
        const [a, b] = [...this.#pointers.values()];
        this.zoomAt((a!.x + b!.x) / 2, (a!.y + b!.y) / 2, (this.scale * distance) / this.#pinchDistance);
        this.#pinchDistance = distance;
        this.moved = true;
      } else if (this.zoomed && (event.pointerType !== 'mouse' || event.buttons === 1)) {
        const dx = point.x - previous.x;
        const dy = point.y - previous.y;
        if (Math.abs(dx) + Math.abs(dy) > 0) this.moved = true;
        this.pan(dx, dy);
      }
    };

    const onPointerUp = (event: PointerEvent) => this.#pointers.delete(event.pointerId);

    node.addEventListener('wheel', onWheel, { passive: false });
    node.addEventListener('pointerdown', onPointerDown);
    node.addEventListener('pointermove', onPointerMove);
    node.addEventListener('pointerup', onPointerUp);
    node.addEventListener('pointercancel', onPointerUp);
    node.addEventListener('pointerleave', onPointerUp);
    return () => {
      node.removeEventListener('wheel', onWheel);
      node.removeEventListener('pointerdown', onPointerDown);
      node.removeEventListener('pointermove', onPointerMove);
      node.removeEventListener('pointerup', onPointerUp);
      node.removeEventListener('pointercancel', onPointerUp);
      node.removeEventListener('pointerleave', onPointerUp);
      this.#pointers.clear();
      this.#node = null;
    };
  };
}
