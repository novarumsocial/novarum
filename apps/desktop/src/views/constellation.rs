// Port of apps/frontend/src/lib/components/constellation-background.svelte.
use std::f32::consts::PI;

use crate::prelude::*;
use rand::Rng;

const ACCENT: (f32, f32, f32) = (130.0, 175.0, 235.0);
const HOT: (f32, f32, f32) = (188.0, 212.0, 250.0);
const MAX_DIST: f32 = 150.0;

fn color((r, g, b): (f32, f32, f32), alpha: f32) -> Hsla {
    Rgba { r: r / 255.0, g: g / 255.0, b: b / 255.0, a: alpha }.into()
}

#[derive(Clone, Copy)]
struct Node {
    x: f32,
    y: f32,
    vx: f32,
    vy: f32,
    r: f32,
    hub: bool,
    phase: f32,
}

struct Packet {
    a: usize,
    b: usize,
    t: f32,
    speed: f32,
}

pub struct ConstellationBackground {
    nodes: Vec<Node>,
    packets: Vec<Packet>,
    size: (f32, f32),
    mouse: (f32, f32, f32, f32),
}

struct Global_(Entity<ConstellationBackground>);
impl Global for Global_ {}

impl ConstellationBackground {
    /// One field for the app, so it keeps drifting across page changes.
    pub fn global(cx: &mut App) -> Entity<Self> {
        if let Some(global) = cx.try_global::<Global_>() {
            return global.0.clone();
        }
        let entity = cx.new(|_| Self { nodes: vec![], packets: vec![], size: (0.0, 0.0), mouse: (0.0, 0.0, 0.0, 0.0) });
        cx.set_global(Global_(entity.clone()));
        entity
    }

    fn resize(&mut self, width: f32, height: f32) {
        let mut rng = rand::rng();
        let count = 85.min((width * height / 17000.0) as usize);
        self.nodes = (0..count)
            .map(|_| {
                let hub = rng.random::<f32>() < 0.12;
                Node {
                    x: rng.random::<f32>() * width,
                    y: rng.random::<f32>() * height,
                    vx: (rng.random::<f32>() - 0.5) * 0.22,
                    vy: (rng.random::<f32>() - 0.5) * 0.22,
                    r: if hub { 2.1 + rng.random::<f32>() * 1.1 } else { 0.9 + rng.random::<f32>() * 0.8 },
                    hub,
                    phase: rng.random::<f32>() * PI * 2.0,
                }
            })
            .collect();
        self.packets.clear();
        if self.size == (0.0, 0.0) {
            self.mouse = (width / 2.0, height / 2.0, width / 2.0, height / 2.0);
        }
        self.size = (width, height);
    }

    fn step(&mut self) {
        let (width, height) = self.size;
        let mut rng = rand::rng();
        self.mouse.0 += (self.mouse.2 - self.mouse.0) * 0.045;
        self.mouse.1 += (self.mouse.3 - self.mouse.1) * 0.045;
        for p in &mut self.nodes {
            p.x += p.vx;
            p.y += p.vy;
            p.phase += 0.018;
            if p.x < -24.0 { p.x = width + 24.0 } else if p.x > width + 24.0 { p.x = -24.0 }
            if p.y < -24.0 { p.y = height + 24.0 } else if p.y > height + 24.0 { p.y = -24.0 }
        }
        for i in 0..self.nodes.len() {
            for j in i + 1..self.nodes.len() {
                let (a, b) = (self.nodes[i], self.nodes[j]);
                if a.hub && b.hub && (a.x - b.x).hypot(a.y - b.y) < MAX_DIST && rng.random::<f32>() < 0.0009 {
                    self.packets.push(Packet { a: i, b: j, t: 0.0, speed: 0.007 + rng.random::<f32>() * 0.012 });
                }
            }
        }
        self.packets.retain_mut(|packet| {
            packet.t += packet.speed;
            packet.t < 1.0
        });
    }
}

fn dot(window: &mut Window, origin: Point<Pixels>, x: f32, y: f32, r: f32, fill: Hsla) {
    let bounds = Bounds::new(
        point(origin.x + px(x - r), origin.y + px(y - r)),
        size(px(r * 2.0), px(r * 2.0)),
    );
    window.paint_quad(gpui_kit::fill(bounds, fill).corner_radii(px(r)));
}

impl Render for ConstellationBackground {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let viewport = window.viewport_size();
        let (width, height) = (f32::from(viewport.width), f32::from(viewport.height));
        if (width, height) != self.size {
            self.resize(width, height);
        }
        self.step();
        window.request_animation_frame();

        let nodes = self.nodes.clone();
        let packets: Vec<(usize, usize, f32)> = self.packets.iter().map(|p| (p.a, p.b, p.t)).collect();
        let (ox, oy) = (
            (self.mouse.0 - width / 2.0) / width.max(1.0) * 10.0,
            (self.mouse.1 - height / 2.0) / height.max(1.0) * 10.0,
        );

        div()
            .id("constellation")
            .size_full()
            .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, _, _| {
                this.mouse.2 = f32::from(event.position.x);
                this.mouse.3 = f32::from(event.position.y);
            }))
            .child(
                canvas(
                    |_, _, _| {},
                    move |bounds, _, window, _| {
                        let origin = bounds.origin;
                        for i in 0..nodes.len() {
                            for j in i + 1..nodes.len() {
                                let (a, b) = (nodes[i], nodes[j]);
                                let d = (a.x - b.x).hypot(a.y - b.y);
                                if d >= MAX_DIST {
                                    continue;
                                }
                                let mut path = PathBuilder::stroke(px(0.6));
                                path.move_to(point(origin.x + px(a.x + ox), origin.y + px(a.y + oy)));
                                path.line_to(point(origin.x + px(b.x + ox), origin.y + px(b.y + oy)));
                                if let Ok(path) = path.build() {
                                    window.paint_path(path, color(ACCENT, (1.0 - d / MAX_DIST) * 0.2));
                                }
                            }
                        }
                        for &(a, b, t) in &packets {
                            let (a, b) = (nodes[a], nodes[b]);
                            let x = a.x + (b.x - a.x) * t + ox;
                            let y = a.y + (b.y - a.y) * t + oy;
                            let fade = (t * PI).sin();
                            dot(window, origin, x, y, 4.5, color(ACCENT, 0.22 * fade));
                            dot(window, origin, x, y, 1.6, color(HOT, 0.95 * fade));
                        }
                        for p in &nodes {
                            let (x, y) = (p.x + ox, p.y + oy);
                            if p.hub {
                                let pulse = 0.55 + p.phase.sin() * 0.45;
                                dot(window, origin, x, y, p.r * 4.2, color(ACCENT, 0.16 * pulse));
                                dot(window, origin, x, y, p.r, color(HOT, 0.85 * pulse));
                            } else {
                                dot(window, origin, x, y, p.r, color(ACCENT, 0.5));
                            }
                        }
                    },
                )
                .size_full(),
            )
    }
}
