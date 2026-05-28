import { useRef, useMemo, useEffect } from 'react'
import { useFrame, useThree, createPortal } from '@react-three/fiber'
import { useTexture, useFBO } from '@react-three/drei'
import * as THREE from 'three'

// 2D simplex noise — Ashima Arts / Stefan Gustavson, MIT licensed.
const noiseGLSL = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }

float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                     -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
                 + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy),
                          dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
`

const fullscreenVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

// Brush has TWO falloffs at different radii inside the same plane:
//   A (mask)   — small soft circle (the actual stroke)
//   R (wetness) — much larger soft halo (where the paint *could* spread to)
// Each stamp writes to both. RGB blends additively (wetness saturates fast),
// alpha blends normally (mask builds up with brush opacity).
const brushFragment = /* glsl */ `
varying vec2 vUv;
uniform float uOpacity;
uniform float uMaskRange;

void main() {
  vec2 c = vUv - 0.5;
  float d = length(c) * 2.0;             // 0 at center → ~sqrt(2) at corners

  // Mask: confined to the inner uMaskRange of the plane
  float a = 1.0 - smoothstep(0.0, uMaskRange, d);
  a = pow(a, 1.5);

  // Wetness: extends to the plane edge, giving the soak pass somewhere
  // outside the visible stroke to expand the mask into.
  float wet = 1.0 - smoothstep(0.0, 1.0, d);
  wet = pow(wet, 1.5);

  gl_FragColor = vec4(wet, 0.0, 0.0, a * uOpacity);
}
`

// Decay pass — subtract dt-scaled value from R every frame, leaves A alone.
const decayFragment = /* glsl */ `
uniform float uDecay;
void main() {
  gl_FragColor = vec4(uDecay, 0.0, 0.0, 0.0);
}
`

// Soak pass — the heart of the lingering bleed.
// For each pixel, look at the 8 ring neighbors. Pull the mask toward the
// brightest neighbor's mask value, but only as fast as the wetness allows.
// Also propagate wetness slightly outward so the wet ring expands ahead of
// the mask, giving the mask something to grow into next frame.
// Runs every frame, including after the cursor has stopped — that's the
// "water keeps bleeding for a second or two" effect.
const soakFragment = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tInput;
uniform vec2 uTexelSize;
uniform float uSoakRadius;
uniform float uSoakStrength;
uniform float uWetSpread;

void main() {
  vec4 self = texture2D(tInput, vUv);
  float wetness = self.r;
  float mask = self.a;

  float r = uSoakRadius;
  float k = r * 0.7071;

  vec4 n1 = texture2D(tInput, vUv + vec2( r, 0.0) * uTexelSize);
  vec4 n2 = texture2D(tInput, vUv + vec2(-r, 0.0) * uTexelSize);
  vec4 n3 = texture2D(tInput, vUv + vec2(0.0,  r) * uTexelSize);
  vec4 n4 = texture2D(tInput, vUv + vec2(0.0, -r) * uTexelSize);
  vec4 n5 = texture2D(tInput, vUv + vec2( k,  k) * uTexelSize);
  vec4 n6 = texture2D(tInput, vUv + vec2(-k,  k) * uTexelSize);
  vec4 n7 = texture2D(tInput, vUv + vec2( k, -k) * uTexelSize);
  vec4 n8 = texture2D(tInput, vUv + vec2(-k, -k) * uTexelSize);

  float maxN_mask = max(max(max(n1.a, n2.a), max(n3.a, n4.a)),
                        max(max(n5.a, n6.a), max(n7.a, n8.a)));
  float maxN_wet  = max(max(max(n1.r, n2.r), max(n3.r, n4.r)),
                        max(max(n5.r, n6.r), max(n7.r, n8.r)));

  // Use the brightest local wetness (self or any neighbor) as the rate.
  // This lets the soak reach pixels that weren't directly stamped, as
  // long as a wet neighbor is nearby.
  float wetDriver = max(wetness, maxN_wet);

  // Grow the mask toward the brightest neighbor. Once mask == neighbor,
  // mix() is a no-op, so the equilibrium is "every wet pixel has the
  // mask value of its brightest neighbor".
  mask = mix(mask, maxN_mask, clamp(wetDriver * uSoakStrength, 0.0, 1.0));

  // Spread wetness too, so the wet front advances one ring per frame.
  // uWetSpread < 1 means it dims each hop and eventually falls below
  // significance, bounding total spread distance.
  wetness = max(wetness, maxN_wet * uWetSpread);

  gl_FragColor = vec4(wetness, self.g, self.b, mask);
}
`

// Composite pass — just samples the (already-soaked) mask with a small
// noise displacement for fluid edge irregularity. No render-time dilation;
// the FBO state already has the spread baked into it.
const revealFragment = /* glsl */ `
${noiseGLSL}

varying vec2 vUv;
uniform sampler2D tMask;
uniform sampler2D tColor;
uniform float uNoiseScale;
uniform float uDisplacement;
uniform float uEdgeSoftness;
uniform vec2 uImageAspect;
uniform vec2 uScreenAspect;

void main() {
  float sA = uScreenAspect.x / uScreenAspect.y;
  float iA = uImageAspect.x / uImageAspect.y;

  vec2 imgUv = vUv;
  if (sA < iA) {
    float s = sA / iA;
    imgUv.x = (vUv.x - 0.5) * s + 0.5;
  } else {
    float s = iA / sA;
    imgUv.y = (vUv.y - 0.5) * s + 0.5;
  }

  // Static spatial noise — perturbs the sample UV so the edge looks
  // organic. Time-invariant, so no flowing/smoke effect.
  vec2 dispStatic = vec2(
    snoise(vUv * uNoiseScale),
    snoise(vUv * uNoiseScale + vec2(100.0))
  ) * uDisplacement;

  float mask = texture2D(tMask, vUv + dispStatic).a;
  mask = smoothstep(0.0, uEdgeSoftness, mask);

  vec4 color = texture2D(tColor, imgUv);
  float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));

  vec3 finalRGB = mix(vec3(luma), color.rgb, mask);
  gl_FragColor = vec4(finalRGB, 1.0);
}
`

const FBO_SIZE = 2048

const fboOptions = {
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  format: THREE.RGBAFormat,
  type: THREE.UnsignedByteType,
  depthBuffer: false,
  stencilBuffer: false,
}

export function WatercolorReveal({
  imageUrl,
  brushSize = 0.18,
  brushOpacity = 0.7,
  noiseScale = 5.0,
  displacement = 0.05,
  edgeSoftness = 0.5,
  settleSpeed = 0.35,
  wetHalo = 2.2,
}) {
  const { gl, size, viewport, pointer } = useThree()
  const texture = useTexture(imageUrl)

  const aspect = size.width / Math.max(1, size.height)

  // Ping-pong pair. Each frame, the "in" FBO receives decay + brush
  // stamps, then the soak pass reads it and writes a slightly-grown
  // state into "out". They alternate.
  const fboA = useFBO(FBO_SIZE, FBO_SIZE, fboOptions)
  const fboB = useFBO(FBO_SIZE, FBO_SIZE, fboOptions)
  const tick = useRef(0)

  const brushScene = useMemo(() => new THREE.Scene(), [])
  const decayScene = useMemo(() => new THREE.Scene(), [])
  const soakScene = useMemo(() => new THREE.Scene(), [])
  const brushCamera = useMemo(() => {
    const c = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.001, 10)
    c.position.z = 1
    return c
  }, [])

  // Brush — separate blend equations per channel:
  //   RGB:   additive       → wetness saturates after a couple stamps
  //   Alpha: normal         → mask asymptotes per brush opacity
  const brushMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: fullscreenVertex,
        fragmentShader: brushFragment,
        uniforms: {
          uOpacity: { value: brushOpacity },
          uMaskRange: { value: 1 / wetHalo },
        },
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneFactor,
        blendEquationAlpha: THREE.AddEquation,
        blendSrcAlpha: THREE.OneFactor,
        blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      }),
    [],
  )

  useEffect(() => {
    brushMaterial.uniforms.uOpacity.value = brushOpacity
    brushMaterial.uniforms.uMaskRange.value = 1 / wetHalo
  }, [brushOpacity, wetHalo, brushMaterial])

  // Decay — reverse-subtract on R only, alpha untouched.
  const decayMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: fullscreenVertex,
        fragmentShader: decayFragment,
        uniforms: {
          uDecay: { value: 0.005 },
        },
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendEquation: THREE.ReverseSubtractEquation,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneFactor,
        blendEquationAlpha: THREE.AddEquation,
        blendSrcAlpha: THREE.ZeroFactor,
        blendDstAlpha: THREE.OneFactor,
      }),
    [],
  )

  // Soak — full-RGBA replace (NoBlending). Reads tInput, writes a grown
  // mask + propagated wetness.
  const soakMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: fullscreenVertex,
        fragmentShader: soakFragment,
        uniforms: {
          tInput: { value: null },
          uTexelSize: { value: new THREE.Vector2(1 / FBO_SIZE, 1 / FBO_SIZE) },
          uSoakRadius: { value: 3.0 },
          uSoakStrength: { value: 0.4 },
          uWetSpread: { value: 0.86 },
        },
        transparent: false,
        depthTest: false,
        depthWrite: false,
        blending: THREE.NoBlending,
      }),
    [],
  )

  const revealMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: fullscreenVertex,
        fragmentShader: revealFragment,
        uniforms: {
          tMask: { value: fboA.texture },
          tColor: { value: null },
          uNoiseScale: { value: noiseScale },
          uDisplacement: { value: displacement },
          uEdgeSoftness: { value: edgeSoftness },
          uImageAspect: { value: new THREE.Vector2(1, 1) },
          uScreenAspect: { value: new THREE.Vector2(1, 1) },
        },
      }),
    [fboA],
  )

  useEffect(() => {
    revealMaterial.uniforms.tColor.value = texture
    if (texture?.image) {
      revealMaterial.uniforms.uImageAspect.value.set(
        texture.image.width,
        texture.image.height,
      )
    }
  }, [texture, revealMaterial])

  useEffect(() => {
    revealMaterial.uniforms.uScreenAspect.value.set(size.width, size.height)
  }, [size, revealMaterial])

  const brushRef = useRef()
  const lastPointer = useRef(new THREE.Vector2(NaN, NaN))

  // Clear both FBOs on mount — their initial contents are undefined.
  useEffect(() => {
    const prevColor = new THREE.Color()
    gl.getClearColor(prevColor)
    const prevAlpha = gl.getClearAlpha()
    const prevTarget = gl.getRenderTarget()

    gl.setClearColor(0x000000, 0)
    gl.setRenderTarget(fboA)
    gl.clear()
    gl.setRenderTarget(fboB)
    gl.clear()

    gl.setRenderTarget(prevTarget)
    gl.setClearColor(prevColor, prevAlpha)
  }, [gl, fboA, fboB])

  useFrame((_, dt) => {
    revealMaterial.uniforms.uNoiseScale.value = noiseScale
    revealMaterial.uniforms.uDisplacement.value = displacement
    revealMaterial.uniforms.uEdgeSoftness.value = edgeSoftness

    decayMaterial.uniforms.uDecay.value = Math.min(0.2, settleSpeed * dt)

    const isEven = tick.current % 2 === 0
    const inFbo = isEven ? fboA : fboB
    const outFbo = isEven ? fboB : fboA

    const px = pointer.x
    const py = pointer.y
    const last = lastPointer.current

    const prevAutoClear = gl.autoClear
    const prevTarget = gl.getRenderTarget()
    gl.autoClear = false

    // (1) Decay + brush stamps → inFbo (in place)
    gl.setRenderTarget(inFbo)
    gl.render(decayScene, brushCamera)

    if (brushRef.current) {
      if (Number.isNaN(last.x)) {
        last.set(px, py)
      } else {
        const dx = px - last.x
        const dy = py - last.y
        const dist = Math.sqrt(dx * dx + dy * dy)

        if (dist >= 1e-4 && dist <= 0.4) {
          const stepSize = Math.max(brushSize * 0.25, 0.01)
          const steps = Math.max(1, Math.min(64, Math.ceil(dist / stepSize)))
          for (let i = 1; i <= steps; i++) {
            const t = i / steps
            brushRef.current.position.x = THREE.MathUtils.lerp(last.x, px, t)
            brushRef.current.position.y = THREE.MathUtils.lerp(last.y, py, t)
            gl.render(brushScene, brushCamera)
          }
        }
        last.set(px, py)
      }
    }

    // (2) Soak → outFbo (full replace via NoBlending)
    soakMaterial.uniforms.tInput.value = inFbo.texture
    gl.setRenderTarget(outFbo)
    gl.render(soakScene, brushCamera)

    // (3) Composite reads whichever FBO just got soaked into.
    revealMaterial.uniforms.tMask.value = outFbo.texture

    gl.setRenderTarget(prevTarget)
    gl.autoClear = prevAutoClear

    tick.current++
  })

  // Brush plane is wetHalo times bigger than the visible mask diameter,
  // so the brush fragment shader has room to write a wet halo around the
  // mask. uMaskRange in the shader trims the mask back to "brush diameter".
  const brushScale = [
    (brushSize * wetHalo) / aspect,
    brushSize * wetHalo,
    1,
  ]

  return (
    <>
      {createPortal(
        <mesh ref={brushRef} scale={brushScale}>
          <planeGeometry args={[1, 1]} />
          <primitive object={brushMaterial} attach="material" />
        </mesh>,
        brushScene,
      )}
      {createPortal(
        <mesh>
          <planeGeometry args={[2, 2]} />
          <primitive object={decayMaterial} attach="material" />
        </mesh>,
        decayScene,
      )}
      {createPortal(
        <mesh>
          <planeGeometry args={[2, 2]} />
          <primitive object={soakMaterial} attach="material" />
        </mesh>,
        soakScene,
      )}
      <mesh>
        <planeGeometry args={[viewport.width, viewport.height]} />
        <primitive object={revealMaterial} attach="material" />
      </mesh>
    </>
  )
}
