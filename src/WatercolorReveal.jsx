import { useRef, useMemo, useEffect } from 'react'
import { useFrame, useThree, createPortal } from '@react-three/fiber'
import { useTexture, useFBO } from '@react-three/drei'
import * as THREE from 'three'

// 2D simplex noise - Ashima Arts / Stefan Gustavson, MIT licensed.
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
//   A (mask)     - small soft circle (the visible color reveal)
//   R (wetness)  - larger soft halo (where the mask can keep spreading)
//   G/B          - intentionally unused in this version
// Each stamp writes to both R and A. RGB blends additively so wetness can
// accumulate quickly; alpha blends normally so the reveal mask builds up
// with brush opacity. This keeps the original broad brush feel.
const brushFragment = /* glsl */ `
varying vec2 vUv;
uniform float uOpacity;
uniform float uMaskRange;

void main() {
  vec2 c = vUv - 0.5;
  float d = length(c) * 2.0;             // 0 at center -> ~sqrt(2) at corners

  // Mask: confined to the inner uMaskRange of the plane.
  float a = 1.0 - smoothstep(0.0, uMaskRange, d);
  a = pow(a, 1.5);

  // Wetness: extends to the plane edge, giving the soak pass somewhere
  // outside the visible stroke to expand the mask into.
  float wet = 1.0 - smoothstep(0.0, 1.0, d);
  wet = pow(wet, 1.5);

  gl_FragColor = vec4(wet, 0.0, 0.0, a * uOpacity);
}
`

// Decay pass - subtract dt-scaled value from R every frame, leaves A alone.
const decayFragment = /* glsl */ `
uniform float uDecay;
void main() {
  gl_FragColor = vec4(uDecay, 0.0, 0.0, 0.0);
}
`

// Soak pass - the actual "water keeps bleeding" state update.
// For each pixel, look at the 8 ring neighbors. Wet pixels pull their mask
// toward the brightest nearby mask value, while wetness itself creeps ahead
// of the pigment and then decays in the separate decay pass.
//
// The only change from the original model is that growth rate is modulated
// by STATIC paper/fiber noise at the edge. The actual A mask still grows;
// there is no separate color fog, bloom layer, or animated noise overlay.
const soakFragment = /* glsl */ `
${noiseGLSL}

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

  float wetDriver = max(wetness, maxN_wet);
  float paper = snoise(vUv * 38.0) * 0.5 + 0.5;
  float fiber = snoise(vUv * vec2(16.0, 72.0) + vec2(11.0, -7.0)) * 0.5 + 0.5;
  float grain = mix(paper, fiber, 0.35);

  // Keep saturated interiors still; let the actual mask edge creep unevenly.
  float edgeBand = smoothstep(0.02, 0.42, maxN_mask) *
                   (1.0 - smoothstep(0.62, 0.96, mask));
  float rate = wetDriver * uSoakStrength * mix(0.55, 1.28, grain);
  mask = mix(mask, maxN_mask, clamp(rate * edgeBand, 0.0, 1.0));

  // Wetness still moves ahead of the pigment, but static paper texture
  // decides which fibers carry it farther.
  wetness = max(wetness, maxN_wet * mix(0.78, uWetSpread, grain));

  gl_FragColor = vec4(wetness, self.g, self.b, mask);
}
`

// Composite pass - sample the soaked A mask, displace that lookup with a
// static noise field for irregular edges, then mix grayscale and color.
// Time does not appear here; any motion comes from the persistent FBO state.
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

  // Static spatial noise perturbs the mask lookup, not the final color.
  // That keeps the edge organic without making the image look like smoke.
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

const CAPTURE_PATH = [
  { t: 0.25, x: -0.52, y: -0.13 },
  { t: 0.65, x: -0.38, y: -0.27 },
  { t: 1.05, x: -0.18, y: -0.22 },
  { t: 1.45, x: -0.02, y: -0.1 },
  { t: 1.85, x: -0.18, y: 0.07 },
  { t: 2.25, x: -0.36, y: 0.16 },
  { t: 2.65, x: -0.12, y: 0.25 },
  { t: 3.05, x: 0.06, y: 0.17 },
  { t: 3.55, x: 0.3, y: 0.24 },
  { t: 4.2, x: 0.55, y: 0.17 },
  { t: 4.85, x: 0.36, y: -0.06 },
]

const fboOptions = {
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  format: THREE.RGBAFormat,
  type: THREE.UnsignedByteType,
  depthBuffer: false,
  stencilBuffer: false,
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

function sampleCapturePath(time) {
  if (time < CAPTURE_PATH[0].t || time > CAPTURE_PATH[CAPTURE_PATH.length - 1].t) {
    return null
  }

  for (let i = 0; i < CAPTURE_PATH.length - 1; i++) {
    const a = CAPTURE_PATH[i]
    const b = CAPTURE_PATH[i + 1]
    if (time >= a.t && time <= b.t) {
      const t = smoothstep(0, 1, (time - a.t) / (b.t - a.t))
      return {
        x: THREE.MathUtils.lerp(a.x, b.x, t),
        y: THREE.MathUtils.lerp(a.y, b.y, t),
      }
    }
  }

  return null
}

export function WatercolorReveal({
  imageUrl,
  brushSize = 0.28,
  brushOpacity = 0.7,
  noiseScale = 5.0,
  displacement = 0.05,
  edgeSoftness = 0.5,
  settleSpeed = 0.35,
  wetHalo = 2.2,
  captureMode = false,
}) {
  const { gl, size, viewport, pointer } = useThree()
  const texture = useTexture(imageUrl)

  const aspect = size.width / Math.max(1, size.height)

  // Ping-pong pair. Each frame, the "in" FBO receives decay + brush stamps,
  // then the soak pass reads it and writes the next mask state into "out".
  // They alternate because WebGL cannot safely read from and write to the
  // same texture in one pass.
  const fboA = useFBO(FBO_SIZE, FBO_SIZE, fboOptions)
  const fboB = useFBO(FBO_SIZE, FBO_SIZE, fboOptions)
  const tick = useRef(0)
  const captureStart = useRef(null)

  const brushScene = useMemo(() => new THREE.Scene(), [])
  const decayScene = useMemo(() => new THREE.Scene(), [])
  const soakScene = useMemo(() => new THREE.Scene(), [])
  const brushCamera = useMemo(() => {
    const c = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.001, 10)
    c.position.z = 1
    return c
  }, [])

  // Brush - separate blend equations per channel:
  //   RGB:   additive       -> wetness saturates after a couple stamps
  //   Alpha: normal alpha   -> mask asymptotes per brush opacity
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

  // Decay - reverse-subtract on R only, alpha untouched.
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

  // Soak - full-RGBA replace (NoBlending). Reads tInput, writes a grown
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
          uSoakStrength: { value: 0.48 },
          uWetSpread: { value: 0.88 },
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

  // Clear both FBOs on mount; render target contents are undefined initially.
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

  useFrame((state, dt) => {
    revealMaterial.uniforms.uNoiseScale.value = noiseScale
    revealMaterial.uniforms.uDisplacement.value = displacement
    revealMaterial.uniforms.uEdgeSoftness.value = edgeSoftness

    decayMaterial.uniforms.uDecay.value = Math.min(0.2, settleSpeed * dt)

    const isEven = tick.current % 2 === 0
    const inFbo = isEven ? fboA : fboB
    const outFbo = isEven ? fboB : fboA

    if (captureStart.current === null) {
      captureStart.current = state.clock.elapsedTime
    }

    const capturePointer = captureMode
      ? sampleCapturePath(state.clock.elapsedTime - captureStart.current)
      : null
    const shouldStamp = captureMode ? capturePointer !== null : true
    const px = captureMode ? capturePointer?.x : pointer.x
    const py = captureMode ? capturePointer?.y : pointer.y
    const last = lastPointer.current

    const prevAutoClear = gl.autoClear
    const prevTarget = gl.getRenderTarget()
    gl.autoClear = false

    // (1) Decay + brush stamps -> inFbo, preserving previous accumulated state.
    gl.setRenderTarget(inFbo)
    gl.render(decayScene, brushCamera)

    if (
      brushRef.current &&
      shouldStamp &&
      px !== undefined &&
      py !== undefined
    ) {
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

    // (2) Soak -> outFbo, baking the edge feather into the persistent mask.
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
  // so the fragment shader can write wetness outside the revealed color.
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
