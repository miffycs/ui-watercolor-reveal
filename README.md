# ui-watercolor-reveal

🎨 WebGL practice — recreating the watercolor reveal effect from <https://ai-quest.lusion.co/> using **React Three Fiber** and GLSL shaders.

A grayscale image reveals its colored version wherever your cursor moves.
Each stroke lays down paint with naturally irregular fluid edges, and the
"water" keeps bleeding outward for ~3 seconds *after* the cursor stops —
exactly like watercolor settling into paper.

**The reference** we were recreating (the original Lusion effect):

https://github.com/user-attachments/assets/8c654b3c-527a-43bb-9c84-3ff559a06319

**The result (this repo):** [demo recording](./Screen%20Recording%202026-05-28%20at%202.44.19%20PM.mov)

https://github.com/user-attachments/assets/d1a441c1-7521-44ba-bbb4-66f55e29406f

---

## Part 1 — How to describe this effect (so an LLM / graphics dev gets it on the first try)

The terms that get you understood the fastest:

| Term | What it means in this effect |
|---|---|
| **Interactive alpha-mask reveal** | Two source images (color + grayscale) mixed per-pixel by a mask texture |
| **Framebuffer object / render target** | An off-screen canvas that *persists between frames*. This is what makes the mouse trail "stick" instead of disappearing the moment the mouse moves on |
| **Two-channel state texture** | Pack the FBO as `R = wetness, A = mask`. Brush stamps both at once but with *different per-channel blend equations* — additive on RGB (wetness saturates fast), normal-alpha on A (mask builds up with brush opacity) |
| **Wet halo brush** | One brush stamp writes the visible mask into a *small* inner circle and writes wetness into a *larger* halo. The wetness halo is where the bleed is allowed to grow into; nothing past it can ever bleed |
| **Ping-pong FBOs** | Two render targets that alternate roles each frame. Pass 1 reads from `inFbo`, writes a grown state into `outFbo`; next frame they swap. This is the only way to write back into the texture you read from in WebGL |
| **Soak / diffusion pass** | The mask physically grows each frame: every pixel pulls its mask value toward its brightest 8-ring neighbor, scaled by the wetness at that pixel. Wetness also creeps one ring outward per frame, with a falloff multiplier so total spread is bounded |
| **Domain warping / UV displacement with simplex noise** | Perturb the sample coordinate into the mask using a 2D noise field. Turns a circular edge into an organic watercolor edge. *Spatial only*, no `uTime` — adding time makes it look like flowing smoke, not paper |
| **Decay-modulated growth** | Wetness is subtracted by a small amount each frame. The soak pass only grows where wetness > 0, so once a region is "dry" the mask freezes in place. That's what "and then stops" feels like |

### A reusable prompt template

> Build an interactive WebGL watercolor reveal using React Three Fiber.
> Render a fullscreen quad textured with a vibrant color image and
> desaturate it inside the fragment shader (one image, not two).
>
> Use **two ping-pong RGBA framebuffers** to hold a persistent state.
> Each FBO encodes `R = wetness, A = mask`. Each frame, on the current
> "input" FBO: (1) run a decay pass that subtracts a small dt-scaled
> value from R only — `ReverseSubtractEquation` for RGB, alpha factors
> set to `Zero, One` so the mask is untouched. (2) Stamp the brush. The
> brush plane is ~2× the size of the visible stroke; its fragment shader
> writes the mask alpha into a smaller inner circle (`smoothstep(0,
> 1/wetHalo, d)`) and the wetness R into the full plane (`smoothstep(0,
> 1, d)`). Use `CustomBlending` with separate RGB and alpha equations:
> RGB additive (`Add One One`) so wetness saturates after a couple of
> stamps, alpha normal (`Add One OneMinusSrcAlpha`) so mask builds up
> with brush opacity.
>
> Then run a **soak pass** that reads the input FBO and writes a new
> state to the output FBO via `NoBlending` (full-RGBA replace). For each
> pixel, sample the 8 ring neighbors at radius ~3 texels. Compute the
> max neighbor mask and the max neighbor wetness. Pull the pixel's mask
> toward `maxNeighborMask` scaled by `max(self.r, maxNeighbor.r) *
> soakStrength` — so wet pixels (or pixels next to wet pixels) grow,
> dry pixels are unchanged. Also propagate wetness outward with
> `wetness = max(wetness, maxNeighborWet * 0.86)` so the wet front
> advances one ring per frame, fading with distance.
>
> Swap input and output for the next frame. The composite pass reads
> whichever FBO just got soaked into. Composite just samples the mask
> at `vUv + spatialNoise()` (no `uTime` — keep it static so it doesn't
> flow like smoke), smoothsteps the edge, and `mix(luma, color, mask)`.
>
> Net effect: brush stamps deposit paint with a fluid edge. While the
> wetness is still present (~3 sec), the mask keeps growing outward
> inside the wet halo. Once wetness decays to zero, the mask freezes —
> watercolor bleeding out, then settling.

### Things people get wrong when describing it

- Calling it "an SVG mask" — SVG can't sample noise per-pixel at 60fps.
- Saying "the mouse erases the gray layer" — there's no erasing. Both images
  are always there; the mask just chooses which one to show.
- Drawing a circle every frame at the cursor — gives a hard circle, not a
  trail. You need a persistent FBO so stamps accumulate.
- Forgetting the noise step — without UV displacement the edge is a perfect
  smoothstep'd circle. The result will look like an airbrush.
- **Animating the noise with `uTime` for the "watercolor" feel** — gives you
  flowing smoke, not water. Watercolor edges are *spatially* irregular but
  *temporally* still. Keep the displacement static and use a separate
  diffusion pass for the time-based bleed.
- **Doing the bleed as a render-time dilation only.** That gives an instant
  halo that doesn't linger past the cursor, and worse, it *retracts* as the
  wetness decays. The bleed has to be baked into the FBO state itself, via
  a ping-pong soak pass.

---

## Part 2 — How it works

```
                ┌──────────────────┐    ┌──────────────────────┐
                │  Cursor position │ →  │ Wet-halo brush stamp │
                │ (NDC, R3F)       │    │ • A += falloff·op    │
                └──────────────────┘    │ • R += larger falloff│
                                        └──────────┬───────────┘
                                                   │
              ┌──────────────────┐    ┌────────────▼─────────┐
              │ Decay quad       │ →  │   inFbo (R, A)       │
              │ (every frame,    │    │  wetness + mask      │
              │  ReverseSubtract │    └────────────┬─────────┘
              │  on R only)      │                 │ read
              └──────────────────┘                 ↓
                                       ┌──────────────────────┐
                                       │ Soak pass            │
                                       │ • for each pixel,    │
                                       │   sample 8 neighbors │
                                       │ • mask ← mix(mask,   │
                                       │     maxN, wet*k)     │
                                       │ • wet  ← max(wet,    │
                                       │     maxNwet * 0.86)  │
                                       │ • NoBlending replace │
                                       └────────────┬─────────┘
                                                    │ write
                                                    ↓
                                       ┌──────────────────────┐
                                       │  outFbo (R, A)       │
                                       │  ←── composite reads │
                                       └────────────┬─────────┘
                                                    │
                                       (next frame: outFbo
                                        becomes inFbo, etc.)
                                                    │
┌──────────────────┐                                ↓
│ Color image      │ ──→ ┌──────────────────────────────────────────────┐
│ (one of three    │     │ Composite fragment shader (fullscreen quad): │
│  webps in /img)  │     │   luma  = dot(rgb, [.299, .587, .114])       │
└──────────────────┘     │   disp  = vec2(noise(uv), noise(uv+100))     │
                         │   mask  = texture(tFbo, uv + disp).a         │
                         │   mask  = smoothstep(0, edgeSoft, mask)      │
                         │   out   = mix(luma, color, mask)             │
                         └─────────────────────┬────────────────────────┘
                                               ↓
                                       ┌──────────────┐
                                       │ Screen pixel │
                                       └──────────────┘
```

Three render passes per frame, all into the FBOs, all before R3F renders
the main scene:

1. **Decay pass** subtracts a dt-scaled value from R only. Uses
   `ReverseSubtractEquation` for RGB (`dst − src`) and `Zero/One` alpha
   factors so the mask in A is preserved. Wetness fades whether or not the
   cursor is moving.

2. **Brush pass** stamps the wet-halo brush at interpolated cursor
   positions. The brush plane is `brushSize × wetHalo` in NDC. Its
   fragment shader:
   - Computes `d = length(vUv − 0.5) * 2`.
   - Writes mask alpha for `d` inside `1/wetHalo` (the inner part of the
     plane — the visible stroke).
   - Writes wetness for `d` inside `1.0` (the whole plane — the soak
     reservoir).
   - Outputs `vec4(wet, 0, 0, a * uOpacity)`.
   
   The material uses `THREE.CustomBlending` with separate per-channel
   equations:
   - RGB: `Add(One, One)` — wetness saturates after about one stamp.
   - Alpha: `Add(One, OneMinusSrcAlpha)` — mask asymptotes per brush opacity.

3. **Soak pass.** A fullscreen quad with `NoBlending` (full-RGBA replace).
   The fragment shader reads `tInput` at `vUv` and at 8 ring positions,
   computes the brightest neighbor's mask + wetness, and writes:
   - `mask ← mix(mask, maxN_mask, wetDriver * soakStrength)` — growth
     scaled by the brightest local wetness.
   - `wetness ← max(wetness, maxN_wet * wetSpread)` — the wet front
     creeps outward by one ring radius per frame, fading geometrically.

4. (Then R3F renders the main scene.) **Composite pass** is a fullscreen
   quad textured with the just-soaked FBO. It samples mask at
   `vUv + spatialNoise()`, smoothsteps the edge, and `mix(luma, color, mask)`.

### Why the noise displacement matters

Without noise:

```glsl
float mask = texture2D(tMask, vUv).a;          // crisp soft-circle edge
```

With **spatial** noise:

```glsl
vec2 disp = vec2(snoise(vUv * scale),
                 snoise(vUv * scale + 100.0)) * strength;
float mask = texture2D(tMask, vUv + disp).a;   // fluid, irregular edge
```

You're not changing the *mask*, you're changing *where you look in the
mask*. The pixels near the boundary sometimes sample "inside" (where the
mask is opaque) and sometimes sample "outside" — the edge develops
finger-shaped tendrils.

Critically there's no `uTime` in the noise sample. The noise field is
fixed in screen space, so the fluid edge shape is stable. Adding time-
varying noise was an earlier version of this code and gave the strokes a
constant smoky/flame-like flow that didn't look like watercolor at all.

### Why the soak pass matters

The previous version of this effect used a render-time **dilation** in the
composite shader — sample the mask at 8 (or 16) ring positions, take the
max. That gives an instant halo, but it has two problems:

1. The bleed is purely a function of the current cursor position. The
   moment you stop the cursor, the bleed stops.
2. If you tie the dilation radius to wetness so it doesn't bleed forever,
   the halo *retracts* as wetness decays, which looks like the paint is
   being un-absorbed. Backwards from real watercolor.

The soak pass fixes both by baking the growth into the *actual mask in the
FBO*. Each frame, wet pixels permanently nudge their mask values upward
toward their brightest neighbors. Wetness creeps one ring outward per
frame, so the mask follows behind it. Once wetness fully decays (~3 sec
at the default `settleSpeed = 0.35`), no pixel has any growth driver left,
and the mask freezes wherever it stopped. The bleed is permanent.

The wet halo on the brush is what gives the soak somewhere to grow into.
Without it, freshly stamped wetness sits inside the painted area only —
the mask is already saturated there, so the "max neighbor" growth is
a no-op, and there's no bleed at all. With the halo, wetness is deposited
in a region around the stroke where the mask is still zero, so the soak
can actually grow the mask into that region over the wet duration.

---

## Run it

```sh
# clean the old vanilla-three install (only needed once on first switch)
rm -rf node_modules package-lock.json

# install React + Three + R3F + drei + Vite
npm install

# start the dev server
npm run dev
```

Then open the printed URL (usually <http://localhost:5173>).

---

## Controls

| Control | What it does |
|---|---|
| **Image thumbnails (1A / 1B / 1C)** | Switch between the three story-intro images in `/img`. Switching wipes the mask |
| **Load image** | Pick any local file — gray is computed in-shader |
| **Reset mask** | Wipe both FBOs and start fresh |
| **Brush size** | Diameter of the *visible* mask area (the wet halo extends past this by `wetHalo` ×) |
| **Brush opacity** | How much alpha each stamp deposits. 1.0 = single stamp at brush center reveals fully. Default 0.7 = 1–2 stamps for full reveal |
| **Noise scale** | Frequency of the displacement noise. High = small wiggles, low = big swooping tendrils |
| **Displacement** | Amplitude of the UV displacement. 0 = airbrush; 0.1+ = aggressive splatter |
| **Edge softness** | Width of the smoothstep that turns the raw mask value into the mix factor |
| **Wet halo** | How far past the visible mask the brush deposits wetness — i.e. the maximum distance the bleed can ever reach. Default 2.2× the brush size |
| **Settle speed** | How fast wetness decays. Lower = bleed continues longer after the cursor stops. Default 0.35 ≈ 3 seconds wet. Try 0.15 for a slow, dramatic spread |

Some combinations to try:

- **Classic watercolor:** brush 0.18, opacity 0.7, noise 5, displacement 0.05, wetHalo 2.2, settle 0.35 (defaults)
- **Slow ink wash:** opacity 0.4, wetHalo 3.0, settle 0.15 — multiple light strokes build up, and the bleed creeps for ~6 seconds
- **Tight stroke, minimal bleed:** wetHalo 1.2, settle 1.5 — almost no halo, dries fast
- **Pixelated paper:** noise 14, displacement 0.04, wetHalo 2.5

---

## Project structure

```
ui-watercolor-reveal/
├── index.html                       Vite entry
├── package.json                     React, R3F, drei, Three, Vite
├── vite.config.js
├── img/                             Three story-intro webp images
│   ├── 1A_Story_Intro.webp
│   ├── 1B_Story_Intro.webp
│   └── 1C_Story_Intro.webp
├── Screen Recording … .mov          Reference video (fed to the LLM originally)
└── src/
    ├── main.jsx                     React root
    ├── App.jsx                      Canvas, image picker, sliders
    ├── App.css
    ├── index.css
    └── WatercolorReveal.jsx         The effect:
                                       • brush / decay / soak / reveal shaders
                                       • ping-pong FBO pair
                                       • brush + decay + soak scenes
                                       • useFrame loop (decay → brush → soak)
                                       • fullscreen reveal quad
```

---

## Where to take it next

- **Real brush texture.** Replace the procedural soft circle with a
  watercolor splatter PNG; rotate it randomly per stamp. Biggest single
  quality jump.
- **Anisotropic soak.** Right now the soak grows uniformly in 8 directions.
  Real watercolor bleeds further along paper-fiber direction. Add a
  per-pixel "fiber direction" sampled from a tiling normal map and bias
  the 8 ring offsets along it.
- **Pigment/water separation.** Watercolor has a darker rim where pigment
  has migrated to the wet edge. Add a second channel for "pigment
  concentration" that diffuses *slower* than the wet front — the
  trailing edge of the wet front accumulates a darker line.
- **Color bleed.** Apply a small displacement to the *color* sample too,
  not just the mask. Looks like ink soaking through paper fibers.
- **Velocity-aware brush.** Scale brush size or opacity by `dist / dt`,
  so flicks leave thin trails and slow drags pool color.
- **Touch / mobile.** R3F's `state.pointer` already includes touch — just
  add `touch-action: none` to the canvas to suppress page scrolling.

---

## Common pitfalls

- **CORS.** Loading a remote image that doesn't set CORS headers will
  produce a black texture in WebGL. The three webps in `/img` are local
  so this isn't an issue, but if you swap to an external URL, check
  `Access-Control-Allow-Origin`.
- **Forgetting to disable `autoClear` for the in-place passes.** The
  decay and brush passes write into the same FBO across frames; if
  `autoClear` is on it gets wiped every frame and you'll just see the
  current frame's stamps.
- **Drawing the brush in the main scene by accident.** It needs to render
  into the FBO only. We use `createPortal` to put it in a private scene
  the main camera never sees.
- **Reading from and writing to the same FBO in the soak pass.** WebGL
  spec says this is undefined behavior. That's why we ping-pong — read
  from `inFbo`, write to `outFbo`, swap next frame.
- **Wetness leaking into the mask.** If the decay pass touches the alpha
  channel you'll watch your reveal slowly disappear. The decay material
  uses `blendSrcAlpha: Zero, blendDstAlpha: One` to keep alpha frozen.
- **Animating the noise with `uTime`.** Looks like smoke, not watercolor.
  Keep noise displacement spatial only; let the *soak pass* provide the
  time-based behavior.
- **No wet halo on the brush.** If the brush stamps wetness and mask in
  the same radius, the soak has nothing to grow into — the mask is
  already saturated everywhere wetness exists, so `max(mask, maxNeighbor)`
  is a no-op. The wet halo (>1.0) gives the soak somewhere to expand to.

---

## References

- [Lusion Labs AI Quest](https://ai-quest.lusion.co/) — the original effect
- [Three.js Documentation](https://threejs.org/docs/)
- [React Three Fiber](https://r3f.docs.pmnd.rs/)
- [drei](https://drei.docs.pmnd.rs/) — `useFBO`, `useTexture`
- [The Book of Shaders](https://thebookofshaders.com/)
- [WebGL Fundamentals](https://webglfundamentals.org/)
- [Ashima Arts simplex noise](https://github.com/ashima/webgl-noise)
